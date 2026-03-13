import "./Map.css";
import PageFixedLayout from "../components/PageFixedLayout";
import Fullscreen from "../plugins/Fullscreen";
import { useIonViewWillEnter, IonAlert } from "@ionic/react";
import { useEffect, useRef, useState } from "react";
import { useDoubleTap } from "use-double-tap";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { StatusBar } from "@capacitor/status-bar";
import { Geolocation } from "@capacitor/geolocation";
import { Capacitor } from "@capacitor/core";
import { db } from "../../firebase";
import { collection, addDoc, doc, getDoc, serverTimestamp } from "firebase/firestore";

// Set Mapbox access token
mapboxgl.accessToken = "pk.eyJ1IjoiYXVyZWxpdXMtemQiLCJhIjoiY21rcXA3cXh2MHNpZDNjcXl1a3MzbW8zciJ9.JO4VSTN6-0vRtWW0YKjlAg";

export default function Map() {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const geolocateRef = useRef(null);
  const locationControlRef = useRef(null);
  const markersRef = useRef([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [idMapStyle, setIdMapStyle] = useState(() => {
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
  const [nameAlert, setNameAlert] = useState(false);
  const [isPathMode, setIsPathMode] = useState(false);
  const [pathToast, setPathToast] = useState(null);
  const isPathModeRef = useRef(false);
  const activePathRef = useRef(null);
  const pathsRef = useRef([]);
  const pathClickHandledRef = useRef(false);
  const pathHelpersRef = useRef({});
  const [featuresLocked, setFeaturesLocked] = useState(false);
  const featuresLockedRef = useRef(false);

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
      label.onclick = (e) => {
        e.stopPropagation();
        namingMarkerRef.current = marker;
        setNameAlert(true);
      };
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
    const pageContainer = document.querySelector(".map.center");

    // Ignore clicks on Mapbox controls
    if (e?.target?.closest(".mapboxgl-control-container")) {
      return;
    }

    if (!fullscreen) {
      if (controlsContainer && pageContainer) {
        controlsContainer.style.display = "none";
        // Android: Hide status bar using Capacitor
        if (isNativeAndroid()) {
          console.log("Android: Enter fullscreen.");
          StatusBar.hide();
          Fullscreen.enter();
        }
        // Try native fullscreen
        if (pageContainer.requestFullscreen) {
          pageContainer.requestFullscreen();
        }
        // @ts-ignore
        else if (pageContainer.webkitRequestFullscreen) {
          /* Safari */
          // @ts-ignore
          pageContainer.webkitRequestFullscreen();
        }
        // @ts-ignore
        else if (pageContainer.msRequestFullscreen) {
          /* IE11 */
          // @ts-ignore
          pageContainer.msRequestFullscreen();
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
        setTimeout(() => { if (mapRef.current) mapRef.current.resize(); }, 100);
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

  // Initialize map and add controls
  useEffect(() => {
    console.log("useEffect > Initialize map");

    // Helper to create a marker with cursor and menu event handlers
    const createMarker = (lngLat) => {
      const marker = new mapboxgl.Marker({ color: "#ff6f00", draggable: true })
        .setLngLat(lngLat)
        .addTo(mapRef.current);
      const el = marker.getElement();
      el.style.cursor = "pointer";
      let wasDragged = false;
      el.addEventListener("mousedown", () => {
        el.style.cursor = "grabbing";
        mapRef.current.getCanvasContainer().classList.add("marker-dragging");
      });
      el.addEventListener("mouseup", () => {
        el.style.cursor = "pointer";
        mapRef.current.getCanvasContainer().classList.remove("marker-dragging");
      });
      marker.on("dragstart", () => { wasDragged = true; });
      marker.on("dragend", () => {
        el.style.cursor = "pointer";
        mapRef.current.getCanvasContainer().classList.remove("marker-dragging");
        setTimeout(() => { wasDragged = false; }, 0);
      });
      el.addEventListener("click", (e) => {
        if (wasDragged) return;
        e.stopPropagation();
        setMenuPos(computeMenuPos(marker));
        setMarkerMenu({ marker });
      });
      marker._markerName = "";
      markersRef.current.push(marker);
      return marker;
    };
    createMarkerRef.current = createMarker;

    // --- Path creation helpers ---
    const ensurePathLayer = (path) => {
      const map = mapRef.current;
      if (!map) return;
      if (!map.getSource(path.sourceId)) {
        map.addSource(path.sourceId, {
          type: "geojson",
          data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } },
        });
      }
      if (!map.getLayer(path.layerId)) {
        map.addLayer({
          id: path.layerId,
          type: "line",
          source: path.sourceId,
          paint: { "line-color": "#ff6f00", "line-width": 3, "line-emissive-strength": 1 },
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
        const pathClickHandler = (e) => {
          if (isPathModeRef.current) return;
          pathClickHandledRef.current = true;
          setTimeout(() => { pathClickHandledRef.current = false; }, 400);
          const rect = map.getContainer().getBoundingClientRect();
          setMapClickMenu({ lngLat: e.lngLat, x: rect.left + e.point.x, y: rect.top + e.point.y, path });
        };
        map.on("click", hitLayerId, pathClickHandler);
        map.on("mouseenter", hitLayerId, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", hitLayerId, () => { map.getCanvas().style.cursor = ""; });
      }
    };

    const updatePathLine = (path) => {
      const source = mapRef.current?.getSource(path.sourceId);
      if (!source) return;
      const coords = path.vertices.map((v) => v.lngLat);
      source.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
    };

    const computeMidpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

    const snapToPath = (path, lngLat) => {
      const verts = path.vertices;
      let bestDist = Infinity, bestSeg = 0, bestT = 0;
      const px = lngLat[0], py = lngLat[1];
      for (let i = 0; i < verts.length - 1; i++) {
        const ax = verts[i].lngLat[0], ay = verts[i].lngLat[1];
        const bx = verts[i + 1].lngLat[0], by = verts[i + 1].lngLat[1];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy;
        const dist = (px - cx) * (px - cx) + (py - cy) * (py - cy);
        if (dist < bestDist) { bestDist = dist; bestSeg = i; bestT = t; }
      }
      return { segmentIndex: bestSeg, t: bestT };
    };

    const getAttachedMarkerPos = (path, am) => {
      const verts = path.vertices;
      const segIdx = am._segmentIndex ?? am.segmentIndex;
      const t = am._t ?? am.t;
      const seg = Math.min(segIdx, verts.length - 2);
      const a = verts[seg].lngLat, b = verts[seg + 1].lngLat;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };

    const updateAttachedMarkers = (path) => {
      if (!path.attachedMarkers) return;
      path.attachedMarkers.forEach((m) => {
        const pos = getAttachedMarkerPos(path, m);
        m.setLngLat(pos);
      });
    };

    const createPathVertex = (lngLat) => {
      const el = document.createElement("div");
      el.className = "path-vertex";
      return new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat(lngLat)
        .addTo(mapRef.current);
    };

    const createMidpointMarker = (lngLat) => {
      const el = document.createElement("div");
      el.className = "path-midpoint";
      return new mapboxgl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat(lngLat)
        .addTo(mapRef.current);
    };

    const updateAdjacentMidpoints = (vertexEntry) => {
      const path = vertexEntry.path;
      const verts = path.vertices;
      const idx = verts.indexOf(vertexEntry);
      if (idx < 0) return;
      path.midpoints.forEach((mp) => {
        if (mp.segmentIndex === idx - 1 || mp.segmentIndex === idx) {
          const a = verts[mp.segmentIndex].lngLat;
          const b = verts[mp.segmentIndex + 1].lngLat;
          mp.marker.setLngLat(computeMidpoint(a, b));
        }
      });
    };

    const hideIntermediateVertices = (path) => {
      path.vertices.forEach((v, i) => {
        if (i > 0 && i < path.vertices.length - 1) {
          v.marker.getElement().style.display = "none";
        }
      });
    };

    const showAllVertices = (path) => {
      path.vertices.forEach((v) => { v.marker.getElement().style.display = ""; });
    };

    const attachVertexDragHandler = (vertexEntry) => {
      vertexEntry.marker.on("dragstart", () => { mapRef.current.getCanvas().style.cursor = "grabbing"; });
      vertexEntry.marker.on("drag", () => {
        const pos = vertexEntry.marker.getLngLat();
        vertexEntry.lngLat = [pos.lng, pos.lat];
        updatePathLine(vertexEntry.path);
        updateAdjacentMidpoints(vertexEntry);
        updateAttachedMarkers(vertexEntry.path);
      });
      vertexEntry.marker.on("dragend", () => {
        mapRef.current.getCanvas().style.cursor = "";
        const pos = vertexEntry.marker.getLngLat();
        vertexEntry.lngLat = [pos.lng, pos.lat];
        updatePathLine(vertexEntry.path);
        updateAttachedMarkers(vertexEntry.path);
        if (!vertexEntry.path.isFinished) rebuildMidpoints(vertexEntry.path);
      });
    };

    const promoteMidpointToVertex = (mpEntry) => {
      const { marker, segmentIndex, path } = mpEntry;
      const ll = marker.getLngLat();
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];
      // Shift attached markers on the split segment
      if (path.attachedMarkers) {
        path.attachedMarkers.forEach((m) => {
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
      path.vertices.splice(segmentIndex + 1, 0, newVertex);
      attachVertexDragHandler(newVertex);
      attachFinishHandler(newVertex);
      updatePathLine(path);
      rebuildMidpoints(path);
      updateVertexStyles(path);
      updateAttachedMarkers(path);
    };

    const rebuildMidpoints = (path) => {
      path.midpoints.forEach((mp) => mp.marker.remove());
      path.midpoints = [];
      const verts = path.vertices;
      for (let i = 0; i < verts.length - 1; i++) {
        const mid = computeMidpoint(verts[i].lngLat, verts[i + 1].lngLat);
        const marker = createMidpointMarker(mid);
        const mpEntry = { marker, segmentIndex: i, path };
        marker.on("dragstart", () => { mapRef.current.getCanvas().style.cursor = "grabbing"; });
        marker.on("drag", () => {
          const pos = marker.getLngLat();
          const coords = [];
          for (let j = 0; j < verts.length; j++) {
            coords.push(verts[j].lngLat);
            if (j === mpEntry.segmentIndex) coords.push([pos.lng, pos.lat]);
          }
          const source = mapRef.current?.getSource(path.sourceId);
          if (source) source.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords } });
        });
        marker.on("dragend", () => {
          mapRef.current.getCanvas().style.cursor = "";
          promoteMidpointToVertex(mpEntry);
        });
        path.midpoints.push(mpEntry);
      }
    };

    const attachFinishHandler = (vertexEntry) => {
      const el = vertexEntry.marker.getElement();
      let wasDragged = false;
      vertexEntry.marker.on("dragstart", () => { wasDragged = true; });
      vertexEntry.marker.on("dragend", () => { setTimeout(() => { wasDragged = false; }, 0); });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (wasDragged) return;
        const path = vertexEntry.path;
        const verts = path.vertices;
        if (!path.isFinished && verts.length > 2) {
          const idx = verts.indexOf(vertexEntry);
          if (idx < 0) return;
          // Shift attached markers for removed vertex
          if (path.attachedMarkers) {
            const maxSeg = verts.length - 2; // segments before removal
            path.attachedMarkers = path.attachedMarkers.filter((m) => {
              // Remove markers on segments touching this vertex that can't be remapped
              if (idx === 0 && m._segmentIndex === 0) {
                m._segmentIndex = 0;
                return true;
              }
              if (m._segmentIndex === idx - 1 || m._segmentIndex === idx) {
                // Merge into the new combined segment
                const prevIdx = Math.max(0, idx - 1);
                const nextIdx = Math.min(idx + 1, verts.length - 1);
                // Re-snap after removal
                const a = verts[prevIdx].lngLat;
                const b = verts[nextIdx].lngLat;
                const pos = m.getLngLat();
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const len2 = dx * dx + dy * dy;
                m._t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pos.lng - a[0]) * dx + (pos.lat - a[1]) * dy) / len2));
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
          updatePathLine(path);
          rebuildMidpoints(path);
          updateVertexStyles(path);
          updateAttachedMarkers(path);
        } else if (path.isFinished && (verts[0] === vertexEntry || verts[verts.length - 1] === vertexEntry)) {
          pathClickHandledRef.current = true;
          setTimeout(() => { pathClickHandledRef.current = false; }, 400);
          const map = mapRef.current;
          const pos = vertexEntry.marker.getLngLat();
          const point = map.project(pos);
          const rect = map.getContainer().getBoundingClientRect();
          setMapClickMenu({ lngLat: pos, x: rect.left + point.x, y: rect.top + point.y, path });
        }
      });
    };

    const updateVertexStyles = (path) => {
      const verts = path.vertices;
      verts.forEach((v) => v.marker.getElement().classList.remove("path-vertex-last"));
      if (verts.length > 0) verts[verts.length - 1].marker.getElement().classList.add("path-vertex-last");
    };

    pathHelpersRef.current = {
      ensurePathLayer, updatePathLine, createPathVertex, rebuildMidpoints,
      attachVertexDragHandler, attachFinishHandler, updateVertexStyles,
      hideIntermediateVertices, showAllVertices, snapToPath, updateAttachedMarkers, getAttachedMarkerPos,
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
    const zoom = !isNaN(urlZoom) ? urlZoom : (!isNaN(lat) && !isNaN(long) ? defaultZoomOnQueryParams : defaultZoom);
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
        this._map.doubleClickZoom.disable();
        this._map.touchZoomRotate.disable();
        this._map.touchPitch.disable();
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

      async _handleTrackBearing() {
        console.log("_handleTrackBearing");
        this._trackingLocation = false;

        // Finish path creation if active
        if (isPathModeRef.current) {
          isPathModeRef.current = false;
          setIsPathMode(false);
          if (activePathRef.current) {
            activePathRef.current.isFinished = true;
            pathHelpersRef.current.hideIntermediateVertices?.(activePathRef.current);
            activePathRef.current.midpoints.forEach((mp) => mp.marker.remove());
            activePathRef.current.midpoints = [];
          }
          setPathToast("Path saved. You can edit it after stopping bearing tracking.");
          setTimeout(() => { setPathToast(null); }, 3000);
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
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/user_tracking_location.svg');"></span>
              </button>
              <button
                  class="mapboxgl-ctrl-geolocate hidden"
                  type="button"
                  title="Stop Tracking User Bearing"
                  aria-label="Tracking User Bearing"
                  data-control="stop_tracking_bearing"
              >
                  <span class="mapboxgl-ctrl-icon" style="background-image: url('assets/user_tracking_bearing.svg');"></span>
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
            center: [long, lat],
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
    });

    // On dragstart
    mapRef.current.on("dragstart", () => {
      console.log("Event > map > dragstart");
      mapRef.current.getCanvasContainer().classList.add("map-dragging");
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
      mapRef.current.getCanvasContainer().classList.remove("map-dragging");
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
      mapRef.current.getCanvasContainer().classList.add("map-dragging");
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
      mapRef.current.getCanvasContainer().classList.remove("map-dragging");
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

    // Add marker on click (debounced to avoid double-tap placing two markers)
    let clickTimer = null;
    mapRef.current.on("click", (e) => {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        // Don't show menu when clicking to close the search input
        if (geocoderOpenRef.current) return;

        // Don't show menu when tracking bearing
        if (locationControlRef.current?.isTrackingBearing()) return;

        // Don't show menu when a path was clicked (handled by layer-specific handler)
        if (pathClickHandledRef.current) return;

        // Path mode: add vertex instead of showing context menu
        if (isPathModeRef.current) {
          const path = activePathRef.current;
          if (path && !path.isFinished) {
            const lngLat = [e.lngLat.lng, e.lngLat.lat];
            const h = pathHelpersRef.current;
            const marker = h.createPathVertex(lngLat);
            const vertex = { lngLat, marker, path };
            path.vertices.push(vertex);
            h.attachVertexDragHandler(vertex);
            h.attachFinishHandler(vertex);
            h.updatePathLine(path);
            h.rebuildMidpoints(path);
            h.updateVertexStyles(path);
            return;
          }
        }

        const point = mapRef.current.project(e.lngLat);
        const rect = mapRef.current.getContainer().getBoundingClientRect();
        setMapClickMenu({ lngLat: e.lngLat, x: rect.left + point.x, y: rect.top + point.y });
      }, 300);
    });

    // Add the geolocate control to the map without adding it to the UI
    mapRef.current.addControl(geolocateRef.current);
    geolocateRef.current._container.style.display = "none";

    // Add search control with custom styling
    const geocoder = new MapboxGeocoder({
      accessToken: mapboxgl.accessToken,
      mapboxgl: mapboxgl,
      marker: false,
      placeholder: "Search",
      collapsed: true,
    });
    mapRef.current.addControl(geocoder, "top-left");

    // Focus on user input when search icon is clicked
    const geocoderEl = document.querySelector(".mapboxgl-ctrl-geocoder");
    if (geocoderEl) {
      geocoderEl.addEventListener("click", () => {
        const input = geocoderEl.querySelector("input");
        input?.focus();
      });
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

    // Add custom location tracking controls to map
    mapRef.current.addControl(locationControlRef.current, "top-right");

    // Add compass icon
    const nav = new mapboxgl.NavigationControl({
      showZoom: false,
      visualizePitch: true,
    });
    mapRef.current.addControl(nav, "top-right");

    // Add custom className to the compass container
    nav._container.classList.add("ctrl-compass-container");

    // Enable rotation gestures (right-click drag on desktop, two-finger rotate on mobile)
    mapRef.current.dragRotate.enable();

    // Enable pinch-to-zoom and rotate gestures on touch devices
    mapRef.current.touchZoomRotate.enable();

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
      }
    }

    // Recreate markers from a Firebase features collection
    const featuresCollectionId = getQueryParams("features_collection");
    if (featuresCollectionId) {
      getDoc(doc(db, "featuresCollections", featuresCollectionId)).then((snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        (data.markers || []).forEach((entry) => {
          const m = createMarker([entry.pos[1], entry.pos[0]]);
          if (entry.name) {
            m._markerName = entry.name;
            updateMarkerLabel(m);
          }
        });
        const h = pathHelpersRef.current;
        (data.paths || []).forEach((entry) => {
          const id = `path-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const path = {
            id,
            sourceId: `path-line-source-${id}`,
            layerId: `path-line-layer-${id}`,
            vertices: [],
            midpoints: [],
            isFinished: true,
          };
          pathsRef.current.push(path);
          h.ensurePathLayer(path);
          entry.coords.forEach((c) => {
            const lngLat = [c.long, c.lat];
            const marker = h.createPathVertex(lngLat);
            const vertex = { lngLat, marker, path };
            path.vertices.push(vertex);
            h.attachVertexDragHandler(vertex);
            h.attachFinishHandler(vertex);
          });
          if (entry.startName && path.vertices.length > 0) {
            path.vertices[0].marker._markerName = entry.startName;
            updateMarkerLabel(path.vertices[0].marker);
          }
          if (entry.endName && path.vertices.length > 0) {
            path.vertices[path.vertices.length - 1].marker._markerName = entry.endName;
            updateMarkerLabel(path.vertices[path.vertices.length - 1].marker);
          }
          if (entry.savedView) path.savedView = entry.savedView;
          if (entry.attachedMarkers) {
            path.attachedMarkers = [];
            entry.attachedMarkers.forEach((am) => {
              const pos = h.getAttachedMarkerPos(path, am);
              const m = createMarker(pos);
              m._attachedPath = path;
              m._segmentIndex = am.segmentIndex;
              m._t = am.t;
              if (am.name) {
                m._markerName = am.name;
                updateMarkerLabel(m);
              }
              m.on("drag", () => {
                if (!m._attachedPath) return;
                const p = m.getLngLat();
                const s = h.snapToPath(m._attachedPath, [p.lng, p.lat]);
                m._segmentIndex = s.segmentIndex;
                m._t = s.t;
                const newPos = h.getAttachedMarkerPos(m._attachedPath, m);
                m.setLngLat(newPos);
              });
              path.attachedMarkers.push(m);
            });
          }
          h.updatePathLine(path);
          h.hideIntermediateVertices(path);
          h.updateVertexStyles(path);
        });
        // Lock features when loaded from URL
        featuresLockedRef.current = true;
        setFeaturesLocked(true);
        markersRef.current.forEach((m) => m.setDraggable(false));
        pathsRef.current.forEach((p) => {
          p.vertices.forEach((v) => v.marker.setDraggable(false));
        });
      });
    }
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
    map.setStyle(mapStyle);
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
      });
    });
  }, [mapStyle]);

  // Keep isPathModeRef in sync with state
  useEffect(() => { isPathModeRef.current = isPathMode; }, [isPathMode]);

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
    mapRef.current.flyTo({ center: markerMenu.marker.getLngLat(), duration: 500 });
    setMarkerMenu(null);
  };

  const handleCopyMarker = () => {
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
    setPathToast("Link copied.");
    setTimeout(() => { setPathToast(null); }, 1000);
  };

  const handleCopyFeatures = async () => {
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const bearing = mapRef.current.getBearing();
    const pitch = mapRef.current.getPitch();
    const freeMarkers = markersRef.current.filter((m) => !m._attachedPath);
    const markers = freeMarkers.map((m, i) => {
      const ll = m.getLngLat();
      return {
        id: `m${i + 1}`,
        name: m._markerName || "",
        pos: [ll.lat, ll.lng],
      };
    });
    const paths = pathsRef.current.map((p, i) => {
      const pathData = {
        id: `p${i + 1}`,
        coords: p.vertices.map((v) => ({ long: v.lngLat[0], lat: v.lngLat[1] })),
      };
      const startName = p.vertices[0]?.marker._markerName;
      const endName = p.vertices[p.vertices.length - 1]?.marker._markerName;
      if (startName) pathData.startName = startName;
      if (endName) pathData.endName = endName;
      if (p.savedView) pathData.savedView = p.savedView;
      if (p.attachedMarkers && p.attachedMarkers.length > 0) {
        pathData.attachedMarkers = p.attachedMarkers.map((m) => {
          const am = { segmentIndex: m._segmentIndex, t: m._t };
          if (m._markerName) am.name = m._markerName;
          return am;
        });
      }
      return pathData;
    });
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
    setPathToast("Link copied.");
    setTimeout(() => { setPathToast(null); }, 1000);
  };

  const handleDeleteMarker = () => {
    markerMenu.marker.remove();
    markersRef.current = markersRef.current.filter((m) => m !== markerMenu.marker);
    setMarkerMenu(null);
  };

  const handleDetachFromPath = () => {
    const marker = markerMenu.marker;
    const path = marker._attachedPath;
    if (path && path.attachedMarkers) {
      path.attachedMarkers = path.attachedMarkers.filter((m) => m !== marker);
    }
    delete marker._attachedPath;
    delete marker._segmentIndex;
    delete marker._t;
    setMarkerMenu(null);
  };

  const handleSetName = () => {
    namingMarkerRef.current = markerMenu.marker;
    setMarkerMenu(null);
    setNameAlert(true);
  };

  const handleFlyToHere = () => {
    mapRef.current.flyTo({ center: mapClickMenu.lngLat, duration: 500 });
    setMapClickMenu(null);
  };

  const applyFeaturesLock = (locked) => {
    markersRef.current.forEach((m) => m.setDraggable(!locked));
    pathsRef.current.forEach((p) => {
      p.vertices.forEach((v) => v.marker.setDraggable(!locked));
    });
  };

  const handleToggleFeaturesLock = () => {
    const newLocked = !featuresLockedRef.current;
    featuresLockedRef.current = newLocked;
    setFeaturesLocked(newLocked);
    applyFeaturesLock(newLocked);
    setMapClickMenu(null);
  };

  const handleAddMarkerFromMenu = () => {
    createMarkerRef.current(mapClickMenu.lngLat);
    setMapClickMenu(null);
  };

  const handleStartPathCreation = () => {
    const lngLat = [mapClickMenu.lngLat.lng, mapClickMenu.lngLat.lat];
    setMapClickMenu(null);

    // Finish any active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished) {
      activePathRef.current.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(activePathRef.current);
      activePathRef.current.midpoints.forEach((mp) => mp.marker.remove());
      activePathRef.current.midpoints = [];
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

    setIsPathMode(true);
    isPathModeRef.current = true;

    const h = pathHelpersRef.current;
    h.ensurePathLayer(newPath);

    // Create first vertex
    const marker = h.createPathVertex(lngLat);
    const vertex = { lngLat, marker, path: newPath };
    newPath.vertices.push(vertex);
    h.attachVertexDragHandler(vertex);
    h.attachFinishHandler(vertex);
    h.updatePathLine(newPath);
    h.updateVertexStyles(newPath);
    setPathToast("Click here to finish the path.");
  };

  const handleEditPath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);

    // Finish any other active unfinished path
    if (activePathRef.current && !activePathRef.current.isFinished && activePathRef.current !== path) {
      activePathRef.current.isFinished = true;
      pathHelpersRef.current.hideIntermediateVertices(activePathRef.current);
      activePathRef.current.midpoints.forEach((mp) => mp.marker.remove());
      activePathRef.current.midpoints = [];
    }

    path.isFinished = false;
    activePathRef.current = path;
    // Unlock features for editing, remember previous state
    path._wasLocked = featuresLockedRef.current;
    if (featuresLockedRef.current) {
      featuresLockedRef.current = false;
      setFeaturesLocked(false);
      applyFeaturesLock(false);
    }
    pathHelpersRef.current.showAllVertices(path);
    pathHelpersRef.current.rebuildMidpoints(path);
    pathHelpersRef.current.updateVertexStyles(path);
    setIsPathMode(true);
    isPathModeRef.current = true;
    setPathToast("Click here to finish the path.");
  };

  const handleReversePath = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);

    const numSegs = path.vertices.length - 1;
    path.vertices.reverse();
    if (path.attachedMarkers) {
      path.attachedMarkers.forEach((m) => {
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

    const map = mapRef.current;
    const hitLayerId = `${path.layerId}-hit`;
    if (map.getLayer(hitLayerId)) map.removeLayer(hitLayerId);
    if (map.getLayer(path.layerId)) map.removeLayer(path.layerId);
    if (map.getSource(path.sourceId)) map.removeSource(path.sourceId);

    path.vertices.forEach((v) => v.marker.remove());
    path.midpoints.forEach((mp) => mp.marker.remove());
    if (path.attachedMarkers) {
      path.attachedMarkers.forEach((m) => {
        m.remove();
        markersRef.current = markersRef.current.filter((mk) => mk !== m);
      });
    }

    pathsRef.current = pathsRef.current.filter((p) => p !== path);

    if (activePathRef.current === path) {
      activePathRef.current = null;
      setIsPathMode(false);
      isPathModeRef.current = false;
    }
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
    setPathToast("Path view recorded.");
    setTimeout(() => { setPathToast(null); }, 1000);
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
        pitch: path.savedView.pitch,
        bearing: path.savedView.bearing,
        duration: 1500,
      });
    } else if (path.vertices.length > 0) {
      map.flyTo({ center: path.vertices[0].lngLat, duration: 1500 });
    }
  };

  const handleAddMarkerToPath = () => {
    const path = mapClickMenu.path;
    const lngLat = mapClickMenu.lngLat;
    setMapClickMenu(null);
    if (!path || path.vertices.length < 2) return;
    const h = pathHelpersRef.current;
    const snap = h.snapToPath(path, [lngLat.lng, lngLat.lat]);
    const a = path.vertices[snap.segmentIndex].lngLat;
    const b = path.vertices[snap.segmentIndex + 1].lngLat;
    const snappedLngLat = [a[0] + snap.t * (b[0] - a[0]), a[1] + snap.t * (b[1] - a[1])];
    const marker = createMarkerRef.current(snappedLngLat);
    marker._attachedPath = path;
    marker._segmentIndex = snap.segmentIndex;
    marker._t = snap.t;
    marker.on("drag", () => {
      if (!marker._attachedPath) return;
      const pos = marker.getLngLat();
      const s = h.snapToPath(marker._attachedPath, [pos.lng, pos.lat]);
      marker._segmentIndex = s.segmentIndex;
      marker._t = s.t;
      const newPos = h.getAttachedMarkerPos(marker._attachedPath, marker);
      marker.setLngLat(newPos);
    });
    if (!path.attachedMarkers) path.attachedMarkers = [];
    path.attachedMarkers.push(marker);
  };

  const handleSetPathStartName = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (path && path.vertices.length > 0) {
      namingMarkerRef.current = path.vertices[0].marker;
      setNameAlert(true);
    }
  };

  const handleSetPathEndName = () => {
    const path = mapClickMenu.path;
    setMapClickMenu(null);
    if (path && path.vertices.length > 0) {
      namingMarkerRef.current = path.vertices[path.vertices.length - 1].marker;
      setNameAlert(true);
    }
  };

  // Show tips
  useEffect(() => {
    console.log("useEffect > Show tips");
    const dontShowTips = localStorage.getItem("rontomap_dont_show_tips");
    if (dontShowTips) {
      setShowTips(false);
    }
  }, []);

  return (
    <PageFixedLayout name="map">
      <IonAlert
        isOpen={showTips}
        onDidDismiss={() => setShowTips(false)}
        header="RontoMap"
        message={
          "Tilt the map: Use two fingers on touchscreen or right-click and drag with mouse.\n\n" +
          "Location tracking: Click location icon to enable, once more to follow direction. \n\n" +
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
        cssClass={`name-alert${idMapStyle === "rontomap_streets_dark" ? " name-alert-dark" : ""}`}
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
        inputs={[{ name: "name", type: "text", placeholder: "Enter name", value: namingMarkerRef.current?._markerName ?? "" }]}
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
      {markerMenu && (
        <>
          <div className="marker-menu-overlay" onClick={() => setMarkerMenu(null)} />
          <div className={`marker-menu${idMapStyle === "rontomap_streets_dark" ? " marker-menu-dark" : ""}`} style={{ left: menuPos.x, top: menuPos.y }}>
            <button onClick={handleCenterToMarker}>Fly to marker</button>
            <button onClick={handleSetName}>Set name</button>
            <button onClick={handleCopyMarker}>Copy link to marker</button>
            {markerMenu.marker._attachedPath && <button onClick={handleDetachFromPath}>Detach from path</button>}
            <button onClick={handleDeleteMarker}>Delete marker</button>
          </div>
        </>
      )}
      {mapClickMenu && (
        <>
          <div className="marker-menu-overlay" onClick={() => setMapClickMenu(null)} />
          <div className={`marker-menu${idMapStyle === "rontomap_streets_dark" ? " marker-menu-dark" : ""}`} style={{ left: mapClickMenu.x, top: mapClickMenu.y }}>
            {mapClickMenu.path ? (
              <>
                <button onClick={handleFlyToPath}>Fly to path</button>
                <button onClick={handleAddMarkerToPath}>Add marker to path</button>
                <button onClick={handleEditPath}>Edit path</button>
                <button onClick={handleReversePath}>Reverse path</button>
                <button onClick={handleSetPathStartName}>Set name to start</button>
                <button onClick={handleSetPathEndName}>Set name to end</button>
                <button onClick={handleRecordPathView}>Record path view</button>
                <button onClick={handleDeletePath}>Delete path</button>
              </>
            ) : (
              <>
                <button onClick={handleFlyToHere}>Fly to here</button>
                <button onClick={handleAddMarkerFromMenu}>Add marker</button>
                <button onClick={handleStartPathCreation}>Start path creation</button>
                <button onClick={handleToggleFeaturesLock}>{featuresLocked ? "Unlock features" : "Lock features"}</button>
                <button onClick={handleCopyFeatures}>Copy link to features</button>
              </>
            )}
          </div>
        </>
      )}
      {pathToast && (
        <div className={`path-toast${idMapStyle === "rontomap_streets_dark" ? " path-toast-dark" : ""}`}
          onClick={() => {
            const path = activePathRef.current;
            if (path && !path.isFinished && path.vertices.length > 1) {
              path.isFinished = true;
              isPathModeRef.current = false;
              setIsPathMode(false);
              pathHelpersRef.current.hideIntermediateVertices(path);
              path.midpoints.forEach((mp) => mp.marker.remove());
              path.midpoints = [];
              setPathToast(null);
              if (path._wasLocked) {
                delete path._wasLocked;
                featuresLockedRef.current = true;
                setFeaturesLocked(true);
                applyFeaturesLock(true);
              }
            }
          }}
          style={{ cursor: isPathMode ? "pointer" : undefined }}>
          {pathToast}
        </div>
      )}
      <div ref={mapContainerRef} {...bind} className={`map-container${idMapStyle === "rontomap_streets_dark" ? " map-style-dark" : ""}`} />
    </PageFixedLayout>
  );
}
