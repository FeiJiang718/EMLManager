// 修复样例 EML 中的内嵌 PNG（生成真实的 16x16 纯色 PNG base64）
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const N = 16;
const px = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  px[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    const o = y * (N * 4 + 1) + 1 + x * 4;
    px[o] = 124; px[o + 1] = 108; px[o + 2] = 255; px[o + 3] = 255;
  }
}
const crcT = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcT[n] = c;
}
const crc = (b) => { let c = ~0; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
const ch = (t, p) => {
  const h = Buffer.alloc(4); h.writeUInt32BE(p.length);
  const body = Buffer.concat([Buffer.from(t, "ascii"), p]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([h, body, c]);
};
const ih = Buffer.alloc(13);
ih.writeUInt32BE(N, 0); ih.writeUInt32BE(N, 4); ih[8] = 8; ih[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ch("IHDR", ih), ch("IDAT", deflateSync(px)), ch("IEND", Buffer.alloc(0)),
]);
const b64raw = png.toString("base64");
// 按 76 字符折行（base64 正文折行合法）
const b64 = b64raw.replace(/(.{76})/g, "$1\n");

const file = "d:/Desktop/EMLManager/samples/样例邮件-01.eml";
let s = readFileSync(file, "utf8");
// 替换 inline PNG part 的正文（headers 之后到下一个 boundary 之间）
const re = /(Content-Disposition: inline; filename="logo\.png"\r?\n\r?\n)[\s\S]*?(\r?\n\r?\n--BOUNDARY-MAIN\r?\nContent-Type: application\/pdf)/;
if (!re.test(s)) { console.error("pattern not found"); process.exit(1); }
s = s.replace(re, (m, head, tail) => head + b64 + tail);
writeFileSync(file, s);
console.log("fixed. png bytes:", png.length, "b64 chars:", b64raw.length);
