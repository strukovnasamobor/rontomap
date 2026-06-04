package hr.strukovnasamobor.rontomap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Verifies TileStore.normalizeCacheKey collapses the same equivalence classes
 * as the service worker's normalizeCacheKey (src/sw.js). Byte-for-byte equality
 * with the JS output is NOT required (native owns both store + serve); only the
 * collapsing behavior must match so a downloaded tile serves runtime variants.
 */
public class TileStoreNormalizeTest {

    private static String n(String u) {
        return TileStore.normalizeCacheKey(u);
    }

    @Test
    public void retinaCollapsesToBase() {
        assertEquals(
                n("https://api.mapbox.com/v4/m/3/4/5@2x.png?access_token=pk"),
                n("https://api.mapbox.com/v4/m/3/4/5.png?sku=z"));
        // @3x too, and at end-of-path with no extension
        assertEquals(n("https://api.mapbox.com/s/sprite.png"),
                n("https://api.mapbox.com/s/sprite@2x.png"));
    }

    @Test
    public void shardedHostsFoldToApi() {
        String api = n("https://api.mapbox.com/v4/m/3/4/5.png?access_token=a");
        assertEquals(api, n("https://a.tiles.mapbox.com/v4/m/3/4/5.png?access_token=b"));
        assertEquals(api, n("https://d.tiles.mapbox.com/v4/m/3/4/5.png"));
        assertEquals(api, n("https://tiles.mapbox.com/v4/m/3/4/5.png"));
    }

    @Test
    public void rasterFormatsCollapseToPng() {
        String png = n("https://api.mapbox.com/v4/m/3/4/5.png");
        assertEquals(png, n("https://api.mapbox.com/v4/m/3/4/5.jpg"));
        assertEquals(png, n("https://api.mapbox.com/v4/m/3/4/5.jpeg"));
        assertEquals(png, n("https://api.mapbox.com/v4/m/3/4/5.webp"));
        assertEquals(png, n("https://api.mapbox.com/v4/m/3/4/5.jpg90"));
        assertEquals(png, n("https://api.mapbox.com/v4/m/3/4/5.png32"));
    }

    @Test
    public void combinedRetinaHostFormat() {
        assertEquals(
                n("https://api.mapbox.com/v4/m/3/4/5.png"),
                n("https://b.tiles.mapbox.com/v4/m/3/4/5@2x.jpg?access_token=pk&fresh=1"));
    }

    @Test
    public void nonFungibleExtensionsUntouched() {
        // .pngraw (terrain-rgb) and .vector.pbf must NOT collapse to .png
        assertNotEquals(
                n("https://api.mapbox.com/v4/m.terrain-rgb/3/4/5.pngraw"),
                n("https://api.mapbox.com/v4/m.terrain-rgb/3/4/5.png"));
        assertNotEquals(
                n("https://api.mapbox.com/v4/m/14/8/8.vector.pbf"),
                n("https://api.mapbox.com/v4/m/14/8/8.png"));
        assertTrue(n("https://api.mapbox.com/v4/m/14/8/8.vector.pbf").endsWith(".vector.pbf"));
    }

    @Test
    public void analyticsAndTokenParamsStripped() {
        assertEquals(
                "https://api.mapbox.com/v4/m/3/4/5.png",
                n("https://api.mapbox.com/v4/m/3/4/5.png?access_token=pk&sku=s&fresh=1&events=1"));
        // Valueless flag param (?...&secure) also stripped.
        assertEquals(
                "https://api.mapbox.com/v4/m/3/4/5.png",
                n("https://api.mapbox.com/v4/m/3/4/5.png?access_token=pk&secure"));
    }

    @Test
    public void glyphsPreservePercentEncoding() {
        assertEquals(
                "https://api.mapbox.com/fonts/v1/u/DIN%20Pro,Arial/0-255.pbf",
                n("https://api.mapbox.com/fonts/v1/u/DIN%20Pro,Arial/0-255.pbf?access_token=pk"));
    }

    @Test
    public void mapboxHostDetection() {
        assertTrue(TileStore.isMapboxHost("api.mapbox.com"));
        assertTrue(TileStore.isMapboxHost("a.tiles.mapbox.com"));
        assertTrue(TileStore.isMapboxHost("tiles.mapbox.com"));
        assertTrue(TileStore.isMapboxHost("events.mapbox.com"));
    }
}
