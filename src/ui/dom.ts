// DOM 构造辅助与通用小组件
import type { CellLabel } from '../core/types';
import { BLACK, WHITE, EMPTY, UNKNOWN } from '../core/types';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | EventListener> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, v as string);
    }
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = el('div', { class: 'toast' }, message);
  document.body.append(t);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.remove(), 2600);
}

export function labelClass(label: CellLabel): string {
  if (label === BLACK) return 'black';
  if (label === WHITE) return 'white';
  if (label === UNKNOWN) return 'unknown';
  return 'empty';
}

export { BLACK, WHITE, EMPTY, UNKNOWN };
