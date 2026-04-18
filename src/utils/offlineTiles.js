const MAPBOX_USERNAME = "aurelius-zd";

// Sources we deliberately don't enumerate for offline:
// - indoor-v3: sparse tileset (404 at high zoom for most areas) and RontoMap
//   doesn't render indoor POIs. User explicit skip.
// - mapbox-terrain-dem-v1: requires a raster:read token scope our public
//   token doesn't have. Every URL 401s. Hillshading/terrain stays absent
//   offline — same as online behavior with this token.
const SKIP_SOURCE_URL_PATTERNS = [
  /mapbox\.indoor-v3/,
  /mapbox\.mapbox-terrain-dem-v1/,
  /mapbox\.mapbox-landmark-pois-v1/,
  /mapbox\.procedural-buildings-v1/,
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

function collectFontStacks(style) {
  const stacks = new Set();
  if (!style.layers) return stacks;
  for (const layer of style.layers) {
    const fonts = layer.layout?.["text-font"];
    if (!Array.isArray(fonts)) continue;
    const literal = fonts.filter((f) => typeof f === "string");
    if (literal.length) stacks.add(literal.join(","));
  }
  return stacks;
}

async function processStyle(style, styleLabel, bounds, minZoom, maxZoom, accessToken, ctx, depth = 0, padTiles = 0) {
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
    const stacks = collectFontStacks(style);
    for (const stack of stacks) {
      for (let r = 0; r < 2560; r += 256) {
        const rangeStr = `${r}-${r + 255}`;
        const fontUrl = style.glyphs
          .replace("{fontstack}", encodeURIComponent(stack))
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
          if (sourceType === "raster" || sourceType === "raster-dem") {
            counters.rasterTileCount += tiles.length;
          } else {
            counters.tileCount += tiles.length;
          }
          tiles.forEach((t) => urls.add(t));
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

export async function calculateTileUrls(bounds, styleConfigs, accessToken, padTiles = 0) {
  const urls = new Set();
  const counters = { tileCount: 0, rasterTileCount: 0 };
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
        `offlineTiles: style ${styleId} \u2192 urls so far: ${urls.size} (tile: ${counters.tileCount}, raster: ${counters.rasterTileCount})`,
      );
    }),
  );

  const estimatedSize = counters.tileCount * 30 * 1024 + counters.rasterTileCount * 80 * 1024;
  return {
    urls: Array.from(urls),
    tileCount: counters.tileCount + counters.rasterTileCount,
    estimatedSize,
  };
}

export function estimateOfflineDownload(bounds, styleConfigs, isRasterStyle) {
  let vectorTiles = 0;
  let rasterTiles = 0;
  for (const { styleId, minZoom, maxZoom } of styleConfigs) {
    let sum = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
      sum += tileCountForBounds(bounds, z);
    }
    if (isRasterStyle && isRasterStyle(styleId)) {
      rasterTiles += sum;
    } else {
      vectorTiles += sum;
    }
  }
  const estimatedBytes = vectorTiles * 60 * 1024 + rasterTiles * 80 * 1024;
  return {
    tileCount: vectorTiles + rasterTiles,
    estimatedBytes,
  };
}
