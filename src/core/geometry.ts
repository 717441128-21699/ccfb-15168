// 纯数学几何：点、四边形、单应性矩阵（homography）、棋盘网格映射
export type { Point, Quad } from './types';
import type { Point, Quad } from './types';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** 3x3 矩阵，行优先，齐次坐标 */
export type Mat3 = number[];

export function matIdentity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] +
        a[r * 3 + 1] * b[3 + c] +
        a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** 用矩阵变换一个点（齐次归一化） */
export function applyMat(m: Mat3, p: Point): Point {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

/**
 * 计算单应性矩阵：把 src 四点映射到 dst 四点。
 * 固定 h22=1，DLT 得到 8 方程 8 未知数线性系统，高斯消元求解。
 * 点顺序：左上、右上、右下、左下。
 */
export function findHomography(src: Quad, dst: Quad): Mat3 {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    // X = (h11 x + h12 y + h13) / (h31 x + h32 y + 1)
    a.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    a.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = gaussianSolve(a, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 高斯消元解 Ax = b（通用线性方程，带部分主元） */
export function gaussianSolve(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row, i) => [...row, bIn[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const pv = a[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col] / pv;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = a[i][n] / (a[i][i] || 1e-12);
  return x;
}

/** 把四边形规整成 左上、右上、右下、左下 的顺序（图像坐标系，y 向下） */
export function orderQuad(points: [Point, Point, Point, Point]): Quad {
  const pts = [...points];
  // x+y 最小=左上，最大=右下
  const tl = pts.reduce((a, b) => (a.x + a.y <= b.x + b.y ? a : b));
  const br = pts.reduce((a, b) => (a.x + a.y >= b.x + b.y ? a : b));
  const rest = pts.filter((p) => p !== tl && p !== br);
  // 剩余两点：x-y 最大=右上，最小=左下
  const tr = rest[0].x - rest[0].y > rest[1].x - rest[1].y ? rest[0] : rest[1];
  const bl = tr === rest[0] ? rest[1] : rest[0];
  return [tl, tr, br, bl];
}

/**
 * 四边形双线性插值：u,v ∈ [0,1]，返回四边形内对应点。
 * 用于把校正后网格坐标映射回原图。
 */
export function quadBilinear(q: Quad, u: number, v: number): Point {
  const top = lerpPoint(q[0], q[1], u);
  const bottom = lerpPoint(q[3], q[2], u);
  return lerpPoint(top, bottom, v);
}

/** 四边形面积（鞋带公式） */
export function quadArea(q: Quad): number {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    s += p.x * n.y - n.x * p.y;
  }
  return Math.abs(s) / 2;
}

/** 标准正方形目标四角（边长 side） */
export function unitSquareQuad(side: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
}

/** 校正图上第 (i,j) 个交叉点的像素坐标（i,j 从 0 到 size-1） */
export function gridIntersection(
  i: number,
  j: number,
  size: number,
  warpedSize: number,
  margin: number,
): Point {
  const span = warpedSize - margin * 2;
  const t = size === 1 ? 0.5 : i / (size - 1);
  const u = j / (size - 1);
  return { x: margin + t * span, y: margin + u * span };
}

/** 多边形是否包含某点（射线法） */
export function polygonContains(q: Quad, p: Point): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[i].x;
    const yi = q[i].y;
    const xj = q[j].x;
    const yj = q[j].y;
    const hit =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** 两条线段交点（无交点返回 null） */
export function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-12) return null;
  const a = p1.x * p2.y - p1.y * p2.x;
  const b = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
    y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
  };
}
