// 交叉点分类（第二版）：
// 主判据是“圆盘覆盖度”——棋子是覆盖网格线的均匀圆盘，空交点是木纹+细网格线；
// 灰度三聚类只用于在确认是棋子后区分黑白。
// 鲁棒项：自适应阈值、反光救回、手部/异物 UNKNOWN、空间一致性降权。
import { ImageBuffer } from './image-buffer';
import { gridIntersection, type Point } from './geometry';
import { BOARD_MARGIN_UV } from '../synth/scene';
import { BLACK, WHITE, EMPTY, UNKNOWN, type BoardSize, type CellLabel } from './types';

export interface CellFeature {
  gray: number;
  grayStd: number;
  ringGray: number;
  /** 圆盘覆盖度 0..1 */
  diskScore: number;
  /** 径向边缘对比度：圆盘边界灰度跳变（棋子边界连续，空交点仅网格线局部跳变） */
  rimContrast: number;
  /** 边缘跳变方向一致性 0..1，棋子整圈同号 */
  ringConsistency: number;
  /** 网格线覆盖度 0..1 */
  lineCoverage: number;
  /** 网格线残留 */
  gridRemnant: number;
  saturation: number;
  skin: number;
  highlight: number;
  coverage: number;
  label: CellLabel;
  confidence: number;
}

export interface ClassifyResult {
  labels: Uint8Array;
  confidence: Float32Array;
  features: CellFeature[];
  centers: { black: number; white: number; empty: number };
  unknownReasons: Record<number, string>;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/** 手部肤色宽口径判定 */
export function isSkin(r: number, g: number, b: number): boolean {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (v < 0.28) return false;
  if (s < 0.12 || s > 0.68) return false;
  const hueOk = h <= 25 || h >= 350;
  return hueOk && r > 95 && r > g && g > b && r - b > 18;
}

interface RawFeature {
  gray: number;
  grayStd: number;
  ringGray: number;
  edgeDark: number;
  /** 径向边缘对比度：圆盘边界内外的灰度跳变（棋子最强，空交点接近 0） */
  rimContrast: number;
  /** 边缘跳变方向一致性 */
  ringConsistency: number;
  saturation: number;
  skin: number;
  highlight: number;
  coverage: number;
  /** 内部采样点与中心灰度的平均偏差（圆盘应很小） */
  radialUniformity: number;
  /** 网格线覆盖度：四向网格线是否被圆盘盖住 */
  lineCoverage: number;
  /** 网格线残留：空交点网格线穿过中心（正值大），棋子切断（≈0） */
  gridRemnant: number;
}

/** 单点灰度（最近邻，越界返回 null） */
function grayAt(img: ImageBuffer, x: number, y: number): number | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
  const i = (yi * img.width + xi) * 4;
  const d = img.data;
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

function extractFeature(
  img: ImageBuffer,
  cx: number,
  cy: number,
  radius: number,
): RawFeature {
  const inner = img.circleStats(cx, cy, radius * 0.6);
  const ring = img.circleStats(cx, cy, radius * 0.95);
  const r2 = radius * radius;
  let satSum = 0;
  let skinCount = 0;
  let highlightCount = 0;
  let sampled = 0;
  let radialDev = 0;
  let radialN = 0;
  const centerGray = inner.grayMean;
  const xMin = Math.max(0, Math.floor(cx - radius));
  const xMax = Math.min(img.width - 1, Math.ceil(cx + radius));
  const yMin = Math.max(0, Math.floor(cy - radius));
  const yMax = Math.min(img.height - 1, Math.ceil(cy + radius));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const [r, g, b, a] = img.getPixel(x, y);
      if (a < 128) continue;
      sampled++;
      const [, s] = rgbToHsv(r, g, b);
      satSum += s;
      if (isSkin(r, g, b)) skinCount++;
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      if (gray > 248) highlightCount++;
      const rr = Math.sqrt(d2) / radius;
      if (rr >= 0.25 && rr <= 0.7) {
        radialDev += Math.abs(gray - centerGray);
        radialN++;
      }
    }
  }
  const cnt = sampled || 1;

  // 径向边缘对比度：沿圆周均匀采样，比较圆盘内侧（0.66r）与外侧（1.12r）灰度。
  // 棋子边界是一整圈连续跳变；空交点的网格线只在 4 个方向造成局部跳变，
  // 因此用“跳变方向一致性 + 中位数”压制网格线干扰。
  const angles = 24;
  const jumpsSigned: number[] = [];
  for (let a = 0; a < angles; a++) {
    const theta = (a / angles) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const gIn = grayAt(img, cx + cos * radius * 0.66, cy + sin * radius * 0.66);
    const gOut = grayAt(img, cx + cos * radius * 1.12, cy + sin * radius * 1.12);
    if (gIn === null || gOut === null) continue;
    // 有符号跳变：gOut - gIn。棋子外圈是木纹，对黑/白棋分别稳定为正/负
    jumpsSigned.push(gOut - gIn);
  }
  const absJumps = jumpsSigned.map((v) => Math.abs(v)).sort((a, b) => a - b);
  // 60 百分位跳变：兼顾“整圈连续”（压网格线）与贴邻棋子（容忍约 1/3 角度被挡）
  const rimContrast = absJumps.length
    ? absJumps[Math.min(absJumps.length - 1, Math.floor(absJumps.length * 0.6))]
    : 0;
  // 方向一致性：棋子整圈跳变同号（外圈木纹 vs 黑/白圆盘），网格线正负混杂
  const pos = jumpsSigned.filter((v) => v > 10).length;
  const neg = jumpsSigned.filter((v) => v < -10).length;
  const ringConsistency = Math.max(pos, neg) / (jumpsSigned.length || 1);

  // 网格线覆盖度：8 方向 0.5 格距探针，取与中心差异的最小值。
  // 棋子周围至少有朝向木纹空隙的方向（差异小）；贴邻棋子只影响个别方向，
  // 取最小值可避免被邻子带偏。
  const pitch = radius / 0.46;
  const lineDiffs: number[] = [];
  for (let a = 0; a < 8; a++) {
    const theta = (a / 8) * Math.PI * 2;
    const g = grayAt(
      img,
      cx + Math.cos(theta) * pitch * 0.5,
      cy + Math.sin(theta) * pitch * 0.5,
    );
    if (g !== null) lineDiffs.push(Math.abs(g - centerGray));
  }
  const lineDiffMin = lineDiffs.length ? Math.min(...lineDiffs) : 0;
  // 差异小 => 该方向仍是同色圆盘 => 棋子
  const lineCoverage = clamp01(1 - lineDiffMin / 24);

  // 网格线残留：沿四条网格轴，在圆盘内圈 0.28r 处取点。
  // 空交点的网格线连续穿过，这些点应明显暗于中心；棋子把线切断，内外同色。
  const axisDark: number[] = [];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const g = grayAt(img, cx + dx * radius * 0.28, cy + dy * radius * 0.28);
    if (g !== null) axisDark.push(centerGray - g); // >0 表示该点比中心暗（网格线）
  }
  axisDark.sort((a, b) => b - a);
  // 取第二暗（容忍一个方向被干扰），空交点为正且较大，棋子接近 0 或负
  const gridRemnant = axisDark.length >= 2 ? axisDark[1] : 0;

  return {
    gray: inner.grayMean,
    grayStd: inner.std,
    ringGray: ring.grayMean,
    edgeDark: 0,
    rimContrast,
    ringConsistency,
    saturation: satSum / cnt,
    skin: skinCount / cnt,
    highlight: highlightCount / cnt,
    coverage: inner.coverage,
    radialUniformity: radialN ? radialDev / radialN : 0,
    lineCoverage,
    gridRemnant,
  };
}

/** 一维三均值聚类，返回按亮度排序的中心；样本不足时回退分位数 */
function clusterGray(values: number[]): { black: number; empty: number; white: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  let black = q(0.08);
  let empty = q(0.5);
  let white = q(0.92);
  for (let iter = 0; iter < 30; iter++) {
    let sb = 0;
    let se = 0;
    let sw = 0;
    let nb = 0;
    let ne = 0;
    let nw = 0;
    for (const v of values) {
      const dB = Math.abs(v - black);
      const dE = Math.abs(v - empty);
      const dW = Math.abs(v - white);
      if (dB <= dE && dB <= dW) {
        sb += v;
        nb++;
      } else if (dE <= dW) {
        se += v;
        ne++;
      } else {
        sw += v;
        nw++;
      }
    }
    const nb2 = nb || 1;
    const ne2 = ne || 1;
    const nw2 = nw || 1;
    const nBlack = sb / nb2;
    const nEmpty = se / ne2;
    const nWhite = sw / nw2;
    if (
      Math.abs(nBlack - black) < 0.3 &&
      Math.abs(nEmpty - empty) < 0.3 &&
      Math.abs(nWhite - white) < 0.3
    ) {
      black = nBlack;
      empty = nEmpty;
      white = nWhite;
      break;
    }
    black = nBlack;
    empty = nEmpty;
    white = nWhite;
  }
  const triplet = [black, empty, white].sort((a, b) => a - b);
  return { black: triplet[0], empty: triplet[1], white: triplet[2] };
}

function clamp01(v: number): number {
  return Math.max(0.01, Math.min(0.99, v));
}

export function classifyIntersections(
  warped: ImageBuffer,
  size: BoardSize,
  marginRatio: number = BOARD_MARGIN_UV,
): ClassifyResult {
  const warpedSize = warped.width;
  const margin = warpedSize * marginRatio;
  const span = warpedSize - margin * 2;
  const cellPitch = span / (size - 1);
  const radius = cellPitch * 0.46;
  const n = size * size;
  const labels = new Uint8Array(n);
  const confidence = new Float32Array(n);
  const unknownReasons: Record<number, string> = {};

  // 第一阶段：标称位置特征，用于全局统计
  const nominal: RawFeature[] = [];
  const nominalPt: Point[] = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const p = gridIntersection(i, j, size, warpedSize, margin);
      nominalPt.push(p);
      nominal.push(extractFeature(warped, p.x, p.y, radius));
    }
  }

  const centers = clusterGray(nominal.map((f) => f.gray));
  const grayValues = nominal.map((f) => f.gray).sort((a, b) => a - b);
  const medianGray = grayValues[Math.floor(grayValues.length / 2)];
  const medRadial = median(nominal.map((f) => f.radialUniformity));
  const rimValues = nominal.map((f) => f.rimContrast).sort((a, b) => a - b);
  const rimP75 = rimValues[Math.floor(rimValues.length * 0.75)];
  const rimFloor = Math.min(14, Math.max(8, rimP75 * 1.1));
  const spreadBE = Math.max(10, centers.empty - centers.black);
  const spreadWE = Math.max(10, centers.white - centers.empty);

  // 第二阶段：保守的局部中心搜索。
  // 标称位置明确（强 rim 或明确网格线）时不搜索，避免空点在偏移处误找到圆盘；
  // 仅对标称位置证据模糊的点，在两级半径内找更强的圆盘证据，救回错位棋子（实测错位可达 ~0.3 格距）。
  const searchOffsets = [
    [0.18, 0],
    [-0.18, 0],
    [0, 0.18],
    [0, -0.18],
    [0.3, 0],
    [-0.3, 0],
    [0, 0.3],
    [0, -0.3],
  ];
  const raws: RawFeature[] = [];
  for (let k = 0; k < n; k++) {
    const base = nominalPt[k];
    const f0 = nominal[k];
    const nominalEvidence = f0.rimContrast - f0.gridRemnant * 1.5;
    // 标称位置已经很确定：直接采用（保护空点与正常棋子）
    const nominalStrong = f0.rimContrast > rimFloor * 1.6 || f0.gridRemnant > 12;
    if (nominalStrong) {
      raws.push(f0);
      continue;
    }
    let best = f0;
    let bestEvidence = nominalEvidence;
    for (const [ox, oy] of searchOffsets) {
      const f = extractFeature(warped, base.x + ox * cellPitch, base.y + oy * cellPitch, radius);
      const evidence = f.rimContrast - f.gridRemnant * 1.5;
      // 要求显著优于标称才采纳，防止噪声漂移；偏移越大要求越严格
      const margin = Math.abs(ox) + Math.abs(oy) > 0.25 ? 14 : 8;
      if (evidence > bestEvidence + margin) {
        bestEvidence = evidence;
        best = f;
      }
    }
    // 错位棋子专用救回：标称点本身已有强 rim（说明确有圆盘），
    // 只是因中心偏移导致网格残留虚高。在偏移处找到“更强 rim + 低残留”即采纳。
    // 空点标称 rim 弱，进不了这个分支，因此不会误伤。
    if (f0.rimContrast > rimFloor * 1.7 && best.gridRemnant > 10) {
      for (const [ox, oy] of searchOffsets) {
        const f = extractFeature(warped, base.x + ox * cellPitch, base.y + oy * cellPitch, radius);
        if (f.rimContrast > f0.rimContrast && f.gridRemnant < 6) {
          best = f;
          break;
        }
      }
    }
    raws.push(best);
  }

  const features: CellFeature[] = [];
  for (let k = 0; k < n; k++) {
    const f = raws[k];
    let label: CellLabel = EMPTY;
    let conf = 0.5;

    // 圆盘证据：rim 为主，lineCoverage 与内部均匀性辅助
    const rimScore = clamp01((f.rimContrast - rimFloor) / Math.max(20, rimFloor));
    const uniformScore = clamp01(1 - f.radialUniformity / Math.max(8, medRadial * 2.2 + 6));
    const ringMatch = clamp01(1 - Math.abs(f.gray - f.ringGray) / 40);
    const diskScore = clamp01(
      rimScore * 0.5 + f.lineCoverage * 0.3 + uniformScore * 0.12 + ringMatch * 0.08,
    );

    // 灰度证据：到黑/白聚类中心的归一化距离，越极端越像棋子
    const grayExtreme = Math.max(
      clamp01(1 - (f.gray - centers.black) / spreadBE),
      clamp01(1 - (centers.white - f.gray) / spreadWE),
    );

    // 1) 手遮挡 / 出界
    if (f.skin > 0.28 || f.coverage < 0.55) {
      label = UNKNOWN;
      conf = 0.4;
      unknownReasons[k] = f.skin > 0.28 ? 'hand' : 'occluded';
    } else if (f.highlight > 0.32 && f.grayStd < 30) {
      // 2) 强反光：白棋有外圈更暗/边缘跳变，空交点没有
      if (f.rimContrast > rimFloor || f.ringGray < f.gray - 6) {
        label = WHITE;
        conf = 0.85;
      } else {
        label = UNKNOWN;
        conf = 0.45;
        unknownReasons[k] = 'glare';
      }
    } else {
      // 网格线残留是最强的空点判据：空交点必有暗网格线穿过内圈（实测 >15），
      // 棋子把线完全切断（实测 <5）。阈值 10 位于两者之间的宽间隔。
      const gridVisible = f.gridRemnant > 10;
      // 3) rim（边界跳变）区分棋子与木纹；灰度极端性区分黑白。
      //    lineCoverage/ringConsistency 只作弱辅助。
      const ringBonus = f.ringConsistency > 0.6 ? 0.08 : 0;
      const isStone =
        !gridVisible &&
        ((rimScore + ringBonus > 0.22 && grayExtreme > 0.4) ||
          (rimScore > 0.45 && f.lineCoverage > 0.55) ||
          rimScore + ringBonus > 0.6);
      if (isStone) {
        const dB = Math.abs(f.gray - centers.black);
        const dW = Math.abs(f.gray - centers.white);
        const belowMedian = f.gray < medianGray - 6;
        if (dB < dW || belowMedian) {
          label = BLACK;
          conf = clamp01(0.78 + rimScore * 0.2);
        } else {
          label = WHITE;
          conf = clamp01(0.78 + rimScore * 0.2);
        }
      } else if (gridVisible || rimScore < 0.12) {
        // 4) 明确的空交点：网格线可见，或边界跳变低于地板
        label = EMPTY;
        conf = clamp01(0.78 + Math.max(0, 0.12 - rimScore) * 0.5 + (gridVisible ? 0.1 : 0));
      } else {
        // 5) 模糊带：交时序/规则裁决
        label = UNKNOWN;
        conf = 0.4;
        unknownReasons[k] = 'ambiguous';
      }
    }

    // 高饱和彩色异物
    if (label !== UNKNOWN && f.saturation > 0.55 && f.skin <= 0.28) {
      label = UNKNOWN;
      conf = 0.4;
      unknownReasons[k] = 'foreign-object';
    }

    labels[k] = label;
    confidence[k] = conf;
    features.push({ ...f, diskScore, label, confidence: conf });
  }

  // 空间一致性校正（基于 8 邻域，两轮收敛）：
  // 围棋棋子成团，孤立的低置信判定可用邻域多数修正；高置信判定保持不动。
  for (let round = 0; round < 2; round++) {
    const snapshot = new Uint8Array(labels);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const k = j * size + i;
        // UNKNOWN（手遮挡/反光/出界）保持不可判读，不被邻域投票覆盖
        if (snapshot[k] === UNKNOWN) continue;
        if (confidence[k] >= 0.85) continue; // 高置信不参与翻转
        const votes = new Map<number, number>();
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= size || nj >= size) continue;
            const v = snapshot[nj * size + ni];
            if (v === UNKNOWN) continue;
            votes.set(v, (votes.get(v) ?? 0) + 1);
          }
        }
        let bestV = -1;
        let bestCount = 0;
        for (const [v, c] of votes) {
          if (c > bestCount) {
            bestCount = c;
            bestV = v;
          }
        }
        // 至少 4 个邻域一致（强多数）才翻转，避免误杀孤立棋子
        if (bestV >= 0 && bestCount >= 4 && bestV !== snapshot[k]) {
          labels[k] = bestV;
          confidence[k] = Math.max(confidence[k], 0.72);
        }
      }
    }
  }

  return { labels, confidence, features, centers, unknownReasons };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
