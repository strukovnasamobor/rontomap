/**
 * @typedef {import('../types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('../types').ExportScope} ExportScope
 */

import { scopeData } from "./rontoJson";

/**
 * Import: convert a GPX string to RontoJSON.
 * @param {string} content
 * @returns {RontoFeatureCollection}
 */
export function toRonto(content) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(content, "application/xml");

  if (xmlDoc.querySelector("parsererror")) {
    throw new Error("Invalid GPX file.");
  }

  const markers = [];
  const paths = [];
  let mIdx = 1;
  let pIdx = 1;

  // Waypoints → markers or pending sights
  const pendingSights = [];
  const wpts = xmlDoc.querySelectorAll("wpt");
  for (const wpt of wpts) {
    const lat = parseFloat(wpt.getAttribute("lat"));
    const lon = parseFloat(wpt.getAttribute("lon"));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const nameEl = wpt.querySelector("name");
    const typeEl = wpt.querySelector("type");
    const descEl = wpt.querySelector("desc");
    const name = nameEl?.textContent || "";
    const description = descEl?.textContent || "";

    // Check if this is a sight (has rontomap:sight extension or type=sight)
    const sightExt = parseExtSight(wpt);
    if (sightExt || typeEl?.textContent === "sight") {
      pendingSights.push({
        pathId: sightExt?.pathId,
        segmentIndex: sightExt?.segmentIndex ?? 0,
        t: sightExt?.t ?? 0.5,
        name,
        description,
        lng: lon,
        lat,
      });
      continue;
    }

    const marker = {
      id: `m${mIdx++}`,
      name,
      pos: [lat, lon],
    };
    if (description) marker.description = description;
    markers.push(marker);
  }

  // Routes → paths
  const rtes = xmlDoc.querySelectorAll("rte");
  for (const rte of rtes) {
    const rtepts = rte.querySelectorAll("rtept");
    const coords = [];
    for (const pt of rtepts) {
      const lat = parseFloat(pt.getAttribute("lat"));
      const lon = parseFloat(pt.getAttribute("lon"));
      if (isFinite(lat) && isFinite(lon)) {
        coords.push({ long: lon, lat });
      }
    }
    if (coords.length < 2) continue;
    const nameEl = rte.querySelector("name");
    const extId = parseExtValue(rte, "id");
    const pathData = {
      id: extId || `p${pIdx++}`,
      coords,
    };
    if (isCircuitCoords(coords)) {
      pathData.isCircuit = true;
      coords.pop();
    }
    if (nameEl?.textContent) pathData.name = nameEl.textContent;
    const descEl = rte.querySelector("desc");
    if (descEl?.textContent) pathData.description = descEl.textContent;
    const snap = parseExtRoadSnap(rte);
    if (snap) pathData.roadSnap = snap;
    const rteDist = parseFloat(parseExtValue(rte, "routeDistance"));
    if (isFinite(rteDist)) pathData.routeDistance = rteDist;
    const rteDur = parseFloat(parseExtValue(rte, "routeDuration"));
    if (isFinite(rteDur)) pathData.routeDuration = rteDur;
    paths.push(pathData);
  }

  // Tracks → paths
  const trks = xmlDoc.querySelectorAll("trk");
  for (const trk of trks) {
    const nameEl = trk.querySelector("name");
    const trksegs = trk.querySelectorAll("trkseg");
    for (const seg of trksegs) {
      const trkpts = seg.querySelectorAll("trkpt");
      const coords = [];
      for (const pt of trkpts) {
        const lat = parseFloat(pt.getAttribute("lat"));
        const lon = parseFloat(pt.getAttribute("lon"));
        if (isFinite(lat) && isFinite(lon)) {
          coords.push({ long: lon, lat });
        }
      }
      if (coords.length < 2) continue;
      const pathData = {
        id: `p${pIdx++}`,
        coords,
      };
      if (isCircuitCoords(coords)) {
        pathData.isCircuit = true;
        coords.pop();
      }
      if (nameEl?.textContent) pathData.name = nameEl.textContent;
      const trkDescEl = trk.querySelector("desc");
      if (trkDescEl?.textContent) pathData.description = trkDescEl.textContent;
      paths.push(pathData);
    }
  }

  // Link pending sights to paths
  for (const sight of pendingSights) {
    const targetPath = sight.pathId ? paths.find((p) => p.id === sight.pathId) : paths[0];
    if (targetPath) {
      if (!targetPath.sights) targetPath.sights = [];
      const am = sight.pathId
        ? { segmentIndex: sight.segmentIndex, t: sight.t }
        : projectPointOnPath(targetPath.coords, sight.lng, sight.lat);
      if (sight.name) am.name = sight.name;
      if (sight.description) am.description = sight.description;
      targetPath.sights.push(am);
    } else {
      // No matching path — import as standalone marker
      const fallback = {
        id: `m${mIdx++}`,
        name: sight.name || "",
        pos: [sight.lat, sight.lng],
      };
      if (sight.description) fallback.description = sight.description;
      markers.push(fallback);
    }
  }

  return { markers, paths };
}

/**
 * Export: convert RontoJSON to a GPX string.
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {string}
 */
export function fromRonto(data, scope) {
  const scoped = scopeData(data, scope);
  const lines = [];

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<gpx version="1.1" creator="RontoMap" xmlns="http://www.topografix.com/GPX/1/1" xmlns:rontomap="https://rontomap.com/gpx/1">`);

  // Markers as waypoints
  for (const m of scoped.markers || []) {
    lines.push(`  <wpt lat="${m.pos[0]}" lon="${m.pos[1]}">`);
    lines.push(`    <name>${escapeXml(m.name || "")}</name>`);
    if (m.description) lines.push(`    <desc>${escapeXml(m.description)}</desc>`);
    lines.push(`  </wpt>`);
  }

  for (const p of scoped.paths || []) {
    const coords = getExportCoords(p);

    // Export sights as waypoints linked to path
    if (p.sights) {
      for (const s of p.sights) {
        const [lng, lat] = interpolateSightPosition(p, s);
        lines.push(`  <wpt lat="${lat}" lon="${lng}">`);
        lines.push(`    <name>${escapeXml(s.name || `Sight on ${p.name || p.id}`)}</name>`);
        if (s.description) lines.push(`    <desc>${escapeXml(s.description)}</desc>`);
        lines.push(`    <type>sight</type>`);
        lines.push(`    <extensions>`);
        lines.push(`      <rontomap:sight pathId="${escapeXml(p.id)}" segmentIndex="${s.segmentIndex}" t="${s.t}"/>`);
        lines.push(`    </extensions>`);
        lines.push(`  </wpt>`);
      }
    }

    // All paths export as <rte>
    lines.push(`  <rte>`);
    if (p.name) lines.push(`    <name>${escapeXml(p.name)}</name>`);
    if (p.description) lines.push(`    <desc>${escapeXml(p.description)}</desc>`);
    const rteExtensions = [];
    if (p.sights && p.sights.length > 0) {
      rteExtensions.push(`      <rontomap:id>${escapeXml(p.id)}</rontomap:id>`);
    }
    if (p.roadSnap) {
      rteExtensions.push(`      <rontomap:roadSnap>${escapeXml(typeof p.roadSnap === "string" ? p.roadSnap : "car")}</rontomap:roadSnap>`);
    }
    if (p.routeDistance != null) {
      rteExtensions.push(`      <rontomap:routeDistance>${p.routeDistance}</rontomap:routeDistance>`);
    }
    if (p.routeDuration != null) {
      rteExtensions.push(`      <rontomap:routeDuration>${p.routeDuration}</rontomap:routeDuration>`);
    }
    if (rteExtensions.length > 0) {
      lines.push(`    <extensions>`);
      lines.push(...rteExtensions);
      lines.push(`    </extensions>`);
    }
    for (const [lng, lat] of coords) {
      lines.push(`    <rtept lat="${lat}" lon="${lng}"></rtept>`);
    }
    lines.push(`  </rte>`);
  }

  lines.push(`</gpx>`);
  return lines.join("\n");
}

// --- Helpers ---

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseExtSight(el) {
  const exts = el.querySelector("extensions");
  if (!exts) return null;
  for (const child of exts.children) {
    if (child.localName === "sight") {
      const pathId = child.getAttribute("pathId");
      const segmentIndex = parseFloat(child.getAttribute("segmentIndex"));
      const t = parseFloat(child.getAttribute("t"));
      if (!pathId) return null;
      return { pathId, segmentIndex: isFinite(segmentIndex) ? segmentIndex : 0, t: isFinite(t) ? t : 0.5 };
    }
  }
  return null;
}

function parseExtValue(el, name) {
  const exts = el.querySelector("extensions");
  if (!exts) return null;
  for (const child of exts.children) {
    if (child.localName === name) {
      return child.textContent?.trim() || null;
    }
  }
  return null;
}

function parseExtRoadSnap(el) {
  const exts = el.querySelector("extensions");
  if (!exts) return null;
  for (const child of exts.children) {
    if (child.localName === "roadSnap") {
      const val = child.textContent?.trim();
      if (val === "car" || val === "bike" || val === "foot") return val;
      return null;
    }
  }
  return null;
}

function getExportCoords(path) {
  let coords;
  if (path.snappedSegments && path.snappedSegments.length > 0) {
    const snapped = [];
    for (const seg of path.snappedSegments) {
      for (const c of seg.coords) {
        snapped.push([c.lng, c.lat]);
      }
    }
    coords = snapped.length >= 2 ? snapped : path.coords.map((c) => [c.long, c.lat]);
  } else {
    coords = path.coords.map((c) => [c.long, c.lat]);
  }
  if (path.isCircuit && coords.length >= 2) {
    coords = [...coords, coords[0]];
  }
  return coords;
}

function isCircuitCoords(coords) {
  if (coords.length < 3) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const THRESHOLD = 0.00001; // ~1 meter
  return Math.abs(first.long - last.long) < THRESHOLD && Math.abs(first.lat - last.lat) < THRESHOLD;
}

function projectPointOnPath(coords, lng, lat) {
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const c1 = coords[i];
    const c2 = coords[i + 1];
    const dx = c2.long - c1.long;
    const dy = c2.lat - c1.lat;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((lng - c1.long) * dx + (lat - c1.lat) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = c1.long + t * dx;
    const py = c1.lat + t * dy;
    const dist = (lng - px) ** 2 + (lat - py) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestSeg = i;
      bestT = t;
    }
  }
  return { segmentIndex: bestSeg, t: bestT };
}

function interpolateSightPosition(path, sight) {
  const coords = path.coords;
  const maxSeg = path.isCircuit ? coords.length - 1 : coords.length - 2;
  const i = Math.min(sight.segmentIndex, maxSeg);
  if (i < 0 || coords.length < 2) return [coords[0]?.long || 0, coords[0]?.lat || 0];
  const c1 = coords[i];
  const c2 = coords[(i + 1) % coords.length];
  const t = sight.t;
  return [c1.long + (c2.long - c1.long) * t, c1.lat + (c2.lat - c1.lat) * t];
}
