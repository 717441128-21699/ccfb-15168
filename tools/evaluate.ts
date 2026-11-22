// 评估公共逻辑：角点误差、逐交点准确率、混淆矩阵、遮挡处理率。
import type { PhotoObservation, Point, Quad } from '../src/core/types';
import { UNKNOWN, type CellLabel } from '../src/core/types';

export interface AccuracyBreakdown {
  total: number;
  correct: number;
  unknown: number;
  wrong: number;
  /** 可见交点（非遮挡）准确率 */
  visibleAccuracy: number;
  /** 全量严格准确率（UNKNOWN 视为错误） */
  strictAccuracy: number;
  confusion: number[][]; // 行=真值(0..2)，列=预测(0..3)
}

export function evaluateLabels(
  truth: Uint8Array,
  obs: PhotoObservation,
  occluded: number[],
): AccuracyBreakdown {
  const occSet = new Set(occluded);
  const confusion = Array.from({ length: 3 }, () => new Array<number>(4).fill(0));
  let correct = 0;
  let unknown = 0;
  let wrong = 0;
  let visibleTotal = 0;
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i];
    const p: CellLabel = obs.labels[i] as CellLabel;
    confusion[t][p]++;
    if (p === UNKNOWN) {
      unknown++;
      continue;
    }
    if (p === t) correct++;
    else wrong++;
    if (!occSet.has(i)) visibleTotal++;
  }
  // 可见交点中预测正确的比例（UNKNOWN 与错误都算失败，但单独披露）
  let visibleCorrect = 0;
  let visibleAll = 0;
  for (let i = 0; i < truth.length; i++) {
    if (occSet.has(i)) continue;
    visibleAll++;
    if (obs.labels[i] === truth[i]) visibleCorrect++;
  }
  return {
    total: truth.length,
    correct,
    unknown,
    wrong,
    visibleAccuracy: visibleAll ? visibleCorrect / visibleAll : 1,
    strictAccuracy: correct / truth.length,
    confusion,
  };
}

/** 四角平均误差，按图像对角线归一化 */
export function quadError(pred: Quad, truth: Quad, diagonal: number): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += dist(pred[i], truth[i]);
  }
  return sum / 4 / diagonal;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface OcclusionStats {
  occludedTotal: number;
  unknownCount: number;
  correctConcreteCount: number;
  /** 遮挡点被正确处理（UNKNOWN 或猜对颜色）的比例 */
  handledRate: number;
}

export function evaluateOcclusion(
  truth: Uint8Array,
  obs: PhotoObservation,
  occluded: number[],
): OcclusionStats {
  let unknownCount = 0;
  let correctConcrete = 0;
  for (const i of occluded) {
    if (obs.labels[i] === UNKNOWN) unknownCount++;
    else if (obs.labels[i] === truth[i]) correctConcrete++;
  }
  const total = occluded.length;
  return {
    occludedTotal: total,
    unknownCount,
    correctConcreteCount: correctConcrete,
    handledRate: total ? (unknownCount + correctConcrete) / total : 1,
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
