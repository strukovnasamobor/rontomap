/**
 * @typedef {Object} RontoFeatureCollection
 * @property {RontoMarker[]} markers
 * @property {RontoPath[]} paths
 * @property {RontoCamera} [camera]
 */

/**
 * @typedef {Object} RontoCamera
 * @property {[number, number]} center - [lng, lat]
 * @property {number} zoom
 * @property {number} [bearing]
 * @property {number} [pitch]
 */

/**
 * @typedef {Object} RontoMarker
 * @property {string} id
 * @property {string} name
 * @property {[number, number]} pos - [lat, lng]
 * @property {string} [description]
 * @property {string} [collectionId] - persistence only; never emitted by collectFeatures
 */

/**
 * @typedef {Object} RontoPath
 * @property {string} id
 * @property {RontoCoord[]} coords
 * @property {string} [name]
 * @property {boolean} [isCircuit]
 * @property {boolean} [closingForced]
 * @property {boolean} [isRoute]
 * @property {boolean} [isTrack]
 * @property {"car"|"bike"|"foot"} [roadSnap]
 * @property {RontoSnappedSegment[]} [snappedSegments]
 * @property {RontoSight[]} [sights]
 * @property {string} [description]
 * @property {string} [collectionId] - persistence only; never emitted by collectFeatures
 */

/**
 * @typedef {Object} RontoCoord
 * @property {number} long - longitude
 * @property {number} lat - latitude
 * @property {boolean} [force]
 */

/**
 * @typedef {Object} RontoSnappedSegment
 * @property {"snapped"|"offset"|"direct"|"fallback"} type
 * @property {{lng: number, lat: number}[]} coords
 */

/**
 * @typedef {Object} RontoSight
 * @property {number} segmentIndex
 * @property {number} t
 * @property {string} [name]
 * @property {string} [description]
 */

/**
 * A feature collection (folder) as shown in the features list. One nesting
 * level: collections never contain collections. Membership lives on the
 * feature (collectionId), not here, so a deleted feature cannot dangle.
 *
 * @typedef {Object} RontoCollection
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [hidden]
 * @property {string} [description]
 * @property {number} [createdAt]
 */

/**
 * The saved-features localStorage blob (key: rontomap_saved_features).
 *
 * Deliberately NOT the same shape as RontoFeatureCollection: collections are
 * not part of the import/export interchange. GPX, GeoJSON and FIT have no
 * folder concept, scopeData rebuilds fresh object literals that would drop the
 * field, and exportFeatures rejects a document with no markers and no paths.
 *
 * @typedef {Object} RontoSavedBlob
 * @property {RontoMarker[]} markers
 * @property {RontoPath[]} paths
 * @property {RontoCollection[]} [collections]
 */

/**
 * @typedef {"rontoJson"|"geoJson"|"gpx"|"kml"|"fit"} FormatId
 */

/**
 * @typedef {Object} ExportScope
 * @property {"all"|"marker"|"path"} type
 * @property {RontoMarker} [marker] - when type is "marker"
 * @property {RontoPath} [path] - when type is "path"
 */
