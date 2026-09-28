/**
 * Generates the extension's PNG icons with zero dependencies.
 *
 * Writing a PNG by hand (raw pixels -> zlib deflate -> CRC'd chunks) is a
 * bit of work, but it beats committing binaries nobody can regenerate or
 * adding an image library for three small files.
 *
 * Run: node scripts/make-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "extension", "icons");

/* ---------------- PNG encoding ---------------- */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- the mark: a shield ---------------- */

/** Distance from a point to the two-segment check-mark polyline. */
function distToCheck(x, y, size) {
  const pts = [
    [size * 0.33, size * 0.50],
    [size * 0.45, size * 0.61],
    [size * 0.68, size * 0.38],
  ];
  let best = Infinity;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[s + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    const px2 = x1 + t * dx;
    const py2 = y1 + t * dy;
    best = Math.min(best, Math.hypot(x - px2, y - py2));
  }
  return best;
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;

  // Shield outline as a function of normalised coords.
  const inShield = (x, y) => {
    const nx = (x - cx) / (size * 0.34);
    const ny = (y - size * 0.5) / (size * 0.42);
    if (ny < -1 || ny > 1) return false;
    // Top: rounded rectangle. Bottom: tapers to a point.
    const halfWidth = ny < 0.15 ? 1 : 1 - Math.pow((ny - 0.15) / 0.85, 1.35);
    return Math.abs(nx) <= halfWidth;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 2x2 supersample for a smoother edge at 16px.
      let hits = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (inShield(x + dx, y + dy)) hits++;
      }
      if (hits === 0) { px[i + 3] = 0; continue; }

      const t = y / size;                       // vertical gradient
      px[i]     = Math.round(21 + t * 40);      // #1570ef -> deeper blue
      px[i + 1] = Math.round(112 - t * 40);
      px[i + 2] = Math.round(239 - t * 30);
      px[i + 3] = Math.round((hits / 4) * 255);

      // A check mark, not a minus sign: the product's whole argument is
      // that you can still send your message, not that you are blocked.
      if (distToCheck(x + 0.5, y + 0.5, size) < size * 0.075) {
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      }
    }
  }
  return px;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, size, drawIcon(size)));
  console.log("wrote", path.relative(process.cwd(), file));
}
