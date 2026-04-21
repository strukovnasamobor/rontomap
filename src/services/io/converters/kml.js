/**
 * @typedef {import('../types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('../types').ExportScope} ExportScope
 */

import { scopeData } from "./rontoJson";

/**
 * Import: convert a KML string to RontoJSON.
 * @param {string} content
 * @returns {RontoFeatureCollection}
 */
export function toRonto(content) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(content, "application/xml");

  if (xmlDoc.querySelector("parsererror")) {
    throw new Error("Invalid KML file.");
  }

  const markers = [];
  const paths = [];
  const pendingSights = [];
  let mIdx = 1;
  let pIdx = 1;

  const placemarks = xmlDoc.querySelectorAll("Placemark");
  for (const pm of placemarks) {
    const nameEl = pm.querySelector("name");
    const name = nameEl?.textContent || "";
    const extType = parseExtData(pm, "type");

    // Check for sight Placemarks (Point with type=sight in ExtendedData)
    if (extType === "sight") {
      const point = pm.querySelector("Point");
      if (point) {
        const ptCoords = parseKmlCoordinates(point.querySelector("coordinates")?.textContent || "");
        if (ptCoords.length > 0) {
          pendingSights.push({
            pathId: parseExtData(pm, "pathId"),
            segmentIndex: parseFloat(parseExtData(pm, "segmentIndex")) || 0,
            t: parseFloat(parseExtData(pm, "t")) || 0.5,
            name,
            lng: ptCoords[0].long,
            lat: ptCoords[0].lat,
          });
        }
      }
      continue;
    }

    // Legacy: MultiGeometry (sight: Point + LineString together)
    const multiGeom = pm.querySelector("MultiGeometry");
    if (multiGeom) {
      const point = multiGeom.querySelector("Point");
      const lineString = multiGeom.querySelector("LineString");
      if (point && lineString) {
        const lineCoords = parseKmlCoordinates(lineString.querySelector("coordinates")?.textContent || "");
        if (lineCoords.length >= 2) {
          const pathData = {
            id: `p${pIdx++}`,
            coords: lineCoords,
          };
          if (isCircuitCoords(lineCoords)) {
            pathData.isCircuit = true;
            lineCoords.pop();
          }
          if (name) pathData.name = name;

          const ptCoords = parseKmlCoordinates(point.querySelector("coordinates")?.textContent || "");
          if (ptCoords.length > 0) {
            const sight = projectPointOnPath(lineCoords, ptCoords[0].long, ptCoords[0].lat);
            if (name) sight.name = name;
            pathData.sights = [sight];
          }
          paths.push(pathData);
          continue;
        }
      }
    }

    const point = pm.querySelector("Point");
    const lineString = pm.querySelector("LineString");

    if (point) {
      const coordText = point.querySelector("coordinates")?.textContent || "";
      const coords = parseKmlCoordinates(coordText);
      if (coords.length > 0) {
        const marker = {
          id: `m${mIdx++}`,
          name,
          pos: [coords[0].lat, coords[0].long],
        };
        markers.push(marker);
      }
    } else if (lineString) {
      const coordText = lineString.querySelector("coordinates")?.textContent || "";
      const coords = parseKmlCoordinates(coordText);
      if (coords.length >= 2) {
        const extId = parseExtData(pm, "pathId");
        const pathData = {
          id: extId || `p${pIdx++}`,
          coords,
        };
        if (isCircuitCoords(coords)) {
          pathData.isCircuit = true;
          coords.pop();
        }
        if (name) pathData.name = name;
        const snap = parseExtRoadSnap(pm);
        if (snap) pathData.roadSnap = snap;
        const kmlDist = parseFloat(parseExtData(pm, "routeDistance"));
        if (isFinite(kmlDist)) pathData.routeDistance = kmlDist;
        const kmlDur = parseFloat(parseExtData(pm, "routeDuration"));
        if (isFinite(kmlDur)) pathData.routeDuration = kmlDur;
        paths.push(pathData);
      }
    }

    // gx:Track support (GPS tracks from Google Earth)
    const gxTrack = pm.querySelector("Track") || pm.getElementsByTagNameNS("http://www.google.com/kml/ext/2.2", "Track")[0];
    if (gxTrack) {
      const coords = parseGxTrack(gxTrack);
      if (coords.length >= 2) {
        const pathData = {
          id: `p${pIdx++}`,
          coords,
        };
        if (isCircuitCoords(coords)) {
          pathData.isCircuit = true;
          coords.pop();
        }
        if (name) pathData.name = name;
        paths.push(pathData);
      }
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
      targetPath.sights.push(am);
    } else {
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
 * Export: convert RontoJSON to a KML string.
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {string}
 */
export function fromRonto(data, scope) {
  const scoped = scopeData(data, scope);
  const lines = [];

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<kml xmlns="http://www.opengis.net/kml/2.2">`);
  lines.push(`<Document>`);
  lines.push(`  <name>RontoMap Export</name>`);

  // Styles
  lines.push(`  <Style id="marker-style">`);
  lines.push(`    <IconStyle><color>ff006fff</color></IconStyle>`);
  lines.push(`  </Style>`);
  lines.push(`  <Style id="sight-style">`);
  lines.push(`    <IconStyle><color>ffff9100</color></IconStyle>`);
  lines.push(`  </Style>`);
  lines.push(`  <Style id="path-style">`);
  lines.push(`    <LineStyle><color>ff006fff</color><width>3</width></LineStyle>`);
  lines.push(`  </Style>`);
  lines.push(`  <Style id="route-style">`);
  lines.push(`    <LineStyle><color>ffff9100</color><width>3</width></LineStyle>`);
  lines.push(`  </Style>`);

  // Markers
  for (const m of scoped.markers || []) {
    lines.push(`  <Placemark>`);
    lines.push(`    <name>${escapeXml(m.name || "")}</name>`);
    lines.push(`    <styleUrl>#marker-style</styleUrl>`);
    lines.push(`    <Point>`);
    lines.push(`      <coordinates>${m.pos[1]},${m.pos[0]},0</coordinates>`);
    lines.push(`    </Point>`);
    lines.push(`  </Placemark>`);
  }

  // Paths
  for (const p of scoped.paths || []) {
    const coords = getExportCoords(p);
    const styleId = p.isRoute ? "route-style" : "path-style";

    // Export sights as separate Point Placemarks linked by pathId
    if (p.sights && p.sights.length > 0) {
      for (const s of p.sights) {
        const [lng, lat] = interpolateSightPosition(p, s);
        lines.push(`  <Placemark>`);
        lines.push(`    <name>${escapeXml(s.name || "Sight")}</name>`);
        lines.push(`    <styleUrl>#sight-style</styleUrl>`);
        lines.push(`    <ExtendedData>`);
        lines.push(`      <Data name="type"><value>sight</value></Data>`);
        lines.push(`      <Data name="pathId"><value>${escapeXml(p.id)}</value></Data>`);
        lines.push(`      <Data name="segmentIndex"><value>${s.segmentIndex}</value></Data>`);
        lines.push(`      <Data name="t"><value>${s.t}</value></Data>`);
        lines.push(`    </ExtendedData>`);
        lines.push(`    <Point>`);
        lines.push(`      <coordinates>${lng},${lat},0</coordinates>`);
        lines.push(`    </Point>`);
        lines.push(`  </Placemark>`);
      }
    }

    // Main path placemark
    lines.push(`  <Placemark>`);
    lines.push(`    <name>${escapeXml(p.name || "")}</name>`);
    lines.push(`    <styleUrl>#${styleId}</styleUrl>`);
    const extData = [];
    if (p.sights && p.sights.length > 0) extData.push(`      <Data name="pathId"><value>${escapeXml(p.id)}</value></Data>`);
    if (p.roadSnap) extData.push(`      <Data name="roadSnap"><value>${escapeXml(typeof p.roadSnap === "string" ? p.roadSnap : "car")}</value></Data>`);
    if (p.routeDistance != null) extData.push(`      <Data name="routeDistance"><value>${p.routeDistance}</value></Data>`);
    if (p.routeDuration != null) extData.push(`      <Data name="routeDuration"><value>${p.routeDuration}</value></Data>`);
    if (extData.length > 0) {
      lines.push(`    <ExtendedData>`);
      lines.push(...extData);
      lines.push(`    </ExtendedData>`);
    }
    lines.push(`    <LineString>`);
    lines.push(`      <coordinates>`);
    lines.push(`        ${coords.map(([lng, lat]) => `${lng},${lat},0`).join(" ")}`);
    lines.push(`      </coordinates>`);
    lines.push(`    </LineString>`);
    lines.push(`  </Placemark>`);
  }

  lines.push(`</Document>`);
  lines.push(`</kml>`);
  return lines.join("\n");
}

// --- Helpers ---

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseExtData(placemarkEl, name) {
  const dataEls = placemarkEl.querySelectorAll("ExtendedData > Data");
  for (const d of dataEls) {
    if (d.getAttribute("name") === name) {
      return d.querySelector("value")?.textContent?.trim() || null;
    }
  }
  return null;
}

function parseExtRoadSnap(placemarkEl) {
  const val = parseExtData(placemarkEl, "roadSnap");
  if (val === "car" || val === "bike" || val === "foot") return val;
  return null;
}

/**
 * Parse KML coordinate string "lng,lat,alt lng,lat,alt ..." into RontoCoord[].
 */
function parseKmlCoordinates(text) {
  const coords = [];
  const parts = text.trim().split(/\s+/);
  for (const part of parts) {
    const [lngStr, latStr] = part.split(",");
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    if (isFinite(lng) && isFinite(lat)) {
      coords.push({ long: lng, lat });
    }
  }
  return coords;
}

/**
 * Parse a gx:Track element into RontoCoord[].
 */
function parseGxTrack(trackEl) {
  const coords = [];
  // gx:coord elements contain "lng lat alt"
  const coordEls = trackEl.getElementsByTagNameNS("http://www.google.com/kml/ext/2.2", "coord");
  for (const el of coordEls) {
    const parts = el.textContent.trim().split(/\s+/);
    const lng = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    if (isFinite(lng) && isFinite(lat)) {
      coords.push({ long: lng, lat });
    }
  }
  return coords;
}

/**
 * Project a point onto the nearest segment of a path and return a sight object.
 */
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
  const THRESHOLD = 0.00001;
  return Math.abs(first.long - last.long) < THRESHOLD && Math.abs(first.lat - last.lat) < THRESHOLD;
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
