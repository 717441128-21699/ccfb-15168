import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { ImageBuffer } from '../src/core/image-buffer';
import { encodePng } from '../src/synth/png';
import { decodePng } from '../tools/png-decoder';

test('PNG 编码后解码，像素完全一致', () => {
  const w = 24;
  const h = 18;
  const img = new ImageBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      img.setPixel(x, y, (x * 7) & 255, (y * 11) & 255, (x + y) * 13 & 255, 255);
    }
  }
  const png = encodePng(img, (d) => new Uint8Array(deflateSync(Buffer.from(d))));
  const decoded = decodePng(png);
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  let mismatches = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (Math.abs(decoded.data[i] - img.data[i]) > 0) mismatches++;
  }
  assert.equal(mismatches, 0);
  void inflateSync;
});
