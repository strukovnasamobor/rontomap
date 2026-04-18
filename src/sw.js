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
    u.searchParams.delete("secure");
    u.searchParams.delete("events");
    // Strip sdk=js-X.Y.Z — Mapbox GL JS adds it to every request but the
    // download URLs don't include it. Same style JSON / tile under either.
    u.searchParams.delete("sdk");
    // Collapse retina variants (@2x, @3x) onto the non-retina path so a
    // runtime @2x request hits the cached @1x tile and vice versa.
    u.pathname = u.pathname.replace(/@[23]x(?=\.|$)/, "");
    // Canonicalize Mapbox tile hosts onto api.mapbox.com. Downloads store
    // tiles under the sharded CDN host returned by TileJSON
    // ({a-d}.tiles.mapbox.com), but Mapbox GL JS v3 requests the same tile
    // from api.mapbox.com at runtime — without folding both onto one key,
    // the offline cache lookup misses and we serve a 504.
    if (
      /^([a-d]\.)?tiles\.mapbox\.com$/.test(u.hostname) ||
      u.hostname === "api.mapbox.com"
    ) {
      u.hostname = "api.mapbox.com";
    }
    // Collapse interchangeable raster formats onto .png so a runtime request
    // for any raster variant (.webp, .jpg, .jpg70, .jpg90, .png32, .png64,
    // .png256, etc.) hits whatever raster variant we downloaded. Vector
    // (.vector.pbf/.mvt) and model/array (.glb/.mrt) paths are untouched —
    // their contents are non-fungible.
    u.pathname = u.pathname.replace(/\.(webp|jpe?g|png)\d*$/i, ".png");
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
    console.warn(`[sw miss] offline 504: url=${request.url} key=${key}`);
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
      handleDownloadRegion(data.region, data.tileUrls, event.source, {
        isUpdate: !!data.isUpdate,
      }),
    );
  } else if (data.type === "DOWNLOAD_BASE_MAP") {
    event.waitUntil(
      handleDownloadBase(data.region, data.tileUrls, event.source),
    );
  } else if (data.type === "DELETE_REGION") {
    event.waitUntil(
      handleDeleteRegion(data.regionId, data.tileUrls, event.source),
    );
  } else if (data.type === "DELETE_BASE_MAP") {
    event.waitUntil(handleDeleteBase(event.source));
  } else if (data.type === "GET_REGIONS") {
    event.waitUntil(handleGetRegions(event.ports[0]));
  } else if (data.type === "CANCEL_DOWNLOAD") {
    cancelledDownloads.add(data.regionId);
  } else if (data.type === "RENAME_REGION") {
    event.waitUntil(handleRenameRegion(data.regionId, data.name, event.source));
  }
});

const FETCH_TIMEOUT_MS = 25000;
const FETCH_RETRIES = 5;

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, tag, maxAttempts = FETCH_RETRIES + 1) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (res && res.ok) return res;
      const status = res && res.status;
      lastErr = new Error(`HTTP ${status}`);
      // Fail fast on hard client errors. 401/403 from Mapbox are permanent
      // token-scope failures (e.g. raster tilesets the token can't access),
      // not transient — retrying just wastes time and blocks workers.
      if (status && status >= 400 && status < 500 &&
          status !== 408 && status !== 429) {
        console.warn(`[sw ${tag}] fail http ${status} (no retry): ${url}`);
        throw lastErr;
      }
      // Honor server-supplied Retry-After (seconds) when present.
      const ra = Number(res?.headers?.get("retry-after"));
      if (!Number.isNaN(ra) && ra > 0 && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, Math.min(ra * 1000, 30000)));
        continue;
      }
      console.warn(`[sw ${tag}] retry ${attempt + 1}/${maxAttempts} http ${status}: ${url}`);
    } catch (err) {
      if (err === lastErr) throw err;
      lastErr = err;
      console.warn(`[sw ${tag}] retry ${attempt + 1}/${maxAttempts} ${err?.name || "err"}: ${url}`);
    }
    if (attempt < maxAttempts - 1) {
      // Exponential backoff with jitter: 500ms, 1s, 2s, 4s, 8s (+ 0..500ms).
      const delay = 500 * Math.pow(2, attempt) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function handleDownloadRegion(region, tileUrls, source, opts = {}) {
  const baseTag = opts.isBase ? { isBase: true } : {};
  const logTag = opts.isBase ? "base" : "region";
  const isUpdate = !!opts.isUpdate && region.id != null;
  let regionId = region.id;
  let oldTileUrls = null;
  try {
    if (isUpdate) {
      const existing = await dbGet(regionId);
      oldTileUrls = existing?.tileUrls || [];
    } else {
      const now = Date.now();
      const saved = await dbPut({
        ...region,
        tileUrls,
        sizeBytes: region.sizeBytes || 0,
        createdAt: region.createdAt || now,
        updatedAt: now,
      });
      regionId = typeof saved === "number" ? saved : region.id;
    }

    const cache = await caches.open(TILES_CACHE);
    const total = tileUrls.length;
    let done = 0;
    let failed = 0;
    let totalSize = 0;
    const concurrency = 6;
    let idx = 0;
    const startedAt = Date.now();
    const existingKeys = new Set(
      (await cache.keys()).map((req) => {
        try { return normalizeCacheKey(req.url); } catch { return req.url; }
      }),
    );
    console.info(
      `[sw ${logTag}] download start id=${regionId} total=${total} concurrency=${concurrency} existing=${existingKeys.size}`,
    );
    postToClient(source, {
      type: "DOWNLOAD_PROGRESS",
      regionId,
      done: 0,
      total,
      failed: 0,
      percent: 0,
      complete: false,
      ...baseTag,
    });


    const worker = async (workerIdx) => {
      while (idx < total) {
        if (cancelledDownloads.has(regionId)) {
          console.info(`[sw ${logTag}] worker ${workerIdx} cancel (id=${regionId})`);
          return;
        }
        const myIdx = idx++;
        const url = tileUrls[myIdx];
        const key = normalizeCacheKey(url);
        try {
          if (!existingKeys.has(key)) {
            const res = await fetchWithRetry(url, logTag);
            const bytes = Number(res.headers.get("content-length")) || 0;
            totalSize += bytes;
            existingKeys.add(key);
            cache.put(key, res).catch((err) => {
              failed++;
              console.warn(`[sw ${logTag}] cache.put failed #${myIdx} ${url} — ${err?.message || err}`);
            });
          } else {
            // Resumed: add the cached response's size so totalSize reflects
            // total on-disk bytes for this region, not just bytes fetched now.
            try {
              const cached = await cache.match(key);
              const bytes = Number(cached?.headers.get("content-length")) || 0;
              totalSize += bytes;
            } catch {}
          }
        } catch (err) {
          failed++;
          console.warn(`[sw ${logTag}] tile failed #${myIdx} ${url} — ${err?.message || err}`);
        }
        done++;
        if (done % 20 === 0 || done === total) {
          const pct = ((done / total) * 100).toFixed(1);
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.info(`[sw ${logTag}] progress ${done}/${total} (${pct}%) failed=${failed} elapsed=${elapsed}s`);
          postToClient(source, {
            type: "DOWNLOAD_PROGRESS",
            regionId,
            done,
            total,
            failed,
            percent: (done / total) * 100,
            complete: false,
            ...baseTag,
          });
        }
      }
      console.info(`[sw ${logTag}] worker ${workerIdx} done`);
    };

    await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const endMsg = `[sw ${logTag}] download end id=${regionId} done=${done}/${total} failed=${failed} bytes=${totalSize} elapsed=${elapsed}s`;
    if (failed > 0) {
      console.warn(`${endMsg} \u26a0 ${failed} tile(s) failed — map will have holes. Re-download to retry.`);
    } else {
      console.info(endMsg);
    }

    if (cancelledDownloads.has(regionId)) {
      cancelledDownloads.delete(regionId);
      if (isUpdate) {
        // Purge only tiles newly fetched by this update — keep everything the old record referenced.
        const oldSet = new Set((oldTileUrls || []).map(normalizeCacheKey));
        const cache = await caches.open(TILES_CACHE);
        const toDelete = tileUrls.filter((u) => !oldSet.has(normalizeCacheKey(u)));
        await Promise.all(toDelete.map((u) => cache.delete(normalizeCacheKey(u))));
        // Old DB row was never overwritten — nothing to restore.
      } else {
        await handleDeleteRegion(regionId, tileUrls, source);
      }
      postToClient(source, { type: "DOWNLOAD_CANCELLED", regionId });
      return;
    }

    await dbPut({
      ...region,
      id: regionId,
      tileUrls,
      sizeBytes: totalSize,
      createdAt: region.createdAt || Date.now(),
      updatedAt: Date.now(),
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
      ...baseTag,
    });
  } catch (err) {
    postToClient(source, {
      type: "DOWNLOAD_ERROR",
      regionId,
      message: String(err?.message || err),
      ...baseTag,
    });
  }
}

async function handleDownloadBase(region, tileUrls, source) {
  try {
    const all = await dbGetAll();
    const existing = all.find((r) => r.type === "base");
    if (existing) {
      const cache = await caches.open(TILES_CACHE);
      await Promise.all(
        (existing.tileUrls || []).map((u) => cache.delete(normalizeCacheKey(u))),
      );
      await dbDelete(existing.id);
    }
  } catch {}
  await handleDownloadRegion(
    { ...region, type: "base" },
    tileUrls,
    source,
    { isBase: true },
  );
}

async function handleDeleteBase(source) {
  try {
    const all = await dbGetAll();
    const cache = await caches.open(TILES_CACHE);
    for (const r of all) {
      await Promise.all(
        (r.tileUrls || []).map((u) => cache.delete(normalizeCacheKey(u))),
      );
      await dbDelete(r.id);
    }
    postToClient(source, { type: "BASE_DELETED" });
    postToClient(source, { type: "REGION_DELETED" });
  } catch (err) {
    postToClient(source, {
      type: "DELETE_ERROR",
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

async function handleRenameRegion(regionId, name, source) {
  try {
    const r = await dbGet(regionId);
    if (!r) return;
    await dbPut({ ...r, name });
    postToClient(source, { type: "REGION_RENAMED", regionId, name });
  } catch (err) {
    postToClient(source, {
      type: "RENAME_ERROR",
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
