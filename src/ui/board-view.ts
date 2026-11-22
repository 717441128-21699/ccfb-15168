// 棋盘 SVG 渲染：网格、星位、棋子、UNKNOWN 标记、矛盾高亮、点击回调。
import { el } from './dom';
import { BLACK, WHITE, UNKNOWN, type BoardSize } from '../core/types';

export interface BoardViewOptions {
  size: BoardSize;
  /** 边长（SVG 像素） */
  pixel?: number;
  /** 每个交叉点的标签 */
  labels?: ArrayLike<number>;
  /** 高亮的交叉点索引（矛盾/选中等） */
  highlights?: Set<number>;
  /** 点击交叉点回调 */
  onCellClick?: (index: number) => void;
  /** 是否可交互（显示手型光标） */
  interactive?: boolean;
}

const STAR_POINTS: Record<number, Array<[number, number]>> = {
  19: [
    [3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15],
  ],
  13: [
    [3, 3], [6, 3], [9, 3], [3, 6], [6, 6], [9, 6], [3, 9], [6, 9], [9, 9],
  ],
  9: [
    [2, 2], [6, 2], [4, 4], [2, 6], [6, 6],
  ],
};

export function renderBoard(opts: BoardViewOptions): SVGSVGElement {
  const { size, labels, highlights, onCellClick, interactive } = opts;
  const pixel = opts.pixel ?? 560;
  const margin = pixel * 0.06;
  const span = pixel - margin * 2;
  const pitch = span / (size - 1);
  const stoneR = pitch * 0.47;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${pixel} ${pixel}`);
  svg.setAttribute('class', 'board-svg');
  if (interactive) svg.style.cursor = 'pointer';

  const pos = (i: number) => margin + i * pitch;

  // 棋盘底色
  svg.append(svgRect(0, 0, pixel, pixel, 'var(--board)'));

  // 网格线
  for (let k = 0; k < size; k++) {
    const p = pos(k);
    svg.append(svgLine(margin, p, pixel - margin, p));
    svg.append(svgLine(p, margin, p, pixel - margin));
  }
  // 星位
  for (const [i, j] of STAR_POINTS[size] ?? []) {
    const c = svgCircle(pos(i), pos(j), pitch * 0.09, 'var(--board-line)');
    svg.append(c);
  }

  // 高亮层
  if (highlights) {
    for (const idx of highlights) {
      const i = idx % size;
      const j = Math.floor(idx / size);
      const r = svgRect(
        pos(i) - stoneR,
        pos(j) - stoneR,
        stoneR * 2,
        stoneR * 2,
        'none',
        'var(--warn)',
        2.5,
      );
      r.setAttribute('rx', '4');
      svg.append(r);
    }
  }

  // 棋子与点击层
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = j * size + i;
      const cx = pos(i);
      const cy = pos(j);
      const label = labels ? labels[idx] : 0;
      if (label === BLACK) {
        svg.append(stone(cx, cy, stoneR, '#1f1d1b', '#555'));
      } else if (label === WHITE) {
        svg.append(stone(cx, cy, stoneR, '#f6f3ec', '#9a9388'));
      } else if (label === UNKNOWN) {
        const c = svgCircle(cx, cy, stoneR, 'rgba(201,162,39,0.35)');
        c.setAttribute('stroke', 'var(--unknown)');
        c.setAttribute('stroke-width', '2');
        c.setAttribute('stroke-dasharray', '4 3');
        svg.append(c);
        const q = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        q.setAttribute('x', String(cx));
        q.setAttribute('y', String(cy + 6));
        q.setAttribute('text-anchor', 'middle');
        q.setAttribute('font-size', String(stoneR * 1.1));
        q.setAttribute('fill', 'var(--unknown)');
        q.textContent = '?';
        svg.append(q);
      }
      if (onCellClick) {
        const hit = svgCircle(cx, cy, pitch * 0.5, 'transparent');
        hit.addEventListener('click', () => onCellClick(idx));
        svg.append(hit);
      }
    }
  }
  return svg;
}

function svgRect(x: number, y: number, w: number, h: number, fill: string, stroke?: string, sw?: number): SVGRectElement {
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(w));
  r.setAttribute('height', String(h));
  r.setAttribute('fill', fill);
  if (stroke) r.setAttribute('stroke', stroke);
  if (sw) r.setAttribute('stroke-width', String(sw));
  return r;
}

function svgLine(x1: number, y1: number, x2: number, y2: number): SVGLineElement {
  const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  l.setAttribute('x1', String(x1));
  l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2));
  l.setAttribute('y2', String(y2));
  l.setAttribute('stroke', 'var(--board-line)');
  l.setAttribute('stroke-width', '1.2');
  return l;
}

function svgCircle(cx: number, cy: number, r: number, fill: string): SVGCircleElement {
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', String(cx));
  c.setAttribute('cy', String(cy));
  c.setAttribute('r', String(r));
  c.setAttribute('fill', fill);
  return c;
}

function stone(cx: number, cy: number, r: number, fill: string, stroke: string): SVGCircleElement {
  const c = svgCircle(cx, cy, r, fill);
  c.setAttribute('stroke', stroke);
  c.setAttribute('stroke-width', '1');
  // 简单高光
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'radialGradient');
  const id = `g-${Math.round(cx)}-${Math.round(cy)}-${fill.replace('#', '')}`;
  grad.setAttribute('id', id);
  const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', fill);
  const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', fill === '#1f1d1b' ? '#000' : '#d8d2c4');
  grad.append(stop1, stop2);
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.append(grad);
  c.setAttribute('fill', `url(#${id})`);
  const wrap = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  wrap.append(defs, c);
  return wrap as unknown as SVGCircleElement;
}

export function legend(): HTMLElement {
  return el(
    'div',
    { class: 'legend' },
    el('span', { class: 'lg-black' }, '黑子'),
    el('span', { class: 'lg-white' }, '白子'),
    el('span', { class: 'lg-unknown' }, '未知（遮挡/反光，待裁决）'),
  );
}
