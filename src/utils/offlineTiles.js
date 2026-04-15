const MAPBOX_USERNAME = "aurelius-zd";

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

async function fetchStyle(styleId, token) {
  const url = `https://api.mapbox.com/styles/v1/${MAPBOX_USERNAME}/${styleId}?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Style ${styleId} fetch failed: ${res.status}`);
  return res.json();
}

async function fetchTileJson(sourceUrl, token) {
  const resolved = resolveMapboxUrl(sourceUrl, token);
  const res = await fetch(resolved);
  if (!res.ok) throw new Error(`TileJSON fetch failed: ${res.status} ${resolved}`);
  return res.json();
}

function enumerateTileUrls(tileTemplate, bounds, minZoom, maxZoom) {
  const urls = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lng2tile(bounds.west, z);
    const xMax = lng2tile(bounds.east, z);
    const yMin = lat2tile(bounds.north, z);
    const yMax = lat2tile(bounds.south, z);
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

export async function calculateTileUrls(bounds, minZoom, maxZoom, styleIds, accessToken) {
  const urls = new Set();
  let tileCount = 0;
  let rasterTileCount = 0;

  for (const styleId of styleIds) {
    urls.add(`https://api.mapbox.com/styles/v1/${MAPBOX_USERNAME}/${styleId}?access_token=${accessToken}`);

    let style;
    try {
      style = await fetchStyle(styleId, accessToken);
    } catch (err) {
      console.warn(`offlineTiles: style ${styleId} fetch failed`, err);
      continue;
    }

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
      for (const source of Object.values(style.sources)) {
        let tileTemplates = null;
        let sourceType = source.type;

        if (Array.isArray(source.tiles)) {
          tileTemplates = source.tiles.map((t) => appendToken(t, accessToken));
        } else if (typeof source.url === "string") {
          try {
            urls.add(resolveMapboxUrl(source.url, accessToken));
            const tileJson = await fetchTileJson(source.url, accessToken);
            if (Array.isArray(tileJson.tiles)) {
              tileTemplates = tileJson.tiles.map((t) => appendToken(t, accessToken));
            }
          } catch (err) {
            console.warn(
              `offlineTiles: TileJSON fetch failed for source (style=${styleId}, type=${source.type}, url=${source.url})`,
              err,
            );
          }
        }

        if (!tileTemplates) continue;

        const srcMinZoom = Math.max(minZoom, source.minzoom ?? 0);
        const srcMaxZoom = Math.min(maxZoom, source.maxzoom ?? maxZoom);

        for (const template of tileTemplates) {
          const tiles = enumerateTileUrls(template, bounds, srcMinZoom, srcMaxZoom);
          if (sourceType === "raster" || sourceType === "raster-dem") {
            rasterTileCount += tiles.length;
          } else {
            tileCount += tiles.length;
          }
          tiles.forEach((t) => urls.add(t));
        }
      }
    }

    console.info(
      `offlineTiles: style ${styleId} \u2192 urls so far: ${urls.size} (tile: ${tileCount}, raster: ${rasterTileCount})`,
    );
  }

  const estimatedSize = tileCount * 30 * 1024 + rasterTileCount * 80 * 1024;
  return {
    urls: Array.from(urls),
    tileCount: tileCount + rasterTileCount,
    estimatedSize,
  };
}
