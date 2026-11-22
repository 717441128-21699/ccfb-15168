import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHomography, applyMat, orderQuad, gaussianSolve } from '../src/core/geometry';
import type { Quad } from '../src/core/types';

test('单应性：正方形到正方形应近似恒等', () => {
  const q: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const h = findHomography(q, q);
  const p = applyMat(h, { x: 50, y: 50 });
  assert.ok(Math.abs(p.x - 50) < 1e-6);
  assert.ok(Math.abs(p.y - 50) < 1e-6);
});

test('单应性：四点映射后角点精确对应', () => {
  const src: Quad = [
    { x: 10, y: 20 },
    { x: 300, y: 5 },
    { x: 320, y: 240 },
    { x: 15, y: 260 },
  ];
  const dst: Quad = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 400 },
    { x: 0, y: 400 },
  ];
  const h = findHomography(src, dst);
  for (let i = 0; i < 4; i++) {
    const p = applyMat(h, src[i]);
    assert.ok(Math.abs(p.x - dst[i].x) < 1e-4, `角点 ${i} x`);
    assert.ok(Math.abs(p.y - dst[i].y) < 1e-4, `角点 ${i} y`);
  }
});

test('orderQuad 把乱序四点规整为 TL TR BR BL', () => {
  const messy: Quad = [
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const q = orderQuad(messy);
  assert.deepEqual(q[2], { x: 100, y: 100 });
  assert.deepEqual(q[0], { x: 0, y: 0 });
});

test('gaussianSolve 解线性方程组', () => {
  const x = gaussianSolve(
    [
      [2, 1],
      [1, -1],
    ],
    [3, 0],
  );
  assert.ok(Math.abs(x[0] - 1) < 1e-9);
  assert.ok(Math.abs(x[1] - 1) < 1e-9);
});
