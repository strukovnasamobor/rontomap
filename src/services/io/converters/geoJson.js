/**
 * @typedef {import('../types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('../types').ExportScope} ExportScope
 */

import { scopeData } from "./rontoJson";

/**
 * Import: convert a GeoJSON string to RontoJSON.
 * @param {string} content
 * @returns {RontoFeatureCollection}
 */
export function toRonto(content) {
  const geo = JSON.parse(content);
  const features = geo.type === "FeatureCollection" ? geo.features || [] : geo.type === "Feature" ? [geo] : [];

  const markers = [];
  const paths = [];
  // Track sights to link after paths are processed
  const pendingSights = [];
  let mIdx = 1;
  let pIdx = 1;

  for (const f of features) {
    if (!f.geometry) continue;
    const props = f.properties || {};
    const geomType = f.geometry.type;

    if (geomType === "Point") {
      const [lng, lat] = f.geometry.coordinates;
      // Check if this is a sight (attached to a path)
      if (props.type === "sight" && props.pathId) {
        pendingSights.push({
          pathId: props.pathId,
          segmentIndex: props.segmentIndex ?? 0,
          t: props.t ?? 0.5,
          name: props.name || "",
          savedView: props.savedView,
          lng,
          lat,
        });
        continue;
      }
      const marker = {
        id: `m${mIdx++}`,
        name: props.name || props.title || "",
        pos: [lat, lng],
      };
      if (props.savedView) marker.savedView = props.savedView;
      markers.push(marker);
    } else if (geomType === "LineString") {
      const coords = f.geometry.coordinates.map(([lng, lat]) => ({ long: lng, lat }));
      if (coords.length < 2) continue;
      const pathData = {
        id: props.id || `p${pIdx++}`,
        coords,
      };
      if (props.name || props.title) {
        pathData.name = props.name || props.title;
      }
      if (props.isCircuit) {
        pathData.isCircuit = true;
      } else if (isCircuitCoords(coords)) {
        pathData.isCircuit = true;
        coords.pop();
      }
      if (props.isRoute) pathData.isRoute = true;
      if (props.roadSnap) pathData.roadSnap = props.roadSnap;
      if (props.routeDistance != null) pathData.routeDistance = props.routeDistance;
      if (props.routeDuration != null) pathData.routeDuration = props.routeDuration;
      if (props.savedView) pathData.savedView = props.savedView;
      paths.push(pathData);
    }
    // Skip Polygon, MultiPoint, etc.
  }

  // Link sights to their paths
  for (const sight of pendingSights) {
    const targetPath = paths.find((p) => p.id === sight.pathId);
    if (targetPath) {
      if (!targetPath.sights) targetPath.sights = [];
      const am = { segmentIndex: sight.segmentIndex, t: sight.t };
      if (sight.name) am.name = sight.name;
      if (sight.savedView) am.savedView = sight.savedView;
      targetPath.sights.push(am);
    } else {
      // No matching path — import as a standalone marker
      markers.push({
        id: `m${mIdx++}`,
        name: sight.name || "",
        pos: [sight.lat, sight.lng],
      });
    }
  }

  return { markers, paths };
}

/**
 * Export: convert RontoJSON to a GeoJSON string.
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {string}
 */
export function fromRonto(data, scope) {
  const scoped = scopeData(data, scope);
  const features = [];

  for (const m of scoped.markers || []) {
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [m.pos[1], m.pos[0]], // [lng, lat]
      },
      properties: {
        name: m.name || "",
        type: "marker",
        ...(m.savedView ? { savedView: m.savedView } : {}),
      },
    });
  }

  for (const p of scoped.paths || []) {
    // For road-snapped paths, export the snapped geometry if available
    const coords = getExportCoords(p);
    const props = {
      name: p.name || "",
      type: p.isRoute ? "route" : "path",
      id: p.id,
    };
    if (p.isCircuit) props.isCircuit = true;
    if (p.isRoute) props.isRoute = true;
    if (p.roadSnap) props.roadSnap = p.roadSnap;
    if (p.routeDistance != null) props.routeDistance = p.routeDistance;
    if (p.routeDuration != null) props.routeDuration = p.routeDuration;
    if (p.savedView) props.savedView = p.savedView;

    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coords,
      },
      properties: props,
    });

    // Export sights as separate Point features linked by pathId
    if (p.sights) {
      for (const s of p.sights) {
        const sightPos = interpolateSightPosition(p, s);
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: sightPos,
          },
          properties: {
            name: s.name || "",
            type: "sight",
            pathId: p.id,
            segmentIndex: s.segmentIndex,
            t: s.t,
            ...(s.savedView ? { savedView: s.savedView } : {}),
          },
        });
      }
    }
  }

  const geojson = {
    type: "FeatureCollection",
    features,
  };
  return JSON.stringify(geojson, null, 2);
}

// --- Helpers ---

/**
 * Get export coordinates for a path.
 * If the path has snappedSegments, concatenate them for the full rendered line.
 * Otherwise, use the vertex coordinates.
 * @param {Object} path
 * @returns {[number, number][]} Array of [lng, lat]
 */
function isCircuitCoords(coords) {
  if (coords.length < 3) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const THRESHOLD = 0.00001;
  return Math.abs(first.long - last.long) < THRESHOLD && Math.abs(first.lat - last.lat) < THRESHOLD;
}

function getExportCoords(path) {
  if (path.snappedSegments && path.snappedSegments.length > 0) {
    const coords = [];
    for (const seg of path.snappedSegments) {
      for (const c of seg.coords) {
        // snappedSegments coords are {lng, lat} in Firestore format
        coords.push([c.lng, c.lat]);
      }
    }
    return coords.length >= 2 ? coords : path.coords.map((c) => [c.long, c.lat]);
  }
  return path.coords.map((c) => [c.long, c.lat]);
}

/**
 * Interpolate a sight's geographic position from its path and parametric location.
 * @param {Object} path
 * @param {Object} sight - {segmentIndex, t}
 * @returns {[number, number]} [lng, lat]
 */
function interpolateSightPosition(path, sight) {
  const coords = path.coords;
  const maxSeg = path.isCircuit ? coords.length - 1 : coords.length - 2;
  const i = Math.min(sight.segmentIndex, maxSeg);
  if (i < 0 || coords.length < 2) return [coords[0]?.long || 0, coords[0]?.lat || 0];

  const c1 = coords[i];
  const c2 = coords[(i + 1) % coords.length];
  const t = sight.t;
  const lng = c1.long + (c2.long - c1.long) * t;
  const lat = c1.lat + (c2.lat - c1.lat) * t;
  return [lng, lat];
}
