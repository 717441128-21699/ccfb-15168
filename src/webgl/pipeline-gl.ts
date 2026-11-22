// 识别管线门面：优先 WebGL2 做 GPU 透视校正，不可用或失败时回退纯 CPU。
// 检测（角点）与分类（交叉点判定）始终走同一套 TS 逻辑，保证结果一致、可测试。
import { ImageBuffer, warpPerspective } from '../core/image-buffer';
import { detectBoard } from '../core/detector';
import { classifyIntersections } from '../core/classifier';
import { findHomography, unitSquareQuad, type Quad } from '../core/geometry';
import type { BoardSize, PhotoObservation } from '../core/types';
import { createGlContext, gpuWarp, type GlContext } from './warp-gl';

export interface RecognitionBackend {
  mode: 'webgl2' | 'cpu';
  reason?: string;
}

let sharedCtx: GlContext | null | undefined;

function getContext(canvas: HTMLCanvasElement): GlContext | null {
  if (sharedCtx === undefined) {
    try {
      sharedCtx = createGlContext(canvas);
    } catch (err) {
      sharedCtx = null;
      throw err;
    }
  }
  return sharedCtx;
}

/**
 * 浏览器端识别入口。
 * @param source 已解码的位图
 * @param size 棋盘路数
 * @param knownQuad 人工修正过的四角（可选）
 */
export async function recognizePhoto(
  source: ImageBitmap,
  size: BoardSize,
  knownQuad?: Quad,
  warpedSize = 768,
): Promise<{ observation: PhotoObservation; backend: RecognitionBackend }> {
  const t0 = performance.now();
  const canvas = document.createElement('canvas');
  // 先把位图绘入 ImageBuffer 供 CPU 检测
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('无法获取 2D 上下文');
  ctx2d.drawImage(source, 0, 0);
  const imageData = ctx2d.getImageData(0, 0, source.width, source.height);
  const srcBuffer = ImageBuffer.fromImageData(imageData);

  const detection = knownQuad
    ? { quad: knownQuad, confidence: 1, debug: { lines: [], edgeDensity: 0, fallback: false } }
    : detectBoard(srcBuffer);
  const tDetect = performance.now();

  const square = unitSquareQuad(warpedSize);
  const homography = findHomography(square, detection.quad);

  let warped: ImageBuffer;
  let backend: RecognitionBackend;
  try {
    const gl = getContext(canvas);
    if (gl) {
      const pixels = gpuWarp(
        gl,
        source,
        homography,
        { width: source.width, height: source.height },
        warpedSize,
      );
      warped = new ImageBuffer(warpedSize, warpedSize, pixels);
      backend = { mode: 'webgl2' };
    } else {
      throw new Error('webgl2-unavailable');
    }
  } catch (err) {
    warped = warpPerspective(srcBuffer, homography, warpedSize);
    backend = { mode: 'cpu', reason: err instanceof Error ? err.message : String(err) };
  }
  const tWarp = performance.now();

  const result = classifyIntersections(warped, size);
  const tClassify = performance.now();

  const observation: PhotoObservation = {
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
  return { observation, backend };
}
