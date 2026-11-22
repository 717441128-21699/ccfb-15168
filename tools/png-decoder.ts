// 测试用 PNG 解码（仅需支持本项目生成的 8-bit RGBA）。
// 走 node:zlib 解压，实现全部 5 种行 filter。
import { inflateSync } from 'node:zlib';
import { ImageBuffer } from '../src/core/image-buffer';

export function decodePng(bytes: Uint8Array): ImageBuffer {
  let pos = 8; // 跳过签名
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = readU32(bytes, pos);
    pos += 4;
    const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const data = bytes.subarray(pos + 4, pos + 4 + len);
    pos += 4 + len + 4; // type + data + crc
    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error(`仅支持 8-bit RGBA PNG，收到 bitDepth=${data[8]} colorType=${data[9]}`);
      }
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  const total = idat.reduce((s, d) => s + d.length, 0);
  const concat = new Uint8Array(total);
  let off = 0;
  for (const d of idat) {
    concat.set(d, off);
    off += d.length;
  }
  const raw = inflateSync(concat);
  const bpp = 4;
  const stride = width * bpp;
  const out = new Uint8ClampedArray(stride * height);
  let rp = 0;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    cur.set(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          cur[x] = (cur[x] + a) & 255;
          break;
        case 2:
          cur[x] = (cur[x] + b) & 255;
          break;
        case 3:
          cur[x] = (cur[x] + ((a + b) >> 1)) & 255;
          break;
        case 4:
          cur[x] = (cur[x] + paeth(a, b, c)) & 255;
          break;
        default:
          throw new Error(`未知 PNG filter: ${filter}`);
      }
    }
    out.set(cur, y * stride);
    prev.set(cur);
  }
  return new ImageBuffer(width, height, out);
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
