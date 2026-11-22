// 与 DOM 无关的 RGBA 图像缓冲，浏览器（ImageData）与 Node 测试共用。
// 所有计算机视觉算法都基于这个类，便于单测与离线管线复用。

export class ImageBuffer {
  readonly width: number;
  readonly height: number;
  /** RGBA 行优先，长度 = width*height*4 */
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
  }

  static fromImageData(img: ImageData): ImageBuffer {
    return new ImageBuffer(img.width, img.height, new Uint8ClampedArray(img.data));
  }

  toImageData(): ImageData {
    return new ImageData(
      new Uint8ClampedArray(this.data),
      this.width,
      this.height,
    );
  }

  idx(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  getPixel(x: number, y: number): [number, number, number, number] {
    const i = this.idx(x, y);
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  setPixel(x: number, y: number, r: number, g: number, b: number, a = 255): void {
    const i = this.idx(x, y);
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  /** 双线性采样（浮点坐标，越界返回透明黑） */
  sampleBilinear(x: number, y: number): [number, number, number, number] {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;
    if (x0 < 0 || y0 < 0 || x1 >= this.width || y1 >= this.height) {
      return [0, 0, 0, 0];
    }
    const tx = x - x0;
    const ty = y - y0;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const out: [number, number, number, number] = [0, 0, 0, 0];
    const pts: Array<[number, number, number, number]> = [
      this.getPixel(x0, y0),
      this.getPixel(x1, y0),
      this.getPixel(x0, y1),
      this.getPixel(x1, y1),
    ];
    const ws = [w00, w10, w01, w11];
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += pts[k][c] * ws[k];
      out[c] = s;
    }
    return out;
  }

  /** 灰度（Rec. 601），返回 Float32 数组，值域 0..255 */
  toGrayscale(): Float32Array {
    const out = new Float32Array(this.width * this.height);
    const d = this.data;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      out[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return out;
  }

  clone(): ImageBuffer {
    return new ImageBuffer(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  /** 圆形区域均值 RGB 与不透明度（用于棋子分类） */
  circleStats(cx: number, cy: number, radius: number): {
    mean: [number, number, number];
    std: number;
    coverage: number;
    grayMean: number;
  } {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let graySum = 0;
    let graySq = 0;
    let n = 0;
    let valid = 0;
    const r2 = radius * radius;
    const xMin = Math.max(0, Math.floor(cx - radius));
    const xMax = Math.min(this.width - 1, Math.ceil(cx + radius));
    const yMin = Math.max(0, Math.floor(cy - radius));
    const yMax = Math.min(this.height - 1, Math.ceil(cy + radius));
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        n++;
        const [r, g, b, a] = this.getPixel(x, y);
        if (a < 128) continue;
        valid++;
        rSum += r;
        gSum += g;
        bSum += b;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        graySum += gray;
        graySq += gray * gray;
      }
    }
    const cnt = valid || 1;
    const grayMean = graySum / cnt;
    const variance = Math.max(0, graySq / cnt - grayMean * grayMean);
    return {
      mean: [rSum / cnt, gSum / cnt, bSum / cnt],
      std: Math.sqrt(variance),
      coverage: valid / (n || 1),
      grayMean,
    };
  }
}

/** 用单应性矩阵把 src 校正到 size×size 的正方形（双线性采样） */
export function warpPerspective(
  src: ImageBuffer,
  homography: number[],
  outSize: number,
): ImageBuffer {
  const out = new ImageBuffer(outSize, outSize);
  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      const srcPt = applyH(homography, x, y);
      const [r, g, b, a] = src.sampleBilinear(srcPt.x, srcPt.y);
      out.setPixel(x, y, r, g, b, a);
    }
  }
  return out;
}

/** 正变换：输出图像坐标 -> 源图像坐标（homography 本身即 dst->src 时） */
function applyH(m: number[], x: number, y: number): { x: number; y: number } {
  const w = m[6] * x + m[7] * y + m[8];
  return {
    x: (m[0] * x + m[1] * y + m[2]) / w,
    y: (m[3] * x + m[4] * y + m[5]) / w,
  };
}
