// WebGL2 加速：GPU 透视校正（fragment shader 双线性采样）+ 灰度/特征纹理。
// 检测与最终判定仍复用 CPU 逻辑（数据共享、易测试），GPU 负责最重的逐像素 warp。
import type { Quad } from '../core/types';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 透视校正：用输出->源的单应性逆变换采样原图
const WARP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform mat3 uH;        // 输出 UV -> 源像素坐标
uniform vec2 uSrcSize;
uniform float uOutSize;
void main() {
  vec3 dst = vec3(vUv * uOutSize, 1.0);
  vec3 src = uH * dst;
  vec2 srcUv = (src.xy / src.z) / uSrcSize;
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 0.0);
  } else {
    outColor = texture(uSrc, srcUv);
  }
}`;

// 灰度 + 逐交点圆斑特征（在一个全屏 pass 里输出灰度纹理，圆斑统计回读 CPU）
const GRAY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() {
  vec4 c = texture(uSrc, vUv);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  outColor = vec4(g, g, g, c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('无法创建 shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader 编译失败: ${log}`);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('无法创建 program');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program 链接失败: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export interface GlContext {
  gl: WebGL2RenderingContext;
  warpProgram: WebGLProgram;
  grayProgram: WebGLProgram;
  vao: WebGLVertexArrayObject;
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

/** 创建 WebGL2 上下文；不支持时返回 null，由调用方回退 CPU */
export function createGlContext(canvas: HTMLCanvasElement): GlContext | null {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;
  const warpProgram = program(gl, VERT, WARP_FRAG);
  const grayProgram = program(gl, VERT, GRAY_FRAG);
  const vao = gl.createVertexArray();
  if (!vao) return null;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  if (!texture) return null;
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) return null;
  return { gl, warpProgram, grayProgram, vao, texture, framebuffer };
}

/** 上传源图像到纹理 */
function uploadSource(gl: WebGL2RenderingContext, tex: WebGLTexture, img: ImageBitmap | HTMLImageElement): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
}

/** 创建输出纹理并挂到 framebuffer */
function attachOutput(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const out = gl.createTexture();
  if (!out) throw new Error('无法创建输出纹理');
  gl.bindTexture(gl.TEXTURE_2D, out);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
  return out;
}

/**
 * GPU 透视校正：返回 size×size 的 RGBA 图像（readPixels 结果）。
 * @param homography 输出像素 -> 源像素 的 3x3 单应性（列主序传入 GPU）
 */
export function gpuWarp(
  ctx: GlContext,
  source: ImageBitmap | HTMLImageElement,
  homography: number[],
  srcSize: { width: number; height: number },
  outSize: number,
): Uint8ClampedArray {
  const { gl } = ctx;
  uploadSource(gl, ctx.texture, source);
  const outTex = attachOutput(gl, outSize);
  gl.viewport(0, 0, outSize, outSize);
  gl.useProgram(ctx.warpProgram);
  gl.bindVertexArray(ctx.vao);
  // mat3 转列主序
  const colMajor = new Float32Array([
    homography[0], homography[3], homography[6],
    homography[1], homography[4], homography[7],
    homography[2], homography[5], homography[8],
  ]);
  const uH = gl.getUniformLocation(ctx.warpProgram, 'uH');
  const uSrc = gl.getUniformLocation(ctx.warpProgram, 'uSrc');
  const uSrcSize = gl.getUniformLocation(ctx.warpProgram, 'uSrcSize');
  const uOutSize = gl.getUniformLocation(ctx.warpProgram, 'uOutSize');
  gl.uniformMatrix3fv(uH, false, colMajor);
  gl.uniform1i(uSrc, 0);
  gl.uniform2f(uSrcSize, srcSize.width, srcSize.height);
  gl.uniform1f(uOutSize, outSize);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.texture);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const pixels = new Uint8ClampedArray(outSize * outSize * 4);
  gl.readPixels(0, 0, outSize, outSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  gl.deleteTexture(outTex);
  // WebGL 原点在左下，图像在左上，垂直翻转
  return flipY(pixels, outSize);
}

function flipY(data: Uint8ClampedArray, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * rowBytes;
    out.set(data.subarray(src, src + rowBytes), y * rowBytes);
  }
  return out;
}

/** 检测 WebGL2 是否可用（供 UI 显示加速状态） */
export function isWebGL2Supported(): boolean {
  if (typeof document === 'undefined') return false;
  const c = document.createElement('canvas');
  return !!c.getContext('webgl2');
}

export type { Quad };
