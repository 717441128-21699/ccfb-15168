// 样例照片合成渲染器（纯 TS，无 DOM / 无原生依赖）。
// 输出 ImageBuffer + 与渲染严格一致的 ground truth，供准确率与计时测试使用。
// 模拟项：透视倾斜、三种灯光、镜面反光、手指遮挡、棋子错位、传感器噪点、暗角。
import { ImageBuffer } from '../core/image-buffer';
import { Rng } from '../core/rng';
import {
  applyMat,
  findHomography,
  quadBilinear,
  type Mat3,
  type Point,
  type Quad,
} from '../core/geometry';
import type { BoardSize, Cell } from '../core/types';
import { BLACK, WHITE } from '../core/types';

export type { Quad } from '../core/geometry';

export interface LightingConfig {
  name: string;
  /** 整体亮度系数 */
  brightness: number;
  /** 光源方向（图像空间，单位向量） */
  lightDir: Point;
  /** 环境光比例 */
  ambient: number;
  /** 暖/冷色调（乘到 RGB） */
  tint: [number, number, number];
  /** 方向渐变强度 */
  shade: number;
}

export const LIGHTING_PRESETS: Record<string, LightingConfig> = {
  warm: {
    name: 'warm',
    brightness: 1.02,
    lightDir: normalize({ x: -0.45, y: -0.62 }),
    ambient: 0.55,
    tint: [1.06, 0.99, 0.86],
    shade: 0.22,
  },
  neutral: {
    name: 'neutral',
    brightness: 1.0,
    lightDir: normalize({ x: 0.3, y: -0.75 }),
    ambient: 0.62,
    tint: [1, 1, 1],
    shade: 0.16,
  },
  cool: {
    name: 'cool',
    brightness: 0.92,
    lightDir: normalize({ x: 0.55, y: -0.5 }),
    ambient: 0.5,
    tint: [0.88, 0.96, 1.1],
    shade: 0.26,
  },
};

export interface GlareConfig {
  /** 棋盘 UV 坐标 0..1 */
  u: number;
  v: number;
  /** 半径（UV 单位） */
  radius: number;
  strength: number;
}

export interface HandConfig {
  /** 指尖位置（棋盘 UV） */
  u: number;
  v: number;
  /** 手指指向（UV 空间单位向量），手指沿反方向延伸 */
  angle: number;
  /** 指尖半径（相对图像短边） */
  radiusRatio: number;
  lengthRatio: number;
  skinTone: [number, number, number];
}

export interface RenderConfig {
  size: BoardSize;
  /** ground truth：交叉点索引 -> 棋子颜色 */
  stones: Map<number, Cell>;
  width: number;
  height: number;
  /** 棋盘四角（图像像素，顺序 TL TR BR BL） */
  quad: Quad;
  seed: number;
  lighting: LightingConfig;
  glare?: GlareConfig;
  hand?: HandConfig;
  /** 错位棋子比例（0..1），错位量按格距高斯扰动 */
  misplaceRatio?: number;
  /** 传感器噪点标准差（0..255 量级，通常 2..8） */
  noiseLevel?: number;
  /** 超采样倍数（1=关闭，2=2x2 SSAA） */
  ssaa?: number;
  woodTone?: [number, number, number];
}

function normalize(p: Point): Point {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
}

/**
 * 棋盘边框边距（UV 单位）。网格最外侧交点不在棋盘边缘，而在内缩处，
 * 渲染器与识别分类器必须共用此约定，保证采样点对齐。
 */
export const BOARD_MARGIN_UV = 0.06;

/** 第 (i,j) 交点的 UV 坐标 */
export function intersectionUv(i: number, j: number, size: number): { u: number; v: number } {
  const span = 1 - BOARD_MARGIN_UV * 2;
  return {
    u: BOARD_MARGIN_UV + (i / (size - 1)) * span,
    v: BOARD_MARGIN_UV + (j / (size - 1)) * span,
  };
}

/** 二维值噪声（hash 网格 + smoothstep），用于木纹 */
function makeValueNoise(seed: number) {
  const hash = (ix: number, iy: number) => {
    let h = (ix * 374761393 + iy * 668265263 + seed * 1442695040) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

interface StoneSprite {
  cx: number;
  cy: number;
  r: number;
  color: Cell;
  /** 错位后的实际中心与标准中心之差（像素） */
  shift: Point;
}

export interface RenderedScene {
  image: ImageBuffer;
  /** 与图像严格一致的交叉点标签（行优先） */
  truth: Uint8Array;
  /** 实际使用的四角 */
  quad: Quad;
  /** 被手遮挡的交叉点索引 */
  occluded: number[];
}

export function renderScene(cfg: RenderConfig): RenderedScene {
  const rng = new Rng(cfg.seed);
  const noise = makeValueNoise(cfg.seed);
  const { width: W, height: H, size, quad } = cfg;
  const ssaa = cfg.ssaa ?? 2;
  const image = new ImageBuffer(W, H);
  const truth = new Uint8Array(size * size);
  const occluded: number[] = [];

  // 图像像素 -> 棋盘 UV 的单应性
  const unitQuad: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const imgToUv: Mat3 = findHomography(quad, unitQuad);
  const uvToImg: Mat3 = findHomography(unitQuad, quad);
  const uvToImgPoint = (u: number, v: number): Point =>
    applyMat(uvToImg, { x: u, y: v });

  // 棋盘格距（UV）：网格在边距内铺开，棋子半径约 0.49 格
  const spanUv = 1 - BOARD_MARGIN_UV * 2;
  const pitchUv = spanUv / (size - 1);
  const stoneRuv = pitchUv * 0.49;
  const wood = cfg.woodTone ?? [214, 178, 122];

  // 预计算每个棋子的图像空间中心与半径
  const sprites: StoneSprite[] = [];
  const misplaceRatio = cfg.misplaceRatio ?? 0;
  for (const [idx, color] of cfg.stones) {
    const i = idx % size;
    const j = Math.floor(idx / size);
    const base = intersectionUv(i, j, size);
    let u = base.u;
    let v = base.v;
    let shiftUv: Point = { x: 0, y: 0 };
    if (rng.next() < misplaceRatio) {
      // 最严重错位约 0.32 格距（“没放正”但仍明显属于该交点）
      shiftUv = {
        x: rng.gaussian(0, pitchUv * 0.11),
        y: rng.gaussian(0, pitchUv * 0.11),
      };
      u += shiftUv.x;
      v += shiftUv.y;
    }
    const center = uvToImgPoint(u, v);
    const edge = uvToImgPoint(u + stoneRuv, v);
    const r = Math.hypot(edge.x - center.x, edge.y - center.y);
    sprites.push({ cx: center.x, cy: center.y, r, color, shift: shiftUv });
    truth[idx] = color;
  }

  // 图像空间空间哈希，加速近邻棋子查询
  const cellSize = Math.max(8, ...sprites.map((s) => s.r)) * 2.2;
  const hash = new Map<number, StoneSprite[]>();
  const hkey = (cx: number, cy: number): number =>
    (Math.floor(cx / cellSize) * 73856093) ^ (Math.floor(cy / cellSize) * 19349663);
  for (const s of sprites) {
    const k = hkey(s.cx, s.cy);
    const arr = hash.get(k) ?? [];
    arr.push(s);
    hash.set(k, arr);
  }
  const nearbyStones = (px: number, py: number): StoneSprite[] => {
    const kx = Math.floor(px / cellSize);
    const ky = Math.floor(py / cellSize);
    const out: StoneSprite[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = hash.get((kx + dx) * 73856093 ^ (ky + dy) * 19349663);
        if (arr) out.push(...arr);
      }
    }
    return out;
  };

  const light = cfg.lighting;
  const noiseLevel = cfg.noiseLevel ?? 4;
  const lineWidthUv = pitchUv * 0.06;

  // 手指（胶囊）几何预处理
  const hand = cfg.hand;
  let handBase: Point | null = null;
  let handTip: Point | null = null;
  let handR = 0;
  if (hand) {
    const tipUv = { x: hand.u, y: hand.v };
    const dirx = Math.cos(hand.angle);
    const diry = Math.sin(hand.angle);
    const baseUv = {
      x: hand.u - dirx * hand.lengthRatio * 0.5,
      y: hand.v - diry * hand.lengthRatio * 0.5,
    };
    handTip = uvToImgPoint(tipUv.x, tipUv.y);
    handBase = uvToImgPoint(baseUv.x, baseUv.y);
    handR = Math.min(W, H) * hand.radiusRatio;
  }

  const pointInHand = (px: number, py: number): number => {
    if (!hand || !handTip || !handBase) return -1;
    const ax = handTip.x;
    const ay = handTip.y;
    const bx = handBase.x;
    const by = handBase.y;
    const abx = bx - ax;
    const aby = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
    const qx = ax + abx * t;
    const qy = ay + aby * t;
    const d = Math.hypot(px - qx, py - qy);
    return d <= handR ? t : -1;
  };

  // 记录被手遮住的交叉点（ground truth 仍保留真实标签，识别端应给 UNKNOWN）
  if (hand && handTip) {
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const gp = intersectionUv(i, j, size);
        const p = uvToImgPoint(gp.u, gp.v);
        if (pointInHand(p.x, p.y) >= 0) occluded.push(j * size + i);
      }
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ssaa; sy++) {
        for (let sx = 0; sx < ssaa; sx++) {
          const px = x + (sx + 0.5) / ssaa;
          const py = y + (sy + 0.5) / ssaa;
          const [sr, sg, sb] = shadeSample(px, py);
          r += sr;
          g += sg;
          b += sb;
        }
      }
      const n = ssaa * ssaa;
      image.setPixel(x, y, clamp255(r / n), clamp255(g / n), clamp255(b / n), 255);
    }
  }

  function shadeSample(px: number, py: number): [number, number, number] {
    const uvPt = applyMat(imgToUv, { x: px, y: py });
    const uv = { u: uvPt.x, v: uvPt.y };
    let base: [number, number, number];
    let onBoard = uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1;

    if (!onBoard) {
      // 桌面/桌布：深绿灰织纹
      const n1 = noise(px * 0.05, py * 0.05);
      base = [38 + n1 * 10, 52 + n1 * 9, 47 + n1 * 8];
    } else {
      base = shadeBoard(uv.u, uv.v);
    }

    // 棋子（在桌面区域不可能命中，但统一处理）
    let hit: StoneSprite | null = null;
    let hitD = Infinity;
    if (onBoard) {
      for (const s of nearbyStones(px, py)) {
        const d = Math.hypot(px - s.cx, py - s.cy) / s.r;
        if (d < 1.05 && d < hitD) {
          hit = s;
          hitD = d;
        }
      }
    }
    if (hit) {
      base = shadeStone(hit, px, py, hitD, base);
    }

    // 反光（屏幕空间叠加，过曝）
    if (onBoard && cfg.glare) {
      const gp = uvToImgPoint(cfg.glare.u, cfg.glare.v);
      const gr = cfg.glare.radius * Math.min(W, H);
      const d = Math.hypot(px - gp.x, py - gp.y) / (gr || 1);
      if (d < 1) {
        const fall = (1 - d) ** 2 * cfg.glare.strength;
        base = [
          base[0] + fall * 190,
          base[1] + fall * 188,
          base[2] + fall * 180,
        ];
      }
    }

    // 手指
    const ht = pointInHand(px, py);
    if (ht >= 0 && hand) {
      base = shadeHand(ht, base, hand.skinTone);
    }

    // 暗角
    const vx = (px / W - 0.5) / 0.62;
    const vy = (py / H - 0.5) / 0.62;
    const vig = Math.max(0.72, 1 - 0.32 * (vx * vx + vy * vy));
    base = [base[0] * vig, base[1] * vig, base[2] * vig];

    // 传感器噪点
    const nz = (rng.next() + rng.next() - 1) * noiseLevel;
    return [clamp255(base[0] + nz), clamp255(base[1] + nz), clamp255(base[2] + nz)];
  }

  function shadeBoard(u: number, v: number): [number, number, number] {
    // 木纹：沿 v 方向拉长的条带噪声
    const grain =
      (noise(u * 9, v * 3.2) - 0.5) * 26 +
      (noise(u * 26, v * 7.5) - 0.5) * 9;
    // 光照方向渐变（用 UV 近似）
    const grad =
      1 +
      light.shade *
        (light.lightDir.x * (u - 0.5) + light.lightDir.y * (v - 0.5)) * 2;
    let k = light.brightness * light.ambient + light.brightness * (1 - light.ambient) * grad;
    let rgb: [number, number, number] = [
      (wood[0] + grain) * k * light.tint[0],
      (wood[1] + grain * 0.85) * k * light.tint[1],
      (wood[2] + grain * 0.6) * k * light.tint[2],
    ];
    // 网格线（在边距内的 size×size 交点网格）
    const gridU = (u - BOARD_MARGIN_UV) / pitchUv;
    const gridV = (v - BOARD_MARGIN_UV) / pitchUv;
    const linePosU = Math.round(gridU);
    const linePosV = Math.round(gridV);
    const du = Math.abs(gridU - linePosU) * pitchUv;
    const dv = Math.abs(gridV - linePosV) * pitchUv;
    const inGridU = linePosU >= 0 && linePosU <= size - 1;
    const inGridV = linePosV >= 0 && linePosV <= size - 1;
    const onLineU = du < lineWidthUv && inGridU;
    const onLineV = dv < lineWidthUv && inGridV;
    if (onLineU || onLineV) {
      const strengthU = onLineU ? 1 - du / lineWidthUv : 0;
      const strengthV = onLineV ? 1 - dv / lineWidthUv : 0;
      const s = Math.max(strengthU, strengthV) * 0.55;
      rgb = [rgb[0] * (1 - s), rgb[1] * (1 - s), rgb[2] * (1 - s)];
    }
    // 星位
    const stars = starPoints(size);
    for (const [si, sj] of stars) {
      const sp = intersectionUv(si, sj, size);
      if (Math.hypot(u - sp.u, v - sp.v) < lineWidthUv * 2.2) {
        const s = 0.6;
        rgb = [rgb[0] * (1 - s), rgb[1] * (1 - s), rgb[2] * (1 - s)];
      }
    }
    // 棋盘外缘边框压暗
    const edge = Math.min(u, 1 - u, v, 1 - v);
    if (edge < BOARD_MARGIN_UV * 0.5) {
      const s = 0.22 * (1 - edge / (BOARD_MARGIN_UV * 0.5));
      rgb = rgb.map((c) => c * (1 - s)) as [number, number, number];
    }
    return rgb;
  }

  function shadeStone(
    s: StoneSprite,
    px: number,
    py: number,
    d: number,
    under: [number, number, number],
  ): [number, number, number] {
    // 接触阴影（略大的柔边暗盘）
    const shadowT = Math.max(0, Math.min(1, (d - 0.82) / 0.28));
    const shadow = (1 - shadowT) * 0.28;
    let rgb: [number, number, number] = [
      under[0] * (1 - shadow),
      under[1] * (1 - shadow),
      under[2] * (1 - shadow),
    ];
    if (d >= 1) return rgb;

    const nx = (px - s.cx) / s.r;
    const ny = (py - s.cy) / s.r;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const L = light.lightDir;
    const diffuse = Math.max(0, nx * L.x + ny * L.y + nz * L.y * 0 + nz * 0.9);
    const lit = light.ambient + (1 - light.ambient) * diffuse;
    // 高光（半视角向量，相机在正上方）
    const hx = L.x;
    const hy = L.y - 1;
    const hl = Math.hypot(hx, hy) || 1;
    const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * -1) / -hl), s.color === BLACK ? 42 : 26);

    if (s.color === BLACK) {
      // 真实黑棋：深灰玻璃/玻璃光面，受光面明显变亮，高光集中
      const base = 34;
      rgb = [
        (base + 48 * lit) * light.tint[0] + spec * 150,
        (base + 48 * lit) * light.tint[1] + spec * 150,
        (base + 54 * lit) * light.tint[2] + spec * 160,
      ];
    } else {
      const base = 238;
      rgb = [
        (base - 26 * (1 - lit)) * light.tint[0] + spec * 60,
        (base - 24 * (1 - lit)) * light.tint[1] + spec * 60,
        (base - 30 * (1 - lit)) * light.tint[2] + spec * 58,
      ];
    }
    // 边缘菲涅耳暗化，增强圆盘轮廓
    const rim = Math.max(0, (d - 0.8) / 0.2) * 0.35;
    rgb = rgb.map((c) => c * (1 - rim)) as [number, number, number];
    return rgb;
  }

  function shadeHand(t: number, under: [number, number, number], tone: [number, number, number]): [number, number, number] {
    const shade = 0.82 + 0.18 * (1 - Math.abs(t - 0.5) * 2);
    const hi = light.ambient + (1 - light.ambient) * (0.6 + 0.4 * Math.cos(t * Math.PI));
    return [
      tone[0] * shade * hi + under[0] * 0.06,
      tone[1] * shade * hi + under[1] * 0.05,
      tone[2] * shade * hi + under[2] * 0.05,
    ];
  }

  return { image, truth, quad, occluded };
}

function starPoints(size: BoardSize): Array<[number, number]> {
  if (size === 19) {
    const p = [3, 9, 15];
    const out: Array<[number, number]> = [];
    for (const i of p) for (const j of p) out.push([i, j]);
    return out;
  }
  if (size === 13) {
    const p = [3, 6, 9];
    const out: Array<[number, number]> = [];
    for (const i of p) for (const j of p) out.push([i, j]);
    return out;
  }
  return [
    [2, 2],
    [2, 6],
    [6, 2],
    [6, 6],
    [4, 4],
  ];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 生成带随机透视的棋盘四角 */
export function randomQuad(
  W: number,
  H: number,
  rng: Rng,
  insetRatio = 0.06,
): Quad {
  const inset = Math.min(W, H) * insetRatio;
  const base: Quad = [
    { x: inset, y: inset },
    { x: W - inset, y: inset },
    { x: W - inset, y: H - inset },
    { x: inset, y: H - inset },
  ];
  const jitter = Math.min(W, H) * 0.09;
  return base.map((p: Point) => ({
    x: p.x + rng.gaussian(0, jitter * 0.5),
    y: p.y + rng.gaussian(0, jitter * 0.5),
  })) as Quad;
}

/** 已知四角时，直接取棋盘上第 (i,j) 交点的图像坐标 */
export function intersectionPixel(q: Quad, i: number, j: number, size: number): Point {
  const u = i / (size - 1);
  const v = j / (size - 1);
  return quadBilinear(q, u, v);
}

export { BLACK, WHITE };
