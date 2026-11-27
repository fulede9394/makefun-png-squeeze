// png-squeeze entry: lossless PNG re-encoder for 1280x720 RGBA screenshots.
//
// Strategy: decode the stored input PNG, pick the cheapest lossless
// representation per image (palette when <=256 distinct colours, grey /
// grey+alpha / RGB / RGBA otherwise), choose filters per row by a
// sum-of-absolute-residual cost, and compress with Node's zlib at level 9,
// keeping the smallest of several filter-stream / deflate-setting combos.
// Everything is deterministic: no clock, no environment reads, no network.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync, constants as zlibConstants } from "node:zlib";

const PIC_WIDTH = 1280;
const PIC_HEIGHT = 720;
const INSTANCE_IDS = ["i001", "i002", "i003", "i004", "i005", "i006", "i007", "i008"];

// ---------------------------------------------------------------------------
// CRC-32 (PNG polynomial), table built once at startup.
// ---------------------------------------------------------------------------

const CRC_TABLE = buildCrcTable();

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32Of(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG chunk assembly.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function makeChunk(tag, payload) {
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  out.write(tag, 4, "ascii");
  Buffer.from(payload).copy(out, 8);
  out.writeUInt32BE(crc32Of(out.subarray(4, 8 + payload.length)), 8 + payload.length);
  return out;
}

function makeIhdr(colourType) {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(PIC_WIDTH, 0);
  body.writeUInt32BE(PIC_HEIGHT, 4);
  body[8] = 8; // bit depth
  body[9] = colourType;
  body[10] = 0; // compression
  body[11] = 0; // filter method
  body[12] = 0; // non-interlaced
  return makeChunk("IHDR", body);
}

// ---------------------------------------------------------------------------
// PNG decoding (input is a stored colour-type-6 PNG; other 8-bit types
// are handled too so the decoder stays honest).
// ---------------------------------------------------------------------------

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function unfilterRows(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(stride * height);
  const zero = new Uint8Array(stride);
  let prev = zero;
  for (let y = 0; y < height; y++) {
    const kind = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const dst = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? dst[x - bytesPerPixel] : 0;
      const b = prev[x];
      const c = x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      let v = src[x];
      if (kind === 1) v = (v + a) & 0xff;
      else if (kind === 2) v = (v + b) & 0xff;
      else if (kind === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (kind === 4) v = (v + paethPredictor(a, b, c)) & 0xff;
      dst[x] = v;
    }
    prev = dst;
  }
  return out;
}

function decodePng(fileBytes) {
  if (fileBytes.length < 8 || !fileBytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let bitDepth = 8;
  const idatParts = [];
  let palette = null;
  let transparency = null;
  while (offset + 12 <= fileBytes.length) {
    const length = fileBytes.readUInt32BE(offset);
    const tag = fileBytes.toString("ascii", offset + 4, offset + 8);
    const data = fileBytes.subarray(offset + 8, offset + 8 + length);
    if (tag === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (tag === "PLTE") {
      palette = data;
    } else if (tag === "tRNS") {
      transparency = data;
    } else if (tag === "IDAT") {
      idatParts.push(data);
    } else if (tag === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error("only 8-bit PNG input supported");
  const bppByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bytesPerPixel = bppByType[colourType];
  if (!bytesPerPixel) throw new Error("unsupported input colour type " + colourType);
  const inflated = inflateSync(Buffer.concat(idatParts));
  const raw = unfilterRows(inflated, width, height, bytesPerPixel);
  const rgba = new Uint8Array(width * height * 4);
  const pixels = width * height;
  if (colourType === 6) {
    rgba.set(raw);
  } else if (colourType === 2) {
    for (let i = 0; i < pixels; i++) {
      rgba[i * 4] = raw[i * 3];
      rgba[i * 4 + 1] = raw[i * 3 + 1];
      rgba[i * 4 + 2] = raw[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (colourType === 0) {
    for (let i = 0; i < pixels; i++) {
      const g = raw[i];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = 255;
    }
  } else if (colourType === 4) {
    for (let i = 0; i < pixels; i++) {
      const g = raw[i * 2];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = raw[i * 2 + 1];
    }
  } else if (colourType === 3) {
    if (!palette) throw new Error("palette PNG without PLTE");
    for (let i = 0; i < pixels; i++) {
      const idx = raw[i];
      rgba[i * 4] = palette[idx * 3];
      rgba[i * 4 + 1] = palette[idx * 3 + 1];
      rgba[i * 4 + 2] = palette[idx * 3 + 2];
      rgba[i * 4 + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Representation choice: scan the pixels once and pick the cheapest
// lossless colour type.
// ---------------------------------------------------------------------------

function analysePixels(rgba) {
  const pixels = rgba.length / 4;
  const seen = new Map();
  const paletteOrder = [];
  let allOpaque = true;
  let allGrey = true;
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) allGrey = false;
    if (seen.size <= 256) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      if (!seen.has(key)) {
        seen.set(key, paletteOrder.length);
        paletteOrder.push(key);
      }
    }
  }
  return { distinct: seen.size, paletteOrder, allOpaque, allGrey, indexOf: seen };
}

// Pack the RGBA pixels into the chosen representation's unfiltered planes:
// one byte per pixel for palette/grey, two for grey+alpha, three for RGB,
// four for RGBA. Returns the planes plus palette/trns when applicable.
function packPlanes(rgba, choice) {
  const pixels = rgba.length / 4;
  if (choice.kind === "palette") {
    const planes = new Uint8Array(pixels);
    const palette = new Uint8Array(choice.paletteOrder.length * 3);
    const trns = new Uint8Array(choice.paletteOrder.length);
    let needsTrns = false;
    for (let i = 0; i < choice.paletteOrder.length; i++) {
      const key = choice.paletteOrder[i];
      palette[i * 3] = (key >> 24) & 0xff;
      palette[i * 3 + 1] = (key >> 16) & 0xff;
      palette[i * 3 + 2] = (key >> 8) & 0xff;
      trns[i] = key & 0xff;
      if ((key & 0xff) !== 255) needsTrns = true;
    }
    // Trim trailing fully-opaque entries from tRNS.
    let trnsLength = needsTrns ? trns.length : 0;
    while (trnsLength > 0 && trns[trnsLength - 1] === 255) trnsLength--;
    for (let i = 0; i < pixels; i++) {
      const key =
        (rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3];
      planes[i] = choice.indexOf.get(key);
    }
    return {
      colourType: 3,
      bytesPerPixel: 1,
      planes,
      palette,
      trns: trnsLength > 0 ? trns.subarray(0, trnsLength) : null,
    };
  }
  if (choice.kind === "grey") {
    const planes = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) planes[i] = rgba[i * 4];
    return { colourType: 0, bytesPerPixel: 1, planes, palette: null, trns: null };
  }
  if (choice.kind === "greyAlpha") {
    const planes = new Uint8Array(pixels * 2);
    for (let i = 0; i < pixels; i++) {
      planes[i * 2] = rgba[i * 4];
      planes[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return { colourType: 4, bytesPerPixel: 2, planes, palette: null, trns: null };
  }
  if (choice.kind === "rgb") {
    const planes = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      planes[i * 3] = rgba[i * 4];
      planes[i * 3 + 1] = rgba[i * 4 + 1];
      planes[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colourType: 2, bytesPerPixel: 3, planes, palette: null, trns: null };
  }
  return { colourType: 6, bytesPerPixel: 4, planes: rgba, palette: null, trns: null };
}

function pickRepresentation(rgba) {
  const info = analysePixels(rgba);
  // Grey first: a palette shuffles grey values into arbitrary index order,
  // which destroys the smoothness filters exploit. Raw grey bytes filter
  // far better even when the image has few distinct greys.
  if (info.allGrey && info.allOpaque) return { kind: "grey" };
  if (info.allGrey) return { kind: "greyAlpha" };
  if (info.distinct <= 256) {
    return { kind: "palette", paletteOrder: info.paletteOrder, indexOf: info.indexOf };
  }
  if (info.allOpaque) return { kind: "rgb" };
  return { kind: "rgba" };
}

// ---------------------------------------------------------------------------
// Row filtering. Cost of a filtered row is the sum of |signed byte| values,
// which tracks deflate size well for these screenshots.
// ---------------------------------------------------------------------------

function filterOneRow(dst, srcRow, prevRow, bytesPerPixel, kind) {
  const n = srcRow.length;
  dst[0] = kind;
  const out = dst.subarray(1);
  for (let x = 0; x < n; x++) {
    const a = x >= bytesPerPixel ? srcRow[x - bytesPerPixel] : 0;
    const b = prevRow[x];
    const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
    let pred = 0;
    if (kind === 1) pred = a;
    else if (kind === 2) pred = b;
    else if (kind === 3) pred = (a + b) >> 1;
    else if (kind === 4) pred = paethPredictor(a, b, c);
    out[x] = (srcRow[x] - pred) & 0xff;
  }
}

function rowCost(filteredRow) {
  let cost = 0;
  for (let i = 1; i < filteredRow.length; i++) {
    const v = filteredRow[i];
    cost += v < 128 ? v : 256 - v;
  }
  return cost;
}

// Build a fully filtered image buffer under one strategy:
// "adaptive" picks the cheapest filter per row, "paeth"/"sub" fix one filter.
function buildFiltered(planes, bytesPerPixel, strategy) {
  const stride = PIC_WIDTH * bytesPerPixel;
  const out = new Uint8Array(PIC_HEIGHT * (stride + 1));
  const scratch = new Uint8Array(stride + 1);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < PIC_HEIGHT; y++) {
    const srcRow = planes.subarray(y * stride, (y + 1) * stride);
    const prevRow = y === 0 ? zero : planes.subarray((y - 1) * stride, y * stride);
    const dstRow = out.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    if (strategy === "adaptive") {
      let bestKind = 0;
      let bestCost = Infinity;
      for (let kind = 0; kind <= 4; kind++) {
        filterOneRow(scratch, srcRow, prevRow, bytesPerPixel, kind);
        const cost = rowCost(scratch);
        if (cost < bestCost) {
          bestCost = cost;
          bestKind = kind;
          dstRow.set(scratch);
        }
      }
    } else {
      const kind = strategy === "paeth" ? 4 : 1;
      filterOneRow(dstRow, srcRow, prevRow, bytesPerPixel, kind);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding: try filter strategies, deflate each, then try extra zlib
// settings on the winner. Return the complete PNG file bytes.
// ---------------------------------------------------------------------------

const BASE_DEFLATE = { level: 9, memLevel: 9 };
const EXTRA_DEFLATES = [
  { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED },
  { level: 9, memLevel: 8 },
];

function assemblePng(packed, zlibStream) {
  const parts = [PNG_SIGNATURE, makeIhdr(packed.colourType)];
  if (packed.palette) parts.push(makeChunk("PLTE", packed.palette));
  if (packed.trns) parts.push(makeChunk("tRNS", packed.trns));
  parts.push(makeChunk("IDAT", zlibStream));
  parts.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encodeImage(rgba) {
  const packed = packPlanes(rgba, pickRepresentation(rgba));
  const strategies = ["adaptive", "paeth", "sub"];
  let bestFiltered = null;
  let bestZlib = null;
  let bestTotal = Infinity;
  for (const strategy of strategies) {
    const filtered = buildFiltered(packed.planes, packed.bytesPerPixel, strategy);
    const zlibStream = deflateSync(filtered, BASE_DEFLATE);
    const total = zlibStream.length;
    if (total < bestTotal) {
      bestTotal = total;
      bestFiltered = filtered;
      bestZlib = zlibStream;
    }
  }
  for (const opts of EXTRA_DEFLATES) {
    const zlibStream = deflateSync(bestFiltered, opts);
    if (zlibStream.length < bestTotal) {
      bestTotal = zlibStream.length;
      bestZlib = zlibStream;
    }
  }
  return assemblePng(packed, bestZlib);
}

// ---------------------------------------------------------------------------
// Driver: one run answers all eight instances.
// ---------------------------------------------------------------------------

function answerInstance(id) {
  const inputPath = "/input/" + id + "/image.png";
  const outputPath = "/output/" + id + "/image.png";
  const fileBytes = readFileSync(inputPath);
  const decoded = decodePng(fileBytes);
  if (decoded.width !== PIC_WIDTH || decoded.height !== PIC_HEIGHT) {
    throw new Error(id + ": unexpected size " + decoded.width + "x" + decoded.height);
  }
  const png = encodeImage(decoded.rgba);
  mkdirSync("/output/" + id, { recursive: true });
  writeFileSync(outputPath, png);
}

for (const id of INSTANCE_IDS) {
  answerInstance(id);
}
