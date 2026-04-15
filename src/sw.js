/* eslint-env serviceworker */
/* global self, caches, indexedDB, fetch, Response */

const CACHE_VERSION = "v1";
const APP_CACHE = `rontomap-app-${CACHE_VERSION}`;
const TILES_CACHE = "rontomap-tiles";
const DB_NAME = "rontomap_offline";
const DB_VERSION = 1;
const REGIONS_STORE = "regions";

const PRECACHE_URLS = (self.__WB_MANIFEST || []).map((e) =>
  typeof e === "string" ? e : e.url,
);

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(REGIONS_STORE)) {
        db.createObjectStore(REGIONS_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(region) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE, "readwrite");
    const store = tx.objectStore(REGIONS_STORE);
    const req = region.id != null ? store.put(region) : store.add(region);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE, "readonly");
    const req = tx.objectStore(REGIONS_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE, "readonly");
    const req = tx.objectStore(REGIONS_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGIONS_STORE, "readwrite");
    const req = tx.objectStore(REGIONS_STORE).delete(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function normalizeCacheKey(url) {
  try {
    const u = new URL(url, self.location.origin);
    u.searchParams.delete("access_token");
    u.searchParams.delete("sku");
    u.searchParams.delete("fresh");
    return u.toString();
  } catch {
    return url;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      await Promise.allSettled(
        PRECACHE_URLS.map((u) => cache.add(u).catch(() => null)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== TILES_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  const isMapboxHost =
    url.hostname === "api.mapbox.com" ||
    url.hostname === "events.mapbox.com" ||
    url.hostname === "tiles.mapbox.com" ||
    url.hostname.endsWith(".tiles.mapbox.com");
  if (isMapboxHost) {
    event.respondWith(handleMapboxRequest(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleAppRequest(request));
  }
});

async function handleMapboxRequest(request) {
  const cache = await caches.open(TILES_CACHE);
  const key = normalizeCacheKey(request.url);
  const cached = await cache.match(key);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

async function handleAppRequest(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(APP_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const fallback =
        (await cache.match("/")) || (await cache.match("/index.html"));
      if (fallback) return fallback;
    }
    return new Response("Offline", { status: 504 });
  }
}

const cancelledDownloads = new Set();

async function postToClient(source, message) {
  if (source && source.postMessage) {
    source.postMessage(message);
  } else {
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage(message));
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === "DOWNLOAD_REGION") {
    event.waitUntil(
      handleDownloadRegion(data.region, data.tileUrls, event.source),
    );
  } else if (data.type === "DELETE_REGION") {
    event.waitUntil(
      handleDeleteRegion(data.regionId, data.tileUrls, event.source),
    );
  } else if (data.type === "GET_REGIONS") {
    event.waitUntil(handleGetRegions(event.ports[0]));
  } else if (data.type === "CANCEL_DOWNLOAD") {
    cancelledDownloads.add(data.regionId);
  }
});

async function handleDownloadRegion(region, tileUrls, source) {
  let regionId = region.id;
  try {
    const saved = await dbPut({
      ...region,
      tileUrls,
      sizeBytes: region.sizeBytes || 0,
      createdAt: region.createdAt || Date.now(),
    });
    regionId = typeof saved === "number" ? saved : region.id;

    const cache = await caches.open(TILES_CACHE);
    const total = tileUrls.length;
    let done = 0;
    let failed = 0;
    let totalSize = 0;
    const concurrency = 8;
    let idx = 0;

    const worker = async () => {
      while (idx < total) {
        if (cancelledDownloads.has(regionId)) return;
        const myIdx = idx++;
        const url = tileUrls[myIdx];
        const key = normalizeCacheKey(url);
        try {
          const existing = await cache.match(key);
          if (existing) {
            try {
              const blob = await existing.clone().blob();
              totalSize += blob.size;
            } catch {}
          } else {
            const res = await fetch(url);
            if (res && res.ok) {
              const clone = res.clone();
              await cache.put(key, res);
              try {
                const blob = await clone.blob();
                totalSize += blob.size;
              } catch {}
            } else {
              failed++;
            }
          }
        } catch {
          failed++;
        }
        done++;
        if (done % 20 === 0 || done === total) {
          postToClient(source, {
            type: "DOWNLOAD_PROGRESS",
            regionId,
            done,
            total,
            failed,
            percent: (done / total) * 100,
            complete: false,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    if (cancelledDownloads.has(regionId)) {
      cancelledDownloads.delete(regionId);
      await handleDeleteRegion(regionId, tileUrls, source);
      postToClient(source, { type: "DOWNLOAD_CANCELLED", regionId });
      return;
    }

    await dbPut({
      ...region,
      id: regionId,
      tileUrls,
      sizeBytes: totalSize,
      createdAt: region.createdAt || Date.now(),
    });

    postToClient(source, {
      type: "DOWNLOAD_PROGRESS",
      regionId,
      done,
      total,
      failed,
      percent: 100,
      complete: true,
      sizeBytes: totalSize,
    });
  } catch (err) {
    postToClient(source, {
      type: "DOWNLOAD_ERROR",
      regionId,
      message: String(err?.message || err),
    });
  }
}

async function handleDeleteRegion(regionId, tileUrls, source) {
  try {
    let urls = tileUrls;
    if (!urls) {
      const region = await dbGet(regionId);
      urls = region?.tileUrls || [];
    }
    const cache = await caches.open(TILES_CACHE);
    await Promise.all(urls.map((u) => cache.delete(normalizeCacheKey(u))));
    await dbDelete(regionId);
    postToClient(source, { type: "REGION_DELETED", regionId });
  } catch (err) {
    postToClient(source, {
      type: "DELETE_ERROR",
      regionId,
      message: String(err?.message || err),
    });
  }
}

async function handleGetRegions(port) {
  try {
    const regions = await dbGetAll();
    const stripped = regions.map(({ tileUrls, ...r }) => r);
    if (port) port.postMessage({ type: "REGIONS", regions: stripped });
  } catch (err) {
    if (port)
      port.postMessage({ type: "ERROR", message: String(err?.message || err) });
  }
}
