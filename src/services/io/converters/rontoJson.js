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
export function collectFeatures(markersRef, pathsRef, serializeSnappedSegments) {
  const freeMarkers = markersRef.current.filter((m) => !m._sightPath);
  const markers = freeMarkers.map((m, i) => {
    const ll = m.getLngLat();
    const markerData = {
      id: `m${i + 1}`,
      name: m._markerName || "",
      pos: [ll.lat, ll.lng],
    };
    if (m._savedView) markerData.savedView = m._savedView;
    return markerData;
  });

  const paths = pathsRef.current.map((p, i) => {
    const pathData = {
      id: `p${i + 1}`,
      coords: p.vertices.map((v) => ({ long: v.lngLat[0], lat: v.lngLat[1], ...(v.force ? { force: true } : {}) })),
    };
    if (p.name) pathData.name = p.name;
    if (p.savedView) pathData.savedView = p.savedView;
    if (p.roadSnap) pathData.roadSnap = p.roadSnap;
    if (p.snappedSegments) pathData.snappedSegments = serializeSnappedSegments(p.snappedSegments);
    if (p.isCircuit) pathData.isCircuit = true;
    if (p.closingForced) pathData.closingForced = true;
    if (p.isRoute) pathData.isRoute = true;
    if (p.isTrack) pathData.isTrack = true;
    if (p.sights && p.sights.length > 0) {
      pathData.sights = p.sights.map((m) => {
        const am = { segmentIndex: m._segmentIndex, t: m._t };
        if (m._markerName) am.name = m._markerName;
        if (m._savedView) am.savedView = m._savedView;
        return am;
      });
    }
    return pathData;
  });

  return { markers, paths };
}

/**
 * Collect a single marker into a RontoJSON structure.
 * @param {Object} marker - Mapbox GL marker instance
 * @returns {RontoFeatureCollection}
 */
export function collectMarker(marker) {
  const ll = marker.getLngLat();
  const markerData = {
    id: "m1",
    name: marker._markerName || "",
    pos: [ll.lat, ll.lng],
  };
  if (marker._savedView) markerData.savedView = marker._savedView;
  return { markers: [markerData], paths: [] };
}

/**
 * Collect a single path (with its sights) into a RontoJSON structure.
 * @param {Object} path - Path object from pathsRef
 * @param {Function} serializeSnappedSegments
 * @returns {RontoFeatureCollection}
 */
export function collectPath(path, serializeSnappedSegments) {
  const pathData = {
    id: "p1",
    coords: path.vertices.map((v) => ({ long: v.lngLat[0], lat: v.lngLat[1], ...(v.force ? { force: true } : {}) })),
  };
  if (path.name) pathData.name = path.name;
  if (path.savedView) pathData.savedView = path.savedView;
  if (path.roadSnap) pathData.roadSnap = path.roadSnap;
  if (path.snappedSegments) pathData.snappedSegments = serializeSnappedSegments(path.snappedSegments);
  if (path.isCircuit) pathData.isCircuit = true;
  if (path.closingForced) pathData.closingForced = true;
  if (path.isRoute) pathData.isRoute = true;
  if (path.isTrack) pathData.isTrack = true;
  if (path.sights && path.sights.length > 0) {
    pathData.sights = path.sights.map((m) => {
      const am = { segmentIndex: m._segmentIndex, t: m._t };
      if (m._markerName) am.name = m._markerName;
      if (m._savedView) am.savedView = m._savedView;
      return am;
    });
  }
  return { markers: [], paths: [pathData] };
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
    if (entry.savedView) m._savedView = entry.savedView;
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
  if (entry.savedView) path.savedView = entry.savedView;
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
      if (am.savedView) m._savedView = am.savedView;
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
  return {
    markers: Array.isArray(obj.markers) ? obj.markers : [],
    paths: Array.isArray(obj.paths) ? obj.paths : [],
  };
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
  if (scope.type === "marker" && scope.marker) return { markers: [scope.marker], paths: [] };
  if (scope.type === "path" && scope.path) return { markers: [], paths: [scope.path] };
  return data;
}
