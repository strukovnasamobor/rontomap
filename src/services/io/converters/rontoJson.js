/**
 * @typedef {import('../types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('../types').ExportScope} ExportScope
 */

/**
 * Collect all map features from the live refs into the RontoJSON schema.
 * Extracted from Map.jsx handleCopyFeatures / handleCopyFeaturesCode.
 *
 * @param {React.MutableRefObject} markersRef
 * @param {React.MutableRefObject} pathsRef
 * @param {Function} serializeSnappedSegments
 * @returns {RontoFeatureCollection}
 */
export function collectFeatures(markersRef, pathsRef, serializeSnappedSegments, camera) {
  const freeMarkers = markersRef.current.filter((m) => !m._sightPath);
  const markers = freeMarkers.map((m, i) => {
    const ll = m.getLngLat();
    const markerData = {
      id: `m${i + 1}`,
      name: m._markerName || "",
      pos: [ll.lat, ll.lng],
    };
    if (m._description) markerData.description = m._description;
    return markerData;
  });

  const paths = pathsRef.current.map((p, i) => {
    const pathData = {
      id: `p${i + 1}`,
      coords: p.vertices.map((v) => ({ long: v.lngLat[0], lat: v.lngLat[1], ...(v.force ? { force: true } : {}) })),
    };
    if (p.name) pathData.name = p.name;
    if (p._description) pathData.description = p._description;
    if (p.roadSnap) pathData.roadSnap = p.roadSnap;
    if (p.snappedSegments) pathData.snappedSegments = serializeSnappedSegments(p.snappedSegments);
    if (p.routeDistance != null) pathData.routeDistance = p.routeDistance;
    if (p.routeDuration != null) pathData.routeDuration = p.routeDuration;
    if (p.isCircuit) pathData.isCircuit = true;
    if (p.closingForced) pathData.closingForced = true;
    if (p.isRoute) pathData.isRoute = true;
    if (p.isTrack) pathData.isTrack = true;
    if (p.sights && p.sights.length > 0) {
      pathData.sights = p.sights.map((m) => {
        const am = { segmentIndex: m._segmentIndex, t: m._t };
        if (m._markerName) am.name = m._markerName;
        if (m._description) am.description = m._description;
        return am;
      });
    }
    return pathData;
  });

  const out = { markers, paths };
  if (camera) out.camera = camera;
  return out;
}

/**
 * Collect a single marker into a RontoJSON structure.
 * @param {Object} marker - Mapbox GL marker instance
 * @param {RontoCamera} [camera]
 * @returns {RontoFeatureCollection}
 */
export function collectMarker(marker, camera) {
  const ll = marker.getLngLat();
  const markerData = {
    id: "m1",
    name: marker._markerName || "",
    pos: [ll.lat, ll.lng],
  };
  if (marker._description) markerData.description = marker._description;
  const out = { markers: [markerData], paths: [] };
  if (camera) out.camera = camera;
  return out;
}

/**
 * Collect a single path (with its sights) into a RontoJSON structure.
 * @param {Object} path - Path object from pathsRef
 * @param {Function} serializeSnappedSegments
 * @param {RontoCamera} [camera]
 * @returns {RontoFeatureCollection}
 */
export function collectPath(path, serializeSnappedSegments, camera) {
  const pathData = {
    id: "p1",
    coords: path.vertices.map((v) => ({ long: v.lngLat[0], lat: v.lngLat[1], ...(v.force ? { force: true } : {}) })),
  };
  if (path.name) pathData.name = path.name;
  if (path._description) pathData.description = path._description;
  if (path.roadSnap) pathData.roadSnap = path.roadSnap;
  if (path.snappedSegments) pathData.snappedSegments = serializeSnappedSegments(path.snappedSegments);
  if (path.routeDistance != null) pathData.routeDistance = path.routeDistance;
  if (path.routeDuration != null) pathData.routeDuration = path.routeDuration;
  if (path.isCircuit) pathData.isCircuit = true;
  if (path.closingForced) pathData.closingForced = true;
  if (path.isRoute) pathData.isRoute = true;
  if (path.isTrack) pathData.isTrack = true;
  if (path.sights && path.sights.length > 0) {
    pathData.sights = path.sights.map((m) => {
      const am = { segmentIndex: m._segmentIndex, t: m._t };
      if (m._markerName) am.name = m._markerName;
      if (m._description) am.description = m._description;
      return am;
    });
  }
  const out = { markers: [], paths: [pathData] };
  if (camera) out.camera = camera;
  return out;
}

/**
 * Recreate map features from RontoJSON data onto the map.
 * Extracted from Map.jsx features-collection loader (lines 2876-2960).
 *
 * @param {RontoFeatureCollection} data
 * @param {Object} deps
 * @param {Function} deps.createMarker - (lngLat, color?) => mapboxgl.Marker
 * @param {React.MutableRefObject} deps.pathHelpersRef
 * @param {Function} deps.updateMarkerLabel
 * @param {Function} deps.deserializeSnappedSegments
 * @param {React.MutableRefObject} deps.pathsRef
 * @returns {{markerCount: number, pathCount: number, skipped: number}}
 */
export function materializeFeatures(data, deps) {
  const { createMarker, updateMarkerLabel } = deps;
  let markerCount = 0;
  let pathCount = 0;
  let skipped = 0;

  (data.markers || []).forEach((entry) => {
    if (!isValidCoord(entry.pos?.[0], entry.pos?.[1])) {
      skipped++;
      return;
    }
    const m = createMarker([entry.pos[1], entry.pos[0]]);
    if (entry.name) {
      m._markerName = entry.name;
      updateMarkerLabel(m);
    }
    if (entry.description) m._description = entry.description;
    markerCount++;
  });

  (data.paths || []).forEach((entry) => {
    const ok = materializePathFromShape(entry, deps);
    if (ok) pathCount++;
    else skipped++;
  });

  return { markerCount, pathCount, skipped };
}

/**
 * Materialize a single path from a shape compatible with the materializer (RontoJSON path entry,
 * or a URL-decoded entry whose snappedSegments are already in runtime form).
 * @param {Object} entry
 * @param {Object} deps - same shape as materializeFeatures deps
 * @returns {boolean} true on success, false if skipped (too few valid coords)
 */
export function materializePathFromShape(entry, deps) {
  const { createMarker, pathHelpersRef, updateMarkerLabel, deserializeSnappedSegments, pathsRef } = deps;
  const h = pathHelpersRef.current;

  const validCoords = (entry.coords || []).filter((c) => isValidCoord(c.lat, c.long));
  if (validCoords.length < 2) return false;

  const id = `path-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const path = {
    id,
    sourceId: `path-line-source-${id}`,
    layerId: `path-line-layer-${id}`,
    vertices: [],
    midpoints: [],
    isFinished: true,
  };
  if (entry.isCircuit) path.isCircuit = true;
  if (entry.closingForced) path.closingForced = true;
  if (entry.isRoute || entry.isNavigation) path.isRoute = true;
  if (entry.isTrack || entry.isRecording) path.isTrack = true;
  pathsRef.current.push(path);
  h.ensurePathLayer(path);

  validCoords.forEach((c) => {
    const lngLat = [c.long, c.lat];
    const marker = h.createPathVertex(lngLat);
    const vertex = { lngLat, marker, path };
    if (c.force) vertex.force = true;
    path.vertices.push(vertex);
    h.attachVertexDragHandler(vertex);
    h.attachFinishHandler(vertex);
  });

  const pathName = entry.name ?? entry.startName;
  if (pathName) path.name = pathName;
  if (entry.description) path._description = entry.description;
  if (entry.roadSnap) {
    path.roadSnap = entry.roadSnap === true ? "car" : entry.roadSnap;
    if (entry.snappedSegments) {
      // Already-deserialized runtime form: coords are [lng, lat] tuples (URL parser path).
      // Firestore form: coords are {lng, lat} objects — needs deserializeSnappedSegments.
      const first = entry.snappedSegments[0];
      const alreadyRuntime = first && Array.isArray(first.coords?.[0]);
      path.snappedSegments = alreadyRuntime ? entry.snappedSegments : deserializeSnappedSegments(entry.snappedSegments);
      h.updatePathLine(path);
      h.updateSights(path);
    } else {
      h.fetchRoadSnap(path);
    }
  }
  if (entry.routeDistance != null) path.routeDistance = entry.routeDistance;
  if (entry.routeDuration != null) path.routeDuration = entry.routeDuration;

  const sightsData = entry.sights || entry.attachedMarkers;
  if (sightsData) {
    path.sights = [];
    sightsData.forEach((am) => {
      const pos = h.getSightPos(path, am);
      const m = createMarker(pos, "#0091ff");
      h.applySightColors(m, path);
      m._sightPath = path;
      m._segmentIndex = am.segmentIndex;
      m._t = am.t;
      if (am.name) {
        m._markerName = am.name;
        updateMarkerLabel(m);
      }
      if (am.description) m._description = am.description;
      m.on("drag", () => {
        if (!m._sightPath) return;
        const p = m.getLngLat(),
          lngLat = [p.lng, p.lat];
        const s = h.snapToPath(m._sightPath, lngLat);
        m._segmentIndex = s.segmentIndex;
        m._t = s.t;
        const line = h.getRenderedLine(m._sightPath);
        m.setLngLat(h.closestPointOnLine(line, lngLat));
      });
      path.sights.push(m);
    });
  }

  h.updatePathLine(path);
  h.hideIntermediateVertices(path);
  h.updateVertexStyles(path);
  path.vertices.forEach((v) => {
    v.marker.getElement().classList.remove("active-path-feature");
    v.marker.setDraggable(false);
  });
  if (path.sights) path.sights.forEach((m) => m.setDraggable(false));
  return true;
}

/**
 * Import: parse a RontoJSON string into the feature collection structure.
 * @param {string} content
 * @returns {RontoFeatureCollection}
 */
export function toRonto(content) {
  const obj = JSON.parse(content);
  const out = {
    markers: Array.isArray(obj.markers) ? obj.markers : [],
    paths: Array.isArray(obj.paths) ? obj.paths : [],
  };
  if (isValidCamera(obj.camera)) out.camera = normalizeCamera(obj.camera);
  return out;
}

/**
 * Export: serialize a RontoJSON feature collection to a JSON string.
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {string}
 */
export function fromRonto(data, scope) {
  const out = scopeData(data, scope);
  return JSON.stringify(out, null, 2);
}

/**
 * Build a JSON-serializable extras blob for embedding in KML / GPX / GeoJSON
 * exports. Captures the rontoJSON-specific state that a flat LineString cannot
 * represent: per-vertex `force` flags, the rendered `snappedSegments`, and the
 * `isCircuit` / `closingForced` flags. Returns null if the path has no extras
 * worth preserving (no force flags and no snapped segments).
 *
 * @param {Object} pathData - rontoJSON path entry (from collectPath / collectFeatures)
 * @returns {Object|null}
 */
export function buildPathExtras(pathData) {
  const hasForce = Array.isArray(pathData.coords) && pathData.coords.some((c) => c.force);
  const hasSnapped = Array.isArray(pathData.snappedSegments) && pathData.snappedSegments.length > 0;
  if (!hasForce && !hasSnapped) return null;
  const extras = {};
  extras.coords = pathData.coords.map((c) => {
    const e = { long: c.long, lat: c.lat };
    if (c.force) e.force = true;
    return e;
  });
  if (hasSnapped) {
    extras.snappedSegments = pathData.snappedSegments.map((seg) => ({
      type: seg.type,
      coords: seg.coords.map((c) => ({ lng: c.lng, lat: c.lat })),
    }));
  }
  if (pathData.isCircuit) extras.isCircuit = true;
  if (pathData.closingForced) extras.closingForced = true;
  return extras;
}

/**
 * Parse the JSON string produced by buildPathExtras. Returns null on any error.
 * @param {string|null|undefined} json
 * @returns {Object|null}
 */
export function parsePathExtras(json) {
  if (!json || typeof json !== "string") return null;
  try {
    const e = JSON.parse(json);
    return e && typeof e === "object" ? e : null;
  } catch {
    return null;
  }
}

/**
 * Override fields on a path-data object with values from a parsed extras blob.
 * Mutates pathData in place.
 * @param {Object} pathData - in-progress rontoJSON path entry
 * @param {Object|null} extras - output of parsePathExtras
 */
export function applyPathExtras(pathData, extras) {
  if (!extras) return;
  if (Array.isArray(extras.coords) && extras.coords.length >= 2) {
    pathData.coords = extras.coords;
    if (extras.isCircuit) pathData.isCircuit = true; else delete pathData.isCircuit;
    if (extras.closingForced) pathData.closingForced = true; else delete pathData.closingForced;
  }
  if (Array.isArray(extras.snappedSegments) && extras.snappedSegments.length > 0) {
    pathData.snappedSegments = extras.snappedSegments;
  }
}

// --- Helpers ---

function isValidCoord(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Filter data according to export scope.
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {RontoFeatureCollection}
 */
export function scopeData(data, scope) {
  if (!scope || scope.type === "all") return data;
  const camera = data?.camera;
  if (scope.type === "marker" && scope.marker) {
    return { markers: [scope.marker], paths: [], ...(camera ? { camera } : {}) };
  }
  if (scope.type === "path" && scope.path) {
    return { markers: [], paths: [scope.path], ...(camera ? { camera } : {}) };
  }
  return data;
}

/**
 * Validate a camera object loosely. Accepts {center: [lng, lat], zoom, [bearing], [pitch]}.
 * @param {*} c
 * @returns {boolean}
 */
export function isValidCamera(c) {
  if (!c || typeof c !== "object") return false;
  const ctr = c.center;
  if (!Array.isArray(ctr) || ctr.length < 2) return false;
  const lng = +ctr[0], lat = +ctr[1];
  if (!isFinite(lng) || !isFinite(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (typeof c.zoom !== "number" || !isFinite(c.zoom)) return false;
  return true;
}

/**
 * Normalize a camera object into the canonical shape (numeric coords, optional bearing/pitch).
 * @param {Object} c
 * @returns {RontoCamera}
 */
export function normalizeCamera(c) {
  const out = {
    center: [+c.center[0], +c.center[1]],
    zoom: +c.zoom,
  };
  if (typeof c.bearing === "number" && isFinite(c.bearing)) out.bearing = c.bearing;
  if (typeof c.pitch === "number" && isFinite(c.pitch)) out.pitch = c.pitch;
  return out;
}
