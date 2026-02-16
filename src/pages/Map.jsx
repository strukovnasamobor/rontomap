import "./Map.css";
import PageFixedLayout from "../components/PageFixedLayout";
import Fullscreen from '../plugins/Fullscreen';
import { useIonViewWillEnter, IonAlert } from '@ionic/react';
import { useEffect, useRef, useState } from 'react';
import { useDoubleTap } from 'use-double-tap';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';
import { StatusBar } from '@capacitor/status-bar';
import { Geolocation } from '@capacitor/geolocation';

// Set Mapbox access token
mapboxgl.accessToken = 'pk.eyJ1IjoiYXVyZWxpdXMtemQiLCJhIjoiY21rcXA3cXh2MHNpZDNjcXl1a3MzbW8zciJ9.JO4VSTN6-0vRtWW0YKjlAg';

export default function Map() {
    const mapRef = useRef(null);
    const mapContainerRef = useRef(null);
    const geolocateRef = useRef(null);
    const locationControlRef = useRef(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [idMapStyle, setIdMapStyle] = useState(() => {
        const storedIdMapStyle = localStorage.getItem("rontomap_id_map_style");
        return storedIdMapStyle ? storedIdMapStyle : "rontomap_streets_light";
    });    
    const [mapStyle, setMapStyle] = useState('');
    const [defaultCenter, setDefaultCenter] = useState([0, 0]);
    const [defaultZoom, setDefaultZoom] = useState(14);
    const [defaultBearing, setDefaultBearing] = useState(0);
    const [defaultPitch, setDefaultPitch] = useState(0);
    const [savedCenter, setSavedCenter] = useState(defaultCenter);
    const [savedZoom, setSavedZoom] = useState(1);
    const [savedBearing, setSavedBearing] = useState(defaultBearing);
    const [savedPitch, setSavedPitch] = useState(defaultPitch);
    const [showTips, setShowTips] = useState(true);

    // Detect Android
    const isAndroid = () => {
        return /android/i.test(navigator.userAgent);
    };

    // Get query params from URL
    const getQueryParams = (param) => {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get(param);
    };

    // Add source and support links to the map
    const addSourceAndSupportLink = () => {
        const tryAdd = () => {
            const el = mapRef.current
                ?.getContainer()
                ?.querySelector(".mapboxgl-ctrl-attrib-inner");

            if (!el) {
                // Retry on next animation frame
                requestAnimationFrame(tryAdd);
                return;
            }

            // Prevent duplicates
            if (el.innerHTML.includes("rontomap")) return;
            el.innerHTML = el.innerHTML.replace("Improve this map", "");
            el.innerHTML +=
                ` | <a href="https://github.com/strukovnasamobor/rontomap"
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
        const controlsContainer = document.querySelector('.mapboxgl-control-container');
        const mapContainer = document.querySelector('.map-container');

        // Ignore clicks on Mapbox controls
        if (e?.target?.closest(".mapboxgl-control-container")) {
          return;
        }

        if (!fullscreen) {
            if (controlsContainer && mapContainer) {
                controlsContainer.style.display = 'none';
                 // Android: Hide status bar using Capacitor
                if (isAndroid()) {
                    console.log('Android: Enter fullscreen.');
                    StatusBar.hide();
                    Fullscreen.enter();
                }
                // Try native fullscreen
                if (mapContainer.requestFullscreen) {
                    mapContainer.requestFullscreen();
                }
                // @ts-ignore
                else if (mapContainer.webkitRequestFullscreen) { /* Safari */
                    // @ts-ignore
                    mapContainer.webkitRequestFullscreen();
                }
                // @ts-ignore
                else if (mapContainer.msRequestFullscreen) { /* IE11 */
                    // @ts-ignore
                    mapContainer.msRequestFullscreen();
                }
            }
        }
        else {
            if (controlsContainer)
                controlsContainer.style.display = 'block';
            // Android: Show status bar
            if (isAndroid()) {
                console.log('Android: Exit fullscreen.');
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
            else if (document.webkitFullscreenElement) { /* Safari */
                // @ts-ignore
                if (document.webkitExitFullscreen) {
                    // @ts-ignore
                    document.webkitExitFullscreen();
                }
            }
            // @ts-ignore
            else if (document.msFullscreenElement) { /* IE11 */
                // @ts-ignore
                if (document.msExitFullscreen) {
                    // @ts-ignore
                    document.msExitFullscreen();
                }
            }
        }

        // Toggle state
        setFullscreen(prev => !prev);

        // Resize map
        setTimeout(() => {
            if (mapRef.current) {
                mapRef.current.resize();
            }
        }, 100);
    }, 300);

    // Resize map on view enter
    useIonViewWillEnter(() => {
        if (mapRef.current)
            mapRef.current.resize();
    }, [mapStyle]);

    // Set map style URLs
    useEffect(() => {
        console.log("useEffect > idMapStyle:", idMapStyle);
        if(idMapStyle == "rontomap_streets_light") {
            setMapStyle('mapbox://styles/aurelius-zd/cmjmktkev00cc01sb0a6ff4i5');
            document.querySelector('[data-control="change_map_style_rontomap_streets_light"]')?.classList.add("hidden");
            document.querySelector('[data-control="change_map_style_rontomap_streets_dark"]')?.classList.remove("hidden");
        }
        else if(idMapStyle == "rontomap_streets_dark") {
            setMapStyle('mapbox://styles/aurelius-zd/cmjmqcp3b000101r2g5vb6bse');
            document.querySelector('[data-control="change_map_style_rontomap_streets_dark"]')?.classList.add("hidden");
            document.querySelector('[data-control="change_map_style_rontomap_satellite"]')?.classList.remove("hidden");
        }
        else if(idMapStyle == "rontomap_satellite") {
            setMapStyle('mapbox://styles/aurelius-zd/cmefvgizo00ul01sc2rek321h');
            document.querySelector('[data-control="change_map_style_rontomap_satellite"]')?.classList.add("hidden");
            document.querySelector('[data-control="change_map_style_rontomap_streets_light"]')?.classList.remove("hidden");
        }
    }, [idMapStyle]);

    // Initialize map and add controls
    useEffect(() => {
        if (mapRef.current)
            mapRef.current.resize();

        // Get lat and long from the URL
        const lat = parseFloat(getQueryParams('lat'));
        const long = parseFloat(getQueryParams('long'));

        // Set new center and zoom
        const center = (!isNaN(lat) && !isNaN(long)) ? [long, lat] : savedCenter;
        const zoom = (!isNaN(lat) && !isNaN(long)) ? 20 : savedZoom;
        const bearing = savedBearing;
        const pitch = savedPitch;

        if (mapRef.current) {
            if (!isNaN(lat) && !isNaN(long)) {
                mapRef.current.flyTo({
                    center: center,
                    zoom: zoom,
                    bearing: bearing,
                    pitch: pitch,
                    duration: 1000
                });
            }
            return;
        }

        mapRef.current = new mapboxgl.Map({
            container: mapContainerRef.current,
            style: mapStyle,
            doubleClickZoom: false,
            // @ts-ignore
            center: center,
            zoom: zoom,
            bearing: bearing,
            pitch: pitch
        });

        mapRef.current.once('load', () => {
            if (locationControlRef.current && 'geolocation' in navigator) {
                locationControlRef.current.showTrackingLocationIcon();
            }
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
                this._isUserDragging = false;
                this._zoomOnStartTrackingBearing = defaultZoom;
                this._pitchOnStartTrackingBearing = defaultPitch;
                this._zoomOnStopTrackingBearing = null;
                this._pitchOnStopTrackingBearing = null;
                this._zoomStart = null;
                this._pitchStart = null;
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

            async _handleClick(e) {
                const button = e.target instanceof Element ? e.target.closest('button') : null;
                if (!button) return;

                const control = button.dataset.control;
                console.log('_handleClick:', control);

                switch (control) {
                    case 'change_map_style_rontomap_satellite':
                        await this._handleChangeMapStyle("rontomap_satellite");
                        break;
                    case 'change_map_style_rontomap_streets_light':
                        await this._handleChangeMapStyle("rontomap_streets_light");
                        break;
                    case 'change_map_style_rontomap_streets_dark':
                        await this._handleChangeMapStyle("rontomap_streets_dark");
                        break;
                    case 'track_location':
                        this.hideTrackingIcons();
                        await this._handleTrackLocation();
                        break;
                    case 'track_bearing':
                        this.hideTrackingIcons();
                        await this._handleTrackBearing();
                        break;
                    case 'stop_tracking_bearing':
                        this.hideTrackingIcons();
                        await this._handleStopTrackingBearing();
                        break;
                }
            }

            async _handleChangeMapStyle(idMapStyle) {
                console.log('_handleChangeMapStyle');
                localStorage.setItem("rontomap_id_map_style", idMapStyle);
                setIdMapStyle(idMapStyle);
            }

            async _handleTrackLocation() {
                console.log('_handleTrackLocation');

                // Set the starting zoom and pitch
                this._zoomStart = this._map.getZoom();
                this._pitchStart = this._map.getPitch();

                if(this._zoomStart == 1)
                    this._zoomStart = defaultZoom;

                // Override to prevent camera movement
                this._geolocate._updateCamera = async () => {
                    try {
                        // Check current permission status
                        const permissionStatus = await Geolocation.checkPermissions();
                        
                        if (permissionStatus.location !== 'granted') {
                            // Request if not granted
                            const permissions = await Geolocation.requestPermissions();
                            if (permissions.location !== 'granted' && permissions.location !== 'limited') {
                                console.log("_updateCamera > Location permission denied");
                                return;
                            }
                        }
                        
                        const position = await Geolocation.getCurrentPosition();
                        const long = position.coords.longitude;
                        const lat = position.coords.latitude;
                        const bearing = position.coords.heading ? position.coords.heading : null;
                        console.log("_updateCamera:", long, lat, bearing);
                    } catch (err) {
                        console.error("_updateCamera > Error getting user location:", err);
                    }
                };

                // Set map to last position
                if (this._lastPostionLat != null && this._lastPostionLong != null) {
                    console.log("_handleTrackLocation > Set map to last position.");
                    const lat = this._lastPostionLat;
                    const long = this._lastPostionLong;
                    let zoom = this._map.getZoom();
                    let pitch = this._map.getPitch();

                    if (this.getZoomStart() != null) {
                        zoom = this.getZoomStart();
                        this.resetZoomStart();
                    }

                    if (this.getPitchStart() != null) {
                        pitch = this.getPitchStart();
                        this.resetPitchStart();
                    }

                    mapRef.current.flyTo({
                        center: [long, lat],
                        zoom: zoom,
                        pitch: pitch,
                        duration: 1000
                    }).once('moveend', () => {
                        this.showTrackingBearingIcon();
                        this._trackingLocation = true;
                    });
                }
                else {
                    this._geolocate.trigger();
                    this._trackingLocation = true;
                }
            }

            async _handleTrackBearing() {
                console.log('_handleTrackBearing');
                //mapRef.current.dragPan.disable();
                this._trackingLocation = false;

                // Request wake lock
                await this._requestWakeLock();

                // Remember the current zoom and pitch
                this._zoomOnStartTrackingBearing = this._map.getZoom();
                this._pitchOnStartTrackingBearing = this._map.getPitch();

                // Set the starting zoom and pitch
                if (this._zoomOnStopTrackingBearing == null)
                    this._zoomStart = 18;
                else
                    this._zoomStart = this._zoomOnStopTrackingBearing;
                if (this._pitchOnStopTrackingBearing == null)
                    this._pitchStart = 60;
                else
                    this._pitchStart = this._pitchOnStopTrackingBearing;

                // Set map to last position
                if (this._lastPostionLat != null && this._lastPostionLong != null) {
                    console.log("_handleTrackBearing > Set map to last position.");
                    const lat = this._lastPostionLat;
                    const long = this._lastPostionLong;
                    let zoom = this._map.getZoom();
                    let pitch = this._map.getPitch();
                    let bearing = this._lastPositionBearing ? this._lastPositionBearing : this._map.getBearing();

                    if (this.getZoomStart() != null) {
                        zoom = this.getZoomStart();
                        this.resetZoomStart();
                    }

                    if (this.getPitchStart() != null) {
                        pitch = this.getPitchStart();
                        this.resetPitchStart();
                    }

                    mapRef.current.flyTo({
                        center: [long, lat],
                        offset: [0, 120],
                        zoom: zoom,
                        pitch: pitch,
                        bearing: bearing,
                        duration: 1000
                    }).once('moveend', () => {
                        this.showStopTrackingBearingIcon();
                        this._trackingBearing = true;
                    });
                }
                else {
                    this._trackingBearing = true;
                }
            }

            _handleStopTrackingBearing() {
                console.log('_handleStopTrackingBearing');
                this._trackingBearing = false;

                // Remember the current zoom and pitch
                this._zoomOnStopTrackingBearing = this._map.getZoom();
                this._pitchOnStopTrackingBearing = this._map.getPitch();

                // Set the starting zoom and pitch
                if (this._zoomOnStartTrackingBearing == null)
                    this._zoomStart = defaultZoom;
                else
                    this._zoomStart = this._zoomOnStartTrackingBearing;
                if (this._pitchOnStartTrackingBearing == null)
                    this._pitchStart = defaultPitch;
                else
                    this._pitchStart = this._pitchOnStartTrackingBearing;

                // Set map to last position
                if (this._lastPostionLat != null && this._lastPostionLong != null) {
                    const lat = this._lastPostionLat;
                    const long = this._lastPostionLong;
                    let zoom = this._map.getZoom();
                    let pitch = this._map.getPitch();
                    let bearing = this._lastPositionBearing ? this._lastPositionBearing : this._map.getBearing();

                    if (this.getZoomStart() != null) {
                        zoom = this.getZoomStart();
                        this.resetZoomStart();
                    }

                    if (this.getPitchStart() != null) {
                        pitch = this.getPitchStart();
                        this.resetPitchStart();
                    }

                    mapRef.current.flyTo({
                        center: [long, lat],
                        zoom: zoom,
                        pitch: pitch,
                        bearing: bearing,
                        duration: 1000
                    }).once('moveend', () => {
                        this.showTrackingBearingIcon();
                        this._trackingLocation = true;
                        this._releaseWakeLock();
                    });
                }
                else {
                    this._trackingLocation = true;
                    this._releaseWakeLock();
                }
            }

            stopTrackingLocation() {
                this._trackingLocation = false;
                this._geolocate._watchState = 'BACKGROUND';
                this.showTrackingLocationIcon();
            }

            stopTrackingLocationAndBearing() {
                this._trackingBearing = false;
                this._trackingLocation = false;
                this._geolocate._watchState = 'BACKGROUND';
                this.showTrackingLocationIcon();
            }

            isUserDragging() {
                return this._isUserDragging;
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

            getZoomStart() {
                return this._zoomStart;
            }

            getPitchStart() {
                return this._pitchStart;
            }

            resetZoomStart() {
                this._zoomStart = null;
            }

            resetPitchStart() {
                this._pitchStart = null;
            }

            onAdd() {
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
                this._container.removeEventListener('click', this._handleClick);
                this._container.parentNode.removeChild(this._container);
                this._map = undefined;
            }

            async _requestWakeLock() {
                try {
                    if ('wakeLock' in navigator) {
                        this._wakeLock = await navigator.wakeLock.request('screen');
                        this._isScreenLocked = true;
                        console.log('_requestWakeLock > Wake Lock activated.');

                        // Add listener for visibility change
                        document.addEventListener('visibilitychange', async () => {
                            if (this._isScreenLocked && document.visibilityState === 'visible') {
                                this._wakeLock = await navigator.wakeLock.request('screen');
                            }
                        });
                    } else {
                        console.log('_requestWakeLock > Wake Lock API not supported.');
                    }
                } catch (err) {
                    console.error('_requestWakeLock > Wake Lock request failed:', err);
                }
            }

            async _releaseWakeLock() {
                if (this._wakeLock && this._isScreenLocked) {
                    try {
                        await this._wakeLock.release();
                        this._wakeLock = null;
                        this._isScreenLocked = false;
                        console.log('_releaseWakeLock > Wake Lock deactivated.');
                    } catch (err) {
                        console.error('_releaseWakeLock > Wake Lock release failed:', err);
                    }
                }
            }
        }

        // Add geolocate control to the map
        geolocateRef.current = new mapboxgl.GeolocateControl({
            positionOptions: {
                enableHighAccuracy: true
            },
            trackUserLocation: true,
            showUserHeading: true
        });

        geolocateRef.current.on('geolocate', (e) => {
            const long = e.coords.longitude;
            const lat = e.coords.latitude;
            const bearing = e.coords.heading ? e.coords.heading : mapRef.current.getBearing();
            let zoom = mapRef.current.getZoom();
            let pitch = mapRef.current.getPitch();

            if (locationControlRef.current.isTrackingBearing() && locationControlRef.current.getZoomStart() != null) {
                zoom = locationControlRef.current.getZoomStart();
                pitch = locationControlRef.current.getPitchStart();
                locationControlRef.current.resetZoomStart();
                locationControlRef.current.resetPitchStart();
                mapRef.current.flyTo({
                    center: [long, lat],
                    offset: [0, 120],
                    zoom: zoom,
                    pitch: pitch,
                    bearing: bearing,
                    duration: 1000
                }).once('moveend', () => {
                    locationControlRef.current.showStopTrackingBearingIcon();
                });
            }
            else if (locationControlRef.current.isTrackingLocation() && locationControlRef.current.getZoomStart() != null) {
                zoom = locationControlRef.current.getZoomStart();
                locationControlRef.current.resetZoomStart();
                mapRef.current.flyTo({
                    center: [long, lat],
                    zoom: zoom,
                    pitch: pitch,
                    duration: 1000
                }).once('moveend', () => {
                    locationControlRef.current.showTrackingBearingIcon();
                });
            }
            else {
                // Adaptive duration based on distance moved
                let duration = 500;
                if (locationControlRef.current._lastPostionLat !== null && 
                    locationControlRef.current._lastPostionLong !== null) {
                    // Calculate Euclidean distance (rough approximation)
                    const distance = Math.sqrt(
                        Math.pow(long - locationControlRef.current._lastPostionLong, 2) + 
                        Math.pow(lat - locationControlRef.current._lastPostionLat, 2)
                    );
                    if (distance < 0.00005) {
                        // Very small movement (< ~5.5 meters) 
                        duration = 500;
                    } else if (distance < 0.0001) {
                        // Small movement (~5.5-11 meters) 
                        duration = 250;
                    } else if (distance < 0.0005) {
                        // Medium movement (~11-55 meters)
                        duration = 125;
                    } else {
                        // Large jump (> ~55 meters)
                        duration = 0;
                    }
                }
                if (locationControlRef.current.isTrackingBearing()) {
                    if (locationControlRef.current.isUserDragging())
                        return;
                    mapRef.current.easeTo({
                        center: [long, lat],
                        offset: [0, 120],
                        bearing: bearing,
                        duration: duration,
                        easing: (t) => t
                    });
                }
                else if (locationControlRef.current.isTrackingLocation()) {
                    mapRef.current.easeTo({
                        center: [long, lat],
                        duration: duration,
                        easing: (t) => t
                    });
                }
            }

            // Save last position
            locationControlRef.current._lastPostionLat = lat;
            locationControlRef.current._lastPostionLong = long;
            locationControlRef.current._lastPositionBearing = bearing;
        });

        // On drag stop tracking location
        mapRef.current.on('drag', (e) => {
            console.log("drag");
            if (locationControlRef.current && locationControlRef.current.isTrackingLocation()) {
                locationControlRef.current.stopTrackingLocation();
            }
        });

        // On dragstart set isUserDragging to prevent camera to move to the user location
        mapRef.current.on('dragstart', () => {
            console.log("dragstart");
            if (locationControlRef.current?.isTrackingBearing()) {
                locationControlRef.current._isUserDragging = true;
            }
        });

        // On dragend remove isUserDragging to enable camera to move to the user location
        mapRef.current.on('dragend', () => {
            console.log("dragend");
            if (locationControlRef.current?.isTrackingBearing()) {
                // Move map back to user's last known location
                if (locationControlRef.current._lastPostionLat != null && locationControlRef.current._lastPostionLong != null) {
                    mapRef.current.easeTo({
                        center: [locationControlRef.current._lastPostionLong, locationControlRef.current._lastPostionLat],
                        offset: [0, 120],
                        duration: 500,
                        easing: (t) => t
                    }).once('moveend', () => {
                        locationControlRef.current._isUserDragging = false;
                    });
                }
                else {
                    locationControlRef.current._isUserDragging = false;
                }
            }
        });

        // Add the geolocate control to the map without adding it to the UI
        mapRef.current.addControl(geolocateRef.current);
        geolocateRef.current._container.style.display = 'none';

        // Add search control with custom styling
        const geocoder = new MapboxGeocoder({
            accessToken: mapboxgl.accessToken,
            mapboxgl: mapboxgl,
            marker: false,
            placeholder: "Search",
            collapsed: true
        });
        mapRef.current.addControl(geocoder, 'top-left');

        // Focus on user input when search icon is clicked
        const geocoderEl = document.querySelector('.mapboxgl-ctrl-geocoder');
        if (geocoderEl) {
            geocoderEl.addEventListener('click', () => {
                const input = geocoderEl.querySelector('input');
                input?.focus();
            });
        }

        // When user clicks on search result stop tracking bearing and location, clear and collapse search input
        geocoder.on('result', () => {
            if (locationControlRef.current) {
                if (locationControlRef.current.isTrackingBearing() || locationControlRef.current.isTrackingLocation()) {
                    locationControlRef.current.stopTrackingLocationAndBearing();
                }
            }
            
            // Clear and hide geocoder and keyboard
            geocoder.clear();
            const geocoderEl = document.querySelector('.mapboxgl-ctrl-geocoder');
            if (geocoderEl) {
                const input = geocoderEl.querySelector('input');
                input?.blur();
                document.activeElement?.blur();
                geocoderEl.classList.add('mapboxgl-ctrl-geocoder--collapsed');
            }
        });

        // Initialize custom location control
        locationControlRef.current = new LocationControl(geolocateRef.current, mapRef.current);

        // Add custom location tracking controls to map
        mapRef.current.addControl(locationControlRef.current, 'top-right');

        // Add compass icon
        const nav = new mapboxgl.NavigationControl({
            showZoom: false,
            visualizePitch: true
        });
        mapRef.current.addControl(nav, 'top-right');

        // Add custom className to the compass container
        nav._container.classList.add('ctrl-compass-container')

        // Enable rotation gestures (right-click drag on desktop, two-finger rotate on mobile)
        mapRef.current.dragRotate.enable();

        // Enable pinch-to-zoom and rotate gestures on touch devices
        mapRef.current.touchZoomRotate.enable();

        // Listen for style changes
        mapRef.current.on('styledata', () => {
            addSourceAndSupportLink();
        });
    }, []);

    // When changing map style preserve the current camera state
    useEffect(() => {
        if (!mapRef.current || !mapStyle) return;
        const map = mapRef.current;
        const center = map.getCenter();
        const zoom = map.getZoom();
        const bearing = map.getBearing();
        const pitch = map.getPitch();
        map.setStyle(mapStyle);
        map.once('style.load', () => {
          map.jumpTo({
            center,
            zoom,
            bearing,
            pitch
          });
        });
    }, [mapStyle]);      

    // Show tips
    useEffect(() => {
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
                message={"Tilt the map: Use two fingers on touchscreen or right-click and drag with mouse.\n\n" + 
                         "Location tracking: Click location icon to enable, once more to follow direction. \n\n" +
                         "Full screen: Double-click to enter/exit.\n\n" +
                         "Web App:\nrontomap.web.app"}
                buttons={[
                    {
                        text: "SOURCE",
                        handler: () => {
                            window.open("https://github.com/strukovnasamobor/rontomap", "_blank");
                        }
                    },
                    {
                        text: "SUPPORT",
                        handler: () => {
                            window.open("https://www.paypal.com/ncp/payment/ZRBQZMWTCJYFE", "_blank");
                        }
                    },
                    {
                        text: "DON'T SHOW AGAIN",
                        handler: () => {
                            localStorage.setItem("rontomap_dont_show_tips", "true");
                        }
                    },                                       
                    {
                        text: "OK",
                        role: "cancel"
                    }
                ]}
              ></IonAlert>
            <div 
                ref={mapContainerRef}
                {...bind}
                className="map-container"
            />
        </PageFixedLayout>
    );
}