// 识别管线（CPU 参考实现，也是 WebGL2 不可用时的兜底）：
// 角点检测 -> 透视校正 -> 交叉点分类 -> PhotoObservation。
import { ImageBuffer, warpPerspective } from './image-buffer';
import { detectBoard } from './detector';
import { classifyIntersections } from './classifier';
import { findHomography, unitSquareQuad, type Quad } from './geometry';
import type { BoardSize, PhotoObservation } from './types';

export interface PipelineOptions {
  /** 校正图边长 */
  warpedSize?: number;
  /** 已知棋盘四角时跳过自动检测（人工修正后重跑用） */
  knownQuad?: Quad;
}

export function runPipeline(
  img: ImageBuffer,
  size: BoardSize,
  options: PipelineOptions = {},
): PhotoObservation {
  const t0 = now();
  const detection = options.knownQuad
    ? { quad: options.knownQuad, confidence: 1, debug: { lines: [], edgeDensity: 0, fallback: false } }
    : detectBoard(img);
  const tDetect = now();

  const warpedSize = options.warpedSize ?? 768;
  const square = unitSquareQuad(warpedSize);
  // warpPerspective 按“输出像素 -> 源像素”反向采样，
  // 因此这里需要 dst(square) -> src(检测四角) 的单应性
  const homography = findHomography(square, detection.quad);
  const warped = warpPerspective(img, homography, warpedSize);
  const tWarp = now();

  const result = classifyIntersections(warped, size);
  const tClassify = now();

  return {
    labels: result.labels,
    size,
    confidence: result.confidence,
    corners: detection.quad,
    warpedSize,
    elapsedMs: tClassify - t0,
    stageMs: {
      detect: tDetect - t0,
      warp: tWarp - tDetect,
      classify: tClassify - tWarp,
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
