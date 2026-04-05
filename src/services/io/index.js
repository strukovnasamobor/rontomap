/**
 * @typedef {import('./types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('./types').FormatId} FormatId
 * @typedef {import('./types').ExportScope} ExportScope
 */

import { detectFormat } from "./detect";
import { pickFile, saveFile } from "./filePicker";
import { toRonto as rontoToRonto, fromRonto as rontoFromRonto, scopeData } from "./converters/rontoJson";
import { toRonto as geoJsonToRonto, fromRonto as geoJsonFromRonto } from "./converters/geoJson";
import { toRonto as gpxToRonto, fromRonto as gpxFromRonto } from "./converters/gpx";
import { toRonto as kmlToRonto, fromRonto as kmlFromRonto } from "./converters/kml";

// Re-export for Map.jsx integration
export { collectFeatures, collectMarker, collectPath, materializeFeatures } from "./converters/rontoJson";

const importers = {
  rontoJson: rontoToRonto,
  geoJson: geoJsonToRonto,
  gpx: gpxToRonto,
  kml: kmlToRonto,
  fit: null, // lazy-loaded
};

const exporters = {
  rontoJson: rontoFromRonto,
  geoJson: geoJsonFromRonto,
  gpx: gpxFromRonto,
  kml: kmlFromRonto,
};

const MIME_TYPES = {
  rontoJson: "application/octet-stream",
  geoJson: "application/geo+json",
  gpx: "application/gpx+xml",
  kml: "application/vnd.google-earth.kml+xml",
  fit: "application/vnd.ant.fit",
};

const EXTENSIONS = {
  rontoJson: ".rontojson",
  geoJson: ".geojson",
  gpx: ".gpx",
  kml: ".kml",
  fit: ".fit",
};

/**
 * Open file picker, detect format, and convert to RontoJSON.
 * @returns {Promise<{data: RontoFeatureCollection, format: FormatId}>}
 */
export async function importFeatures() {
  const { name, content } = await pickFile();

  const format = detectFormat(name, content);
  if (!format) throw new Error("Unrecognized file format. Supported: JSON, GeoJSON, GPX, KML, FIT.");

  let data;
  if (format === "fit") {
    const { toRonto: fitToRonto } = await import("./converters/fit");
    data = await fitToRonto(content);
  } else {
    const importer = importers[format];
    if (!importer) throw new Error(`Import not supported for format: ${format}`);
    data = importer(content, name);
  }

  if ((!data.markers || data.markers.length === 0) && (!data.paths || data.paths.length === 0)) {
    throw new Error("No features found in the file.");
  }

  return { data, format };
}

/**
 * Import from raw content (used when the app is opened with a file).
 * @param {string} name - file name
 * @param {string|ArrayBuffer} content - file content
 * @returns {Promise<{data: RontoFeatureCollection, format: FormatId}>}
 */
export async function importFromContent(name, content) {
  const format = detectFormat(name, content);
  if (!format) throw new Error("Unrecognized file format. Supported: JSON, GeoJSON, GPX, KML, FIT.");

  let data;
  if (format === "fit") {
    const { toRonto: fitToRonto } = await import("./converters/fit");
    data = await fitToRonto(content);
  } else {
    const importer = importers[format];
    if (!importer) throw new Error(`Import not supported for format: ${format}`);
    data = importer(content, name);
  }

  if ((!data.markers || data.markers.length === 0) && (!data.paths || data.paths.length === 0)) {
    throw new Error("No features found in the file.");
  }

  return { data, format };
}

/**
 * Convert features to the chosen format and trigger a file download.
 * @param {RontoFeatureCollection} data
 * @param {FormatId} format
 * @param {ExportScope} scope
 * @param {string} [baseName="rontomap"] - base filename without extension
 */
export async function exportFeatures(data, format, scope, baseName = "rontomap") {
  const scoped = scopeData(data, scope);

  if ((!scoped.markers || scoped.markers.length === 0) && (!scoped.paths || scoped.paths.length === 0)) {
    throw new Error("No features to export.");
  }

  if (format === "fit") {
    const { fromRonto: fitFromRonto } = await import("./converters/fit");
    const blob = fitFromRonto(scoped, scope);
    const fileName = `${baseName}${EXTENSIONS[format]}`;
    return await saveFile(fileName, blob, MIME_TYPES[format]);
  }

  const exporter = exporters[format];
  if (!exporter) throw new Error(`Export not supported for format: ${format}`);

  const content = exporter(scoped, scope);
  const fileName = `${baseName}${EXTENSIONS[format]}`;
  const mimeType = MIME_TYPES[format];

  return await saveFile(fileName, content, mimeType);
}
