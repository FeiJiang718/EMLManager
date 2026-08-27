// Generates app icon: PNG (512px) + ICO wrapper wrapping the same PNG.
// Usage: node tools/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 512;

// ---------- vector helpers ----------
const len2 = (x, y) => Math.hypot(x, y);
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return len2(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
  return len2(apx - abx * t, apy - aby * t);
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const cov = (sd) => clamp01(0.5 - sd);

// ---------- geometry ----------
const MARGIN = 10, R_BG = 104;
const CARD = { cx: N / 2, cy: 258, hw: 158, hh: 88, r: 26 };
const STROKE = 11;
const FLAP = [
  [CARD.cx - CARD.hw + 14, CARD.cy - CARD.hh + 12],
  [CARD.cx, CARD.cy - 6],
  [CARD.cx + CARD.hw - 14, CARD.cy - CARD.hh + 12],
];

// gradient stops (indigo -> violet), t along x+y normalized
const C1 = [99, 102, 241], C2 = [168, 85, 247];
const gradAt = (t) => {
  const k = clamp01(t);
  return [
    C1[0] + (C2[0] - C1[0]) * k,
    C1[1] + (C2[1] - C1[1]) * k,
    C1[2] + (C2[2] - C1[2]) * k,
  ];
};

const data = Buffer.alloc(N * N * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const px = x + 0.5, py = y + 0.5;
    const g = gradAt((px + py) / (2 * N));
    // background rounded square
    let [r, gch, b, a] = [...g, 255 * cov(sdRoundRect(px, py, N / 2, N / 2, (N - 2 * MARGIN) / 2, (N - 2 * MARGIN) / 2, R_BG))];

    // subtle bottom sheen
    const sheen = 14 * Math.max(0, 1 - (py / N)) ;
    // letter card (slightly translucent white)
    const cCard = cov(sdRoundRect(px, py, CARD.cx, CARD.cy, CARD.hw, CARD.hh, CARD.r));
    if (cCard > 0) {
      const cr = 250, cg = 250, cb = 253;
      r += (cr - r) * cCard; gch += (cg - gch) * cCard; b += (cb - b) * cCard;
    }
    // flap stroke lines
    let sMin = Infinity;
    for (let i = 0; i < FLAP.length - 1; i++) {
      sMin = Math.min(sMin, segDist(px, py, FLAP[i][0], FLAP[i][1], FLAP[i + 1][0], FLAP[i + 1][1]));
    }
    const cs = cov(sMin - STROKE / 2);
    if (cs > 0) {
      const sr = 109, sg = 40, sb = 217; // purple-700
      r += (sr - r) * cs; gch += (sg - gch) * cs; b += (sb - b) * cs;
    }
    r = Math.min(255, r + sheen);

    const o = (y * N + x) * 4;
    data[o] = r | 0; data[o + 1] = gch | 0; data[o + 2] = b | 0; data[o + 3] = a | 0;
  }
}

// ---------- PNG encode ----------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  data.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

// ---------- ICO wrap ----------
const ico = Buffer.concat([
  Buffer.from([0, 0, 1, 0, 1, 0]),
  Buffer.from([0, 0, 0, 0, 1, 0, 32, 0]), // w,h bytes (0=>256+), palette, reserved, planes, bpp
  (() => { const b = Buffer.alloc(8); b.writeUInt32LE(png.length, 0); b.writeUInt32LE(22, 4); return b; })(),
  png,
]);

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "icon.png"), png);
writeFileSync(join(outDir, "icon.ico"), ico);
console.log("icons written:", outDir);
