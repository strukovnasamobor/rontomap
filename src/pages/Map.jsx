import "./Map.css";
import PageFixedLayout from "../components/PageFixedLayout";
import Fullscreen from "../plugins/Fullscreen";
import { useIonViewWillEnter, IonAlert } from "@ionic/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDoubleTap } from "use-double-tap";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { StatusBar } from "@capacitor/status-bar";
import { Geolocation } from "@capacitor/geolocation";
import { Capacitor, registerPlugin } from "@capacitor/core";
const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");
import { App as CapApp } from "@capacitor/app";
import { db } from "../../firebase";
import { collection, addDoc, doc, getDoc, serverTimestamp } from "firebase/firestore";
import { collectFeatures, collectMarker, collectPath, materializeFeatures } from "../services/io/converters/rontoJson";
import { importFeatures, importFromContent, exportFeatures } from "../services/io";

// Set Mapbox access token
mapboxgl.accessToken = "pk.eyJ1IjoiYXVyZWxpdXMtemQiLCJhIjoiY21rcXA3cXh2MHNpZDNjcXl1a3MzbW8zciJ9.JO4VSTN6-0vRtWW0YKjlAg";

// Ramer-Douglas-Peucker simplification (~5m tolerance)
const RDP_TOLERANCE = 0.00005;
const rdpSimplify = (coords, tolerance) => {
  if (coords.length <= 2) return coords;
  const [x1, y1] = coords[0];
  const [x2, y2] = coords[coords.length - 1];
  const dx = x2 - x1,
    dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let maxDist = 0,
    maxIdx = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const [px, py] = coords[i];
    const t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
    const qx = x1 + t * dx,
      qy = y1 + t * dy;
    const d = (px - qx) ** 2 + (py - qy) ** 2;
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tolerance * tolerance) {
    const left = rdpSimplify(coords.slice(0, maxIdx + 1), tolerance);
    const right = rdpSimplify(coords.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [coords[0], coords[coords.length - 1]];
};

// Serialize snappedSegments for Firestore (coords: [[lng,lat]] → [{lng,lat}])
const serializeSnappedSegments = (segments) =>
  segments.map((seg) => ({
    type: seg.type,
    coords: (seg.type === "snapped" ? rdpSimplify(seg.coords, RDP_TOLERANCE) : seg.coords).map(([lng, lat]) => ({
      lng,
      lat,
    })),
  }));

// Deserialize snappedSegments from Firestore ({lng,lat} → [lng,lat])
// Remap legacy "direct" correction segments (adjacent to "snapped") to "offset"
const deserializeSnappedSegments = (segments) =>
  segments.map((seg, i, arr) => ({
    type:
      seg.type === "direct" &&
      ((i > 0 && arr[i - 1].type === "snapped") || (i < arr.length - 1 && arr[i + 1].type === "snapped"))
        ? "offset"
        : seg.type,
    coords: seg.coords.map((c) => [c.lng, c.lat]),
  }));

export default function Map() {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const geolocateRef = useRef(null);
  const locationControlRef = useRef(null);
  const markersRef = useRef([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [idMapStyle, setIdMapStyle] = useState(() => {
    const urlStyle = new URLSearchParams(window.location.search).get("style");
    if (urlStyle && ["rontomap_streets_light", "rontomap_streets_dark", "rontomap_satellite"].includes(urlStyle)) {
      return urlStyle;
    }
    const storedIdMapStyle = localStorage.getItem("rontomap_id_map_style");
    return storedIdMapStyle ? storedIdMapStyle : "rontomap_streets_light";
  });
  const [mapStyle, setMapStyle] = useState("");
  const [defaultCenter, setDefaultCenter] = useState([0, 0]);
  const [defaultZoom, setDefaultZoom] = useState(1);
  const [defaultZoomOnQueryParams, setDefaultZoomOnQueryParams] = useState(20);
  const [defaultZoomOnUserTrackingLocation, setDefaultZoomOnUserTrackingLocation] = useState(14);
  const [defaultZoomOnUserTrackingBearing, setDefaultZoomOnUserTrackingBearing] = useState(18);
  const [defaultPitch, setDefaultPitch] = useState(0);
  const [defaultPitchOnUserTrackingBearing, setDefaultPitchOnUserTrackingBearing] = useState(60);
  const [defaultBearing, setDefaultBearing] = useState(0);
  const [showTips, setShowTips] = useState(true);
  const [markerMenu, setMarkerMenu] = useState(null); // { marker }
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [mapClickMenu, setMapClickMenu] = useState(null); // { lngLat, x, y }

  const namingMarkerRef = useRef(null);
  const createMarkerRef = useRef(null);
  const geocoderOpenRef = useRef(false);
  const geocoderRef = useRef(null);
  const [nameAlert, setNameAlert] = useState(false);
  const [deleteAllAlert, setDeleteAllAlert] = useState(false);
  const [deletePathAlert, setDeletePathAlert] = useState(null);
  const [cancelPathAlert, setCancelPathAlert] = useState(false);
  const cancelPathAlertRef = useRef(false);
  const [circuitAlert, setCircuitAlert] = useState(false);
  const circuitAlertRef = useRef(false);
  const pendingCircuitPathRef = useRef(null);
  const [trackBearingAlert, setTrackBearingAlert] = useState(false);
  const [attachSightAlert, setAttachSightAlert] = useState(false);
  const pendingAttachSightRef = useRef(null);
  const [isPathMode, setIsPathMode] = useState(false);
  const [pathVertexCount, setPathVertexCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const pathUndoStackRef = useRef([]);
  const pathRedoStackRef = useRef([]);
  const [toastMsg, setToastMsg] = useState(null);
  const [snapMode, setSnapMode] = useState(null);
  const [forceMode, setForceMode] = useState(false);
  const forceModeRef = useRef(false);
  const isPathModeRef = useRef(false);
  const activePathRef = useRef(null);
  const pathsRef = useRef([]);
  const pathPointToastShownRef = useRef(false);
  const pathClickHandledRef = useRef(false);
  const longPressHandledRef = useRef(false);
  const featureMenuOpenedRef = useRef(false);
  const contextDotRef = useRef(null);
  const pathHelpersRef = useRef({});
  const [isNavigationMode, setIsNavigationMode] = useState(false);
  const isNavigationModeRef = useRef(false);
  const [isNavigationTracking, setIsNavigationTracking] = useState(false);
  const isNavigationTrackingRef = useRef(false);
  const [isRecordingTrack, setIsRecordingRoute] = useState(false);
  const isRecordingTrackRef = useRef(false);
  const trackPathRef = useRef(null);
  const trackCoordsRef = useRef([]);
  const bgWatcherIdRef = useRef(null);
  const [stopRecordingAlert, setStopRecordingAlert] = useState(false);
  const [routeDistance, setNavRouteDistance] = useState(null);
  const [routeDuration, setNavRouteDuration] = useState(null);
  const [cancelNavigationAlert, setCancelNavigationAlert] = useState(false);
  const cancelNavigationAlertRef = useRef(false);
  const passedPathSourceId = useRef(null);
  const passedPathLayerId = useRef(null);
  const passedPathCoordsRef = useRef([]);
  const routeSplitIndexRef = useRef(0);
  const routeSplitTRef = useRef(0);
  const isOffPathRef = useRef(false);
  const offPathCoordsRef = useRef([]);
  const isRenavigatingRef = useRef(false);
  const offPathTimerRef = useRef(null);
  const offPathVertexSegRef = useRef(0);
  const routeTotalDistanceRef = useRef(null);
  const isTracingPathRef = useRef(false);


  const [exportAlert, setExportAlert] = useState(null); // { data, scope, baseName }
  const [featuresLocked, setFeaturesLocked] = useState(false);
  const featuresLockedRef = useRef(false);
  const idMapStyleRef = useRef(idMapStyle);
  const isEmbeddedRef = useRef(new URLSearchParams(window.location.search).get("embedded") === "true");
  const embeddedFocusedRef = useRef(false);
  const embeddedToastTimerRef = useRef(null);

  const menuRefCallback = useCallback((el) => {
    if (!el) return;
    // Reset so the element can expand to its natural size before measuring
    el.style.maxHeight = "";
    el.style.transform = "";
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 12;
    // On mobile (Capacitor), account for system navigation bar via safe-area-inset-bottom
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden";
    document.body.appendChild(probe);
    const safeBottom = probe.getBoundingClientRect().height;
    probe.remove();
    const bottomLimit = vh - safeBottom - PAD;
    const menuTop = rect.top; // top of menu after default translate(-50%, 8px)
    const spaceBelow = bottomLimit - menuTop;
    const clickY = menuTop - 8; // undo the 8px offset to get click point
    const spaceAbove = clickY - PAD;

    // Vertical: flip above if not enough space below
    let translateY = "8px";
    if (rect.height > spaceBelow) {
      if (spaceAbove > spaceBelow && spaceAbove >= 80) {
        translateY = "calc(-100% - 8px)";
        if (rect.height > spaceAbove) el.style.maxHeight = `${spaceAbove}px`;
      } else {
        el.style.maxHeight = `${Math.max(spaceBelow, 80)}px`;
      }
    }

    // Horizontal: shift left if menu extends past right edge
    let translateX = "-50%";
    const menuLeft = rect.left;
    const menuRight = rect.right;
    if (menuRight > vw - PAD) {
      const shift = menuRight - (vw - PAD);
      translateX = `calc(-50% - ${shift}px)`;
    } else if (menuLeft < PAD) {
      const shift = PAD - menuLeft;
      translateX = `calc(-50% + ${shift}px)`;
    }

    el.style.transform = `translate(${translateX}, ${translateY})`;
  }, []);

  // Add or update the name label on a marker element
  const updateMarkerLabel = (marker) => {
    const el = marker.getElement();
    let label = el.querySelector(".marker-label");
    if (marker._markerName) {
      if (!label) {
        label = document.createElement("div");
        label.className = "marker-label";
        el.appendChild(label);
      }
      label.textContent = marker._markerName;
    } else {
      label?.remove();
    }
  };

  // Compute marker menu screen position from its geographic coordinates
  const computeMenuPos = (marker) => {
    const point = mapRef.current.project(marker.getLngLat());
    const rect = mapRef.current.getContainer().getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  };

  // Detect native Android (not web browser on Android)
  const isNativeAndroid = () => {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  };

  // Get query params from URL
  const getQueryParams = (param) => {
    console.log("getQueryParams:", param);
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(param);
  };

  // Add source and support links to the map
  const addSourceAndSupportLink = () => {
    console.log("addSourceAndSupportLink");
    const tryAdd = () => {
      const el = mapRef.current?.getContainer()?.querySelector(".mapboxgl-ctrl-attrib-inner");

      if (!el) {
        // Retry on next animation frame
        requestAnimationFrame(tryAdd);
        return;
      }

      // Prevent duplicates
      if (el.innerHTML.includes("rontomap")) return;
      el.innerHTML = el.innerHTML.replace("Improve this map", "");
      el.innerHTML += ` | <a href="https://github.com/strukovnasamobor/rontomap"
        target="_blank"
        rel="noopener">
        Source</a>
          | <a href="https://www.paypal.com/ncp/payment/ZRBQZMWTCJYFE"
        target="_blank"
        rel="noopener">
        Support</a>`;
    };

    tryAdd();
  };

  // Double tap to toggle fullscreen
  const bind = useDoubleTap((e) => {
    console.log("Event > DoubleTap");
    const controlsContainer = document.querySelector(".mapboxgl-control-container");
    const fsTarget = document.documentElement;

    // Ignore clicks on Mapbox controls
    if (e?.target?.closest(".mapboxgl-control-container")) {
      return;
    }

    if (!fullscreen) {
      if (controlsContainer) {
        controlsContainer.style.display = "none";
        // Android: Hide status bar using Capacitor
        if (isNativeAndroid()) {
          console.log("Android: Enter fullscreen.");
          StatusBar.hide();
          Fullscreen.enter();
        }
        // Try native fullscreen
        if (fsTarget.requestFullscreen) {
          fsTarget.requestFullscreen();
        }
        // @ts-ignore
        else if (fsTarget.webkitRequestFullscreen) {
          /* Safari */
          // @ts-ignore
          fsTarget.webkitRequestFullscreen();
        }
        // @ts-ignore
        else if (fsTarget.msRequestFullscreen) {
          /* IE11 */
          // @ts-ignore
          fsTarget.msRequestFullscreen();
        }
      }
    } else {
      if (controlsContainer) controlsContainer.style.display = "block";
      // Android: Show status bar
      if (isNativeAndroid()) {
        console.log("Android: Exit fullscreen.");
        StatusBar.show();
        Fullscreen.exit();
      }
      // Exit native fullscreen
      if (document.fullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        }
      }
      // @ts-ignore
      else if (document.webkitFullscreenElement) {
        /* Safari */
        // @ts-ignore
        if (document.webkitExitFullscreen) {
          // @ts-ignore
          document.webkitExitFullscreen();
        }
      }
      // @ts-ignore
      else if (document.msFullscreenElement) {
        /* IE11 */
        // @ts-ignore
        if (document.msExitFullscreen) {
          // @ts-ignore
          document.msExitFullscreen();
        }
      }
    }

    // Toggle state
    setFullscreen((prev) => !prev);

    // Resize map
    setTimeout(() => {
      if (mapRef.current) {
        mapRef.current.resize();
      }
    }, 100);
  }, 300);

  // Sync fullscreen state when exiting via Escape/F11
  useEffect(() => {
    const onFullscreenChange = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement && !document.msFullscreenElement) {
        setFullscreen(false);
        const controlsContainer = document.querySelector(".mapboxgl-control-container");
        if (controlsContainer) controlsContainer.style.display = "block";
        if (isNativeAndroid()) {
          StatusBar.show();
          Fullscreen.exit();
        }
        setTimeout(() => {
          if (mapRef.current) mapRef.current.resize();
        }, 100);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  // Resize map on view enter
  useIonViewWillEnter(() => {
    console.log("useIonViewWillEnter");
    if (mapRef.current) mapRef.current.resize();
  }, [mapStyle]);

  // Set map style URLs
  useEffect(() => {
    console.log("useEffect > idMapStyle:", idMapStyle);
    if (idMapStyle == "rontomap_streets_light") {
      setMapStyle("mapbox://styles/aurelius-zd/cmjmktkev00cc01sb0a6ff4i5");
      document.querySelector('[data-control="change_map_style_rontomap_streets_light"]')?.classList.add("hidden");
      document.querySelector('[data-control="change_map_style_rontomap_streets_dark"]')?.classList.remove("hidden");
    } else if (idMapStyle == "rontomap_streets_dark") {
      setMapStyle("mapbox://styles/aurelius-zd/cmjmqcp3b000101r2g5vb6bse");
      document.querySelector('[data-control="change_map_style_rontomap_streets_dark"]')?.classList.add("hidden");
      document.querySelector('[data-control="change_map_style_rontomap_satellite"]')?.classList.remove("hidden");
    } else if (idMapStyle == "rontomap_satellite") {
      setMapStyle("mapbox://styles/aurelius-zd/cmefvgizo00ul01sc2rek321h");
      document.querySelector('[data-control="change_map_style_rontomap_satellite"]')?.classList.add("hidden");
      document.querySelector('[data-control="change_map_style_rontomap_streets_light"]')?.classList.remove("hidden");
    }
  }, [idMapStyle]);

  const haversineDistance = (coords) => {
    const toRad = (d) => (d * Math.PI) / 180;
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      total += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
    return total;
  };

  const formatDistance = (meters) => {
    if (meters == null) return "";
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  };

  const formatDuration = (seconds) => {
    if (seconds == null) return "";
    if (seconds < 60) return "< 1 min";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs} h ${rem} min` : `${hrs} h`;
  };

  const formatETA = (seconds) => {
    if (seconds == null) return "";
    const eta = new Date(Date.now() + seconds * 1000);
    return eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // Initialize map and add controls
  useEffect(() => {
    console.log("useEffect > Initialize map");

    // Helper to create a marker with cursor and menu event handlers
    const createMarker = (lngLat, color = "#ff6f00") => {
      const marker = new mapboxgl.Marker({ color, draggable: true }).setLngLat(lngLat).addTo(mapRef.current);
      const el = marker.getElement();
      el.style.setProperty("cursor", "grab", "important");
      let wasDragged = false;
      el.addEventListener("mousedown", () => {
        if (!marker.isDraggable()) return;
        el.style.setProperty("cursor", "grabbing", "important");
        mapRef.current.getContainer().classList.add("marker-dragging");
      });
      el.addEventListener("mouseup", () => {
        if (!marker.isDraggable()) return;
        el.style.setProperty("cursor", "grab", "important");
        mapRef.current.getContainer().classList.remove("marker-dragging");
      });
      marker.on("dragstart", () => {
        wasDragged = true;
      });
      marker.on("dragend", () => {
        el.style.setProperty("cursor", marker.isDraggable() ? "grab" : "alias", "important");
        mapRef.current.getContainer().classList.remove("marker-dragging");
        setTimeout(() => {
          wasDragged = false;
        }, 0);
        // If marker is not already a sight, check proximity to finished paths
        if (!marker._sightPath) {
          const map = mapRef.current;
          const pos = marker.getLngLat();
          const markerPx = map.project(pos);
          const THRESHOLD_PX = 30;
          let bestPath = null;
          let bestDistSq = THRESHOLD_PX * THRESHOLD_PX;
          for (const p of pathsRef.current) {
            if (!p.isFinished || p.vertices.length < 2) continue;
            const line = pathHelpersRef.current.getRenderedLine(p);
            const result = pathHelpersRef.current.closestPointOnLineWithIndex(line, [pos.lng, pos.lat]);
            const ptPx = map.project(result.point);
            const dx = ptPx.x - markerPx.x, dy = ptPx.y - markerPx.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestPath = p;
            }
          }
          if (bestPath) {
            pendingAttachSightRef.current = { marker, path: bestPath };
            setAttachSightAlert(true);
          }
        }
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (wasDragged) return;
        if (isPathModeRef.current) return;
        if (isEmbeddedRef.current) return;
        featureMenuOpenedRef.current = true;
        setTimeout(() => {
          featureMenuOpenedRef.current = false;
        }, 300);
        setMenuPos(computeMenuPos(marker));
        setMarkerMenu({ marker });
      });
      // Sync cursor with draggable state
      const origSetDraggable = marker.setDraggable.bind(marker);
      marker.setDraggable = (v) => {
        origSetDraggable(v);
        el.style.setProperty("cursor", v ? "grab" : "alias", "important");
      };
      marker._markerName = "";
      markersRef.current.push(marker);
      return marker;
    };
    createMarkerRef.current = createMarker;

    // Get sight marker colors based on parent path type
    const getSightColors = (path) => {
      if (path.isTrack) return { pin: "#0000ff", circle: "#ffffff" };
      if (path.isRoute) return { pin: "#0091ff", circle: "#ffffff" };
      return { pin: "#ff6f00", circle: "#0091ff" };
    };

    const applySightColors = (marker, path) => {
      const colors = getSightColors(path);
      const el = marker.getElement();
      const svg = el.querySelector("svg");
      if (svg) {
        const paths = svg.querySelectorAll("path[fill]");
        paths.forEach((p) => { p.setAttribute("fill", colors.pin); });
        const circle = svg.querySelector("circle");
        if (circle) circle.setAttribute("fill", colors.circle);
      }
    };

    // --- Path creation helpers ---
    const ensurePathLayer = (path) => {
      const map = mapRef.current;
      if (!map) return;
      if (!map.getSource(path.sourceId)) {
        map.addSource(path.sourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer(path.layerId)) {
        map.addLayer({
          id: path.layerId,
          type: "line",
          source: path.sourceId,
          paint: { "line-color": ["get", "color"], "line-width": ["coalesce", ["get", "width"], 3], "line-emissive-strength": 1 },
          layout: { "line-cap": "round", "line-join": "round" },
        });
        const hitLayerId = `${path.layerId}-hit`;
        map.addLayer({
          id: hitLayerId,
          type: "line",
          source: path.sourceId,
          paint: { "line-color": "#000000", "line-width": 16, "line-opacity": 0 },
          layout: { "line-cap": "round", "line-join": "round" },
        });
        path._hitLayerId = hitLayerId;
        map.on("mouseenter", hitLayerId, () => {
          if (!isPathModeRef.current) map.getCanvas().style.cursor = "alias";
        });
        map.on("mouseleave", hitLayerId, () => {
          map.getCanvas().style.cursor = "";
        });
        const arrowLayerId = `${path.layerId}-arrows`;
        map.addLayer({
          id: arrowLayerId,
          type: "symbol",
          source: path.sourceId,
          layout: {
            "symbol-placement": "line",
            "symbol-spacing": 100,
            "text-field": ">",
            "text-size": 22,
            "text-rotation-alignment": "map",
            "text-keep-upright": false,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: {
            "text-color": path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00",
            "text-emissive-strength": 1,
          },
        });
        path._arrowLayerId = arrowLayerId;
      }
    };

    const ensurePassedPathLayer = (routePath) => {
      const map = mapRef.current;
      if (!map) return;
      const srcId = "passed-path-source-" + routePath.id;
      const lyrId = "passed-path-layer-" + routePath.id;
      if (!map.getSource(srcId)) {
        map.addSource(srcId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer(lyrId)) {
        map.addLayer(
          {
            id: lyrId,
            type: "line",
            source: srcId,
            paint: { "line-color": "#0000ff", "line-width": ["coalesce", ["get", "width"], 3], "line-emissive-strength": 1 },
            layout: { "line-cap": "round", "line-join": "round" },
          },
          routePath._arrowLayerId,
        );
      }
      passedPathSourceId.current = srcId;
      passedPathLayerId.current = lyrId;
    };

    const removePassedPathLayer = () => {
      const map = mapRef.current;
      if (!map) return;
      if (passedPathLayerId.current && map.getLayer(passedPathLayerId.current)) {
        map.removeLayer(passedPathLayerId.current);
      }
      if (passedPathSourceId.current && map.getSource(passedPathSourceId.current)) {
        map.removeSource(passedPathSourceId.current);
      }
      passedPathSourceId.current = null;
      passedPathLayerId.current = null;
      passedPathCoordsRef.current = [];
      routeSplitIndexRef.current = 0;
      routeSplitTRef.current = 0;
      isOffPathRef.current = false;
      offPathCoordsRef.current = [];
      isRenavigatingRef.current = false;
      routeTotalDistanceRef.current = null;
    };

    const updatePassedPathLine = (coords, roadSnap) => {
      const map = mapRef.current;
      if (!map || !passedPathSourceId.current) return;
      const source = map.getSource(passedPathSourceId.current);
      if (!source) return;
      const width = roadSnap === "car" ? 10 : roadSnap === "bike" || roadSnap === "foot" ? 5 : 3;
      const features = coords.length >= 2 ? [makeFeature(coords, "#0000ff", width)] : [];
      source.setData({ type: "FeatureCollection", features });
    };

    const makeFeature = (coords, color, width) => ({
      type: "Feature",
      properties: { color, ...(width != null && { width }) },
      geometry: { type: "LineString", coordinates: coords },
    });

    const updatePathLine = (path) => {
      const source = mapRef.current?.getSource(path.sourceId);
      if (!source) return;
      const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00";
      const forceColor = path.isRoute ? "#ff0000" : "#6F00FF";

      if (path.roadSnap && path.snappedSegments) {
        const features = [];
        const isNav = path.isRoute;
        for (const seg of path.snappedSegments) {
          if (seg.coords.length >= 2) {
            const width = isNav && seg.type === "snapped" ? (path.roadSnap === "car" ? 10 : (path.roadSnap === "bike" || path.roadSnap === "foot") ? 5 : undefined) : undefined;
            const segColor = seg.type === "direct" ? forceColor : seg.type === "offset" ? forceColor : mainColor;
            features.push(makeFeature(seg.coords, segColor, width));
          }
        }
        source.setData({ type: "FeatureCollection", features });
      } else {
        const verts = path.vertices;
        const hasForce = verts.some((v) => v.force);
        if (!hasForce) {
          const coords = verts.map((v) => v.lngLat);
          if (path.isCircuit && coords.length >= 2) coords.push(coords[0]);
          const features = coords.length >= 2 ? [makeFeature(coords, mainColor)] : [];
          source.setData({ type: "FeatureCollection", features });
        } else {
          const features = [];
          for (let i = 0; i < verts.length - 1; i++) {
            const c = (verts[i].force || verts[i + 1].force) ? forceColor : mainColor;
            features.push(makeFeature([verts[i].lngLat, verts[i + 1].lngLat], c));
          }
          if (path.isCircuit && verts.length >= 2) {
            const lastI = verts.length - 1;
            const c = (verts[lastI].force || verts[0].force || path.closingForced) ? forceColor : mainColor;
            features.push(makeFeature([verts[lastI].lngLat, verts[0].lngLat], c));
          }
          source.setData({ type: "FeatureCollection", features });
        }
        // Compute straight-line distance in Free mode for the active path
        if (path === activePathRef.current && verts.length >= 2) {
          const coords = verts.map((v) => v.lngLat);
          if (path.isCircuit) coords.push(coords[0]);
          setNavRouteDistance(haversineDistance(coords));
          setNavRouteDuration(null);
        }
      }

      // Set dash pattern for navigation foot/bike modes
      const map = mapRef.current;
      if (map && map.getLayer(path.layerId)) {
        if (path.isRoute && path.roadSnap === "foot") {
          map.setLayoutProperty(path.layerId, "line-cap", "round");
          map.setPaintProperty(path.layerId, "line-dasharray", [0, 3]);
        } else if (path.isRoute && path.roadSnap === "bike") {
          map.setPaintProperty(path.layerId, "line-dasharray", [3, 3]);
        } else {
          map.setPaintProperty(path.layerId, "line-dasharray", null);
        }
      }
    };

    const SNAP_PROFILES = { foot: "walking", bike: "cycling", car: "driving" };
    const AVG_SPEEDS = { foot: 1.4, bike: 4.2, car: 13.9 }; // m/s (~5, ~15, ~50 km/h)

    // Fetch directions for a list of vertices, handling the 25-waypoint batch limit
    const fetchDirections = async (verts, profile) => {
      const MAX = 25;
      const batches = [];
      for (let i = 0; i < verts.length; i += MAX - 1) {
        batches.push(verts.slice(i, i + MAX));
        if (i + MAX >= verts.length) break;
      }
      const allCoords = [];
      let totalDistance = 0;
      let totalDuration = 0;
      for (const batch of batches) {
        const coords = batch.map((v) => v.lngLat.join(",")).join(";");
        const res = await fetch(
          `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`,
        );
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
          const route = data.routes[0];
          const routeCoords = route.geometry.coordinates;
          allCoords.push(...(allCoords.length > 0 ? routeCoords.slice(1) : routeCoords));
          totalDistance += route.distance || 0;
          totalDuration += route.duration || 0;
        } else {
          return null;
        }
      }
      return { coords: allCoords, distance: totalDistance, duration: totalDuration };
    };

    // Build segment runs: consecutive non-force-adjacent pairs are snap runs, force-adjacent are direct
    const buildSegmentRuns = (vertices) => {
      const runs = [];
      let currentRun = [0];
      for (let i = 1; i < vertices.length; i++) {
        if (vertices[i - 1].force || vertices[i].force) {
          if (currentRun.length >= 2) runs.push({ type: "snap", indices: currentRun });
          runs.push({ type: "direct", indices: [i - 1, i] });
          currentRun = [i];
        } else {
          currentRun.push(i);
        }
      }
      if (currentRun.length >= 2) runs.push({ type: "snap", indices: currentRun });
      return runs;
    };

    const fetchRoadSnap = async (path) => {
      if (!path.roadSnap || path.vertices.length < 2) {
        path.snappedSegments = null;
        path.routeDistance = null;
        path.routeDuration = null;
        setNavRouteDistance(null);
        setNavRouteDuration(null);
        updatePathLine(path);
        return;
      }
      const profile = SNAP_PROFILES[path.roadSnap] || "driving";
      const verts = path.isCircuit
        ? [...path.vertices, { ...path.vertices[0], ...(path.closingForced ? { force: true } : {}) }]
        : path.vertices;
      const runs = buildSegmentRuns(verts);

      try {
        const segments = [];
        let pathDistance = 0;
        let pathDuration = 0;
        const speed = AVG_SPEEDS[path.roadSnap] || AVG_SPEEDS.car;
        const addStraightLine = (coords) => {
          const d = haversineDistance(coords);
          pathDistance += d;
          pathDuration += d / speed;
        };
        for (const run of runs) {
          if (run.type === "direct") {
            const coords = run.indices.map((i) => verts[i].lngLat);
            segments.push({ type: "direct", coords });
            addStraightLine(coords);
          } else {
            const runVerts = run.indices.map((i) => verts[i]);
            const result = await fetchDirections(runVerts, profile);
            if (result) {
              pathDistance += result.distance;
              pathDuration += result.duration;
              // Add direct red segment from first vertex to snapped start if they differ
              const first = runVerts[0].lngLat;
              const last = runVerts[runVerts.length - 1].lngLat;
              if (first[0] !== result.coords[0][0] || first[1] !== result.coords[0][1]) {
                const offsetCoords = [first, result.coords[0]];
                segments.push({ type: "offset", coords: offsetCoords });
                addStraightLine(offsetCoords);
              }
              segments.push({ type: "snapped", coords: result.coords });
              // Add offset segment from snapped end to last vertex if they differ
              const snappedEnd = result.coords[result.coords.length - 1];
              if (last[0] !== snappedEnd[0] || last[1] !== snappedEnd[1]) {
                const offsetCoords = [snappedEnd, last];
                segments.push({ type: "offset", coords: offsetCoords });
                addStraightLine(offsetCoords);
              }
            } else {
              // Fallback: render as straight line (not force)
              const fallbackCoords = runVerts.map((v) => v.lngLat);
              segments.push({ type: "fallback", coords: fallbackCoords });
              addStraightLine(fallbackCoords);
            }
          }
        }
        path.snappedSegments = segments;
        path.routeDistance = pathDistance;
        path.routeDuration = pathDuration;
        setNavRouteDistance(pathDistance);
        setNavRouteDuration(pathDuration);
      } catch {
        path.snappedSegments = null;
        path.routeDistance = null;
        path.routeDuration = null;
        setNavRouteDistance(null);
        setNavRouteDuration(null);
      }
      updatePathLine(path);
      updateSights(path);
      // Refit map when navigation path snap changes (skip during path editing)
      if (path.isRoute && mapRef.current && !isPathModeRef.current) {
        const bounds = new mapboxgl.LngLatBounds();
        if (path.snappedSegments) {
          path.snappedSegments.forEach((seg) => seg.coords.forEach((c) => bounds.extend(c)));
        } else {
          path.vertices.forEach((v) => bounds.extend(v.lngLat));
        }
        mapRef.current.fitBounds(bounds, {
          padding: 80,
          bearing: mapRef.current.getBearing(),
          pitch: mapRef.current.getPitch(),
          duration: 1000,
        });
      }
    };

    const computeMidpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const snapToPath = (path, lngLat) => {
      const verts = path.vertices;
      let bestDist = Infinity,
        bestSeg = 0,
        bestT = 0;
      const px = lngLat[0],
        py = lngLat[1];
      const segCount = path.isCircuit && verts.length >= 2 ? verts.length : verts.length - 1;
      for (let i = 0; i < segCount; i++) {
        const ax = verts[i].lngLat[0],
          ay = verts[i].lngLat[1];
        const next = (i + 1) % verts.length;
        const bx = verts[next].lngLat[0],
          by = verts[next].lngLat[1];
        const dx = bx - ax,
          dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx,
          cy = ay + t * dy;
        const dist = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (dist < bestDist) {
          bestDist = dist;
          bestSeg = i;
          bestT = t;
        }
      }
      return { segmentIndex: bestSeg, t: bestT };
    };

    // Closest point on an array of [lng,lat] coords
    const closestPointOnLine = (line, lngLat) => {
      const px = lngLat[0],
        py = lngLat[1];
      let bestDist = Infinity,
        bestPos = line[0];
      for (let i = 0; i < line.length - 1; i++) {
        const ax = line[i][0],
          ay = line[i][1];
        const bx = line[i + 1][0],
          by = line[i + 1][1];
        const dx = bx - ax,
          dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx,
          cy = ay + t * dy;
        const dist = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = [cx, cy];
        }
      }
      return bestPos;
    };

    const closestPointOnLineWithIndex = (line, lngLat) => {
      const px = lngLat[0],
        py = lngLat[1];
      let bestDist = Infinity,
        bestPos = line[0],
        bestIdx = 0,
        bestT = 0;
      for (let i = 0; i < line.length - 1; i++) {
        const ax = line[i][0],
          ay = line[i][1];
        const bx = line[i + 1][0],
          by = line[i + 1][1];
        const dx = bx - ax,
          dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx,
          cy = ay + t * dy;
        const dist = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = [cx, cy];
          bestIdx = i;
          bestT = t;
        }
      }
      return { point: bestPos, segmentIndex: bestIdx, t: bestT, distanceSq: bestDist };
    };

    const getRenderedLine = (path) => {
      if (path.roadSnap && path.snappedSegments) {
        const all = [];
        for (const seg of path.snappedSegments) {
          for (let i = 0; i < seg.coords.length; i++) {
            if (all.length > 0 && i === 0) {
              const last = all[all.length - 1];
              if (last[0] === seg.coords[0][0] && last[1] === seg.coords[0][1]) continue;
            }
            all.push(seg.coords[i]);
          }
        }
        return all.length >= 2 ? all : path.vertices.map((v) => v.lngLat);
      }
      const line = path.vertices.map((v) => v.lngLat);
      if (path.isCircuit && line.length >= 2) line.push(line[0]);
      return line;
    };

    const getSightPos = (path, am) => {
      const verts = path.vertices;
      const segIdx = am._segmentIndex ?? am.segmentIndex;
      const t = am._t ?? am.t;
      const maxSeg = path.isCircuit ? verts.length - 1 : verts.length - 2;
      const seg = Math.min(segIdx, maxSeg);
      const next = (seg + 1) % verts.length;
      const a = verts[seg].lngLat,
        b = verts[next].lngLat;
      const rawPos = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

      if (!path.roadSnap || !path.snappedSegments || verts.length < 2) return rawPos;

      return closestPointOnLine(getRenderedLine(path), rawPos);
    };

    const updateSights = (path) => {
      if (!path.sights) return;
      path.sights.forEach((m) => {
        const pos = getSightPos(path, m);
        m.setLngLat(pos);
      });
    };

    const createPathVertex = (lngLat) => {
      const el = document.createElement("div");
      el.className = "path-vertex active-path-feature";
      const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat(lngLat)
        .addTo(mapRef.current);
      const origSetDraggable = marker.setDraggable.bind(marker);
      marker.setDraggable = (v) => {
        origSetDraggable(v);
        if (v) el.classList.remove("not-draggable");
        else el.classList.add("not-draggable");
      };
      return marker;
    };

    const createMidpointMarker = (lngLat) => {
      const el = document.createElement("div");
      el.className = "path-midpoint active-path-feature";
      return new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat(lngLat)
        .addTo(mapRef.current);
    };

    const updateAdjacentMidpoints = (vertexEntry) => {
      const path = vertexEntry.path;
      const verts = path.vertices;
      const idx = verts.indexOf(vertexEntry);
      if (idx < 0) return;
      const lastI = verts.length - 1;
      path.midpoints.forEach((mp) => {
        const isAdjacent = mp.segmentIndex === idx - 1 || mp.segmentIndex === idx
          || (path.isCircuit && idx === 0 && mp.segmentIndex === lastI);
        if (isAdjacent) {
          const a = verts[mp.segmentIndex].lngLat;
          const b = (mp.segmentIndex + 1 < verts.length ? verts[mp.segmentIndex + 1] : verts[0]).lngLat;
          mp.marker.setLngLat(computeMidpoint(a, b));
        }
      });
    };

    const hideIntermediateVertices = (path) => {
      path.vertices.forEach((v, i) => {
        const isEndpoint = path.isCircuit ? i === 0 : (i === 0 || i === path.vertices.length - 1);
        if (!isEndpoint) {
          v.marker.getElement().style.display = "none";
        }
      });
    };

    const showAllVertices = (path) => {
      path.vertices.forEach((v) => {
        v.marker.getElement().style.display = "";
      });
    };

    const attachVertexDragHandler = (vertexEntry) => {
      vertexEntry.marker.on("dragstart", () => {
        mapRef.current.getContainer().classList.add("marker-dragging");
        pushPathSnapshot(vertexEntry.path);
        if (forceModeRef.current) {
          vertexEntry.force = true;
          updateVertexStyles(vertexEntry.path);
        }
      });
      vertexEntry.marker.on("drag", () => {
        const pos = vertexEntry.marker.getLngLat();
        vertexEntry.lngLat = [pos.lng, pos.lat];
        const path = vertexEntry.path;
        if (vertexEntry.force && path.roadSnap && path.snappedSegments) {
          // Render stale snapped segments + live force lines from current vertex positions
          const verts = path.vertices;
          const vi = verts.indexOf(vertexEntry);
          const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00";
          const features = [];
          // Keep stale snapped/offset segments
          for (const seg of path.snappedSegments) {
            if (seg.coords.length >= 2 && seg.type !== "direct") {
              features.push(makeFeature(seg.coords, mainColor));
            }
          }
          // Draw all force lines from current vertex positions
          const forceColor = path.isRoute ? "#ff0000" : "#6F00FF";
          for (let i = 0; i < verts.length - 1; i++) {
            if (verts[i].force || verts[i + 1].force) {
              features.push(makeFeature([verts[i].lngLat, verts[i + 1].lngLat], forceColor));
            }
          }
          // Circuit closing force line
          if (path.isCircuit && verts.length >= 2) {
            const last = verts[verts.length - 1], first = verts[0];
            if (last.force || first.force) {
              features.push(makeFeature([last.lngLat, first.lngLat], forceColor));
            }
          }
          const source = mapRef.current?.getSource(path.sourceId);
          if (source) source.setData({ type: "FeatureCollection", features });
        } else if (path.isCircuit && path.roadSnap && path.snappedSegments) {
          // Snapped circuit: render stale snapped segments only (no live closing segment to avoid duplicates)
          const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00";
          const features = [];
          for (const seg of path.snappedSegments) {
            if (seg.coords.length >= 2) {
              const segColor = seg.type === "direct" ? (path.isRoute ? "#ff0000" : "#6F00FF") : seg.type === "offset" ? (path.isRoute ? "#ff0000" : "#6F00FF") : mainColor;
              features.push(makeFeature(seg.coords, segColor));
            }
          }
          const source = mapRef.current?.getSource(path.sourceId);
          if (source) source.setData({ type: "FeatureCollection", features });
        } else {
          updatePathLine(path);
        }
        updateAdjacentMidpoints(vertexEntry);
        updateSights(path);
      });
      vertexEntry.marker.on("dragend", () => {
        mapRef.current.getContainer().classList.remove("marker-dragging");
        const pos = vertexEntry.marker.getLngLat();
        vertexEntry.lngLat = [pos.lng, pos.lat];
        if (forceModeRef.current) {
          vertexEntry.force = true;
          updateVertexStyles(vertexEntry.path);
        }
        if (!vertexEntry.path.roadSnap) updatePathLine(vertexEntry.path);
        updateSights(vertexEntry.path);
        if (!vertexEntry.path.isFinished) {
          // Update midpoint force styles in place instead of rebuilding
          // (positions are already correct from updateAdjacentMidpoints during drag)
          const path = vertexEntry.path;
          path.midpoints.forEach((mp) => {
            const verts = path.vertices;
            const a = verts[mp.segmentIndex];
            const b = mp.segmentIndex + 1 < verts.length ? verts[mp.segmentIndex + 1] : (path.isCircuit ? verts[0] : undefined);
            if (a?.force || b?.force) {
              mp.marker.getElement().classList.add("path-midpoint-forced");
            } else {
              mp.marker.getElement().classList.remove("path-midpoint-forced");
            }
            if (a?.force && b?.force) {
              mp.marker.getElement().classList.add("path-midpoint-both-forced");
            } else {
              mp.marker.getElement().classList.remove("path-midpoint-both-forced");
            }
          });
        }
        if (vertexEntry.path.roadSnap) fetchRoadSnap(vertexEntry.path);
        // Check if last vertex was dragged near the start — offer to close circuit
        const cPath = vertexEntry.path;
        const cVerts = cPath.vertices;
        if (
          !cPath.isFinished &&
          !cPath.isCircuit &&
          cVerts.length >= 3 &&
          vertexEntry === cVerts[cVerts.length - 1]
        ) {
          const [lon1, lat1] = cVerts[0].lngLat;
          const [lon2, lat2] = vertexEntry.lngLat;
          const toRad = (d) => (d * Math.PI) / 180;
          const dLat = toRad(lat2 - lat1);
          const dLon = toRad(lon2 - lon1);
          const a2 =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
          const dist = 6371000 * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
          if (dist < 30) {
            pendingCircuitPathRef.current = cPath;
            setCircuitAlert(true);
          }
        }
      });
    };

    const promoteMidpointToVertex = (mpEntry) => {
      const { marker, segmentIndex, path } = mpEntry;
      pushPathSnapshot(path);
      const ll = marker.getLngLat();
      // Shift attached markers on the split segment
      if (path.sights) {
        path.sights.forEach((m) => {
          if (m._segmentIndex === segmentIndex) {
            // Split t: marker was at t along old segment, now need to remap
            if (m._t <= 0.5) {
              m._t = m._t * 2;
            } else {
              m._segmentIndex = segmentIndex + 1;
              m._t = (m._t - 0.5) * 2;
            }
          } else if (m._segmentIndex > segmentIndex) {
            m._segmentIndex += 1;
          }
        });
      }
      const newMarker = createPathVertex([ll.lng, ll.lat]);
      const newVertex = { lngLat: [ll.lng, ll.lat], marker: newMarker, path };
      const prevForced = path.vertices[segmentIndex]?.force;
      const nextVert = path.vertices[segmentIndex + 1] || (path.isCircuit ? path.vertices[0] : undefined);
      const nextForced = nextVert?.force;
      if (forceModeRef.current || (prevForced && nextForced)) newVertex.force = true;
      path.vertices.splice(segmentIndex + 1, 0, newVertex);
      setPathVertexCount(path.vertices.length);
      if (!pathPointToastShownRef.current) {
        pathPointToastShownRef.current = true;
        setToastMsg("Click a point to remove it, or hold and drag it.");
        setTimeout(() => {
          setToastMsg(null);
        }, 3000);
      }
      attachVertexDragHandler(newVertex);
      attachFinishHandler(newVertex);
      if (!path.roadSnap) updatePathLine(path);
      rebuildMidpoints(path);
      updateVertexStyles(path);
      updateSights(path);
      if (path.roadSnap) fetchRoadSnap(path);
    };

    const rebuildMidpoints = (path) => {
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];
      const verts = path.vertices;
      for (let i = 0; i < verts.length - 1; i++) {
        const mid = computeMidpoint(verts[i].lngLat, verts[i + 1].lngLat);
        const marker = createMidpointMarker(mid);
        if (verts[i].force || verts[i + 1].force) marker.getElement().classList.add("path-midpoint-forced");
        if (verts[i].force && verts[i + 1].force) marker.getElement().classList.add("path-midpoint-both-forced");
        const mpEntry = { marker, segmentIndex: i, path };
        marker.on("dragstart", () => {
          mapRef.current.getContainer().classList.add("marker-dragging");
        });
        marker.on("drag", () => {
          const pos = marker.getLngLat();
          const midPt = [pos.lng, pos.lat];
          const si = mpEntry.segmentIndex;
          const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00";
          const forceColor = path.isRoute ? "#ff0011" : "#6F00FF";
          const features = [];
          // Build segments with per-edge coloring
          const dragging = forceModeRef.current || verts[si].force || verts[si + 1].force;
          for (let j = 0; j < verts.length; j++) {
            const from = j === si ? [verts[j].lngLat, midPt] : j === si + 1 ? [midPt, verts[j].lngLat] : null;
            if (from) {
              features.push(makeFeature(from, dragging ? forceColor : mainColor));
            }
            if (j < verts.length - 1 && j !== si) {
              const c = (verts[j].force || verts[j + 1].force) ? forceColor : mainColor;
              features.push(makeFeature([verts[j].lngLat, verts[j + 1].lngLat], c));
            }
          }
          // Circuit closing segment
          if (path.isCircuit && verts.length >= 2) {
            const lastI = verts.length - 1;
            const c = (verts[lastI].force || verts[0].force || path.closingForced) ? forceColor : mainColor;
            features.push(makeFeature([verts[lastI].lngLat, verts[0].lngLat], c));
          }
          const source = mapRef.current?.getSource(path.sourceId);
          if (source) source.setData({ type: "FeatureCollection", features });
        });
        marker.on("dragend", () => {
          mapRef.current.getContainer().classList.remove("marker-dragging");
          promoteMidpointToVertex(mpEntry);
        });
        const midEl = marker.getElement();
        if (path.isRoute) midEl.classList.add("route-path-midpoint");
        midEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        path.midpoints.push(mpEntry);
      }
      // Closing segment midpoint for circuit paths
      if (path.isCircuit && verts.length >= 2) {
        const lastI = verts.length - 1;
        const mid = computeMidpoint(verts[lastI].lngLat, verts[0].lngLat);
        const marker = createMidpointMarker(mid);
        if (verts[lastI].force || verts[0].force || path.closingForced) marker.getElement().classList.add("path-midpoint-forced");
        if (verts[lastI].force && verts[0].force) marker.getElement().classList.add("path-midpoint-both-forced");
        const mpEntry = { marker, segmentIndex: lastI, path };
        marker.on("dragstart", () => {
          mapRef.current.getContainer().classList.add("marker-dragging");
        });
        marker.on("drag", () => {
          const pos = marker.getLngLat();
          const midPt = [pos.lng, pos.lat];
          const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#0000ff" : "#ff6f00";
          const forceColor = path.isRoute ? "#ff0011" : "#6F00FF";
          const features = [];
          for (let j = 0; j < verts.length - 1; j++) {
            const c = (verts[j].force || verts[j + 1].force) ? forceColor : mainColor;
            features.push(makeFeature([verts[j].lngLat, verts[j + 1].lngLat], c));
          }
          const cc = (forceModeRef.current || verts[lastI].force || verts[0].force || path.closingForced) ? forceColor : mainColor;
          features.push(makeFeature([verts[lastI].lngLat, midPt], cc));
          features.push(makeFeature([midPt, verts[0].lngLat], cc));
          const source = mapRef.current?.getSource(path.sourceId);
          if (source) source.setData({ type: "FeatureCollection", features });
        });
        marker.on("dragend", () => {
          mapRef.current.getContainer().classList.remove("marker-dragging");
          promoteMidpointToVertex(mpEntry);
        });
        const midEl = marker.getElement();
        if (path.isRoute) midEl.classList.add("route-path-midpoint");
        midEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        path.midpoints.push(mpEntry);
      }
    };

    const attachFinishHandler = (vertexEntry) => {
      const el = vertexEntry.marker.getElement();
      let wasDragged = false;
      vertexEntry.marker.on("dragstart", () => {
        wasDragged = true;
      });
      vertexEntry.marker.on("dragend", () => {
        setTimeout(() => {
          wasDragged = false;
        }, 0);
      });
      // Click: remove vertex during path creation
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (wasDragged) return;
        const path = vertexEntry.path;
        const verts = path.vertices;
        if (!path.isFinished) {
          const idx = verts.indexOf(vertexEntry);
          if (idx < 0) return;
          // Click on start/end of a circuit → un-circuit (remove closing segment)
          if (path.isCircuit && (idx === 0 || idx === verts.length - 1)) {
            pushPathSnapshot(path);
            path.isCircuit = false;
            updatePathLine(path);
            rebuildMidpoints(path);
            updateVertexStyles(path);
            if (path.roadSnap) fetchRoadSnap(path);
            return;
          }
          pushPathSnapshot(path);
          if (path.sights && verts.length > 1) {
            const maxSeg = verts.length - 2;
            path.sights = path.sights.filter((m) => {
              if (idx === 0 && m._segmentIndex === 0) {
                m._segmentIndex = 0;
                return true;
              }
              if (m._segmentIndex === idx - 1 || m._segmentIndex === idx) {
                const prevIdx = Math.max(0, idx - 1);
                const nextIdx = Math.min(idx + 1, verts.length - 1);
                const a = verts[prevIdx].lngLat;
                const b = verts[nextIdx].lngLat;
                const pos = m.getLngLat();
                const dx = b[0] - a[0],
                  dy = b[1] - a[1];
                const len2 = dx * dx + dy * dy;
                m._t =
                  len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pos.lng - a[0]) * dx + (pos.lat - a[1]) * dy) / len2));
                m._segmentIndex = idx === 0 ? 0 : idx - 1;
                return true;
              }
              if (m._segmentIndex > idx) {
                m._segmentIndex -= 1;
              } else if (m._segmentIndex === maxSeg && idx === verts.length - 1) {
                m._segmentIndex = Math.max(0, m._segmentIndex - 1);
              }
              return true;
            });
          }
          vertexEntry.marker.remove();
          verts.splice(idx, 1);
          setPathVertexCount(verts.length);
          if (verts.length === 0) {
            // Last vertex removed — clean up the path
            const map = mapRef.current;
            const hitLayerId = `${path.layerId}-hit`;
            const arrowLayerId = `${path.layerId}-arrows`;
            if (map.getLayer(arrowLayerId)) map.removeLayer(arrowLayerId);
            if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
            if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
            if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);
            path.midpoints.forEach((mp) => mp.marker.remove());
            path.midpoints = [];
            if (path.sights) {
              path.sights.forEach((m) => {
                m.remove();
                markersRef.current = markersRef.current.filter((mk) => mk !== m);
              });
            }
            pathsRef.current = pathsRef.current.filter((p) => p !== path);
            activePathRef.current = null;
          } else {
            updatePathLine(path);
            rebuildMidpoints(path);
            updateVertexStyles(path);
            updateSights(path);
            if (path.roadSnap) fetchRoadSnap(path);
          }
        }
      });
      // Right click: open path menu on finished path endpoints
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (wasDragged) return;
        if (isPathModeRef.current) return;
        if (isEmbeddedRef.current) return;
        featureMenuOpenedRef.current = true;
        setTimeout(() => {
          featureMenuOpenedRef.current = false;
        }, 300);
        const path = vertexEntry.path;
        const verts = path.vertices;
        if (path.isFinished && (verts[0] === vertexEntry || verts[verts.length - 1] === vertexEntry)) {
          pathClickHandledRef.current = true;
          setTimeout(() => {
            pathClickHandledRef.current = false;
          }, 400);
          const map = mapRef.current;
          const pos = vertexEntry.marker.getLngLat();
          const point = map.project(pos);
          const rect = map.getContainer().getBoundingClientRect();
          setMapClickMenu({
            lngLat: pos,
            x: rect.left + point.x,
            y: rect.top + point.y,
            path,
            fromVertex: vertexEntry.marker,
          });
        }
      });
    };

    const updateVertexStyles = (path) => {
      const verts = path.vertices;
      verts.forEach((v) => {
        const el = v.marker.getElement();
        el.classList.remove("path-vertex-last", "path-vertex-circuit-start", "path-vertex-circuit-end", "path-vertex-force", "route-path-vertex", "track-path-vertex", "path-vertex-intermediate");
        if (path.isRoute) el.classList.add("route-path-vertex");
        if (path.isTrack) el.classList.add("track-path-vertex");
        if (v.force) el.classList.add("path-vertex-force");
      });
      if (verts.length > 0 && !path.isCircuit) verts[verts.length - 1].marker.getElement().classList.add("path-vertex-last");
      if (path.isCircuit && verts.length >= 2) {
        verts[0].marker.getElement().classList.add("path-vertex-circuit-start");
        verts[verts.length - 1].marker.getElement().classList.add("path-vertex-intermediate");
      }
      for (let i = 1; i < verts.length - 1; i++) {
        verts[i].marker.getElement().classList.add("path-vertex-intermediate");
      }
    };

    pathHelpersRef.current = {
      ensurePathLayer,
      updatePathLine,
      fetchRoadSnap,
      createPathVertex,
      rebuildMidpoints,
      attachVertexDragHandler,
      attachFinishHandler,
      updateVertexStyles,
      hideIntermediateVertices,
      showAllVertices,
      snapToPath,
      updateSights,
      getSightPos,
      closestPointOnLine,
      closestPointOnLineWithIndex,
      getRenderedLine,
      ensurePassedPathLayer,
      removePassedPathLayer,
      updatePassedPathLine,
      makeFeature,
      applySightColors,
    };

    if (mapRef.current) mapRef.current.resize();

    // Get camera params from the URL
    const lat = parseFloat(getQueryParams("lat"));
    const long = parseFloat(getQueryParams("long"));
    const urlZoom = parseFloat(getQueryParams("zoom"));
    const urlBearing = parseFloat(getQueryParams("bearing"));
    const urlPitch = parseFloat(getQueryParams("pitch"));

    // Set new center and zoom
    const center = !isNaN(lat) && !isNaN(long) ? [long, lat] : defaultCenter;
    const zoom = !isNaN(urlZoom) ? urlZoom : !isNaN(lat) && !isNaN(long) ? defaultZoomOnQueryParams : defaultZoom;
    const pitch = !isNaN(urlPitch) ? urlPitch : defaultPitch;
    const bearing = !isNaN(urlBearing) ? urlBearing : defaultBearing;

    // If map already initialized fly to the new center and zoom
    if (mapRef.current) {
      if (!isNaN(lat) && !isNaN(long)) {
        mapRef.current.flyTo({
          center: center,
          zoom: zoom,
          pitch: pitch,
          bearing: bearing,
          duration: 1000,
        });
      }
      return;
    }

    // Initialize map
    mapRef.current = new mapboxgl.Map({
      respectPrefersReducedMotion: false,
      container: mapContainerRef.current,
      style: mapStyle,
      attributionControl: false,
      doubleClickZoom: false,
      // @ts-ignore
      center: center,
      zoom: zoom,
      bearing: bearing,
      pitch: pitch,
    });

    // Add navigation control
    mapRef.current.once("load", () => {
      console.log("Event > Map > load");
      if (locationControlRef.current && "geolocation" in navigator) {
        locationControlRef.current.showTrackingLocationIcon();
      }
    });

    // Listen for styledata changes
    mapRef.current.on("styledata", () => {
      console.log("Event > map > styledata");
      addSourceAndSupportLink();
    });

    // Custom location control
    class LocationControl {
      constructor(geolocate, map) {
        this._geolocate = geolocate;
        this._map = map;
        this._wakeLock = null;
        this._isScreenLocked = false;
        this._trackingLocation = false;
        this._trackingBearing = false;
        this._isUserMovingMapWhenTrackingBearing = false;
        this._isUserDragging = false;
        this._isUserZooming = false;
        this._isUserRotating = false;
        this._isUserPitching = false;
        this._isMapBeingControlledProgrammatically = false;
        this._programmaticMoveId = 0;
        this._isSnappingBackToUser = false;
        this._zoomOnStartTrackingBearing = defaultZoomOnUserTrackingBearing;
        this._pitchOnStartTrackingBearing = defaultPitchOnUserTrackingBearing;
        this._zoomOnStopTrackingBearing = null;
        this._pitchOnStopTrackingBearing = null;
        this._lastPostionLong = null;
        this._lastPostionLat = null;
        this._lastPositionBearing = null;
        this._handleClick = this._handleClick.bind(this);
      }

      hideTrackingIcons() {
        console.log("hideTrackingIcons");
        this._container.querySelector('[data-control="track_location"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="track_bearing"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="stop_tracking_bearing"]')?.classList.add("hidden");
      }

      showTrackingLocationIcon() {
        console.log("showTrackingLocationIcon");
        this._container.querySelector('[data-control="track_location"]')?.classList.remove("hidden");
        this._container.querySelector('[data-control="track_bearing"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="stop_tracking_bearing"]')?.classList.add("hidden");
      }

      showTrackingBearingIcon() {
        console.log("showTrackingBearingIcon");
        this._container.querySelector('[data-control="track_location"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="track_bearing"]')?.classList.remove("hidden");
        this._container.querySelector('[data-control="stop_tracking_bearing"]')?.classList.add("hidden");
      }

      showStopTrackingBearingIcon() {
        console.log("showStopTrackingBearingIcon");
        this._container.querySelector('[data-control="track_location"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="track_bearing"]')?.classList.add("hidden");
        this._container.querySelector('[data-control="stop_tracking_bearing"]')?.classList.remove("hidden");
      }

      disableUserInteractions() {
        console.log("disableUserInteractions");
        this._isMapBeingControlledProgrammatically = true;
        this._map.boxZoom.disable();
        this._map.scrollZoom.disable();
        this._map.dragPan.disable();
        this._map.dragRotate.disable();
        this._map.keyboard.disable();
        this._map.touchZoomRotate.disable();
        this._map.touchPitch.disable();
        if (this._map.touchZoomRotate._tapDragZoom) this._map.touchZoomRotate._tapDragZoom.disable();
      }

      enableUserInteractions() {
        console.log("enableUserInteractions");
        this._isMapBeingControlledProgrammatically = false;
        this._map.boxZoom.enable();
        this._map.scrollZoom.enable();
        this._map.dragPan.enable();
        this._map.dragRotate.enable();
        this._map.keyboard.enable();
        this._map.touchZoomRotate.enable();
        if (this._map.touchZoomRotate._tapDragZoom) this._map.touchZoomRotate._tapDragZoom.disable();
        this._map.touchPitch.enable();
      }

      async _handleClick(e) {
        const button = e.target instanceof Element ? e.target.closest("button") : null;
        if (!button) return;

        const control = button.dataset.control;
        console.log("_handleClick:", control);

        switch (control) {
          case "change_map_style_rontomap_satellite":
            await this._handleChangeMapStyle("rontomap_satellite");
            break;
          case "change_map_style_rontomap_streets_light":
            await this._handleChangeMapStyle("rontomap_streets_light");
            break;
          case "change_map_style_rontomap_streets_dark":
            await this._handleChangeMapStyle("rontomap_streets_dark");
            break;
          case "track_location":
            this.hideTrackingIcons();
            await this._handleTrackLocation();
            break;
          case "track_bearing":
            this.hideTrackingIcons();
            await this._handleTrackBearing();
            break;
          case "stop_tracking_bearing":
            this.hideTrackingIcons();
            await this._handleStopTrackingBearing();
            break;
        }
      }

      async _handleChangeMapStyle(idMapStyle) {
        console.log("_handleChangeMapStyle");
        localStorage.setItem("rontomap_id_map_style", idMapStyle);
        setIdMapStyle(idMapStyle);
      }

      async _handleTrackLocation() {
        console.log("_handleTrackLocation");

        // If we don't have a last known position, try to get the current position
        if (this._lastPostionLat == null || this._lastPostionLong == null) {
          try {
            // On native platforms, explicitly request permissions first
            if (Capacitor.isNativePlatform()) {
              const permissionStatus = await Geolocation.checkPermissions();
              if (permissionStatus.location !== "granted") {
                const permissions = await Geolocation.requestPermissions();
                if (permissions.location !== "granted" && permissions.location !== "limited") {
                  console.log("_handleTrackLocation > Location permission denied");
                  this.showTrackingLocationIcon();
                  return;
                }
              }
            }
            // On web, getCurrentPosition() itself triggers the browser permission prompt
            this._geolocate.trigger();
          } catch (err) {
            console.error("_handleTrackLocation > Error getting user location:", err);
            this.showTrackingLocationIcon();
            return;
          }
        } else {
          // Fly to last known position immediately
          this.disableUserInteractions();
          mapRef.current
            .flyTo({
              center: [this._lastPostionLong, this._lastPostionLat],
              duration: 1000,
            })
            .once("moveend", () => {
              console.log("Event > _handleTrackLocation > moveend");
              this.showTrackingBearingIcon();
              this.enableUserInteractions();
              this._trackingLocation = true;
            });
        }
      }

      _finishPathForBearing() {
        if (isPathModeRef.current) {
          isPathModeRef.current = false;
          setIsPathMode(false);
          if (activePathRef.current) {
            const path = activePathRef.current;
            path.isFinished = true;
            pathHelpersRef.current.hideIntermediateVertices?.(path);
            path.midpoints.forEach((mp) => mp.marker.remove());
            path.midpoints = [];
            path.vertices.forEach((v) => {
              v.marker.getElement().classList.remove("active-path-feature");
              v.marker.setDraggable(false);
            });
            if (path.sights)
              path.sights.forEach((m) => {
                m.getElement().classList.remove("active-path-feature");
                m.setDraggable(false);
              });
            delete path._wasLocked;
          }
          setToastMsg("Path saved. You can edit it after stopping bearing tracking.");
          setTimeout(() => {
            setToastMsg(null);
          }, 3000);
        }
      }

      async _handleTrackBearing() {
        console.log("_handleTrackBearing");
        this._trackingLocation = false;

        // If editing a path (not navigation), show alert and wait for confirmation
        if (isPathModeRef.current && !isNavigationTrackingRef.current && !isNavigationModeRef.current) {
          this.showTrackingBearingIcon();
          setTrackBearingAlert(true);
          return;
        }

        // If in navigation mode, finish path visually and enter navigation tracking
        if (isNavigationModeRef.current && !isNavigationTrackingRef.current) {
          const path = activePathRef.current;
          if (path) {
            path.isFinished = true;
            pathHelpersRef.current.hideIntermediateVertices(path);
            path.midpoints.forEach((mp) => mp.marker.remove());
            path.midpoints = [];
            path.vertices.forEach((v) => v.marker.getElement().classList.remove("active-path-feature"));
          }
          setIsNavigationTracking(true);
          isNavigationTrackingRef.current = true;
          setToastMsg("Click stop icon to leave navigation.");
          setTimeout(() => setToastMsg(null), 3000);
        }

        // Remember the current zoom and pitch to restore them when stopping bearing tracking
        this._zoomOnStartTrackingBearing = this._map.getZoom();
        this._pitchOnStartTrackingBearing = this._map.getPitch();

        let lat = this._lastPostionLat;
        let long = this._lastPostionLong;
        let zoom =
          this._zoomOnStopTrackingBearing != null ? this._zoomOnStopTrackingBearing : defaultZoomOnUserTrackingBearing;
        let pitch =
          this._pitchOnStopTrackingBearing != null
            ? this._pitchOnStopTrackingBearing
            : defaultPitchOnUserTrackingBearing;
        let bearing = this._lastPositionBearing ? this._lastPositionBearing : this._map.getBearing();

        // Set map to last position with bearing
        if (lat != null && long != null) {
          this.disableUserInteractions();
          mapRef.current
            .flyTo({
              center: [long, lat],
              offset: [0, 120],
              zoom: zoom,
              pitch: pitch,
              bearing: bearing,
              duration: 1000,
            })
            .once("moveend", async () => {
              console.log("Event > _handleTrackBearing > moveend");
              mapRef.current.getContainer().classList.add("geolocate-track-user-bearing");
              this.showStopTrackingBearingIcon();
              this.enableUserInteractions();
              await this._requestWakeLock();
              this._trackingBearing = true;
            });
        } else {
          console.log("_handleTrackBearing > No last position available");
          this.showTrackingLocationIcon();
        }
      }

      async _handleStopTrackingBearing() {
        console.log("_handleStopTrackingBearing");
        this._trackingBearing = false;

        // Remember the current zoom and pitch to restore them when starting bearing tracking again
        this._zoomOnStopTrackingBearing = this._map.getZoom();
        this._pitchOnStopTrackingBearing = this._map.getPitch();

        let lat = this._lastPostionLat;
        let long = this._lastPostionLong;
        let zoom = this._zoomOnStartTrackingBearing;
        let pitch = this._pitchOnStartTrackingBearing;
        let bearing = this._lastPositionBearing ? this._lastPositionBearing : this._map.getBearing();

        this.disableUserInteractions();
        mapRef.current.getContainer().classList.remove("geolocate-track-user-bearing");
        mapRef.current
          .flyTo({
            center: [long, lat],
            zoom: zoom,
            pitch: pitch,
            bearing: bearing,
            duration: 1000,
          })
          .once("moveend", () => {
            console.log("Event > _handleStopTrackingBearing > moveend");
            this.showTrackingBearingIcon();
            this.enableUserInteractions();
            this._trackingLocation = true;
            this._releaseWakeLock();

            // If in navigation mode, restore editing UI
            if (isNavigationModeRef.current) {
              isOffPathRef.current = false;
              offPathCoordsRef.current = [];
              isRenavigatingRef.current = false;
              if (offPathTimerRef.current) { clearTimeout(offPathTimerRef.current); offPathTimerRef.current = null; }
              const path = activePathRef.current;
              if (path) {
                path.isFinished = false;
                pathHelpersRef.current.showAllVertices(path);
                pathHelpersRef.current.rebuildMidpoints(path);
                path.vertices.forEach((v) => {
                  v.marker.setDraggable(true);
                  v.marker.getElement().classList.add("active-path-feature");
                });
                pathHelpersRef.current.updateVertexStyles(path);
                // Restore sight colors after tracking
                if (path.sights) {
                  path.sights.forEach((m) => {
                    delete m._passed;
                    pathHelpersRef.current.applySightColors(m, path);
                  });
                }
              }
              setIsNavigationTracking(false);
              isNavigationTrackingRef.current = false;
            }
          });
      }

      stopTrackingLocation() {
        console.log("stopTrackingLocation");
        this._trackingLocation = false;
        this._geolocate._watchState = "BACKGROUND";
        this.showTrackingLocationIcon();
      }

      stopTrackingLocationAndBearing() {
        console.log("stopTrackingLocationAndBearing");
        this._trackingBearing = false;
        this._trackingLocation = false;
        this._geolocate._watchState = "BACKGROUND";
        this.showTrackingLocationIcon();
      }

      isUserMovingMapWhenTrackingBearing() {
        return this._isUserMovingMapWhenTrackingBearing;
      }

      isTrackingLocation() {
        return this._trackingLocation;
      }

      isTrackingBearing() {
        return this._trackingBearing;
      }

      getZoomOnStartTrackingBearing() {
        return this._zoomOnStartTrackingBearing;
      }

      getPitchOnStartTrackingBearing() {
        return this._pitchOnStartTrackingBearing;
      }

      getZoomOnStopTrackingBearing() {
        return this._zoomOnStopTrackingBearing;
      }

      getPitchOnStopTrackingBearing() {
        return this._pitchOnStopTrackingBearing;
      }

      onAdd() {
        console.log("LocationControl onAdd");
        this._container = document.createElement("div");
        this._container.className = "mapboxgl-control";

        this._container.innerHTML = `
          <div class="ctrl-location-container mapboxgl-ctrl mapboxgl-ctrl-group">
              <button
                  class="mapboxgl-ctrl-geolocate hidden"
                  type="button"
                  title="Track User Location"
                  aria-label="Track User Location"
                  data-control="track_location"
              >
                  <span class="mapboxgl-ctrl-icon"></span>
              </button>
              <button
                  class="mapboxgl-ctrl-geolocate hidden"
                  type="button"
                  title="Track User Bearing"
                  aria-label="Track User Bearing"
                  data-control="track_bearing"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/start_tracking_bearing.svg');"></span>
              </button>
              <button
                  class="mapboxgl-ctrl-geolocate hidden"
                  type="button"
                  title="Stop Tracking User Bearing"
                  aria-label="Tracking User Bearing"
                  data-control="stop_tracking_bearing"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/stop_tracking_bearing.svg');"></span>
              </button>
          </div>
          <div class="ctrl-mapstyle-container mapboxgl-ctrl mapboxgl-ctrl-group">
              <button
                  type="button"
                  class="mapboxgl-ctrl-icon ${idMapStyle === "rontomap_satellite" ? "" : "hidden"}"
                  title="Change Map Style"
                  aria-label="Change Map Style"
                  data-control="change_map_style_rontomap_streets_light"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/map_style_change.svg');"></span>
              </button>
              <button
                  type="button"
                  class="mapboxgl-ctrl-icon ${idMapStyle === "rontomap_streets_light" ? "" : "hidden"}"
                  title="Change Map Style"
                  aria-label="Change Map Style"
                  data-control="change_map_style_rontomap_streets_dark"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/map_style_change.svg');"></span>
              </button>
              <button
                  type="button"
                  class="mapboxgl-ctrl-icon ${idMapStyle === "rontomap_streets_dark" ? "" : "hidden"}"
                  title="Change Map Style"
                  aria-label="Change Map Style"
                  data-control="change_map_style_rontomap_satellite"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/map_style_change.svg');"></span>
              </button>
          </div>
        `;

        this._container.addEventListener("click", this._handleClick);
        return this._container;
      }

      onRemove() {
        console.log("LocationControl onRemove");
        this._container.removeEventListener("click", this._handleClick);
        this._container.parentNode.removeChild(this._container);
        this._map = undefined;
      }

      async _requestWakeLock() {
        console.log("_requestWakeLock");
        try {
          if ("wakeLock" in navigator) {
            this._wakeLock = await navigator.wakeLock.request("screen");
            this._isScreenLocked = true;
            console.log("_requestWakeLock > Wake Lock activated.");

            // Add listener for visibility change
            document.addEventListener("visibilitychange", async () => {
              if (this._isScreenLocked && document.visibilityState === "visible") {
                this._wakeLock = await navigator.wakeLock.request("screen");
              }
            });
          } else {
            console.log("_requestWakeLock > Wake Lock API not supported.");
          }
        } catch (err) {
          console.error("_requestWakeLock > Wake Lock request failed:", err);
        }
      }

      _scheduleSnapBackToUser(source) {
        if (this._isSnappingBackToUser) {
          console.log(`Event > map > ${source} > Snap-back already in progress, ignoring.`);
          return;
        }
        this._isSnappingBackToUser = true;

        setTimeout(() => {
          if (this._isUserDragging || this._isUserZooming || this._isUserRotating || this._isUserPitching) {
            console.log(
              `Event > map > ${source} > User is still interacting with the map, not moving back to user location.`,
            );
            this._isSnappingBackToUser = false;
            return;
          }
          if (this._lastPostionLat != null && this._lastPostionLong != null) {
            mapRef.current
              .easeTo({
                center: [this._lastPostionLong, this._lastPostionLat],
                offset: [0, 120],
                duration: 500,
                easing: (t) => t,
              })
              .once("moveend", () => {
                console.log(`Event > map > ${source} > moveend`);
                mapRef.current.getContainer().classList.add("geolocate-track-user-bearing");
                this.showStopTrackingBearingIcon();
                this._isUserMovingMapWhenTrackingBearing = false;
                this._isSnappingBackToUser = false;
              });
          } else {
            mapRef.current.getContainer().classList.add("geolocate-track-user-bearing");
            this.showStopTrackingBearingIcon();
            this._isUserMovingMapWhenTrackingBearing = false;
            this._isSnappingBackToUser = false;
          }
        }, 500);
      }

      async _releaseWakeLock() {
        console.log("_releaseWakeLock");
        if (this._wakeLock && this._isScreenLocked) {
          try {
            await this._wakeLock.release();
            this._wakeLock = null;
            this._isScreenLocked = false;
            console.log("_releaseWakeLock > Wake Lock deactivated.");
          } catch (err) {
            console.error("_releaseWakeLock > Wake Lock release failed:", err);
          }
        }
      }
    }

    // Add geolocate control to the map
    geolocateRef.current = new mapboxgl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 3000,
      },
      trackUserLocation: true,
      showUserHeading: true,
    });

    // Override default _updateCamera to prevent it from moving the camera.
    // All camera movement is handled by the custom "geolocate" event handler below.
    geolocateRef.current._updateCamera = () => {};

    // Override the internal geolocation watcher to poll at a custom interval
    // for more frequent updates than the default watchPosition provides.
    const GPS_POLL_INTERVAL = 500; // ms — poll every 500ms for faster updates
    geolocateRef.current._onSuccess = geolocateRef.current._onSuccess.bind(geolocateRef.current);
    geolocateRef.current._onError = geolocateRef.current._onError.bind(geolocateRef.current);
    const originalSetupFn = geolocateRef.current._setup;
    geolocateRef.current._setup = function () {
      originalSetupFn.call(this);

      // Replace the native watchPosition with a polling getCurrentPosition
      if (this._geolocationWatchID !== undefined) {
        navigator.geolocation.clearWatch(this._geolocationWatchID);
      }
      this._geolocationWatchID = undefined;
      this._gpsPollTimer = setInterval(() => {
        navigator.geolocation.getCurrentPosition(this._onSuccess, this._onError, this.options.positionOptions);
      }, GPS_POLL_INTERVAL);
    };

    // Clean up polling timer when control is removed
    const originalOnRemove = geolocateRef.current.onRemove;
    geolocateRef.current.onRemove = function (map) {
      if (this._gpsPollTimer) {
        clearInterval(this._gpsPollTimer);
        this._gpsPollTimer = null;
      }
      return originalOnRemove.call(this, map);
    };

    geolocateRef.current.on("geolocate", (e) => {
      console.log("Event > geolocate");
      const long = e.coords.longitude;
      const lat = e.coords.latitude;
      const bearing = e.coords.heading ? e.coords.heading : mapRef.current.getBearing();

      // Snap user display position to road during navigation tracking
      const OFF_PATH_THRESHOLD = 30;
      const RENAVIGATE_DELAY = 10000;
      let displayLong = long, displayLat = lat;
      let _routeSnapResult = null;
      if (
        locationControlRef.current.isTrackingBearing() &&
        isNavigationTrackingRef.current &&
        activePathRef.current?.isRoute &&
        activePathRef.current.roadSnap
      ) {
        const _path = activePathRef.current;
        const _h = pathHelpersRef.current;
        const _renderedLine = _h.getRenderedLine(_path);
        if (_renderedLine.length >= 2) {
          const _result = _h.closestPointOnLineWithIndex(_renderedLine, [long, lat]);
          const _dist = haversineDistance([[long, lat], _result.point]);
          if (_dist <= OFF_PATH_THRESHOLD) {
            displayLong = _result.point[0];
            displayLat = _result.point[1];
            _routeSnapResult = { ..._result, renderedLine: _renderedLine, distMeters: _dist };
            if (geolocateRef.current._userLocationDotMarker) {
              geolocateRef.current._userLocationDotMarker.setLngLat([displayLong, displayLat]);
            }
          }
        }
      }

      // If user is currently moving the map while tracking bearing, do not move the map
      if (locationControlRef.current.isUserMovingMapWhenTrackingBearing()) {
        console.log("Event > geolocate > User is moving the map while tracking bearing, ignoring geolocate event.");
        locationControlRef.current._lastPostionLat = lat;
        locationControlRef.current._lastPostionLong = long;
        locationControlRef.current._lastPositionBearing = bearing;
        return;
      }

      if (locationControlRef.current._lastPostionLat == null || locationControlRef.current._lastPostionLong == null) {
        mapRef.current
          .flyTo({
            center: [long, lat],
            zoom: defaultZoomOnUserTrackingLocation,
            duration: 1000,
          })
          .once("moveend", () => {
            console.log("Event > geolocate > moveend");
            locationControlRef.current.showTrackingBearingIcon();
            locationControlRef.current._trackingLocation = true;
          });
      }

      if (locationControlRef.current.isTrackingBearing()) {
        // Use a duration longer than the GPS update interval so the animation
        // is still running when the next geolocate event arrives. This prevents the
        // "stop-and-start" stutter — each new easeTo seamlessly replaces the previous one.
        let duration = 1200;
        if (
          locationControlRef.current._lastPostionLat !== null &&
          locationControlRef.current._lastPostionLong !== null
        ) {
          // Calculate Euclidean distance (rough approximation)
          const distance = Math.sqrt(
            Math.pow(long - locationControlRef.current._lastPostionLong, 2) +
              Math.pow(lat - locationControlRef.current._lastPostionLat, 2),
          );
          if (distance > 0.0005) {
            // Large jump (> ~55 meters) — teleport instantly
            duration = 0;
          }
        }

        locationControlRef.current._isMapBeingControlledProgrammatically = true;
        const moveId = ++locationControlRef.current._programmaticMoveId;
        mapRef.current
          .easeTo({
            center: [displayLong, displayLat],
            offset: [0, 120],
            bearing: bearing,
            duration: duration,
            easing: (t) => t,
          })
          .once("moveend", () => {
            // Only reset the flag if no newer programmatic move has started
            if (locationControlRef.current._programmaticMoveId === moveId) {
              console.log("Event > geolocate > moveend");
              locationControlRef.current._isMapBeingControlledProgrammatically = false;
            }
          });
      } else if (locationControlRef.current.isTrackingLocation()) {
        mapRef.current.easeTo({
          center: [long, lat],
          duration: 500,
          easing: (t) => t,
        });
      }
      // Save last position
      locationControlRef.current._lastPostionLat = lat;
      locationControlRef.current._lastPostionLong = long;
      locationControlRef.current._lastPositionBearing = bearing;

      // === Passed Navigation Path Update ===
      if (isNavigationTrackingRef.current && activePathRef.current?.isRoute) {
        const path = activePathRef.current;
        const h = pathHelpersRef.current;
        const userPos = [long, lat];

        let renderedLine, point, segmentIndex, paramT, distMeters;
        if (_routeSnapResult) {
          renderedLine = _routeSnapResult.renderedLine;
          point = _routeSnapResult.point;
          segmentIndex = _routeSnapResult.segmentIndex;
          paramT = _routeSnapResult.t;
          distMeters = _routeSnapResult.distMeters;
        } else {
          renderedLine = h.getRenderedLine(path);
          if (renderedLine.length < 2) { renderedLine = []; }
          else {
            const result = h.closestPointOnLineWithIndex(renderedLine, userPos);
            point = result.point;
            segmentIndex = result.segmentIndex;
            paramT = result.t;
            distMeters = haversineDistance([userPos, point]);
          }
        }

        if (renderedLine.length >= 2) {
          if (distMeters > OFF_PATH_THRESHOLD) {
            // User is off-path
            if (!isOffPathRef.current) {
              isOffPathRef.current = true;
              offPathCoordsRef.current = [
                passedPathCoordsRef.current.length > 0
                  ? passedPathCoordsRef.current[passedPathCoordsRef.current.length - 1]
                  : point,
              ];
              // Only renavigate for regular navigation, not path tracing
              if (!isTracingPathRef.current) {
                // Record which vertex segment user was on
                const snap = h.snapToPath(path, point || userPos);
                offPathVertexSegRef.current = snap.segmentIndex;
                // Start delayed renavigate
                offPathTimerRef.current = setTimeout(() => {
                  offPathTimerRef.current = null;
                  if (!isRenavigatingRef.current) {
                    isRenavigatingRef.current = true;
                    handleRenavigate().finally(() => { isRenavigatingRef.current = false; });
                  }
                }, RENAVIGATE_DELAY);
              }
            }
            offPathCoordsRef.current.push(userPos);
          } else {
            // User is on-path — cancel pending renavigate
            if (isOffPathRef.current) {
              isOffPathRef.current = false;
              offPathCoordsRef.current = [];
              if (offPathTimerRef.current) {
                clearTimeout(offPathTimerRef.current);
                offPathTimerRef.current = null;
              }
            }

            // Enforce forward-only split (prevent GPS jitter causing backward jumps)
            if (
              segmentIndex > routeSplitIndexRef.current ||
              (segmentIndex === routeSplitIndexRef.current && paramT >= routeSplitTRef.current)
            ) {
              routeSplitIndexRef.current = segmentIndex;
              routeSplitTRef.current = paramT;
            }

            // Build passed coords: all line coords up to split point
            const si = routeSplitIndexRef.current;
            const st = routeSplitTRef.current;
            const passedCoords = renderedLine.slice(0, si + 1);
            if (si < renderedLine.length - 1) {
              const a = renderedLine[si];
              const b = renderedLine[si + 1];
              passedCoords.push([a[0] + st * (b[0] - a[0]), a[1] + st * (b[1] - a[1])]);
            }
            passedPathCoordsRef.current = passedCoords;
            h.updatePassedPathLine(passedCoords, path.roadSnap);

            // Update sight colors for passed sights
            if (path.sights) {
              for (const m of path.sights) {
                const sightPos = m.getLngLat();
                const sightSnap = h.closestPointOnLineWithIndex(renderedLine, [sightPos.lng, sightPos.lat]);
                const passed = sightSnap.segmentIndex < si || (sightSnap.segmentIndex === si && sightSnap.t <= st);
                if (passed && !m._passed) {
                  m._passed = true;
                  const el = m.getElement();
                  const svg = el.querySelector("svg");
                  if (svg) {
                    svg.querySelectorAll("path[fill]").forEach((p) => { p.setAttribute("fill", "#0000ff"); });
                    const circle = svg.querySelector("circle");
                    if (circle) circle.setAttribute("fill", "#ffffff");
                  }
                }
              }
            }

            // Update remaining distance/duration display
            if (routeTotalDistanceRef.current != null) {
              const passedDist = haversineDistance(passedCoords);
              const remaining = Math.max(0, routeTotalDistanceRef.current - passedDist);
              setNavRouteDistance(remaining);
              if (path.routeDuration != null && routeTotalDistanceRef.current > 0) {
                setNavRouteDuration(path.routeDuration * (remaining / routeTotalDistanceRef.current));
              }
            }
          }
        }
      }

      // === Route Recording (web only — native uses BackgroundGeolocation watcher) ===
      if (!Capacitor.isNativePlatform() && isRecordingTrackRef.current && trackPathRef.current) {
        const recCoord = [long, lat];
        trackCoordsRef.current.push(recCoord);
        const recPath = trackPathRef.current;
        const source = mapRef.current?.getSource(recPath.sourceId);
        if (source && trackCoordsRef.current.length >= 2) {
          source.setData({
            type: "FeatureCollection",
            features: [makeFeature(trackCoordsRef.current, "#0000ff")],
          });
        }
        // Update end vertex marker
        if (recPath.vertices.length === 1) {
          const endMarker = createPathVertex(recCoord);
          endMarker.setDraggable(false);
          endMarker.getElement().classList.remove("active-path-feature");
          recPath.vertices.push({ lngLat: recCoord, marker: endMarker, path: recPath });
          updateVertexStyles(recPath);
        } else if (recPath.vertices.length >= 2) {
          const endV = recPath.vertices[recPath.vertices.length - 1];
          endV.lngLat = recCoord;
          endV.marker.setLngLat(recCoord);
        }
      }
    });

    // Mouse button down: track left/right for cursor changes
    mapRef.current.getContainer().addEventListener("mousedown", (ev) => {
      if (ev.button === 0) mapRef.current.getContainer().classList.add("map-mousedown");
      if (ev.button === 2) mapRef.current.getContainer().classList.add("map-right-mousedown");
    });
    window.addEventListener("mouseup", (ev) => {
      if (ev.button === 0) mapRef.current.getContainer().classList.remove("map-mousedown");
      if (ev.button === 2) {
        mapRef.current.getContainer().classList.remove("map-right-mousedown");
        mapRef.current.getContainer().classList.remove("map-right-dragging");
      }
    });

    // On dragstart
    mapRef.current.on("dragstart", () => {
      console.log("Event > map > dragstart");
      mapRef.current.getContainer().classList.add("map-dragging");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > dragstart > Ignoring dragstart event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current.isTrackingLocation()) {
        locationControlRef.current.stopTrackingLocation();
      } else if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current.hideTrackingIcons();
        locationControlRef.current._isUserMovingMapWhenTrackingBearing = true;
        locationControlRef.current._isUserDragging = true;
        mapRef.current.getContainer().classList.remove("geolocate-track-user-bearing");
      }
    });

    // On dragend
    mapRef.current.on("dragend", () => {
      console.log("Event > map > dragend");
      mapRef.current.getContainer().classList.remove("map-dragging");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log("Event > map > dragend > Ignoring dragend event because map is being controlled programmatically.");
        return;
      }
      if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current._isUserDragging = false;
        locationControlRef.current._scheduleSnapBackToUser("dragend");
      }
    });

    // On zoomstart
    mapRef.current.on("zoomstart", () => {
      console.log("Event > map > zoomstart");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > zoomstart > Ignoring zoomstart event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current.isTrackingLocation()) {
        locationControlRef.current.stopTrackingLocation();
      } else if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current.hideTrackingIcons();
        locationControlRef.current._isUserMovingMapWhenTrackingBearing = true;
        locationControlRef.current._isUserZooming = true;
        mapRef.current.getContainer().classList.remove("geolocate-track-user-bearing");
      }
    });

    // On zoomend
    mapRef.current.on("zoomend", () => {
      console.log("Event > map > zoomend");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log("Event > map > zoomend > Ignoring zoomend event because map is being controlled programmatically.");
        return;
      }
      if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current._isUserZooming = false;
        locationControlRef.current._scheduleSnapBackToUser("zoomend");
      }
    });

    // On rotatestart
    mapRef.current.on("rotatestart", () => {
      console.log("Event > map > rotatestart");
      if (mapRef.current.getContainer().classList.contains("map-right-mousedown")) {
        mapRef.current.getContainer().classList.add("map-right-dragging");
      } else {
        mapRef.current.getContainer().classList.add("map-dragging");
      }
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > rotatestart > Ignoring rotatestart event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current.isTrackingLocation()) {
        locationControlRef.current.stopTrackingLocation();
      } else if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current.hideTrackingIcons();
        locationControlRef.current._isUserMovingMapWhenTrackingBearing = true;
        locationControlRef.current._isUserRotating = true;
        mapRef.current.getContainer().classList.remove("geolocate-track-user-bearing");
      }
    });

    // On rotateend
    mapRef.current.on("rotateend", () => {
      console.log("Event > map > rotateend");
      mapRef.current.getContainer().classList.remove("map-dragging");
      mapRef.current.getContainer().classList.remove("map-right-dragging");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > rotateend > Ignoring rotateend event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current._isUserRotating = false;
        locationControlRef.current._scheduleSnapBackToUser("rotateend");
      }
    });

    // On pitchstart
    mapRef.current.on("pitchstart", () => {
      console.log("Event > map > pitchstart");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > pitchstart > Ignoring pitchstart event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current.isTrackingLocation()) {
        locationControlRef.current.stopTrackingLocation();
      } else if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current.hideTrackingIcons();
        locationControlRef.current._isUserMovingMapWhenTrackingBearing = true;
        locationControlRef.current._isUserPitching = true;
        mapRef.current.getContainer().classList.remove("geolocate-track-user-bearing");
      }
    });

    // On pitchend
    mapRef.current.on("pitchend", () => {
      console.log("Event > map > pitchend");
      if (locationControlRef.current._isMapBeingControlledProgrammatically) {
        console.log(
          "Event > map > pitchend > Ignoring pitchend event because map is being controlled programmatically.",
        );
        return;
      }
      if (locationControlRef.current?.isTrackingBearing()) {
        locationControlRef.current._isUserPitching = false;
        locationControlRef.current._scheduleSnapBackToUser("pitchend");
      }
    });

    const canvas = mapRef.current.getCanvasContainer();

    // Click on map: add vertex in path mode (debounced to avoid double-tap conflicts)
    let clickTimer = null;
    mapRef.current.on("click", (e) => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (geocoderOpenRef.current) return;
        if (locationControlRef.current?.isTrackingBearing()) return;
        if (pathClickHandledRef.current) return;
        if (longPressHandledRef.current) {
          longPressHandledRef.current = false;
          return;
        }

        // Embedded mode: ignore single clicks (toggle is on dblclick)
        if (isEmbeddedRef.current) return;

        // Path mode: add vertex or start new path
        if (isPathModeRef.current) {
          let path = activePathRef.current;
          if (!path || path.isFinished) {
            // Start a new path at the click location
            const id = `path-${Date.now()}`;
            const newPath = {
              id,
              sourceId: `path-line-source-${id}`,
              layerId: `path-line-layer-${id}`,
              vertices: [],
              midpoints: [],
              isFinished: false,
            };
            if (isNavigationModeRef.current) newPath.isRoute = true;
            pathsRef.current.push(newPath);
            activePathRef.current = newPath;
            pathHelpersRef.current.ensurePathLayer(newPath);
            path = newPath;
          }
          const lngLat = [e.lngLat.lng, e.lngLat.lat];
          const h = pathHelpersRef.current;
          if (path.vertices.length > 0) pushPathSnapshot(path);
          const marker = h.createPathVertex(lngLat);
          const vertex = { lngLat, marker, path };
          if (forceModeRef.current) vertex.force = true;
          path.vertices.push(vertex);
          setPathVertexCount(path.vertices.length);
          if (!pathPointToastShownRef.current) {
            pathPointToastShownRef.current = true;
            setToastMsg("Click a point to remove it, or hold and drag it.");
            setTimeout(() => {
              setToastMsg(null);
            }, 3000);
          }
          h.attachVertexDragHandler(vertex);
          h.attachFinishHandler(vertex);
          h.updateVertexStyles(path);
          h.updatePathLine(path);
          h.rebuildMidpoints(path);
          h.updateVertexStyles(path);
          if (path.roadSnap) h.fetchRoadSnap(path);
        }
      }, 300);
    });

    // Track right-click drag to suppress context menu after camera rotation
    let rightMouseMoved = false;
    let rightMouseStartPos = null;
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) {
        rightMouseMoved = false;
        rightMouseStartPos = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (rightMouseStartPos) {
        const dx = e.clientX - rightMouseStartPos.x;
        const dy = e.clientY - rightMouseStartPos.y;
        if (dx * dx + dy * dy > 25) rightMouseMoved = true;
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) rightMouseStartPos = null;
    });

    // Prevent browser default context menu on the map
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });

    // Right click on map: open context menu
    mapRef.current.on("contextmenu", (e) => {
      if (isPathModeRef.current) return;
      if (isEmbeddedRef.current) return;
      if (featureMenuOpenedRef.current) return;
      if (geocoderOpenRef.current) return;
      if (rightMouseMoved) {
        rightMouseMoved = false;
        return;
      }

      const point = e.point;
      for (const p of pathsRef.current) {
        if (!p._hitLayerId) continue;
        const features = mapRef.current.queryRenderedFeatures(point, { layers: [p._hitLayerId] });
        if (features.length > 0) {
          const rect = mapRef.current.getContainer().getBoundingClientRect();
          setMapClickMenu({ lngLat: e.lngLat, x: rect.left + point.x, y: rect.top + point.y, path: p });
          return;
        }
      }

      const rect = mapRef.current.getContainer().getBoundingClientRect();
      setMapClickMenu({ lngLat: e.lngLat, x: rect.left + point.x, y: rect.top + point.y });
    });

    // Long press on mobile: open context menu
    let longPressTimer = null;
    let longPressStartPos = null;
    canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          return;
        }
        const touch = e.touches[0];
        longPressStartPos = { x: touch.clientX, y: touch.clientY };
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (isPathModeRef.current) return;
          if (featureMenuOpenedRef.current) return;
          if (isEmbeddedRef.current) return;
          longPressHandledRef.current = true;
          // Suppress the map click that follows touchend
          if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
          }
          // Stop map from dragging after long press opens menu
          mapRef.current.dragPan.disable();
          setTimeout(() => {
            mapRef.current.dragPan.enable();
          }, 0);

          const rect = mapRef.current.getContainer().getBoundingClientRect();
          const point = new mapboxgl.Point(longPressStartPos.x - rect.left, longPressStartPos.y - rect.top);
          const lngLat = mapRef.current.unproject(point);

          // Check for path hits
          for (const p of pathsRef.current) {
            if (!p._hitLayerId) continue;
            const features = mapRef.current.queryRenderedFeatures(point, { layers: [p._hitLayerId] });
            if (features.length > 0) {
              setMapClickMenu({ lngLat, x: longPressStartPos.x, y: longPressStartPos.y, path: p });
              return;
            }
          }

          setMapClickMenu({ lngLat, x: longPressStartPos.x, y: longPressStartPos.y });
        }, 500);
      },
      { passive: true },
    );
    canvas.addEventListener(
      "touchmove",
      (e) => {
        if (longPressTimer && e.touches.length === 1) {
          const touch = e.touches[0];
          const dx = touch.clientX - longPressStartPos.x;
          const dy = touch.clientY - longPressStartPos.y;
          if (dx * dx + dy * dy > 100) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        }
      },
      { passive: true },
    );
    canvas.addEventListener(
      "touchend",
      () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      },
      { passive: true },
    );
    canvas.addEventListener(
      "touchcancel",
      () => {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      },
      { passive: true },
    );

    // Add the geolocate control to the map without adding it to the UI
    if (!isEmbeddedRef.current) {
      mapRef.current.addControl(geolocateRef.current);
      geolocateRef.current._container.style.display = "none";
    }

    // Add search control with custom styling
    const geocoder = new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl: mapboxgl,
      marker: false,
      placeholder: "Search",
      collapsed: true,
    });
    mapRef.current.addControl(geocoder, "top-left");
    geocoderRef.current = geocoder;

    // Focus on user input when search icon is clicked
    const geocoderEl = document.querySelector(".mapboxgl-ctrl-geocoder");
    if (geocoderEl) {
      if (isEmbeddedRef.current) {
        // In embedded mode, hide geocoder and show logo link to full Rontomap
        geocoderEl.style.display = "none";

        const url = new URL(window.location.href);
        url.searchParams.delete("embedded");
        url.searchParams.delete("style");

        const logoContainer = document.createElement("div");
        logoContainer.className = "mapboxgl-ctrl mapboxgl-ctrl-group rontomap-logo";

        const logoBtn = document.createElement("button");
        logoBtn.type = "button";
        logoBtn.className = "mapboxgl-ctrl-icon";
        logoBtn.title = "Open in Rontomap";
        logoBtn.setAttribute("aria-label", "Open in Rontomap");
        logoBtn.addEventListener("click", () => {
          window.open(url.toString(), "_blank", "noopener,noreferrer");
        });

        const logoSpan = document.createElement("span");
        logoSpan.className = "mapboxgl-ctrl-icon";
        logoSpan.style.cssText =
          "background-image: url('/logo512_nobg.png') !important; background-size: 29px 29px !important;";

        logoBtn.appendChild(logoSpan);
        logoContainer.appendChild(logoBtn);

        const topLeftCtrl = mapRef.current.getContainer().querySelector(".mapboxgl-ctrl-top-left");
        if (topLeftCtrl) topLeftCtrl.appendChild(logoContainer);
      } else {
        geocoderEl.addEventListener("click", () => {
          const input = geocoderEl.querySelector("input");
          input?.focus();
        });
      }

      // Disable right-click on geocoder suggestions (block selection + context menu)
      const blockRightClick = (e) => {
        if (e.button === 2 && e.target.closest(".mapboxgl-ctrl-geocoder .suggestions")) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      const blockContextMenu = (e) => {
        if (e.target.closest(".mapboxgl-ctrl-geocoder .suggestions")) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      document.addEventListener("mousedown", blockRightClick, true);
      document.addEventListener("mouseup", blockRightClick, true);
      document.addEventListener("contextmenu", blockContextMenu, true);
    }

    // Capture geocoder expanded state on mousedown/touchstart (before the geocoder auto-collapses)
    const captureGeocoderState = () => {
      const el = document.querySelector(".mapboxgl-ctrl-geocoder");
      if (el && !el.classList.contains("mapboxgl-ctrl-geocoder--collapsed")) {
        const input = el.querySelector("input");
        geocoderOpenRef.current = !input?.value;
      } else {
        geocoderOpenRef.current = false;
      }
    };
    document.addEventListener("mousedown", captureGeocoderState, true);
    document.addEventListener("touchstart", captureGeocoderState, true);

    // When user clicks on search result stop tracking bearing and location, clear and collapse search input
    geocoder.on("result", () => {
      console.log("Event > geocoder result > Stop tracking and clear search input");
      if (locationControlRef.current) {
        if (locationControlRef.current.isTrackingBearing() || locationControlRef.current.isTrackingLocation()) {
          locationControlRef.current.stopTrackingLocationAndBearing();
        }
      }

      // Clear and hide geocoder and keyboard
      geocoder.clear();
      const geocoderEl = document.querySelector(".mapboxgl-ctrl-geocoder");
      if (geocoderEl) {
        const input = geocoderEl.querySelector("input");
        input?.blur();
        document.activeElement?.blur();
        geocoderEl.classList.add("mapboxgl-ctrl-geocoder--collapsed");
      }
    });

    // Initialize custom location control
    locationControlRef.current = new LocationControl(geolocateRef.current, mapRef.current);
    mapRef.current.addControl(locationControlRef.current, "top-right");
    // Move location buttons to bottom-right container
    const locationDiv = locationControlRef.current._container.querySelector(".ctrl-location-container");
    const bottomRight = mapRef.current.getContainer().querySelector(".mapboxgl-ctrl-bottom-right");
    if (locationDiv && bottomRight) {
      bottomRight.appendChild(locationDiv);
    }
    if (isEmbeddedRef.current && locationDiv) {
      locationDiv.style.display = "none";
    }

    // Add compass icon
    const nav = new mapboxgl.NavigationControl({
      showZoom: false,
      visualizePitch: true,
    });
    mapRef.current.addControl(nav, "top-right");
    mapRef.current.addControl(new mapboxgl.ScaleControl({ maxWidth: 100 }), "bottom-left");
    mapRef.current.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-left");

    // On small screens, hide scale + logo when attribution is expanded
    const attribEl = mapRef.current.getContainer().querySelector(".mapboxgl-ctrl-attrib");
    if (attribEl) {
      const observer = new MutationObserver(() => {
        const open = attribEl.classList.contains("mapboxgl-compact-show");
        mapRef.current?.getContainer()?.classList.toggle("attrib-open", open);
      });
      observer.observe(attribEl, { attributes: true, attributeFilter: ["class"] });
    }

    // Add custom className to the compass container
    if (isEmbeddedRef.current) {
      nav._container.style.position = "absolute";
      nav._container.style.top = "46px";
      nav._container.style.right = "0px";
    } else {
      nav._container.classList.add("ctrl-compass-container");
    }

    // Hide compass when bearing is 0
    const compassBtn = nav._container.querySelector(".mapboxgl-ctrl-compass");
    if (compassBtn) {
      const updateCompassVisibility = () => {
        const bearing = mapRef.current?.getBearing() ?? 0;
        compassBtn.style.display = Math.abs(bearing) < 0.5 ? "none" : "";
      };
      mapRef.current.on("rotate", updateCompassVisibility);
      updateCompassVisibility();
    }

    // Enable rotation gestures (right-click drag on desktop, two-finger rotate on mobile)

    // Middle mouse button drag: rotate camera in place (no orbit)
    let middleDrag = false;
    let middleLastX = 0;
    let middleLastY = 0;
    mapRef.current.getCanvas().addEventListener("mousedown", (ev) => {
      if (ev.button === 1) {
        middleDrag = true;
        middleLastX = ev.clientX;
        middleLastY = ev.clientY;
        mapRef.current.getCanvas().style.cursor = "crosshair";
        ev.preventDefault();
      }
    });
    window.addEventListener("mousemove", (ev) => {
      if (!middleDrag) return;
      mapRef.current.getCanvas().style.cursor = "crosshair";
      const dx = ev.clientX - middleLastX;
      const dy = ev.clientY - middleLastY;
      middleLastX = ev.clientX;
      middleLastY = ev.clientY;
      const newBearing = mapRef.current.getBearing() + dx * 0.5;
      const newPitch = Math.max(0, Math.min(85, mapRef.current.getPitch() - dy * 0.5));
      // Use free camera API to rotate in place without orbiting
      const camera = mapRef.current.getFreeCameraOptions();
      camera.setPitchBearing(newPitch, newBearing);
      mapRef.current.setFreeCameraOptions(camera);
    });
    window.addEventListener("mouseup", (ev) => {
      if (ev.button === 1) {
        middleDrag = false;
        mapRef.current.getCanvas().style.cursor = "";
      }
    });

    // Enable pinch-to-zoom and rotate gestures on touch devices
    mapRef.current.touchZoomRotate.enable();

    // Disable one-tap-then-drag-to-zoom gesture
    if (mapRef.current.touchZoomRotate._tapDragZoom) mapRef.current.touchZoomRotate._tapDragZoom.disable();

    // Embedded mode: focus-based interaction gating
    if (isEmbeddedRef.current) {
      const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
      const map = mapRef.current;
      const container = map.getContainer();

      const showEmbeddedToast = (msg) => {
        clearTimeout(embeddedToastTimerRef.current);
        setToastMsg(msg);
        embeddedToastTimerRef.current = setTimeout(() => {
          setToastMsg(null);
        }, 2000);
      };

      if (isTouchDevice) {
        // Touch: enable zoom, rotate, pitch — drag gated by focus
        map.touchZoomRotate.enable();
        if (map.touchZoomRotate._tapDragZoom) map.touchZoomRotate._tapDragZoom.disable();
        map.touchPitch.enable();
        map.dragRotate.enable();
        map.dragPan.disable();

        // Track focus to enable/disable drag
        window.addEventListener("focus", () => {
          embeddedFocusedRef.current = true;
          map.dragPan.enable();
        });
        window.addEventListener("blur", () => {
          embeddedFocusedRef.current = false;
          map.dragPan.disable();
        });

        // Show toast when user tries to drag while unfocused
        let touchDragDetected = false;
        canvas.addEventListener(
          "touchstart",
          (e) => {
            touchDragDetected = e.touches.length === 1;
          },
          { passive: true },
        );
        canvas.addEventListener(
          "touchmove",
          () => {
            if (touchDragDetected && !embeddedFocusedRef.current) {
              touchDragDetected = false;
              showEmbeddedToast("Tap first then drag.");
            }
          },
          { passive: true },
        );
        canvas.addEventListener(
          "touchend",
          () => {
            touchDragDetected = false;
          },
          { passive: true },
        );
      } else {
        // Desktop: enable drag, rotate, pitch — scroll zoom gated by focus
        map.dragPan.enable();
        map.dragRotate.enable();
        map.keyboard.enable();
        map.boxZoom.enable();
        map.scrollZoom.disable();

        // Track focus to enable/disable scroll zoom
        window.addEventListener("focus", () => {
          embeddedFocusedRef.current = true;
          map.scrollZoom.enable();
        });
        window.addEventListener("blur", () => {
          embeddedFocusedRef.current = false;
          map.scrollZoom.disable();
        });

        // Show toast when user tries to scroll zoom while unfocused
        container.addEventListener(
          "wheel",
          () => {
            if (!embeddedFocusedRef.current) {
              showEmbeddedToast("Click first then scroll.");
            }
          },
          { passive: true },
        );
      }
    }

    // Recreate single marker from URL params
    const markerParam = getQueryParams("marker");
    if (markerParam) {
      const parts = markerParam.split("-");
      const markerLat = parseFloat(parts[0]);
      const markerLng = parseFloat(parts[1]);
      if (!isNaN(markerLat) && !isNaN(markerLng)) {
        const m = createMarker([markerLng, markerLat]);
        const markerName = decodeURIComponent(parts.slice(2).join("-"));
        if (markerName) {
          m._markerName = markerName;
          updateMarkerLabel(m);
        }
        featuresLockedRef.current = true;
        setFeaturesLocked(true);
        m.setDraggable(false);
        mapRef.current.getContainer().classList.add("features-locked");
      }
    }

    // Recreate markers from a Firebase features collection
    const featuresCollectionId = getQueryParams("features_collection");
    if (featuresCollectionId) {
      getDoc(doc(db, "featuresCollections", featuresCollectionId)).then((snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        materializeFeatures(data, { createMarker, pathHelpersRef, updateMarkerLabel, deserializeSnappedSegments, pathsRef });
        // Lock features when loaded from URL
        featuresLockedRef.current = true;
        setFeaturesLocked(true);
        mapRef.current.getContainer().classList.add("features-locked");
        markersRef.current.forEach((m) => m.setDraggable(false));
        pathsRef.current.forEach((p) => {
          p.vertices.forEach((v) => v.marker.setDraggable(false));
        });
      });
    }
  }, []);

  // Handle file open from Android intent (e.g. opening a .gpx from Files app)
  useEffect(() => {
    const handleFileOpen = async () => {
      const fileData = window.__importFileData;
      if (!fileData) return;
      delete window.__importFileData;

      try {
        const { name, base64 } = fileData;
        const isBinary = name.toLowerCase().endsWith(".fit");
        let content;
        if (isBinary) {
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          content = bytes.buffer;
        } else {
          content = atob(base64);
        }

        const { data } = await importFromContent(name, content);
        const createMarker = createMarkerRef.current;
        const result = materializeFeatures(data, { createMarker, pathHelpersRef, updateMarkerLabel, deserializeSnappedSegments, pathsRef });

        // Fly to fit all imported content
        const map = mapRef.current;
        if (map) {
          const bounds = new mapboxgl.LngLatBounds();
          markersRef.current.forEach(m => bounds.extend(m.getLngLat()));
          pathsRef.current.forEach(p => {
            p.vertices.forEach(v => bounds.extend(v.lngLat));
            if (p.snappedSegments) p.snappedSegments.forEach(s => s.coords.forEach(c => bounds.extend(c)));
          });
          if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, duration: 1000 });
        }

        const parts = [];
        if (result.markerCount > 0) parts.push(`${result.markerCount} marker${result.markerCount > 1 ? "s" : ""}`);
        if (result.pathCount > 0) parts.push(`${result.pathCount} path${result.pathCount > 1 ? "s" : ""}`);
        let msg = `Imported ${parts.join(", ")}.`;
        if (result.skipped > 0) msg += ` ${result.skipped} feature${result.skipped > 1 ? "s" : ""} skipped.`;
        setToastMsg(msg);
        setTimeout(() => setToastMsg(null), 3000);
      } catch (e) {
        setToastMsg(e.message);
        setTimeout(() => setToastMsg(null), 3000);
      }
    };

    window.addEventListener("rontomap-file-open", handleFileOpen);
    // Also check if data was set before the listener was registered
    if (window.__importFileData) handleFileOpen();

    return () => window.removeEventListener("rontomap-file-open", handleFileOpen);
  }, []);

  // When changing map style preserve the current camera state
  useEffect(() => {
    console.log("useEffect > Change map style:", mapStyle);
    if (!mapRef.current || !mapStyle) return;
    const map = mapRef.current;
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    map.setStyle(mapStyle, { diff: false });
    map.once("style.load", () => {
      map.jumpTo({
        center,
        zoom,
        bearing,
        pitch,
      });
      pathsRef.current.forEach((path) => {
        pathHelpersRef.current.ensurePathLayer(path);
        pathHelpersRef.current.updatePathLine(path);
        pathHelpersRef.current.updateVertexStyles(path);
        if (!path.isFinished) pathHelpersRef.current.rebuildMidpoints(path);
      });
      if (featuresLockedRef.current) {
        const container = mapRef.current?.getContainer();
        if (container) container.classList.add("features-locked");
      }
      // Re-enable dragging on the active path being edited
      const active = activePathRef.current;
      if (active && !active.isFinished) {
        active.vertices.forEach((v) => v.marker.setDraggable(true));
        active.midpoints.forEach((mp) => mp.marker.setDraggable(true));
        if (active.sights) active.sights.forEach((m) => m.setDraggable(true));
      }
      // Restore passed path overlay during navigation
      if (active && isNavigationTrackingRef.current && passedPathCoordsRef.current.length >= 2) {
        pathHelpersRef.current.ensurePassedPathLayer(active);
        pathHelpersRef.current.updatePassedPathLine(passedPathCoordsRef.current, active.roadSnap);
      }
    });
  }, [mapStyle]);

  // Keep refs in sync with state
  useEffect(() => {
    idMapStyleRef.current = idMapStyle;
  }, [idMapStyle]);
  useEffect(() => {
    isPathModeRef.current = isPathMode;
  }, [isPathMode]);
  useEffect(() => {
    forceModeRef.current = forceMode;
  }, [forceMode]);
  useEffect(() => {
    cancelPathAlertRef.current = cancelPathAlert;
  }, [cancelPathAlert]);
  useEffect(() => {
    isRecordingTrackRef.current = isRecordingTrack;
  }, [isRecordingTrack]);
  useEffect(() => {
    cancelNavigationAlertRef.current = cancelNavigationAlert;
  }, [cancelNavigationAlert]);
  useEffect(() => {
    circuitAlertRef.current = circuitAlert;
  }, [circuitAlert]);

  // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z/Ctrl+Y redo, ESC cancel/close geocoder, Enter dismiss alert
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Enter" && circuitAlertRef.current) {
        e.preventDefault();
        setCircuitAlert(false);
        confirmCircuit();
        return;
      }
      if (e.key === "Escape" && circuitAlertRef.current) {
        e.preventDefault();
        setCircuitAlert(false);
        pendingCircuitPathRef.current = null;
        return;
      }
      if (e.key === "Enter" && cancelNavigationAlertRef.current) {
        e.preventDefault();
        setCancelNavigationAlert(false);
        confirmCancelNavigation();
        return;
      }
      if (e.key === "Enter" && cancelPathAlertRef.current) {
        e.preventDefault();
        setCancelPathAlert(false);
        confirmCancelPath();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && isPathModeRef.current) {
        e.preventDefault();
        undoPath();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "Z" || e.key === "y") && isPathModeRef.current) {
        e.preventDefault();
        redoPath();
        return;
      }
      if (e.key !== "Escape") return;
      const el = document.querySelector(".mapboxgl-ctrl-geocoder");
      if (el && !el.classList.contains("mapboxgl-ctrl-geocoder--collapsed")) {
        e.stopPropagation();
        e.preventDefault();
        if (geocoderRef.current) geocoderRef.current.clear();
        const input = el.querySelector("input");
        if (input) input.blur();
        el.classList.add("mapboxgl-ctrl-geocoder--collapsed");
        geocoderOpenRef.current = false;
        return;
      }
      if (isPathModeRef.current) {
        e.stopPropagation();
        e.preventDefault();
        if (cancelNavigationAlertRef.current) {
          setCancelNavigationAlert(false);
        } else if (cancelPathAlertRef.current) {
          setCancelPathAlert(false);
        } else if (isNavigationModeRef.current) {
          setCancelNavigationAlert(true);
        } else {
          setCancelPathAlert(true);
        }
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // WASD keys for map navigation (mirrors arrow key behavior)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handler = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
      if (!map.keyboard.isActive() && !map.keyboard.isEnabled()) return;

      const key = e.key.toLowerCase();
      let xDir = 0,
        yDir = 0,
        bearingDir = 0,
        pitchDir = 0;
      switch (key) {
        case "a":
          e.shiftKey ? (bearingDir = -1) : (xDir = -1);
          break;
        case "d":
          e.shiftKey ? (bearingDir = 1) : (xDir = 1);
          break;
        case "w":
          e.shiftKey ? (pitchDir = 1) : (yDir = -1);
          break;
        case "s":
          e.shiftKey ? (pitchDir = -1) : (yDir = 1);
          break;
        default:
          return;
      }
      e.preventDefault();
      map.easeTo(
        {
          duration: 300,
          easeId: "keyboardHandler",
          easing: (t) => t * (2 - t),
          zoom: map.getZoom(),
          bearing: map.getBearing() + bearingDir * 15,
          pitch: map.getPitch() + pitchDir * 10,
          offset: [-xDir * 100, -yDir * 100],
          center: map.getCenter(),
        },
        { originalEvent: e },
      );
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Warn before leaving page during path editing
  useEffect(() => {
    if (!isPathMode) return;
    const handler = (e) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isPathMode]);

  // Native Android back button: undo path action via @capacitor/app
  useEffect(() => {
    if (!isPathMode) return;
    if (!Capacitor.isNativePlatform()) return;
    const listener = CapApp.addListener("backButton", () => {
      if (!isPathModeRef.current) return;
      if (pathUndoStackRef.current.length > 0) {
        undoPath();
      } else if (isNavigationModeRef.current) {
        setCancelNavigationAlert(true);
      } else {
        setCancelPathAlert(true);
      }
    });
    return () => { listener.then((l) => l.remove()); };
  }, [isPathMode]);

  // PWA back button: undo path action via popstate history guards (standalone mode only)
  useEffect(() => {
    if (!isPathMode) return;
    if (Capacitor.isNativePlatform()) return;
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (!isStandalone) return;
    let active = true;
    let depth = 0;
    for (let i = 0; i < 30; i++) {
      window.history.pushState({ pathEditing: true }, "");
      depth++;
    }
    const handler = () => {
      if (!active || !isPathModeRef.current) return;
      depth--;
      if (pathUndoStackRef.current.length > 0) {
        undoPath();
      } else if (isNavigationModeRef.current) {
        setCancelNavigationAlert(true);
      } else {
        setCancelPathAlert(true);
      }
    };
    window.addEventListener("popstate", handler);
    return () => {
      active = false;
      window.removeEventListener("popstate", handler);
      if (depth > 0) window.history.go(-depth);
    };
  }, [isPathMode]);

  // Show/remove temporary dot or glow at context menu location
  useEffect(() => {
    if (!mapClickMenu || !mapRef.current) return;
    if (mapClickMenu.path) {
      // Glow the entire path: line, vertices, midpoints, attached markers
      const path = mapClickMenu.path;
      const map = mapRef.current;
      const layerId = path.layerId;
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "line-width", 6);
        map.setPaintProperty(layerId, "line-opacity", 0.8);
      }
      const glowEls = [];
      path.vertices.forEach((v) => {
        const el = v.marker.getElement();
        el.classList.add("feature-glow");
        glowEls.push(el);
      });
      path.midpoints.forEach((mp) => {
        const el = mp.marker.getElement();
        el.classList.add("feature-glow");
        glowEls.push(el);
      });
      if (path.sights) {
        path.sights.forEach((m) => {
          const el = m.getElement();
          el.classList.add("feature-glow");
          glowEls.push(el);
        });
      }
      return () => {
        longPressHandledRef.current = false;
        if (map.getLayer(layerId)) {
          map.setPaintProperty(layerId, "line-width", ["coalesce", ["get", "width"], 3]);
          map.setPaintProperty(layerId, "line-opacity", 1);
        }
        glowEls.forEach((el) => el.classList.remove("feature-glow"));
      };
    }
    // Plain map click — show dot
    const el = document.createElement("div");
    el.className = "context-dot";
    const dot = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat(mapClickMenu.lngLat)
      .addTo(mapRef.current);
    contextDotRef.current = dot;
    return () => {
      longPressHandledRef.current = false;
      if (contextDotRef.current) {
        contextDotRef.current.remove();
        contextDotRef.current = null;
      }
    };
  }, [mapClickMenu]);

  // Glow marker when marker menu is open
  useEffect(() => {
    if (!markerMenu) return;
    const el = markerMenu.marker.getElement();
    el.classList.add("feature-glow");
    return () => el.classList.remove("feature-glow");
  }, [markerMenu]);

  // Reposition marker menu on window resize or map move
  useEffect(() => {
    if (!markerMenu) return;
    const reposition = () => setMenuPos(computeMenuPos(markerMenu.marker));
    window.addEventListener("resize", reposition);
    mapRef.current?.on("moveend", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      mapRef.current?.off("moveend", reposition);
    };
  }, [markerMenu]);

  const handleCenterToMarker = () => {
    mapRef.current.easeTo({ center: markerMenu.marker.getLngLat(), duration: 500 });
    setMarkerMenu(null);
  };

  const handleRecordMarkerView = () => {
    const marker = markerMenu.marker;
    setMarkerMenu(null);
    if (!marker) return;
    const map = mapRef.current;
    marker._savedView = {
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
    setToastMsg("Marker view recorded.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleFlyToMarker = () => {
    const marker = markerMenu.marker;
    setMarkerMenu(null);
    if (!marker) return;
    const map = mapRef.current;
    if (marker._savedView) {
      map.flyTo({
        center: marker.getLngLat(),
        zoom: marker._savedView.zoom,
        pitch: marker._savedView.pitch,
        bearing: marker._savedView.bearing,
        duration: 1500,
      });
    } else {
      map.flyTo({ center: marker.getLngLat(), zoom: 18, duration: 1500 });
    }
  };

  const handleCopyLinkMarker = () => {
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const bearing = mapRef.current.getBearing();
    const pitch = mapRef.current.getPitch();
    const ll = markerMenu.marker.getLngLat();
    const params = new URLSearchParams({
      lat: center.lat.toFixed(6),
      long: center.lng.toFixed(6),
      zoom: zoom.toFixed(2),
      bearing: bearing.toFixed(1),
      pitch: pitch.toFixed(1),
      marker: markerMenu.marker._markerName
        ? `${ll.lat.toFixed(6)}-${ll.lng.toFixed(6)}-${encodeURIComponent(markerMenu.marker._markerName)}`
        : `${ll.lat.toFixed(6)}-${ll.lng.toFixed(6)}`,
    });
    const url = `https://rontomap.web.app/?${params}`;
    navigator.clipboard.writeText(url);
    setMarkerMenu(null);
    setToastMsg("Link to marker copied.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleCopyMarkerCode = () => {
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const bearing = mapRef.current.getBearing();
    const pitch = mapRef.current.getPitch();
    const ll = markerMenu.marker.getLngLat();
    const params = new URLSearchParams({
      lat: center.lat.toFixed(6),
      long: center.lng.toFixed(6),
      zoom: zoom.toFixed(2),
      bearing: bearing.toFixed(1),
      pitch: pitch.toFixed(1),
      marker: markerMenu.marker._markerName
        ? `${ll.lat.toFixed(6)}-${ll.lng.toFixed(6)}-${encodeURIComponent(markerMenu.marker._markerName)}`
        : `${ll.lat.toFixed(6)}-${ll.lng.toFixed(6)}`,
      embedded: "true",
      style: idMapStyle,
    });
    const iframe = `<iframe style="width: 100%; height: 100%; border: none;" allow="fullscreen" scrolling="no" src="https://rontomap.web.app/?${params}"></iframe>`;
    navigator.clipboard.writeText(iframe);
    setMarkerMenu(null);
    setToastMsg("Embed code for marker copied.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleCopyFeatures = async () => {
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const bearing = mapRef.current.getBearing();
    const pitch = mapRef.current.getPitch();
    const { markers, paths } = collectFeatures(markersRef, pathsRef, serializeSnappedSegments);
    const docRef = await addDoc(collection(db, "featuresCollections"), {
      created: serverTimestamp(),
      markers,
      paths,
    });
    const params = new URLSearchParams({
      lat: center.lat.toFixed(6),
      long: center.lng.toFixed(6),
      zoom: zoom.toFixed(2),
      bearing: bearing.toFixed(1),
      pitch: pitch.toFixed(1),
      features_collection: docRef.id,
    });
    const url = `https://rontomap.web.app/?${params}`;
    navigator.clipboard.writeText(url);
    setMapClickMenu(null);
    setToastMsg("Link to features copied.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleCopyFeaturesCode = async () => {
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const bearing = mapRef.current.getBearing();
    const pitch = mapRef.current.getPitch();
    const { markers, paths } = collectFeatures(markersRef, pathsRef, serializeSnappedSegments);
    const docRef = await addDoc(collection(db, "featuresCollections"), {
      created: serverTimestamp(),
      markers,
      paths,
    });
    const params = new URLSearchParams({
      lat: center.lat.toFixed(6),
      long: center.lng.toFixed(6),
      zoom: zoom.toFixed(2),
      bearing: bearing.toFixed(1),
      pitch: pitch.toFixed(1),
      features_collection: docRef.id,
      embedded: "true",
      style: idMapStyle,
    });
    const iframe = `<iframe style="width: 100%; height: 100%; border: none;" allow="fullscreen" scrolling="no" src="https://rontomap.web.app/?${params}"></iframe>`;
    navigator.clipboard.writeText(iframe);
    setMapClickMenu(null);
    setToastMsg("Embed code for features copied.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  // --- Import/Export handlers ---

  const handleImportFeatures = async () => {
    setMapClickMenu(null);
    try {
      const { data } = await importFeatures();
      const createMarker = createMarkerRef.current;
      const result = materializeFeatures(data, { createMarker, pathHelpersRef, updateMarkerLabel, deserializeSnappedSegments, pathsRef });
      const parts = [];
      if (result.markerCount > 0) parts.push(`${result.markerCount} marker${result.markerCount > 1 ? "s" : ""}`);
      if (result.pathCount > 0) parts.push(`${result.pathCount} path${result.pathCount > 1 ? "s" : ""}`);
      let msg = `Imported ${parts.join(", ")}.`;
      if (result.skipped > 0) msg += ` ${result.skipped} feature${result.skipped > 1 ? "s" : ""} skipped.`;
      setToastMsg(msg);
      setTimeout(() => setToastMsg(null), 3000);
    } catch (e) {
      if (e.message === "No file selected.") return;
      setToastMsg(e.message);
      setTimeout(() => setToastMsg(null), 3000);
    }
  };

  const handleExportAll = () => {
    setMapClickMenu(null);
    const data = collectFeatures(markersRef, pathsRef, serializeSnappedSegments);
    if (data.markers.length === 0 && data.paths.length === 0) {
      setToastMsg("No features to export.");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    setExportAlert({ data, scope: { type: "all" }, baseName: "rontomap" });
  };

  const handleExportPath = () => {
    const path = mapClickMenu?.path;
    setMapClickMenu(null);
    if (!path) return;
    const data = collectPath(path, serializeSnappedSegments);
    const baseName = path.startName || (path.isTrack ? "track" : "path");
    setExportAlert({ data, scope: { type: "path", path: data.paths[0] }, baseName });
  };

  const handleExportMarker = () => {
    const marker = markerMenu?.marker;
    setMarkerMenu(null);
    if (!marker) return;
    const data = collectMarker(marker);
    const baseName = marker._markerName || (marker._sightPath ? "sight" : "marker");
    setExportAlert({ data, scope: { type: "marker", marker: data.markers[0] }, baseName });
  };

  const confirmExport = async (format) => {
    if (!exportAlert) return;
    const { data, scope, baseName } = exportAlert;
    setExportAlert(null);
    try {
      const savedName = await exportFeatures(data, format, scope, baseName);
      if (savedName) {
        setToastMsg(`Saved to Downloads/${savedName}`);
        setTimeout(() => setToastMsg(null), 3000);
      }
    } catch (e) {
      setToastMsg(e.message);
      setTimeout(() => setToastMsg(null), 3000);
    }
  };

  const handleDeleteAllFeatures = () => {
    setMapClickMenu(null);
    setDeleteAllAlert(true);
  };

  const confirmDeleteAllFeatures = () => {
    const map = mapRef.current;

    // Remove all paths
    pathsRef.current.forEach((path) => {
      const hitLayerId = `${path.layerId}-hit`;
      const arrowLayerId = `${path.layerId}-arrows`;
      if (map.getLayer(arrowLayerId)) map.removeLayer(arrowLayerId);
      if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
      if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
      if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);
      path.vertices.forEach((v) => v.marker.remove());
      path.midpoints.forEach((mp) => mp.marker.remove());
      if (path.sights) {
        path.sights.forEach((m) => m.remove());
      }
    });
    pathsRef.current = [];

    // Remove all markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // If in path mode, stay in it so the next click starts a new path
    if (isPathModeRef.current) {
      activePathRef.current = null;
    }
  };

  const handleDeleteMarker = () => {
    markerMenu.marker.remove();
    markersRef.current = markersRef.current.filter((m) => m !== markerMenu.marker);
    setMarkerMenu(null);
  };

  const handleDetachSight = () => {
    const marker = markerMenu.marker;
    const path = marker._sightPath;
    if (path && path.sights) {
      path.sights = path.sights.filter((m) => m !== marker);
    }
    // Replace blue sight with orange marker
    const pos = marker.getLngLat();
    const name = marker._markerName;
    const draggable = marker.isDraggable();
    marker.remove();
    markersRef.current = markersRef.current.filter((m) => m !== marker);
    const newMarker = createMarkerRef.current(pos, "#ff6f00");
    if (name) {
      newMarker._markerName = name;
      updateMarkerLabel(newMarker);
    }
    if (!draggable) newMarker.setDraggable(false);
    setMarkerMenu(null);
  };

  const confirmAttachSight = () => {
    const pending = pendingAttachSightRef.current;
    if (!pending) return;
    const { marker, path } = pending;
    pendingAttachSightRef.current = null;
    const h = pathHelpersRef.current;
    const pos = marker.getLngLat();
    const snap = h.snapToPath(path, [pos.lng, pos.lat]);
    const sightPos = h.getSightPos(path, { _segmentIndex: snap.segmentIndex, _t: snap.t });
    // Replace marker with sight
    const name = marker._markerName;
    const draggable = marker.isDraggable();
    marker.remove();
    markersRef.current = markersRef.current.filter((m) => m !== marker);
    const newMarker = createMarkerRef.current(sightPos, "#0091ff");
    h.applySightColors(newMarker, path);
    newMarker._sightPath = path;
    newMarker._segmentIndex = snap.segmentIndex;
    newMarker._t = snap.t;
    if (name) {
      newMarker._markerName = name;
      updateMarkerLabel(newMarker);
    }
    newMarker.on("drag", () => {
      if (!newMarker._sightPath) return;
      const p = newMarker.getLngLat(),
        lngLat = [p.lng, p.lat];
      const s = h.snapToPath(newMarker._sightPath, lngLat);
      newMarker._segmentIndex = s.segmentIndex;
      newMarker._t = s.t;
      const line = h.getRenderedLine(newMarker._sightPath);
      newMarker.setLngLat(h.closestPointOnLine(line, lngLat));
    });
    if (!draggable) newMarker.setDraggable(false);
    if (!path.sights) path.sights = [];
    path.sights.push(newMarker);
  };

  const handleSetNameMarker = () => {
    namingMarkerRef.current = markerMenu.marker;
    setMarkerMenu(null);
    setNameAlert(true);
  };

  const handleCenterHere = () => {
    mapRef.current.easeTo({ center: mapClickMenu.lngLat, duration: 500 });
    setMapClickMenu(null);
  };

  const handleToggleMarkerDrag = () => {
    const marker = markerMenu.marker;
    marker.setDraggable(!marker.isDraggable());
    setMarkerMenu(null);
  };

  const handleAddMarkerFromMenu = () => {
    const m = createMarkerRef.current(mapClickMenu.lngLat);
    if (featuresLockedRef.current) {
      m.setDraggable(false);
    }
    setMapClickMenu(null);
  };

  const handleStartPathCreation = () => {
    if (isRecordingTrackRef.current) {
      setMapClickMenu(null);
      setToastMsg("Stop recording first.");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    const lngLat = [mapClickMenu.lngLat.lng, mapClickMenu.lngLat.lat];
    setMapClickMenu(null);

    // Finish any active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished) {
      const prev = activePathRef.current;
      prev.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(prev);
      prev.midpoints.forEach((mp) => mp.marker.remove());
      prev.midpoints = [];
      prev.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (prev.sights)
        prev.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
    }

    const id = `path-${Date.now()}`;
    const newPath = {
      id,
      sourceId: `path-line-source-${id}`,
      layerId: `path-line-layer-${id}`,
      vertices: [],
      midpoints: [],
      isFinished: false,
    };
    pathsRef.current.push(newPath);
    activePathRef.current = newPath;
    pathUndoStackRef.current = [];
    pathRedoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);

    newPath._wasLocked = featuresLockedRef.current;

    setIsPathMode(true);
    isPathModeRef.current = true;
    pathPointToastShownRef.current = false;
    setSnapMode(null);
    setForceMode(false);

    const h = pathHelpersRef.current;
    h.ensurePathLayer(newPath);

    // Create first vertex
    const marker = h.createPathVertex(lngLat);
    const vertex = { lngLat, marker, path: newPath };
    newPath.vertices.push(vertex);
    setPathVertexCount(1);
    h.attachVertexDragHandler(vertex);
    h.attachFinishHandler(vertex);
    h.updatePathLine(newPath);
    h.updateVertexStyles(newPath);
    setToastMsg("Click on map to add path points.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleRecordTrack = async () => {
    setMapClickMenu(null);

    const ctrl = locationControlRef.current;

    // Finish any active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished) {
      const prev = activePathRef.current;
      prev.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(prev);
      prev.midpoints.forEach((mp) => mp.marker.remove());
      prev.midpoints = [];
      prev.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (prev.sights)
        prev.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
    }

    // Request location permissions
    if (Capacitor.isNativePlatform()) {
      const permissionStatus = await Geolocation.checkPermissions();
      if (permissionStatus.location !== "granted") {
        const permissions = await Geolocation.requestPermissions();
        if (permissions.location !== "granted" && permissions.location !== "limited") {
          setToastMsg("Location permission denied.");
          setTimeout(() => setToastMsg(null), 2000);
          return;
        }
      }
    }

    // Get current user position
    let userLng = ctrl._lastPostionLong;
    let userLat = ctrl._lastPostionLat;

    if (userLat == null || userLng == null) {
      setToastMsg("Getting your location...");
      try {
        ctrl._geolocate.trigger();
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve(p),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000 },
          );
        });
        userLng = pos.coords.longitude;
        userLat = pos.coords.latitude;
        ctrl._lastPostionLong = userLng;
        ctrl._lastPostionLat = userLat;
      } catch (err) {
        setToastMsg("Could not get your location.");
        setTimeout(() => setToastMsg(null), 2000);
        return;
      }
    } else {
      ctrl._geolocate.trigger();
    }

    setToastMsg(null);

    // Create the recording path
    const id = `rec-${Date.now()}`;
    const newPath = {
      id,
      sourceId: `path-line-source-${id}`,
      layerId: `path-line-layer-${id}`,
      vertices: [],
      midpoints: [],
      isFinished: false,
      isTrack: true,
    };
    pathsRef.current.push(newPath);
    trackPathRef.current = newPath;
    trackCoordsRef.current = [[userLng, userLat]];

    const h = pathHelpersRef.current;
    h.ensurePathLayer(newPath);

    // Create start vertex marker (blue circle)
    const startMarker = h.createPathVertex([userLng, userLat]);
    startMarker.setDraggable(false);
    startMarker.getElement().classList.remove("active-path-feature");
    newPath.vertices.push({ lngLat: [userLng, userLat], marker: startMarker, path: newPath });
    h.updateVertexStyles(newPath);

    // Activate wake lock for continuous GPS
    await ctrl._requestWakeLock();

    setIsRecordingRoute(true);

    // On native platforms, start a background geolocation watcher
    // that keeps tracking even when the app is backgrounded
    if (Capacitor.isNativePlatform()) {
      const watcherId = await BackgroundGeolocation.addWatcher(
        {
          backgroundTitle: "RontoMap",
          backgroundMessage: "Recording your track...",
          requestPermissions: true,
          stale: false,
          distanceFilter: 5,
        },
        (location, error) => {
          if (error) return;
          if (!location || !isRecordingTrackRef.current || !trackPathRef.current) return;
          const coord = [location.longitude, location.latitude];
          trackCoordsRef.current.push(coord);
          const path = trackPathRef.current;
          const source = mapRef.current?.getSource(path.sourceId);
          if (source && trackCoordsRef.current.length >= 2) {
            source.setData({
              type: "FeatureCollection",
              features: [pathHelpersRef.current.makeFeature(trackCoordsRef.current, "#0000ff")],
            });
          }
          // Update end vertex marker
          const h = pathHelpersRef.current;
          if (path.vertices.length === 1) {
            const endMarker = h.createPathVertex(coord);
            endMarker.setDraggable(false);
            endMarker.getElement().classList.remove("active-path-feature");
            path.vertices.push({ lngLat: coord, marker: endMarker, path });
            h.updateVertexStyles(path);
          } else if (path.vertices.length >= 2) {
            const endV = path.vertices[path.vertices.length - 1];
            endV.lngLat = coord;
            endV.marker.setLngLat(coord);
          }
        },
      );
      bgWatcherIdRef.current = watcherId;
    }

    setToastMsg("Recording track...");
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleStopTrackRecording = () => {
    setMapClickMenu(null);
    if (!trackPathRef.current) return;
    setStopRecordingAlert(true);
  };

  const confirmStopTrackRecording = () => {
    setStopRecordingAlert(false);
    if (!trackPathRef.current) return;

    const path = trackPathRef.current;
    const h = pathHelpersRef.current;
    const coords = trackCoordsRef.current;

    // Remove live start/end markers from recording
    path.vertices.forEach((v) => v.marker.remove());
    path.vertices = [];

    // Apply RDP simplification to reduce point density
    const simplified = coords.length >= 2 ? rdpSimplify(coords, RDP_TOLERANCE) : coords;

    // Create proper vertex objects from simplified coordinates
    simplified.forEach((coord, i) => {
      const marker = h.createPathVertex(coord);
      marker.setDraggable(false);
      marker.getElement().classList.remove("active-path-feature");
      // Hide intermediate vertices, show only start and end
      if (i > 0 && i < simplified.length - 1) {
        marker.getElement().style.display = "none";
      }
      path.vertices.push({ lngLat: coord, marker, path });
    });

    path.isFinished = true;
    delete path.isTrack;
    h.updatePathLine(path);
    h.updateVertexStyles(path);

    // Stop background watcher on native platforms
    if (bgWatcherIdRef.current != null) {
      BackgroundGeolocation.removeWatcher({ id: bgWatcherIdRef.current });
      bgWatcherIdRef.current = null;
    }

    // Release wake lock
    locationControlRef.current?._releaseWakeLock();

    setIsRecordingRoute(false);
    trackPathRef.current = null;
    trackCoordsRef.current = [];

    setToastMsg("Track recorded.");
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleFinishPath = () => {
    const path = activePathRef.current;
    if (path && !path.isFinished && path.vertices.length > 1) {
      path.isFinished = true;
      isPathModeRef.current = false;
      setIsPathMode(false);
      pathHelpersRef.current.hideIntermediateVertices(path);
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];
      setToastMsg(null);
      path.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (path.sights)
        path.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
      delete path._wasLocked;
      delete path._preEditSnapshot;
      pathUndoStackRef.current = [];
      pathRedoStackRef.current = [];
      setCanUndo(false);
      setCanRedo(false);
      setNavRouteDistance(null);
      setNavRouteDuration(null);
    }
  };

  const snapshotPath = (path) => ({
    vertices: path.vertices.map((v) => ({ lngLat: [...v.lngLat], force: v.force || false })),
    roadSnap: path.roadSnap || null,
    snappedSegments: path.snappedSegments ? JSON.parse(JSON.stringify(path.snappedSegments)) : null,
    isCircuit: path.isCircuit || false,
  });

  const pushPathSnapshot = (path) => {
    pathUndoStackRef.current.push(snapshotPath(path));
    pathRedoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  };

  const restorePathFromSnapshot = (path, snapshot) => {
    const h = pathHelpersRef.current;
    path.vertices.forEach((v) => v.marker.remove());
    path.midpoints.forEach((mp) => mp.marker.remove());
    path.midpoints = [];
    path.vertices = [];
    snapshot.vertices.forEach((sv) => {
      const marker = h.createPathVertex(sv.lngLat);
      const vertex = { lngLat: sv.lngLat, marker, path };
      if (sv.force) vertex.force = true;
      path.vertices.push(vertex);
      h.attachVertexDragHandler(vertex);
      h.attachFinishHandler(vertex);
    });
    path.roadSnap = snapshot.roadSnap;
    path.snappedSegments = snapshot.snappedSegments;
    path.isCircuit = snapshot.isCircuit || false;
    h.updatePathLine(path);
    h.updateVertexStyles(path);
    if (!path.isFinished) h.rebuildMidpoints(path);
    if (path.sights) h.updateSights(path);
    setPathVertexCount(path.vertices.length);
    setSnapMode(path.roadSnap || null);
  };

  const undoPath = () => {
    const path = activePathRef.current;
    if (!path || pathUndoStackRef.current.length === 0) return;
    pathRedoStackRef.current.push(snapshotPath(path));
    const snapshot = pathUndoStackRef.current.pop();
    restorePathFromSnapshot(path, snapshot);
    setCanUndo(pathUndoStackRef.current.length > 0);
    setCanRedo(true);
  };

  const redoPath = () => {
    const path = activePathRef.current;
    if (!path || pathRedoStackRef.current.length === 0) return;
    pathUndoStackRef.current.push(snapshotPath(path));
    const snapshot = pathRedoStackRef.current.pop();
    restorePathFromSnapshot(path, snapshot);
    setCanUndo(true);
    setCanRedo(pathRedoStackRef.current.length > 0);
  };

  const handleEditPath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    pathUndoStackRef.current = [];
    pathRedoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);

    // Finish any other active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished && activePathRef.current !== path) {
      const prev = activePathRef.current;
      prev.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(prev);
      prev.midpoints.forEach((mp) => mp.marker.remove());
      prev.midpoints = [];
      prev.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (prev.sights)
        prev.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
    }

    path.isFinished = false;
    activePathRef.current = path;
    path._wasLocked = featuresLockedRef.current;

    // Snapshot for cancel/revert
    path._preEditSnapshot = {
      vertices: path.vertices.map((v) => ({ lngLat: [...v.lngLat], force: v.force || false })),
      roadSnap: path.roadSnap || null,
      snappedSegments: path.snappedSegments ? JSON.parse(JSON.stringify(path.snappedSegments)) : null,
      savedView: path.savedView ? { ...path.savedView } : null,
      isCircuit: path.isCircuit || false,
    };

    pathHelpersRef.current.showAllVertices(path);
    pathHelpersRef.current.rebuildMidpoints(path);
    // Enable dragging only for this path's features and tag them
    path.vertices.forEach((v) => {
      v.marker.setDraggable(true);
      v.marker.getElement().classList.add("active-path-feature");
    });
    path.midpoints.forEach((mp) => {
      mp.marker.setDraggable(true);
      mp.marker.getElement().classList.add("active-path-feature");
    });
    if (path.sights)
      path.sights.forEach((m) => {
        m.setDraggable(true);
        m.getElement().classList.add("active-path-feature");
      });
    pathHelpersRef.current.updateVertexStyles(path);
    setIsPathMode(true);
    isPathModeRef.current = true;
    setPathVertexCount(path.vertices.length);
    setSnapMode(path.roadSnap || null);
    setForceMode(false);
    pathPointToastShownRef.current = false;
    if (path.roadSnap) {
      pathHelpersRef.current.fetchRoadSnap(path);
    } else if (path.vertices.length >= 2) {
      const coords = path.vertices.map((v) => v.lngLat);
      setNavRouteDistance(haversineDistance(coords));
      setNavRouteDuration(null);
    } else {
      setNavRouteDistance(null);
      setNavRouteDuration(null);
    }
    setToastMsg("Click on map to add path points.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleReversePath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);

    const numSegs = path.vertices.length - 1;
    path.vertices.reverse();
    if (path.sights) {
      path.sights.forEach((m) => {
        m._segmentIndex = numSegs - 1 - m._segmentIndex;
        m._t = 1 - m._t;
      });
    }
    pathHelpersRef.current.updatePathLine(path);
    pathHelpersRef.current.updateVertexStyles(path);
  };

  const handleDeletePath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    setDeletePathAlert(path);
  };

  const handleNavigateToMarker = () => {
    const marker = markerMenu.marker;
    setMarkerMenu(null);
    if (!marker) return;
    const pos = marker.getLngLat();
    startNavigation([pos.lng, pos.lat]);
  };

  const handleNavigateToPath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (!path || path.vertices.length === 0) return;
    startNavigation(path.vertices[0].lngLat);
  };

  const handleNavigateHere = () => {
    const lngLat = mapClickMenu.lngLat;
    setMapClickMenu(null);
    if (!lngLat) return;
    startNavigation([lngLat.lng, lngLat.lat]);
  };

  const handleTracePath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (!path || path.vertices.length < 2) return;

    const ctrl = locationControlRef.current;
    if (!ctrl || ctrl._lastPostionLat == null || ctrl._lastPostionLong == null) {
      setToastMsg("Enable location to trace path.");
      setTimeout(() => setToastMsg(null), 3000);
      return;
    }

    const userPos = [ctrl._lastPostionLong, ctrl._lastPostionLat];
    const startPos = path.vertices[0].lngLat;
    const dist = haversineDistance([userPos, startPos]);
    if (dist > 50) {
      setToastMsg("You need to be near the path start point.");
      setTimeout(() => setToastMsg(null), 3000);
      return;
    }

    confirmTracePath(path.roadSnap ?? null, path);
  };

  const confirmTracePath = async (mode, path) => {
    if (!path) return;

    // Finish any active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished && activePathRef.current !== path) {
      const prev = activePathRef.current;
      prev.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(prev);
      prev.midpoints.forEach((mp) => mp.marker.remove());
      prev.midpoints = [];
      prev.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (prev.sights)
        prev.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
    }

    // Save pre-trace state so we can restore on cancel
    path._preTraceSnapshot = {
      isRoute: path.isRoute || false,
      roadSnap: path.roadSnap || null,
      snappedSegments: path.snappedSegments ? JSON.parse(JSON.stringify(path.snappedSegments)) : null,
      routeDistance: path.routeDistance ?? null,
      routeDuration: path.routeDuration ?? null,
    };

    // Style path as route
    path.isRoute = true;
    path.roadSnap = mode;
    const h = pathHelpersRef.current;
    h.updateVertexStyles(path);

    // Recolor sights to route colors
    if (path.sights) {
      path.sights.forEach((m) => h.applySightColors(m, path));
    }

    // Update arrow color to route color
    const map = mapRef.current;
    if (map && path._arrowLayerId && map.getLayer(path._arrowLayerId)) {
      map.setPaintProperty(path._arrowLayerId, "text-color", "#0091ff");
    }

    // Enter navigation-like mode (but don't start tracking yet — user clicks "Start")
    activePathRef.current = path;
    path.isFinished = false;
    isPathModeRef.current = true;
    setIsPathMode(true);
    isNavigationModeRef.current = true;
    setIsNavigationMode(true);
    isTracingPathRef.current = true;
    setSnapMode(mode);
    setForceMode(false);
    setPathVertexCount(path.vertices.length);

    // Apply snap mode
    if (mode) {
      await h.fetchRoadSnap(path);
    } else {
      path.snappedSegments = null;
      path.routeDistance = null;
      path.routeDuration = null;
      const coords = path.vertices.map((v) => v.lngLat);
      if (path.isCircuit) coords.push(coords[0]);
      setNavRouteDistance(haversineDistance(coords));
      setNavRouteDuration(null);
      h.updatePathLine(path);
    }
  };

  const startNavigation = async (destinationLngLat) => {
    // Auto-stop recording before starting navigation
    if (isRecordingTrackRef.current) {
      handleStopTrackRecording();
    }

    const ctrl = locationControlRef.current;

    // Finish any active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished) {
      const prev = activePathRef.current;
      prev.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(prev);
      prev.midpoints.forEach((mp) => mp.marker.remove());
      prev.midpoints = [];
      prev.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      if (prev.sights)
        prev.sights.forEach((m) => {
          m.getElement().classList.remove("active-path-feature");
          m.setDraggable(false);
        });
    }

    let userLng = ctrl._lastPostionLong;
    let userLat = ctrl._lastPostionLat;

    // If no position available, request it
    if (userLat == null || userLng == null) {
      setToastMsg("Getting your location...");
      try {
        if (Capacitor.isNativePlatform()) {
          const permissionStatus = await Geolocation.checkPermissions();
          if (permissionStatus.location !== "granted") {
            const permissions = await Geolocation.requestPermissions();
            if (permissions.location !== "granted" && permissions.location !== "limited") {
              setToastMsg("Location permission denied.");
              setTimeout(() => setToastMsg(null), 2000);
              return;
            }
          }
        }
        // Start geolocate control in parallel so user dot appears immediately
        ctrl._geolocate.trigger();
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (p) => resolve(p),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000 }
          );
        });
        userLng = pos.coords.longitude;
        userLat = pos.coords.latitude;
        ctrl._lastPostionLong = userLng;
        ctrl._lastPostionLat = userLat;
        if (pos.coords.heading) ctrl._lastPositionBearing = pos.coords.heading;
      } catch (err) {
        setToastMsg("Could not get your location.");
        setTimeout(() => setToastMsg(null), 2000);
        return;
      }
    } else {
      // Ensure geolocate control is active so user dot is visible
      ctrl._geolocate.trigger();
    }

    setToastMsg(null);

    const userLngLat = [userLng, userLat];
    const id = `nav-${Date.now()}`;
    const newPath = {
      id,
      sourceId: `path-line-source-${id}`,
      layerId: `path-line-layer-${id}`,
      vertices: [],
      midpoints: [],
      isFinished: false,
      isRoute: true,
    };
    pathsRef.current.push(newPath);
    activePathRef.current = newPath;
    pathUndoStackRef.current = [];
    pathRedoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);

    newPath._wasLocked = featuresLockedRef.current;

    setIsPathMode(true);
    isPathModeRef.current = true;
    setIsNavigationMode(true);
    isNavigationModeRef.current = true;
    pathPointToastShownRef.current = false;
    setSnapMode(null);
    setForceMode(false);
    setNavRouteDistance(null);
    setNavRouteDuration(null);

    const h = pathHelpersRef.current;
    h.ensurePathLayer(newPath);

    // Create start vertex (user position)
    const startMarker = h.createPathVertex(userLngLat);
    const startVertex = { lngLat: userLngLat, marker: startMarker, path: newPath };
    newPath.vertices.push(startVertex);
    h.attachVertexDragHandler(startVertex);
    h.attachFinishHandler(startVertex);

    // Create end vertex (destination)
    const endMarker = h.createPathVertex(destinationLngLat);
    const endVertex = { lngLat: destinationLngLat, marker: endMarker, path: newPath };
    newPath.vertices.push(endVertex);
    h.attachVertexDragHandler(endVertex);
    h.attachFinishHandler(endVertex);

    setPathVertexCount(2);
    h.updatePathLine(newPath);
    h.updateVertexStyles(newPath);
    h.rebuildMidpoints(newPath);

    // Fit map to show all path points without changing bearing or pitch
    const bounds = new mapboxgl.LngLatBounds();
    bounds.extend(userLngLat);
    bounds.extend(destinationLngLat);
    mapRef.current.fitBounds(bounds, {
      padding: 80,
      bearing: mapRef.current.getBearing(),
      pitch: mapRef.current.getPitch(),
      duration: 1000,
    });

    setToastMsg("Adjust route or press Start to navigate.");
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleStartNavigation = () => {
    const path = activePathRef.current;
    if (!path || path.vertices.length < 2) return;

    // Finish the path visually
    path.isFinished = true;
    pathHelpersRef.current.hideIntermediateVertices(path);
    path.midpoints.forEach((mp) => mp.marker.remove());
    path.midpoints = [];
    path.vertices.forEach((v) => v.marker.getElement().classList.remove("active-path-feature"));

    // Enter navigation tracking mode
    setIsNavigationTracking(true);
    isNavigationTrackingRef.current = true;

    // Initialize passed path layer
    pathHelpersRef.current.ensurePassedPathLayer(path);
    passedPathCoordsRef.current = [];
    routeSplitIndexRef.current = 0;
    routeSplitTRef.current = 0;
    isOffPathRef.current = false;
    offPathCoordsRef.current = [];
    isRenavigatingRef.current = false;
    offPathTimerRef.current = null;
    offPathVertexSegRef.current = 0;
    routeTotalDistanceRef.current = path.routeDistance ?? null;

    // Start bearing tracking
    const ctrl = locationControlRef.current;
    ctrl.hideTrackingIcons();
    ctrl._handleTrackBearing();

    setToastMsg(isTracingPathRef.current ? "Click tracking icon to stop tracing." : "Click tracking icon to leave navigation.");
    setTimeout(() => setToastMsg(null), 3000);
  };

  const handleRenavigate = async () => {
    const path = activePathRef.current;
    if (!path) return;
    const ctrl = locationControlRef.current;
    const userLng = ctrl._lastPostionLong;
    const userLat = ctrl._lastPostionLat;
    if (userLat == null || userLng == null) return;

    const userLngLat = [userLng, userLat];
    const h = pathHelpersRef.current;
    // Use current position to determine passed vertices (not the stale value from
    // when off-path was first detected — user may have passed more vertices during
    // the renavigate delay)
    const currentSnap = h.snapToPath(path, userLngLat);
    const segIdx = Math.max(offPathVertexSegRef.current, currentSnap.segmentIndex);

    // Remove passed vertices (indices 0..segIdx) and their markers
    const removeCount = Math.min(segIdx + 1, path.vertices.length);
    for (let i = 0; i < removeCount; i++) {
      path.vertices[i].marker.remove();
    }
    // Adjust sights: remove those on passed segments, shift indices for remaining
    if (path.sights) {
      path.sights = path.sights.filter((m) => {
        const si = m._segmentIndex ?? m.segmentIndex;
        if (si <= segIdx) { m.remove(); return false; }
        m._segmentIndex = si - removeCount;
        if (m.segmentIndex != null) m.segmentIndex = m._segmentIndex;
        return true;
      });
    }
    path.vertices.splice(0, removeCount);

    // Insert user's current position as new first vertex
    const newMarker = h.createPathVertex(userLngLat);
    newMarker.getElement().classList.remove("active-path-feature");
    if (path.isRoute) newMarker.getElement().classList.add("route-path-vertex");
    path.vertices.unshift({ lngLat: userLngLat, marker: newMarker, force: false });
    h.updateVertexStyles(path);

    // Snap the off-path segment and merge into passed path
    const offCoords = offPathCoordsRef.current;
    if (path.roadSnap && offCoords.length >= 2) {
      const profile = { foot: "walking", bike: "cycling", car: "driving" }[path.roadSnap] || "driving";
      try {
        const waypoints = offCoords.map((c) => c.join(",")).join(";");
        const res = await fetch(
          `https://api.mapbox.com/directions/v5/mapbox/${profile}/${waypoints}?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`,
        );
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
          passedPathCoordsRef.current = [...passedPathCoordsRef.current, ...data.routes[0].geometry.coordinates];
        } else {
          passedPathCoordsRef.current = [...passedPathCoordsRef.current, ...offCoords];
        }
      } catch {
        passedPathCoordsRef.current = [...passedPathCoordsRef.current, ...offCoords];
      }
    } else {
      passedPathCoordsRef.current = [...passedPathCoordsRef.current, ...offCoords];
    }

    // Reset off-path state
    isOffPathRef.current = false;
    offPathCoordsRef.current = [];
    routeSplitIndexRef.current = 0;
    routeSplitTRef.current = 0;

    // Re-snap remaining path from user's position forward
    if (path.roadSnap) {
      await h.fetchRoadSnap(path);
    } else {
      h.updatePathLine(path);
    }

    // Update total distance and passed path display
    routeTotalDistanceRef.current = path.routeDistance ?? null;
    h.updatePassedPathLine(passedPathCoordsRef.current, path.roadSnap);
  };

  const handleCancelNavigation = () => {
    setCancelNavigationAlert(true);
  };

  const confirmCancelNavigation = () => {
    if (offPathTimerRef.current) { clearTimeout(offPathTimerRef.current); offPathTimerRef.current = null; }
    pathHelpersRef.current.removePassedPathLayer();

    const path = activePathRef.current;
    if (path && isTracingPathRef.current) {
      // Restore path to its pre-trace state
      const snap = path._preTraceSnapshot;
      if (snap) {
        path.isRoute = snap.isRoute || false;
        if (!path.isRoute) delete path.isRoute;
        path.roadSnap = snap.roadSnap;
        path.snappedSegments = snap.snappedSegments;
        path.routeDistance = snap.routeDistance;
        path.routeDuration = snap.routeDuration;
        delete path._preTraceSnapshot;
      } else {
        delete path.isRoute;
        path.roadSnap = null;
        path.snappedSegments = null;
        path.routeDistance = null;
        path.routeDuration = null;
      }
      path.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(path);
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];
      path.vertices.forEach((v) => {
        v.marker.getElement().classList.remove("active-path-feature");
        v.marker.setDraggable(false);
      });
      pathHelpersRef.current.updateVertexStyles(path);
      pathHelpersRef.current.updatePathLine(path);
      // Restore sight colors for passed sights
      if (path.sights) {
        path.sights.forEach((m) => {
          delete m._passed;
          pathHelpersRef.current.applySightColors(m, path);
        });
      }
      const mainColor = path.isRoute ? "#0091ff" : path.isTrack ? "#91FF00" : "#ff6f00";
      const map = mapRef.current;
      if (map && path._arrowLayerId && map.getLayer(path._arrowLayerId)) {
        map.setPaintProperty(path._arrowLayerId, "text-color", mainColor);
      }
    } else if (path) {
      path.vertices.forEach((v) => v.marker.remove());
      path.midpoints.forEach((mp) => mp.marker.remove());
      const map = mapRef.current;
      const hitLayerId = `${path.layerId}-hit`;
      const arrowLayerId = `${path.layerId}-arrows`;
      if (map.getLayer(arrowLayerId)) map.removeLayer(arrowLayerId);
      if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
      if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
      if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);
      pathsRef.current = pathsRef.current.filter((p) => p !== path);
    }

    activePathRef.current = null;
    isPathModeRef.current = false;
    setIsPathMode(false);
    setIsNavigationMode(false);
    isNavigationModeRef.current = false;
    setIsNavigationTracking(false);
    isNavigationTrackingRef.current = false;
    isTracingPathRef.current = false;
    setToastMsg(null);
    setSnapMode(null);
    setForceMode(false);
    pathUndoStackRef.current = [];
    pathRedoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setNavRouteDistance(null);
    setNavRouteDuration(null);
  };

  const confirmTrackBearing = () => {
    const ctrl = locationControlRef.current;
    if (!ctrl) return;
    ctrl._finishPathForBearing();
    ctrl.hideTrackingIcons();
    ctrl._handleTrackBearing();
  };

  const confirmDeletePath = () => {
    const path = deletePathAlert;
    if (!path) return;
    const map = mapRef.current;
    const hitLayerId = `${path.layerId}-hit`;
    const arrowLayerId = `${path.layerId}-arrows`;
    if (map.getLayer(arrowLayerId)) map.removeLayer(arrowLayerId);
    if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
    if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
    if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);

    path.vertices.forEach((v) => v.marker.remove());
    path.midpoints.forEach((mp) => mp.marker.remove());
    if (path.sights) {
      path.sights.forEach((m) => {
        m.remove();
        markersRef.current = markersRef.current.filter((mk) => mk !== m);
      });
    }

    pathsRef.current = pathsRef.current.filter((p) => p !== path);

    if (activePathRef.current === path) {
      activePathRef.current = null;
      isPathModeRef.current = false;
      setIsPathMode(false);
      setToastMsg(null);
    }
  };

  const handleCancelPathRequest = () => {
    setCancelPathAlert(true);
  };

  const confirmCircuit = () => {
    const path = pendingCircuitPathRef.current;
    if (!path || path.vertices.length < 3) return;
    pushPathSnapshot(path);
    path.isCircuit = true;
    if (forceModeRef.current) path.closingForced = true;
    // Remove the dropped vertex — the circuit closes from the previous vertex back to start
    const lastV = path.vertices.pop();
    lastV.marker.remove();
    setPathVertexCount(path.vertices.length);
    pathHelpersRef.current.updatePathLine(path);
    pathHelpersRef.current.rebuildMidpoints(path);
    pathHelpersRef.current.updateVertexStyles(path);
    if (path.roadSnap) pathHelpersRef.current.fetchRoadSnap(path);
    pendingCircuitPathRef.current = null;
  };

  const confirmCancelPath = () => {
    const path = activePathRef.current;
    if (!path) {
      isPathModeRef.current = false;
      setIsPathMode(false);
      setToastMsg(null);
      setSnapMode(null);
      setForceMode(false);
      pathUndoStackRef.current = [];
      pathRedoStackRef.current = [];
      setCanUndo(false);
      setCanRedo(false);
      setNavRouteDistance(null);
      setNavRouteDuration(null);
      return;
    }
    const h = pathHelpersRef.current;
    const map = mapRef.current;
    const snapshot = path._preEditSnapshot;

    if (!snapshot) {
      // NEW path — delete entirely
      path.vertices.forEach((v) => v.marker.remove());
      path.midpoints.forEach((mp) => mp.marker.remove());
      if (path.sights) {
        path.sights.forEach((m) => {
          m.remove();
          markersRef.current = markersRef.current.filter((mk) => mk !== m);
        });
      }
      const hitLayerId = `${path.layerId}-hit`;
      const arrowLayerId = `${path.layerId}-arrows`;
      if (map.getLayer(arrowLayerId)) map.removeLayer(arrowLayerId);
      if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
      if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
      if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);
      pathsRef.current = pathsRef.current.filter((p) => p !== path);
    } else {
      // EXISTING path — restore to pre-edit state
      path.vertices.forEach((v) => v.marker.remove());
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];

      path.vertices = [];
      snapshot.vertices.forEach((sv) => {
        const marker = h.createPathVertex(sv.lngLat);
        const vertex = { lngLat: sv.lngLat, marker, path };
        if (sv.force) vertex.force = true;
        path.vertices.push(vertex);
        h.attachVertexDragHandler(vertex);
        h.attachFinishHandler(vertex);
      });

      path.roadSnap = snapshot.roadSnap;
      path.snappedSegments = snapshot.snappedSegments;
      path.savedView = snapshot.savedView;
      path.isCircuit = snapshot.isCircuit || false;
      path.isFinished = true;

      h.updatePathLine(path);
      h.hideIntermediateVertices(path);
      h.updateVertexStyles(path);
      if (path.sights) h.updateSights(path);

      if (path._wasLocked) {
        delete path._wasLocked;
        path.vertices.forEach((v) => v.marker.setDraggable(false));
        if (path.sights) path.sights.forEach((m) => m.setDraggable(false));
      }
      path.vertices.forEach((v) => v.marker.getElement().classList.remove("active-path-feature"));
      if (path.sights)
        path.sights.forEach((m) => m.getElement().classList.remove("active-path-feature"));
      delete path._preEditSnapshot;
    }

    activePathRef.current = null;
    isPathModeRef.current = false;
    setIsPathMode(false);
    setToastMsg(null);
    setSnapMode(null);
    setForceMode(false);
    pathUndoStackRef.current = [];
    pathRedoStackRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setNavRouteDistance(null);
    setNavRouteDuration(null);
  };

  const handleRecordPathView = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (!path) return;
    const map = mapRef.current;
    path.savedView = {
      center: map.getCenter().toArray(),
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
    setToastMsg("Path view recorded.");
    setTimeout(() => {
      setToastMsg(null);
    }, 2000);
  };

  const handleCenterToPath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (!path || path.vertices.length === 0) return;
    const start = path.vertices[0].lngLat;
    const end = path.vertices[path.vertices.length - 1].lngLat;
    const center = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    mapRef.current.easeTo({ center, duration: 500 });
  };

  const handleFlyToPath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (!path) return;
    const map = mapRef.current;
    if (path.savedView) {
      map.flyTo({
        center: path.savedView.center,
        zoom: path.savedView.zoom,
        pitch: map.getPitch(),
        bearing: map.getBearing(),
        duration: 1500,
      });
    } else if (path.vertices.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      if (path.snappedSegments) {
        path.snappedSegments.forEach((seg) => seg.coords.forEach((c) => bounds.extend(c)));
      } else {
        path.vertices.forEach((v) => bounds.extend(v.lngLat));
      }
      map.fitBounds(bounds, {
        padding: 60,
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        duration: 1500,
      });
    }
  };

  const handleAddSight = () => {
    const path = mapClickMenu.path;
    const lngLat = mapClickMenu.lngLat;
    setMapClickMenu(null);
    if (!path || path.vertices.length < 2) return;
    const h = pathHelpersRef.current;
    const snap = h.snapToPath(path, [lngLat.lng, lngLat.lat]);
    const markerPos = h.getSightPos(path, { _segmentIndex: snap.segmentIndex, _t: snap.t });
    const marker = createMarkerRef.current(markerPos, "#0091ff");
    pathHelpersRef.current.applySightColors(marker, path);
    marker._sightPath = path;
    marker._segmentIndex = snap.segmentIndex;
    marker._t = snap.t;
    marker.on("drag", () => {
      if (!marker._sightPath) return;
      const p = marker.getLngLat(),
        lngLat = [p.lng, p.lat];
      const s = h.snapToPath(marker._sightPath, lngLat);
      marker._segmentIndex = s.segmentIndex;
      marker._t = s.t;
      const line = h.getRenderedLine(marker._sightPath);
      marker.setLngLat(h.closestPointOnLine(line, lngLat));
    });
    if (featuresLockedRef.current) marker.setDraggable(false);
    if (!path.sights) path.sights = [];
    path.sights.push(marker);
  };

  const handleSetPathName = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (path && path.vertices.length > 0) {
      namingMarkerRef.current = path.vertices[0].marker;
      setNameAlert(true);
    }
  };


  // Show tips
  useEffect(() => {
    console.log("useEffect > Show tips");
    const dontShowTips = localStorage.getItem("rontomap_dont_show_tips");
    if (dontShowTips || isEmbeddedRef.current) {
      setShowTips(false);
    }
  }, []);

  return (
    <PageFixedLayout name="map">
      <IonAlert
        isOpen={showTips}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setShowTips(false)}
        header="RontoMap"
        message={
          "Tilt the map: Use two fingers in parallel on touchscreen or right/wheel-click and drag with mouse.\n\n" +
          "Location tracking: Click location icon for tracking, click once more to follow direction. \n\n" +
          "Full screen: Double-click to enter/exit.\n\n" +
          "Web App:\nrontomap.web.app"
        }
        buttons={[
          {
            text: "SOURCE",
            handler: () => {
              window.open("https://github.com/strukovnasamobor/rontomap", "_blank");
            },
          },
          {
            text: "SUPPORT",
            handler: () => {
              window.open("https://www.paypal.com/ncp/payment/ZRBQZMWTCJYFE", "_blank");
            },
          },
          {
            text: "DON'T SHOW AGAIN",
            handler: () => {
              localStorage.setItem("rontomap_dont_show_tips", "true");
            },
          },
          {
            text: "OK",
            role: "cancel",
          },
        ]}
      ></IonAlert>
      <IonAlert
        isOpen={nameAlert}
        cssClass={`name-alert${idMapStyle === "rontomap_streets_dark" ? " name-alert-dark alert-dark" : ""}`}
        onDidDismiss={() => setNameAlert(false)}
        onDidPresent={() => {
          setTimeout(() => {
            const input = document.querySelector("ion-alert .alert-input");
            if (input) {
              input.focus();
              input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                  if (namingMarkerRef.current) {
                    namingMarkerRef.current._markerName = input.value || "";
                    updateMarkerLabel(namingMarkerRef.current);
                  }
                  setNameAlert(false);
                }
              });
            }
          }, 100);
        }}
        header="Marker name"
        inputs={[
          { name: "name", type: "text", placeholder: "Enter name", value: namingMarkerRef.current?._markerName ?? "" },
        ]}
        buttons={[
          { text: "Cancel", role: "cancel" },
          {
            text: "Clear",
            handler: () => {
              if (namingMarkerRef.current) {
                namingMarkerRef.current._markerName = "";
                updateMarkerLabel(namingMarkerRef.current);
              }
            },
          },
          {
            text: "OK",
            handler: (data) => {
              if (namingMarkerRef.current) {
                namingMarkerRef.current._markerName = data.name || "";
                updateMarkerLabel(namingMarkerRef.current);
              }
            },
          },
        ]}
      />
      <IonAlert
        isOpen={stopRecordingAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setStopRecordingAlert(false)}
        header="Stop recording"
        message="Are you sure you want to stop recording?"
        buttons={[
          { text: "Cancel", role: "cancel" },
          { text: "Stop", handler: confirmStopTrackRecording },
        ]}
      />
      <IonAlert
        isOpen={deleteAllAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setDeleteAllAlert(false)}
        header="Delete all features"
        message="Are you sure you want to delete all markers and paths?"
        buttons={[
          { text: "Cancel", role: "cancel" },
          { text: "Delete", handler: confirmDeleteAllFeatures },
        ]}
      />
      <IonAlert
        isOpen={!!deletePathAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setDeletePathAlert(null)}
        header="Delete path"
        message="Are you sure you want to delete this path?"
        buttons={[
          { text: "Cancel", role: "cancel" },
          { text: "Delete", handler: confirmDeletePath },
        ]}
      />
      <IonAlert
        isOpen={cancelPathAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setCancelPathAlert(false)}
        header="Cancel path editing"
        message="Are you sure you want to cancel? All changes will be lost."
        buttons={[
          { text: "Continue editing", role: "cancel" },
          { text: "Discard changes", handler: confirmCancelPath },
        ]}
      />
      <IonAlert
        isOpen={circuitAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => { setCircuitAlert(false); pendingCircuitPathRef.current = null; }}
        header="Circular path"
        message="Close this path into a circuit?"
        buttons={[
          { text: "No", role: "cancel" },
          { text: "Yes", handler: confirmCircuit },
        ]}
      />
      <IonAlert
        isOpen={trackBearingAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setTrackBearingAlert(false)}
        header="Start bearing tracking"
        message="The current path will be saved before starting bearing tracking."
        buttons={[
          { text: "Cancel", role: "cancel" },
          { text: "OK", handler: confirmTrackBearing },
        ]}
      />
      <IonAlert
        isOpen={attachSightAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => { setAttachSightAlert(false); pendingAttachSightRef.current = null; }}
        header="Attach to path"
        message="Attach this marker to the path as a sight?"
        buttons={[
          { text: "No", role: "cancel" },
          { text: "Yes", handler: confirmAttachSight },
        ]}
      />
      <IonAlert
        isOpen={cancelNavigationAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setCancelNavigationAlert(false)}
        header={isTracingPathRef.current ? "Cancel tracing" : "Cancel navigation"}
        message={isTracingPathRef.current ? "Are you sure you want to cancel tracing?" : "Are you sure you want to cancel navigation?"}
        buttons={[
          { text: "Continue", role: "cancel" },
          { text: isTracingPathRef.current ? "Cancel tracing" : "Cancel navigation", handler: confirmCancelNavigation },
        ]}
      />
      <IonAlert
        isOpen={!!exportAlert}
        cssClass={idMapStyle === "rontomap_streets_dark" ? "alert-dark" : ""}
        onDidDismiss={() => setExportAlert(null)}
        header="Export format"
        message="Select export format:"
        buttons={[
          { text: "RontoJSON", handler: () => confirmExport("rontoJson") },
          { text: "GeoJSON", handler: () => confirmExport("geoJson") },
          { text: "GPX", handler: () => confirmExport("gpx") },
          { text: "KML", handler: () => confirmExport("kml") },
          ...(exportAlert?.scope?.type === "path"
            ? [{ text: "FIT", handler: () => confirmExport("fit") }]
            : []),
          { text: "Cancel", role: "cancel" },
        ]}
      />
      {markerMenu && (
        <>
          <div
            className="marker-menu-overlay"
            onClick={() => setMarkerMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMarkerMenu(null);
            }}
          />
          <div
            key={`${menuPos.x}-${menuPos.y}`}
            ref={menuRefCallback}
            className={`marker-menu${idMapStyle === "rontomap_streets_dark" ? " marker-menu-dark" : ""}`}
            style={{ left: menuPos.x, top: menuPos.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button onClick={handleFlyToMarker}>{markerMenu.marker._sightPath ? "Fly to sight" : "Fly to marker"}</button>
            <button onClick={handleCenterToMarker}>{markerMenu.marker._sightPath ? "Center to sight" : "Center to marker"}</button>
            <button onClick={handleNavigateToMarker}>{markerMenu.marker._sightPath ? "Navigate to sight" : "Navigate to marker"}</button>
            <button onClick={handleCopyLinkMarker}>{markerMenu.marker._sightPath ? "Copy link to sight" : "Copy link to marker"}</button>
            <button onClick={handleCopyMarkerCode}>{markerMenu.marker._sightPath ? "Copy sight code" : "Copy marker code"}</button>
            {markerMenu.marker._sightPath && <button onClick={handleDetachSight}>Detach from path</button>}
            <button onClick={handleSetNameMarker}>{markerMenu.marker._sightPath ? "Set name to sight" : "Set name to marker"}</button>
            <button onClick={handleRecordMarkerView}>{markerMenu.marker._sightPath ? "Record sight view" : "Record marker view"}</button>
            <button onClick={handleExportMarker}>{markerMenu.marker._sightPath ? "Export sight" : "Export marker"}</button>
            <button onClick={handleToggleMarkerDrag}>
              {markerMenu.marker.isDraggable() ? "Disable drag" : "Enable drag"}
            </button>
            <button onClick={handleDeleteMarker}>{markerMenu.marker._sightPath ? "Delete sight" : "Delete marker"}</button>
          </div>
        </>
      )}
      {mapClickMenu && (
        <>
          <div
            className="marker-menu-overlay"
            onClick={() => {
              longPressHandledRef.current = false;
              setMapClickMenu(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!mapRef.current) {
                setMapClickMenu(null);
                return;
              }
              const rect = mapRef.current.getContainer().getBoundingClientRect();
              const point = new mapboxgl.Point(e.clientX - rect.left, e.clientY - rect.top);
              const lngLat = mapRef.current.unproject(point);
              setMapClickMenu({ lngLat, x: e.clientX, y: e.clientY });
            }}
          />
          <div
            key={`${mapClickMenu.x}-${mapClickMenu.y}`}
            ref={menuRefCallback}
            className={`marker-menu${idMapStyle === "rontomap_streets_dark" ? " marker-menu-dark" : ""}`}
            style={{ left: mapClickMenu.x, top: mapClickMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {mapClickMenu.path ? (
              <>
                <button onClick={handleFlyToPath}>Fly to path</button>
                <button onClick={handleCenterToPath}>Center to path</button>
                <button onClick={handleNavigateToPath}>Navigate to path</button>
                <button onClick={handleAddSight}>Add sight to path</button>
                <button onClick={handleEditPath}>Edit path</button>
                <button onClick={handleReversePath}>Reverse path</button>
                <button onClick={handleTracePath}>Trace path</button>
                <button onClick={handleSetPathName}>Set path name</button>
                <button onClick={handleRecordPathView}>Record path view</button>
                <button onClick={handleExportPath}>Export path</button>
                <button onClick={handleDeletePath}>Delete path</button>
              </>
            ) : (
              <>
                <button onClick={handleCenterHere}>Center here</button>
                <button onClick={handleNavigateHere}>Navigate here</button>
                <button onClick={handleAddMarkerFromMenu}>Add marker</button>
                <button onClick={handleStartPathCreation}>Start path creation</button>
                {isRecordingTrack ? (
                  <button onClick={handleStopTrackRecording}>Stop track recording</button>
                ) : (
                  <button onClick={handleRecordTrack}>Record track</button>
                )}
                <button onClick={handleCopyFeaturesCode}>Copy features code</button>
                <button onClick={handleCopyFeatures}>Copy link to features</button>
                <button onClick={handleImportFeatures}>Import features</button>
                <button onClick={handleExportAll}>Export features</button>
                <button onClick={handleDeleteAllFeatures}>Delete all features</button>
              </>
            )}
          </div>
        </>
      )}
      {isPathMode && (
        <div className={`path-actions${idMapStyle === "rontomap_streets_dark" ? " path-actions-dark" : ""}`}>
          {!isNavigationTracking && (
            <>
              <div className="path-actions-group">
                <button className="undo-btn" disabled={!canUndo} onClick={undoPath}>
                  Undo
                </button>
                <button className="redo-btn" disabled={!canRedo} onClick={redoPath}>
                  Redo
                </button>
                <button className="cancel-btn" onClick={isNavigationMode ? handleCancelNavigation : handleCancelPathRequest}>
                  Cancel
                </button>
                {isNavigationMode ? (
                  <button
                    className="start-btn"
                    style={pathVertexCount < 2 ? { opacity: 0.3, cursor: "default" } : {}}
                    onClick={() => {
                      if (pathVertexCount < 2) {
                        setToastMsg("Route needs at least 2 points.");
                        setTimeout(() => {
                          setToastMsg(null);
                        }, 2000);
                        return;
                      }
                      handleStartNavigation();
                    }}
                  >
                    Start
                  </button>
                ) : (
                  <button
                    className="save-btn"
                    style={pathVertexCount < 2 ? { opacity: 0.3, cursor: "default" } : {}}
                    onClick={() => {
                      if (pathVertexCount < 2) {
                        setToastMsg("Path needs to have at least 2 points.");
                        setTimeout(() => {
                          setToastMsg(null);
                        }, 2000);
                        return;
                      }
                      handleFinishPath();
                    }}
                  >
                    Save
                  </button>
                )}
              </div>
              <div className={`snap-toggle${isNavigationMode ? " route-snap-toggle" : ""}`}>
                {[null, "foot", "bike", "car"].map((mode) => (
                  <button
                    key={mode ?? "none"}
                    className={snapMode === mode ? "active" : ""}
                    onClick={() => {
                      setSnapMode(mode);
                      setForceMode(false);
                      const path = activePathRef.current;
                      if (!path) return;
                      pushPathSnapshot(path);
                      path.roadSnap = mode;
                      if (mode) {
                        pathHelpersRef.current.fetchRoadSnap(path);
                      } else {
                        path.snappedSegments = null;
                        pathHelpersRef.current.updatePathLine(path);
                        pathHelpersRef.current.updateSights(path);
                        if (!path.isFinished) pathHelpersRef.current.rebuildMidpoints(path);
                        if (path.isRoute && mapRef.current) {
                          const b = new mapboxgl.LngLatBounds();
                          path.vertices.forEach((v) => b.extend(v.lngLat));
                          mapRef.current.fitBounds(b, {
                            padding: 80,
                            bearing: mapRef.current.getBearing(),
                            pitch: mapRef.current.getPitch(),
                            duration: 1000,
                          });
                        }
                      }
                    }}
                  >
                    {mode === null ? "Free" : mode === "foot" ? "Foot" : mode === "bike" ? "Bike" : "Car"}
                  </button>
                ))}
                <div className="force-divider" />
                <button
                  className={forceMode ? "force-active" : ""}
                  onClick={() => setForceMode((f) => !f)}
                >
                  Force
                </button>
              </div>
            </>
          )}
          {routeDistance != null && (
            <div className="route-info">
              <span>{formatDistance(routeDistance)}</span>
              {routeDuration != null && (
                <>
                  <span className="route-info-separator">&middot;</span>
                  <span>{formatDuration(routeDuration)}</span>
                  {isNavigationMode && (
                    <>
                      <span className="route-info-separator">&middot;</span>
                      <span>{formatETA(routeDuration)}</span>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      {toastMsg && (
        <div className={`toast-msg${idMapStyle === "rontomap_streets_dark" ? " toast-msg-dark" : ""}`}>{toastMsg}</div>
      )}
      <div
        ref={mapContainerRef}
        {...bind}
        className={`map-container${idMapStyle === "rontomap_streets_dark" ? " map-style-dark" : ""}${idMapStyle === "rontomap_satellite" ? " map-style-satellite" : ""}${isPathMode ? " path-editing" : ""}${featuresLocked ? " features-locked" : ""}${isEmbeddedRef.current ? " embedded" : ""}`}
      />
    </PageFixedLayout>
  );
}
