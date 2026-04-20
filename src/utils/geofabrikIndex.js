// Geofabrik region index loader + region suggester.
//
// The index (index-v1.json) is a GeoJSON FeatureCollection of every region
// Geofabrik hosts, with polygons and stable PBF URLs. Geofabrik does not
// send CORS headers, so in the Capacitor webview the fetch is proxied
// through the native OfflineRouting plugin (OkHttp, no CORS). In a plain
// browser/PWA the direct fetch is attempted and will only work if Geofabrik
// ever adds CORS headers — otherwise callers get a clear error.
//
// The result is cached in the browser Cache API with a 7-day TTL. For an
// input bbox (the user's offline map region), we return the minimal set of
// *leaf* regions whose polygon covers at least one corner or the centre of
// the bbox — handling the cross-border case with multiple matches.

import { Capacitor } from "@capacitor/core";
import OfflineRouting from "../plugins/OfflineRouting";

const INDEX_URL = "https://download.geofabrik.de/index-v1.json";
const CACHE_NAME = "rontomap-geofabrik";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

let cachedIndex = null;

function isNativeCapacitor() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

async function fetchTextViaNative(url) {
  const res = await OfflineRouting.httpGet({ url });
  if (!res || res.ok === false) {
    throw new Error(`HTTP ${res?.status ?? "?"} for ${url}`);
  }
  return res.data;
}

export async function fetchGeofabrikIndex({ force = false } = {}) {
  if (cachedIndex && !force) return cachedIndex;

  if (!force && typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(INDEX_URL);
      if (hit) {
        const dateHeader = hit.headers.get("date");
        const age = dateHeader ? Date.now() - new Date(dateHeader).getTime() : Infinity;
        if (Number.isFinite(age) && age < TTL_MS) {
          cachedIndex = await hit.json();
          return cachedIndex;
        }
      }
    } catch {}
  }

  let data;
  if (isNativeCapacitor()) {
    const text = await fetchTextViaNative(INDEX_URL);
    data = JSON.parse(text);
    if (typeof caches !== "undefined") {
      try {
        const cache = await caches.open(CACHE_NAME);
        const synthetic = new Response(text, {
          headers: {
            "Content-Type": "application/json",
            "Date": new Date().toUTCString(),
          },
        });
        await cache.put(INDEX_URL, synthetic);
      } catch {}
    }
  } else {
    const res = await fetch(INDEX_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Geofabrik index fetch failed: ${res.status}`);
    data = await res.clone().json();
    if (typeof caches !== "undefined") {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(INDEX_URL, res);
      } catch {}
    }
  }

  cachedIndex = data;
  return data;
}

function computeLeafFeatures(index) {
  const hasChild = new Set();
  for (const f of index.features) {
    const parent = f.properties?.parent;
    if (parent) hasChild.add(parent);
  }
  return index.features.filter((f) => {
    const id = f.properties?.id;
    const hasPbf = Boolean(f.properties?.urls?.pbf);
    return id && hasPbf && !hasChild.has(id);
  });
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFeature(lng, lat, feature) {
  const geom = feature.geometry;
  if (!geom) return false;
  if (geom.type === "Polygon") {
    return pointInRing(lng, lat, geom.coordinates[0]);
  }
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (pointInRing(lng, lat, poly[0])) return true;
    }
  }
  return false;
}

function bboxOfGeometry(geom) {
  if (!geom) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (ring) => {
    for (const [lng, lat] of ring) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  };
  if (geom.type === "Polygon") geom.coordinates.forEach(visit);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach((p) => p.forEach(visit));
  else return null;
  return { west, south, east, north };
}

/**
 * Given an offline-tile bbox, return the minimal list of Geofabrik leaf
 * regions whose polygon covers the bbox. Cross-border boxes return 2+.
 */
export async function suggestRegions(bounds) {
  if (!bounds) return [];
  const index = await fetchGeofabrikIndex();
  const leaves = computeLeafFeatures(index);

  const probes = [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
    [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
  ];

  const matched = new Map();
  for (const f of leaves) {
    const fb = bboxOfGeometry(f.geometry);
    if (!fb) continue;
    if (fb.east < bounds.west || fb.west > bounds.east ||
        fb.north < bounds.south || fb.south > bounds.north) continue;
    for (const [lng, lat] of probes) {
      if (pointInFeature(lng, lat, f)) {
        matched.set(f.properties.id, {
          id: f.properties.id,
          name: f.properties.name,
          parent: f.properties.parent,
          pbfUrl: f.properties.urls.pbf,
          bbox: fb,
        });
        break;
      }
    }
  }

  return Array.from(matched.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up the PBF URL for a region by its Geofabrik id. Used by the "update"
 * action on an installed routing region to re-trigger the download without
 * re-running region suggestion.
 */
export async function pbfUrlForRegion(regionId) {
  if (!regionId) return null;
  const index = await fetchGeofabrikIndex();
  const feature = index.features.find((f) => f.properties?.id === regionId);
  return feature?.properties?.urls?.pbf || null;
}

/**
 * HEAD the PBF URL to get its download size. On Capacitor native, proxied
 * through the plugin to bypass CORS. In a plain browser, may return null
 * if Geofabrik blocks the HEAD from the webview origin.
 */
export async function headPbfSize(url) {
  try {
    if (isNativeCapacitor()) {
      const res = await OfflineRouting.httpHead({ url });
      if (!res || res.ok === false) return null;
      return typeof res.contentLength === "number" ? res.contentLength : null;
    }
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    const cl = res.headers.get("content-length");
    return cl ? Number(cl) : null;
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
