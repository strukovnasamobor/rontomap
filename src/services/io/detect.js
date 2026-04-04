/** @typedef {import('./types').FormatId} FormatId */

const EXTENSION_MAP = {
  ".geojson": "geoJson",
  ".gpx": "gpx",
  ".kml": "kml",
  ".fit": "fit",
};

/**
 * Detect the format of a file from its name and content.
 * @param {string} fileName
 * @param {string|ArrayBuffer} content
 * @returns {FormatId|null}
 */
export function detectFormat(fileName, content) {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();

  // Known non-JSON extensions
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  // Binary FIT detection (regardless of extension)
  if (content instanceof ArrayBuffer) {
    const bytes = new Uint8Array(content);
    // FIT files: byte 4 is the ASCII for '.' (0x2E), bytes 8-11 are ".FIT"
    if (bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54) {
      return "fit";
    }
    return null;
  }

  const text = typeof content === "string" ? content.trim() : "";

  // JSON-based formats
  if (ext === ".json" || ext === ".geojson") {
    try {
      const obj = JSON.parse(text);
      if (obj && (Array.isArray(obj.markers) || Array.isArray(obj.paths))) return "rontoJson";
      if (obj && (obj.type === "FeatureCollection" || obj.type === "Feature")) return "geoJson";
    } catch {
      // Not valid JSON — fall through to XML sniffing
    }
  }

  // XML-based formats
  if (text.startsWith("<?xml") || text.startsWith("<gpx") || text.startsWith("<kml")) {
    if (text.includes("<gpx") || text.includes("xmlns=\"http://www.topografix.com/GPX")) return "gpx";
    if (text.includes("<kml") || text.includes("xmlns=\"http://www.opengis.net/kml")) return "kml";
  }

  // Last resort: try JSON parsing for extensionless files
  if (ext !== ".json") {
    try {
      const obj = JSON.parse(text);
      if (obj && (Array.isArray(obj.markers) || Array.isArray(obj.paths))) return "rontoJson";
      if (obj && (obj.type === "FeatureCollection" || obj.type === "Feature")) return "geoJson";
    } catch {
      // Not JSON
    }
  }

  return null;
}
