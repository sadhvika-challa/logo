/*
 * build-icons.js
 * Generates the Logo Lift extension icons (icon16/48/128.png) with no external
 * dependencies. It draws a rounded indigo square with a white upward "lift"
 * arrow and encodes the result as a PNG using Node's built-in zlib.
 *
 * Run: node build-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- Tiny PNG encoder (RGBA, 8-bit) ----------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend a 0 filter byte to each scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Drawing ---------------------------------------------------------------

const BG = [79, 70, 229, 255]; // #4F46E5 indigo
const FG = [255, 255, 255, 255]; // white mark

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4); // all transparent by default
  const radius = size * 0.22; // rounded-corner radius

  const set = (x, y, color, alpha = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = alpha;
  };

  // Rounded-square background.
  const insideRounded = (x, y) => {
    const r = radius;
    const left = x < r;
    const right = x > size - 1 - r;
    const top = y < r;
    const bottom = y > size - 1 - r;
    let cx = x;
    let cy = y;
    if (left) cx = r;
    else if (right) cx = size - 1 - r;
    if (top) cy = r;
    else if (bottom) cy = size - 1 - r;
    if (cx === x && cy === y) return 1; // straight edge / center
    const dist = Math.hypot(x - cx, y - cy);
    if (dist <= r - 0.5) return 1;
    if (dist >= r + 0.5) return 0;
    return r + 0.5 - dist; // soft antialiased edge
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = insideRounded(x, y);
      if (cov > 0) set(x, y, BG, Math.round(255 * cov));
    }
  }

  // White upward arrow ("lift"): a triangular head over a vertical stem.
  const cxv = (size - 1) / 2;
  const headTop = size * 0.24;
  const headBottom = size * 0.56;
  const headHalf = size * 0.26; // half-width at the base of the head
  const stemHalf = Math.max(1, size * 0.09);
  const stemBottom = size * 0.78;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inMark = false;
      // Arrow head (triangle).
      if (y >= headTop && y <= headBottom) {
        const t = (y - headTop) / (headBottom - headTop);
        const half = headHalf * t;
        if (Math.abs(x - cxv) <= half) inMark = true;
      }
      // Stem (rectangle).
      if (y >= headBottom && y <= stemBottom && Math.abs(x - cxv) <= stemHalf) {
        inMark = true;
      }
      if (inMark) set(x, y, FG, 255);
    }
  }

  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = makeIcon(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`Wrote icons/icon${size}.png (${png.length} bytes)`);
}
