/**
 * @typedef {import('../types').RontoFeatureCollection} RontoFeatureCollection
 * @typedef {import('../types').ExportScope} ExportScope
 */

import { scopeData } from "./rontoJson";

/**
 * Import: convert a FIT binary file to RontoJSON.
 * Lazy-loaded — this module is only imported when a FIT file is selected.
 * @param {ArrayBuffer} content
 * @returns {RontoFeatureCollection}
 */
export async function toRonto(content) {
  const { default: FitParser } = await import("fit-file-parser");
  const parser = new FitParser({ force: true, mode: "list" });

  return new Promise((resolve, reject) => {
    parser.parse(content, (error, data) => {
      if (error) return reject(new Error("Invalid FIT file."));

      const records = data.records || [];
      const coords = [];
      for (const r of records) {
        const lat = r.position_lat;
        const lng = r.position_long;
        if (lat != null && lng != null && isFinite(lat) && isFinite(lng)) {
          coords.push({ long: lng, lat });
        }
      }

      if (coords.length < 2) {
        return reject(new Error("No valid track points found in FIT file."));
      }

      const pathData = {
        id: "p1",
        coords,
      };

      if (isCircuitCoords(coords)) {
        pathData.isCircuit = true;
        coords.pop();
      }

      // Use sport name if available
      const session = data.sessions?.[0];
      if (session?.sport) {
        pathData.name = session.sport.charAt(0).toUpperCase() + session.sport.slice(1);
      }

      // Laps as sights
      const laps = data.laps || [];
      if (laps.length > 0) {
        pathData.sights = [];
        for (const lap of laps) {
          if (lap.start_position_lat != null && lap.start_position_long != null) {
            const sight = projectPointOnPath(coords, lap.start_position_long, lap.start_position_lat);
            sight.name = lap.wkt_step_name || lap.name || `Lap ${pathData.sights.length + 1}`;
            pathData.sights.push(sight);
          }
        }
        if (pathData.sights.length === 0) delete pathData.sights;
      }

      resolve({ markers: [], paths: [pathData] });
    });
  });
}

/**
 * Export: convert RontoJSON to a FIT binary file (first path only).
 * @param {RontoFeatureCollection} data
 * @param {ExportScope} scope
 * @returns {Blob}
 */
export function fromRonto(data, scope) {
  const scoped = scopeData(data, scope);
  const path = (scoped.paths || [])[0];
  if (!path) throw new Error("No path to export as FIT.");

  let coords = getExportCoords(path);
  if (path.isCircuit && coords.length >= 2) {
    coords = [...coords, coords[0]];
  }

  // FIT epoch: 1989-12-31T00:00:00Z
  const FIT_EPOCH = Date.UTC(1989, 11, 31, 0, 0, 0) / 1000;
  const baseTimestamp = Math.floor(Date.now() / 1000) - FIT_EPOCH;
  const toSemicircles = (deg) => Math.round(deg * (2147483648 / 180));

  // Build data messages
  const messages = [];

  // File ID message (mesg_num=0) — required
  messages.push(buildDefinitionMessage(0, 0, [
    { fieldNum: 0, size: 1, baseType: 0 },   // type (enum)
    { fieldNum: 1, size: 2, baseType: 132 },  // manufacturer (uint16)
    { fieldNum: 2, size: 2, baseType: 132 },  // product (uint16)
    { fieldNum: 4, size: 4, baseType: 134 },  // time_created (uint32)
  ]));
  messages.push(buildDataMessage(0, [
    { value: 4, size: 1 },              // type=activity
    { value: 1, size: 2 },              // manufacturer=garmin
    { value: 1, size: 2 },              // product=1
    { value: baseTimestamp, size: 4 },   // time_created
  ]));

  // Record definition (mesg_num=20)
  messages.push(buildDefinitionMessage(0, 20, [
    { fieldNum: 253, size: 4, baseType: 134 }, // timestamp (uint32)
    { fieldNum: 0, size: 4, baseType: 133 },   // position_lat (sint32)
    { fieldNum: 1, size: 4, baseType: 133 },   // position_long (sint32)
  ]));

  // Record data messages — one per coordinate
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    messages.push(buildDataMessage(0, [
      { value: baseTimestamp + i, size: 4 },
      { value: toSemicircles(lat), size: 4 },
      { value: toSemicircles(lng), size: 4 },
    ]));
  }

  // Concatenate all messages
  const dataBytes = concatBuffers(messages);

  // File header (14 bytes)
  const header = new ArrayBuffer(14);
  const hv = new DataView(header);
  hv.setUint8(0, 14);          // header size
  hv.setUint8(1, 0x20);        // protocol version 2.0
  hv.setUint16(2, 0x0810, true); // profile version
  hv.setUint32(4, dataBytes.byteLength, true); // data size
  // ".FIT" signature
  hv.setUint8(8, 0x2E);  // .
  hv.setUint8(9, 0x46);  // F
  hv.setUint8(10, 0x49); // I
  hv.setUint8(11, 0x54); // T
  // Header CRC
  const headerCrc = fitCrc(new Uint8Array(header, 0, 12));
  hv.setUint16(12, headerCrc, true);

  // File CRC (over header + data)
  const allBytes = concatBuffers([header, dataBytes]);
  const fileCrc = fitCrc(new Uint8Array(allBytes));
  const crcBuf = new ArrayBuffer(2);
  new DataView(crcBuf).setUint16(0, fileCrc, true);

  return new Blob([allBytes, crcBuf], { type: "application/vnd.ant.fit" });
}

// --- FIT binary helpers ---

const FIT_CRC_TABLE = [
  0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
  0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
];

function fitCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    crc = (crc >> 4) ^ FIT_CRC_TABLE[crc & 0xF] ^ FIT_CRC_TABLE[b & 0xF];
    crc = (crc >> 4) ^ FIT_CRC_TABLE[crc & 0xF] ^ FIT_CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc & 0xFFFF;
}

function buildDefinitionMessage(localMesgType, globalMesgNum, fields) {
  // Header(1) + Reserved(1) + Arch(1) + GlobalMesgNum(2) + NumFields(1) + Fields(3 each)
  const size = 6 + fields.length * 3;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x40 | (localMesgType & 0x0F)); // definition message header
  dv.setUint8(1, 0);     // reserved
  dv.setUint8(2, 0);     // architecture: little-endian
  dv.setUint16(3, globalMesgNum, true);
  dv.setUint8(5, fields.length);
  for (let i = 0; i < fields.length; i++) {
    const off = 6 + i * 3;
    dv.setUint8(off, fields[i].fieldNum);
    dv.setUint8(off + 1, fields[i].size);
    dv.setUint8(off + 2, fields[i].baseType);
  }
  return buf;
}

function buildDataMessage(localMesgType, fields) {
  let totalSize = 1; // header byte
  for (const f of fields) totalSize += f.size;
  const buf = new ArrayBuffer(totalSize);
  const dv = new DataView(buf);
  dv.setUint8(0, localMesgType & 0x0F); // data message header
  let off = 1;
  for (const f of fields) {
    if (f.bytes) {
      new Uint8Array(buf, off, f.size).set(f.bytes);
    } else if (f.size === 1) {
      dv.setUint8(off, f.value & 0xFF);
    } else if (f.size === 2) {
      dv.setUint16(off, f.value & 0xFFFF, true);
    } else if (f.size === 4) {
      dv.setInt32(off, f.value | 0, true);
    }
    off += f.size;
  }
  return buf;
}

function encodeString(str, maxLen) {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(str || "");
  const buf = new Uint8Array(maxLen);
  buf.set(encoded.subarray(0, maxLen - 1)); // leave room for null terminator
  return buf;
}

function concatBuffers(buffers) {
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  const result = new ArrayBuffer(total);
  const view = new Uint8Array(result);
  let off = 0;
  for (const b of buffers) {
    view.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return result;
}

function getExportCoords(path) {
  if (path.snappedSegments && path.snappedSegments.length > 0) {
    const coords = [];
    for (const seg of path.snappedSegments) {
      for (const c of seg.coords) {
        coords.push([c.lng, c.lat]);
      }
    }
    return coords.length >= 2 ? coords : path.coords.map((c) => [c.long, c.lat]);
  }
  return path.coords.map((c) => [c.long, c.lat]);
}

function interpolateSightPosition(path, sight) {
  const coords = path.coords;
  const maxSeg = path.isCircuit ? coords.length - 1 : coords.length - 2;
  const i = Math.min(sight.segmentIndex, maxSeg);
  if (i < 0 || coords.length < 2) return [coords[0]?.long || 0, coords[0]?.lat || 0];
  const c1 = coords[i];
  const c2 = coords[(i + 1) % coords.length];
  const t = sight.t;
  return [c1.long + (c2.long - c1.long) * t, c1.lat + (c2.lat - c1.lat) * t];
}

function isCircuitCoords(coords) {
  if (coords.length < 3) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const THRESHOLD = 0.00001;
  return Math.abs(first.long - last.long) < THRESHOLD && Math.abs(first.lat - last.lat) < THRESHOLD;
}

/**
 * Project a point onto the nearest segment of a path.
 */
function projectPointOnPath(coords, lng, lat) {
  let bestDist = Infinity;
  let bestSeg = 0;
  let bestT = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const c1 = coords[i];
    const c2 = coords[i + 1];
    const dx = c2.long - c1.long;
    const dy = c2.lat - c1.lat;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((lng - c1.long) * dx + (lat - c1.lat) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = c1.long + t * dx;
    const py = c1.lat + t * dy;
    const dist = (lng - px) ** 2 + (lat - py) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestSeg = i;
      bestT = t;
    }
  }

  return { segmentIndex: bestSeg, t: bestT };
}
