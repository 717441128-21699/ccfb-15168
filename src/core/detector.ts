// 棋盘检测：灰度 -> Sobel 边缘 -> 霍夫直线 -> 两组方向各取最外侧两条边界 -> 交点得四角。
// 对局部遮挡鲁棒：只要边界线段还在，霍夫投票仍能恢复直线。
import { ImageBuffer } from './image-buffer';
import {
  lineIntersection,
  orderQuad,
  quadArea,
  type Mat3,
  type Point,
  type Quad,
} from './geometry';

export interface BoardDetection {
  quad: Quad;
  /** 0..1，四角检测可信度 */
  confidence: number;
  /** 调试信息（测试与界面展示用） */
  debug: {
    lines: Array<{ theta: number; rho: number; votes: number }>;
    edgeDensity: number;
    fallback: boolean;
  };
}

interface HoughLine {
  theta: number; // 弧度，0..PI
  rho: number; // 像素（检测图坐标系）
  votes: number;
}

/** 缩小到便于检测的尺寸 */
function downscale(img: ImageBuffer, maxDim: number): { buf: ImageBuffer; scale: number } {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const out = new ImageBuffer(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const [r, g, b, a] = img.sampleBilinear(sx, sy);
      out.setPixel(x, y, r, g, b, a);
    }
  }
  return { buf: out, scale };
}

function blur3(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += gray[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/** Sobel 梯度幅值 + 二值边缘图 */
function sobelEdges(gray: Float32Array, w: number, h: number): { mag: Float32Array; edges: Uint8Array; threshold: number } {
  const mag = new Float32Array(w * h);
  const vals: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] + gray[i - w + 1] - 2 * gray[i - 1] + 2 * gray[i + 1] - gray[i + w - 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > 30) vals.push(m);
    }
  }
  vals.sort((a, b) => a - b);
  // 取较强边缘的 75 分位作为阈值，兼顾不同灯光
  const pct = vals.length ? vals[Math.floor(vals.length * 0.75)] : 80;
  const threshold = Math.max(36, Math.min(140, pct));
  const edges = new Uint8Array(w * h);
  let edgeCount = 0;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= threshold) {
      edges[i] = 1;
      edgeCount++;
    }
  }
  return { mag, edges, threshold };
}

/** 标准霍夫变换，theta 步长 2° */
function houghLines(edges: Uint8Array, w: number, h: number): HoughLine[] {
  const thetaBins = 90; // 0..178°
  const thetaStep = Math.PI / thetaBins;
  const maxRho = Math.hypot(w, h);
  const rhoBins = Math.ceil(2 * maxRho) + 1;
  const acc = new Uint16Array(thetaBins * rhoBins);
  const rhoOffset = maxRho;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue;
      for (let t = 0; t < thetaBins; t++) {
        const theta = t * thetaStep;
        const rho = x * Math.cos(theta) + y * Math.sin(theta) + rhoOffset;
        const r = Math.round(rho);
        if (r < 0 || r >= rhoBins) continue;
        acc[t * rhoBins + r]++;
      }
    }
  }
  // 非极大值抑制找峰
  const peaks: HoughLine[] = [];
  let globalMax = 0;
  for (let t = 0; t < thetaBins; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      const v = acc[t * rhoBins + r];
      if (v < 12) continue;
      if (v > globalMax) globalMax = v;
      const isPeak =
        v >= acc[t * rhoBins + r - 1] &&
        v >= acc[t * rhoBins + r + 1] &&
        v >= acc[((t + thetaBins - 1) % thetaBins) * rhoBins + r] &&
        v >= acc[((t + 1) % thetaBins) * rhoBins + r];
      if (isPeak) {
        peaks.push({ theta: t * thetaStep, rho: r - rhoOffset, votes: v });
      }
    }
  }
  const cutoff = Math.max(20, globalMax * 0.32);
  return peaks.filter((p) => p.votes >= cutoff).sort((a, b) => b.votes - a.votes);
}

function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** 把霍夫线聚成两个互相垂直的方向组 */
function clusterOrientations(lines: HoughLine[]): [HoughLine[], HoughLine[]] {
  if (lines.length === 0) return [[], []];
  // 方向直方图：theta 折叠到 [0, PI/2)
  const bins = new Array<number>(45).fill(0);
  for (const ln of lines) {
    const folded = ln.theta % (Math.PI / 2);
    bins[Math.min(44, Math.floor(folded / (Math.PI / 2 / 45)))] += ln.votes;
  }
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  const orient = (best + 0.5) * (Math.PI / 2 / 45);
  const groupA: HoughLine[] = [];
  const groupB: HoughLine[] = [];
  for (const ln of lines) {
    const dA = angleDiff(ln.theta, orient);
    const dB = angleDiff(ln.theta, orient + Math.PI / 2);
    if (dA < 0.18) groupA.push(ln);
    else if (dB < 0.18) groupB.push(ln);
  }
  return [groupA, groupB];
}

/** 同方向内合并相近 rho 的线，按投票加权；返回去重后的线 */
function mergeRho(lines: HoughLine[], rhoTol: number): HoughLine[] {
  const sorted = [...lines].sort((a, b) => a.rho - b.rho);
  const merged: HoughLine[] = [];
  for (const ln of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(ln.rho - last.rho) < rhoTol) {
      const w1 = last.votes;
      const w2 = ln.votes;
      last.rho = (last.rho * w1 + ln.rho * w2) / (w1 + w2);
      last.theta = (last.theta * w1 + ln.theta * w2) / (w1 + w2);
      last.votes = w1 + w2;
    } else {
      merged.push({ ...ln });
    }
  }
  return merged;
}

/** 极坐标线 -> 两点式（取与图像边界的交点） */
function lineToPoints(ln: HoughLine, h: number): [Point, Point] {
  const { theta, rho } = ln;
  const a = Math.cos(theta);
  const b = Math.sin(theta);
  const x0 = a * rho;
  const y0 = b * rho;
  return [
    { x: x0 + b * -h, y: y0 - a * -h },
    { x: x0 + b * h, y: y0 - a * h },
  ];
}

function quadAnglesOk(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const prev = q[(i + 3) % 4];
    const next = q[(i + 1) % 4];
    const v1 = { x: prev.x - p.x, y: prev.y - p.y };
    const v2 = { x: next.x - p.x, y: next.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1e-9);
    const ang = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (ang < 35 || ang > 145) return false;
  }
  return true;
}

/** 兜底：边缘点包围盒收缩成四边形（极端遮挡时使用，低可信度） */
function fallbackQuad(width: number, height: number, edges: Uint8Array): Quad {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!edges[y * width + x]) continue;
      found = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!found) {
    const mx = width * 0.08;
    const my = height * 0.08;
    return [
      { x: mx, y: my },
      { x: width - mx, y: my },
      { x: width - mx, y: height - my },
      { x: mx, y: height - my },
    ];
  }
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

export function detectBoard(img: ImageBuffer): BoardDetection {
  const { buf: small, scale } = downscale(img, 360);
  const w = small.width;
  const h = small.height;
  const gray = blur3(small.toGrayscale(), w, h);
  const { edges } = sobelEdges(gray, w, h);
  let edgeCount = 0;
  for (const e of edges) edgeCount += e;
  const rawLines = houghLines(edges, w, h);
  const [gA, gB] = clusterOrientations(rawLines);
  const rhoTol = Math.max(8, Math.round(Math.min(w, h) * 0.03));
  const mA = mergeRho(gA, rhoTol);
  const mB = mergeRho(gB, rhoTol);

  let quad: Quad | null = null;
  let confidence = 0;
  let usedLines: HoughLine[] = [];

  if (mA.length >= 2 && mB.length >= 2) {
    // 每组取最外侧两条 = 棋盘外边框
    const aSorted = [...mA].sort((a, b) => a.rho - b.rho);
    const bSorted = [...mB].sort((a, b) => a.rho - b.rho);
    const outerA = [aSorted[0], aSorted[aSorted.length - 1]];
    const outerB = [bSorted[0], bSorted[bSorted.length - 1]];
    const pts: Point[] = [];
    for (const la of outerA) {
      const [pa1, pa2] = lineToPoints(la, h);
      for (const lb of outerB) {
        const [pb1, pb2] = lineToPoints(lb, h);
        const hit = lineIntersection(pa1, pa2, pb1, pb2);
        if (hit) pts.push(hit);
      }
    }
    usedLines = [...outerA, ...outerB];
    if (pts.length === 4) {
      const ordered = orderQuad(pts as [Point, Point, Point, Point]);
      const areaRatio = quadArea(ordered) / (w * h);
      if (areaRatio > 0.12 && quadAnglesOk(ordered)) {
        quad = ordered;
        const minVotes = Math.min(...usedLines.map((l) => l.votes));
        confidence = Math.min(0.99, 0.6 + 0.4 * (minVotes / (usedLines[0]?.votes || minVotes || 1)));
        if (areaRatio < 0.25) confidence *= 0.85;
      }
    }
  }

  const fallback = quad === null;
  if (fallback) {
    quad = fallbackQuad(w, h, edges);
    confidence = 0.35;
  }
  const resolvedQuad: Quad = quad ?? fallbackQuad(w, h, edges);

  // 缩回原图坐标
  const fullQuad: Quad = resolvedQuad.map((p: Point) => ({ x: p.x / scale, y: p.y / scale })) as Quad;
  return {
    quad: fullQuad,
    confidence,
    debug: {
      lines: usedLines.map((l) => ({ theta: l.theta, rho: l.rho / scale, votes: l.votes })),
      edgeDensity: edgeCount / (w * h),
      fallback,
    },
  };
}

/** 给 WebGL2 路径复用：仅边缘图计算（CPU 侧小图，开销低） */
export function computeEdgeMap(img: ImageBuffer, maxDim = 360): {
  edges: Uint8Array;
  width: number;
  height: number;
  scale: number;
} {
  const { buf, scale } = downscale(img, maxDim);
  const gray = blur3(buf.toGrayscale(), buf.width, buf.height);
  const { edges } = sobelEdges(gray, buf.width, buf.height);
  return { edges, width: buf.width, height: buf.height, scale };
}

export type { Mat3 };
