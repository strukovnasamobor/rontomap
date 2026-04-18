const MAPBOX_USERNAME = "aurelius-zd";

// Sources we deliberately don't enumerate for offline:
// - indoor-v3: sparse tileset (404 at high zoom for most areas) and RontoMap
//   doesn't render indoor POIs. User explicit skip.
// - mapbox-terrain-dem-v1: requires a raster:read token scope our public
//   token doesn't have. Every URL 401s. Hillshading/terrain stays absent
//   offline — same as online behavior with this token.
// - mapbox-landmark-pois-v1: our public token can't fetch this tileset at
//   download time (verified: enumeration fails). Mapbox GL JS still tries
//   it at runtime, so offline we return 504 for those specific POIs; the
//   main street/POI labels come from mapbox-streets-v8 and render fine.
// - mapbox-landmark-icons-v1: raster-array (.mrt) tileset, same token-scope
//   issue as terrain-dem-v1. Every URL 404s.
// - mapbox-3d-events: 3D Tiles (.glb) for temporary events / construction;
//   RontoMap doesn't render 3D models offline. Skip to avoid download failures.
const SKIP_SOURCE_URL_PATTERNS = [
  /mapbox\.indoor-v3/,
  /mapbox\.mapbox-terrain-dem-v1/,
  /mapbox\.mapbox-landmark-pois-v1/,
  /mapbox\.mapbox-landmark-icons-v1/,
  /mapbox\.mapbox-3d-events/,
  /mapbox\.procedural-buildings-v1/,
  /mapbox\.satellite(?![\w-])/,
];

function shouldSkipSource(source) {
  const url = typeof source?.url === "string" ? source.url : "";
  const tiles = Array.isArray(source?.tiles) ? source.tiles.join(" ") : "";
  const probe = `${url} ${tiles}`;
  return SKIP_SOURCE_URL_PATTERNS.some((re) => re.test(probe));
}

export function lng2tile(lng, z) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

export function lat2tile(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}

export function tileCountForBounds(bounds, z) {
  const { north, south, east, west } = bounds;
  const xMin = lng2tile(west, z);
  const xMax = lng2tile(east, z);
  const yMin = lat2tile(north, z);
  const yMax = lat2tile(south, z);
  return Math.max(0, xMax - xMin + 1) * Math.max(0, yMax - yMin + 1);
}

export function estimateTileCount(bounds, minZoom, maxZoom, styleCount = 1) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    total += tileCountForBounds(bounds, z);
  }
  return total * Math.max(1, styleCount);
}

function appendToken(url, token) {
  if (!token || url.includes("access_token=")) return url;
  return url + (url.includes("?") ? "&" : "?") + "access_token=" + token;
}

function resolveMapboxUrl(url, token) {
  if (!url) return null;
  if (url.startsWith("mapbox://")) {
    const rest = url.slice("mapbox://".length);
    if (rest.startsWith("sprites/")) {
      return appendToken(`https://api.mapbox.com/styles/v1/${rest.slice("sprites/".length)}/sprite`, token);
    }
    if (rest.startsWith("fonts/")) {
      return appendToken(`https://api.mapbox.com/fonts/v1/${rest.slice("fonts/".length)}`, token);
    }
    return appendToken(`https://api.mapbox.com/v4/${rest}.json?secure`, token);
  }
  return appendToken(url, token);
}

function mapboxStyleUrlToApi(styleUrl, token) {
  if (styleUrl.startsWith("mapbox://styles/")) {
    const rest = styleUrl.slice("mapbox://styles/".length);
    return `https://api.mapbox.com/styles/v1/${rest}?access_token=${token}`;
  }
  return appendToken(styleUrl, token);
}

async function fetchStyle(styleId, token) {
  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_USERNAME}/${styleId}?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Style ${styleId} fetch failed: ${res.status}`);
  return res.json();
}

async function fetchStyleByUrl(styleUrl, token) {
  const url = mapboxStyleUrlToApi(styleUrl, token);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Style fetch failed: ${res.status} ${url}`);
  return res.json();
}

async function fetchTileJson(sourceUrl, token) {
  const resolved = resolveMapboxUrl(sourceUrl, token);
  const res = await fetch(resolved);
  if (!res.ok) throw new Error(`TileJSON fetch failed: ${res.status} ${resolved}`);
  return res.json();
}

function enumerateTileUrls(tileTemplate, bounds, minZoom, maxZoom, padTiles = 0) {
  const urls = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const maxTile = Math.pow(2, z) - 1;
    const xMin = Math.max(0, lng2tile(bounds.west, z) - padTiles);
    const xMax = Math.min(maxTile, lng2tile(bounds.east, z) + padTiles);
    const yMin = Math.max(0, lat2tile(bounds.north, z) - padTiles);
    const yMax = Math.min(maxTile, lat2tile(bounds.south, z) + padTiles);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        urls.push(
          tileTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y),
        );
      }
    }
  }
  return urls;
}

// Mapbox GL Style Spec expression operators. An array whose first element is
// in this set is an expression, not a font stack. Font names ("DIN Pro
// Regular", etc.) use spaces and mixed case, so they never collide.
const EXPRESSION_OPS = new Set([
  "literal", "array", "boolean", "collator", "format", "image", "number",
  "number-format", "object", "string", "to-boolean", "to-color", "to-number",
  "to-string", "typeof",
  "feature-state", "geometry-type", "id", "line-progress", "properties",
  "accumulated", "has", "get", "in", "index-of", "length", "slice", "at",
  "config", "global-state", "worldview", "measure-light",
  "raster-value", "raster-particle-speed",
  "!", "!=", "<", "<=", "==", ">", ">=", "all", "any", "case", "coalesce",
  "match", "within",
  "interpolate", "interpolate-hcl", "interpolate-lab", "step",
  "let", "var",
  "concat", "downcase", "is-supported-script", "resolved-locale", "upcase",
  "hsl", "hsla", "rgb", "rgba", "to-rgba",
  "-", "*", "/", "%", "^", "+", "abs", "acos", "asin", "atan", "ceil",
  "cos", "distance", "e", "floor", "ln", "ln2", "log10", "log2", "max",
  "min", "pi", "random", "round", "sin", "sqrt", "tan",
  "zoom", "heatmap-density", "sky-radial-progress", "pitch",
  "distance-from-center",
]);

function resolveConfigMap(style, configOverrides = {}) {
  const resolved = {};
  if (style.schema && typeof style.schema === "object") {
    for (const [k, spec] of Object.entries(style.schema)) {
      if (spec && typeof spec === "object" && "default" in spec) {
        resolved[k] = spec.default;
      }
    }
  }
  if (style.config && typeof style.config === "object") {
    Object.assign(resolved, style.config);
  }
  Object.assign(resolved, configOverrides);
  return resolved;
}

function collectFontStacks(style, configOverrides = {}) {
  const stacks = new Set();
  if (!style.layers) return stacks;
  const config = resolveConfigMap(style, configOverrides);

  const extract = (node) => {
    if (!Array.isArray(node) || node.length === 0) return;
    if (node[0] === "literal" && Array.isArray(node[1]) && node[1].every((v) => typeof v === "string")) {
      stacks.add(node[1].join(","));
      return;
    }
    if (node[0] === "config" && typeof node[1] === "string") {
      const val = config[node[1]];
      if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
        stacks.add(val.join(","));
      }
      return;
    }
    for (const child of node) extract(child);
  };

  for (const layer of style.layers) {
    const fonts = layer.layout?.["text-font"];
    if (!Array.isArray(fonts)) continue;
    const allStrings = fonts.every((v) => typeof v === "string");
    if (allStrings && !EXPRESSION_OPS.has(fonts[0])) {
      stacks.add(fonts.join(","));
    } else {
      extract(fonts);
    }
  }
  return stacks;
}

async function processStyle(style, styleLabel, bounds, minZoom, maxZoom, accessToken, ctx, depth = 0, padTiles = 0, configOverrides = {}) {
  if (depth > 4) {
    console.warn(`offlineTiles: import depth limit hit at ${styleLabel}`);
    return;
  }
  const { urls, counters } = ctx;

  if (style.sprite) {
    const base = resolveMapboxUrl(style.sprite, accessToken);
    const [pathPart, queryPart = ""] = base.split("?");
    const q = queryPart ? `?${queryPart}` : "";
    for (const suffix of ["", "@2x"]) {
      for (const ext of [".json", ".png"]) {
        urls.add(`${pathPart}${suffix}${ext}${q}`);
      }
    }
  }

  if (style.glyphs) {
    const stacks = collectFontStacks(style, configOverrides);
    for (const stack of stacks) {
      // Encode individual font names but keep literal "," between them.
      // Mapbox GL JS substitutes {fontstack} without encoding at runtime, so
      // the browser sends commas unencoded — matching that preserves cache
      // hits. URL-encoding the whole stack would produce "%2C" and miss.
      const fontstackPart = stack.split(",").map(encodeURIComponent).join(",");
      for (let r = 0; r < 2560; r += 256) {
        const rangeStr = `${r}-${r + 255}`;
        const fontUrl = style.glyphs
          .replace("{fontstack}", fontstackPart)
          .replace("{range}", rangeStr);
        urls.add(resolveMapboxUrl(fontUrl, accessToken));
      }
    }
  }

  if (style.sources) {
    await Promise.all(
      Object.entries(style.sources).map(async ([sourceId, source]) => {
        if (shouldSkipSource(source)) {
          console.info(
            `offlineTiles:   source ${styleLabel}/${sourceId} (${source.type}) \u2192 SKIPPED by skip list`,
          );
          return;
        }
        let tileTemplates = null;
        const sourceType = source.type;
        let srcMinzoom = source.minzoom;
        let srcMaxzoom = source.maxzoom;

        if (Array.isArray(source.tiles)) {
          tileTemplates = source.tiles.map((t) => appendToken(t, accessToken));
        } else if (typeof source.url === "string") {
          try {
            urls.add(resolveMapboxUrl(source.url, accessToken));
            const tileJson = await fetchTileJson(source.url, accessToken);
            if (Array.isArray(tileJson.tiles)) {
              tileTemplates = tileJson.tiles.map((t) => appendToken(t, accessToken));
            }
            if (srcMinzoom == null && tileJson.minzoom != null) srcMinzoom = tileJson.minzoom;
            if (srcMaxzoom == null && tileJson.maxzoom != null) srcMaxzoom = tileJson.maxzoom;
          } catch (err) {
            console.warn(
              `offlineTiles: TileJSON fetch failed for source (style=${styleLabel}, id=${sourceId}, type=${source.type}, url=${source.url})`,
              err,
            );
          }
        }

        if (!tileTemplates) {
          console.info(
            `offlineTiles:   source ${styleLabel}/${sourceId} (${sourceType}) \u2192 no tile templates`,
          );
          return;
        }

        const clampedMin = Math.max(minZoom, srcMinzoom ?? 0);
        const clampedMax = Math.min(maxZoom, srcMaxzoom ?? maxZoom);

        let sourceTileCount = 0;
        let sampleTile = null;
        for (const template of tileTemplates) {
          const tiles = enumerateTileUrls(template, bounds, clampedMin, clampedMax, padTiles);
          if (!sampleTile && tiles.length) sampleTile = tiles[0];
          sourceTileCount += tiles.length;
          for (const t of tiles) {
            if (!urls.has(t)) {
              urls.add(t);
              counters.tileCount++;
            }
          }
        }

        console.info(
          `offlineTiles:   source ${styleLabel}/${sourceId} (${sourceType}) \u2192 z${clampedMin}-${clampedMax} (style req ${minZoom}-${maxZoom}, src ${srcMinzoom ?? "?"}-${srcMaxzoom ?? "?"}) tiles=${sourceTileCount}`,
        );
        for (const tpl of tileTemplates) {
          console.info(`offlineTiles:     template: ${tpl}`);
        }
        if (sampleTile) {
          console.info(`offlineTiles:     sample:   ${sampleTile}`);
        }
      }),
    );
  }

  if (Array.isArray(style.imports)) {
    await Promise.all(
      style.imports.map(async (imp) => {
        if (!imp || !imp.url) return;
        const apiUrl = mapboxStyleUrlToApi(imp.url, accessToken);
        urls.add(apiUrl);
        try {
          const importedStyle = await fetchStyleByUrl(imp.url, accessToken);
          await processStyle(
            importedStyle,
            `${styleLabel}>import:${imp.id || imp.url}`,
            bounds,
            minZoom,
            maxZoom,
            accessToken,
            ctx,
            depth + 1,
            padTiles,
            imp.config || {},
          );
        } catch (err) {
          console.warn(
            `offlineTiles: imported style fetch failed (style=${styleLabel}, import=${imp.url})`,
            err,
          );
        }
      }),
    );
  }
}

// Self-calibrating multiplier for estimateOfflineDownload. The fast estimator
// counts tile positions once across the union zoom range, but a real download
// fetches one URL per (style, source) — typically 4-5× more URLs than
// positions. We learn the true ratio from the last calculateTileUrls result
// and persist it so future estimates converge on the observed value.
const CALIBRATION_KEY = "rontomap:offlineEstimateMultiplier";
const BYTES_CALIBRATION_KEY = "rontomap:offlineBytesPerTile";
const DEFAULT_MULTIPLIER = 5;
const DEFAULT_BYTES_PER_TILE = 20 * 1024;

function positionCountForRange(bounds, minZoom, maxZoom) {
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    count += tileCountForBounds(bounds, z);
  }
  return count;
}

// Calibration is keyed by zoom range. Different OFFLINE_MAX_ZOOM configs
// have different urls-per-position ratios and different bytes-per-tile (e.g.
// z=0-18 includes many small high-zoom tiles, z=0-16 drops them and raises
// the average), so a single global ratio would overshoot or undershoot when
// the config changes. Keying by "<minZ>-<maxZ>" isolates each config.
function zoomKey(styleConfigs) {
  const minZoom = Math.min(...styleConfigs.map((c) => c.minZoom));
  const maxZoom = Math.max(...styleConfigs.map((c) => c.maxZoom));
  return `${minZoom}-${maxZoom}`;
}

function getCalibration(zk) {
  try {
    const raw = localStorage.getItem(`${CALIBRATION_KEY}:${zk}`);
    const v = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_MULTIPLIER;
  } catch {
    return DEFAULT_MULTIPLIER;
  }
}

function setCalibration(zk, multiplier) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return;
  try {
    localStorage.setItem(`${CALIBRATION_KEY}:${zk}`, String(multiplier));
  } catch {}
}

function getBytesPerTile(zk) {
  try {
    const raw = localStorage.getItem(`${BYTES_CALIBRATION_KEY}:${zk}`);
    const v = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_BYTES_PER_TILE;
  } catch {
    return DEFAULT_BYTES_PER_TILE;
  }
}

export function recordActualDownload(tileCount, sizeBytes, styleConfigs) {
  if (!Number.isFinite(tileCount) || tileCount <= 0) return;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return;
  if (!Array.isArray(styleConfigs) || !styleConfigs.length) return;
  const bytesPerTile = sizeBytes / tileCount;
  const zk = zoomKey(styleConfigs);
  try {
    localStorage.setItem(`${BYTES_CALIBRATION_KEY}:${zk}`, String(bytesPerTile));
    console.info(
      `offlineTiles: size calibration updated [${zk}] \u2192 bytes/tile = ${bytesPerTile.toFixed(0)} (tiles=${tileCount}, bytes=${sizeBytes})`,
    );
  } catch {}
}

export async function calculateTileUrls(bounds, styleConfigs, accessToken, padTiles = 0) {
  const urls = new Set();
  const counters = { tileCount: 0 };
  const ctx = { urls, counters };

  await Promise.all(
    styleConfigs.map(async (cfg) => {
      const { styleId, minZoom, maxZoom } = cfg;
      urls.add(`https://api.mapbox.com/styles/v1/${MAPBOX_USERNAME}/${styleId}?access_token=${accessToken}`);

      let style;
      try {
        style = await fetchStyle(styleId, accessToken);
      } catch (err) {
        console.warn(`offlineTiles: style ${styleId} fetch failed`, err);
        return;
      }

      await processStyle(style, styleId, bounds, minZoom, maxZoom, accessToken, ctx, 0, padTiles);

      console.info(
        `offlineTiles: style ${styleId} \u2192 urls so far: ${urls.size} (unique tiles: ${counters.tileCount})`,
      );
    }),
  );

  if (styleConfigs.length && counters.tileCount > 0) {
    const minZoom = Math.min(...styleConfigs.map((c) => c.minZoom));
    const maxZoom = Math.max(...styleConfigs.map((c) => c.maxZoom));
    const positions = positionCountForRange(bounds, minZoom, maxZoom);
    if (positions > 0) {
      const zk = zoomKey(styleConfigs);
      const ratio = counters.tileCount / positions;
      setCalibration(zk, ratio);
      console.info(
        `offlineTiles: calibration updated [${zk}] \u2192 urls/position = ${ratio.toFixed(2)} (tiles=${counters.tileCount}, positions=${positions})`,
      );
    }
  }

  const zk = styleConfigs.length ? zoomKey(styleConfigs) : "";
  const estimatedSize = counters.tileCount * getBytesPerTile(zk);
  return {
    urls: Array.from(urls),
    tileCount: counters.tileCount,
    estimatedSize,
  };
}

export function estimateOfflineDownload(bounds, styleConfigs) {
  if (!styleConfigs.length) return { tileCount: 0, estimatedBytes: 0 };
  const minZoom = Math.min(...styleConfigs.map((c) => c.minZoom));
  const maxZoom = Math.max(...styleConfigs.map((c) => c.maxZoom));
  const positions = positionCountForRange(bounds, minZoom, maxZoom);
  const zk = zoomKey(styleConfigs);
  const tileCount = Math.round(positions * getCalibration(zk));
  return {
    tileCount,
    estimatedBytes: tileCount * getBytesPerTile(zk),
  };
}
