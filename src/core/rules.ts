// 围棋规则引擎：落子、提子、合法性、盘面比较。
// 只依赖 types，浏览器与 Node 测试共用。
import { BLACK, WHITE, EMPTY, type BoardSize, type Cell, type Move, type Point, type StoneColor } from './types';

export function opposite(color: StoneColor): StoneColor {
  return color === BLACK ? WHITE : BLACK;
}

export class Board {
  readonly size: number;
  /** 行优先，长度 size*size */
  stones: Uint8Array;
  /** 已发生的提子总数（黑提、白提） */
  captures: Record<number, number>;

  constructor(size: BoardSize, stones?: Uint8Array) {
    this.size = size;
    this.stones = stones ? new Uint8Array(stones) : new Uint8Array(size * size);
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }

  at(x: number, y: number): Cell {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return EMPTY;
    return this.stones[this.idx(x, y)] as Cell;
  }

  set(x: number, y: number, v: Cell): void {
    this.stones[this.idx(x, y)] = v;
  }

  clone(): Board {
    const b = new Board(this.size as BoardSize, this.stones);
    b.captures = { ...this.captures };
    return b;
  }

  neighbors(x: number, y: number): Point[] {
    const out: Point[] = [];
    if (x > 0) out.push({ x: x - 1, y });
    if (x < this.size - 1) out.push({ x: x + 1, y });
    if (y > 0) out.push({ x, y: y - 1 });
    if (y < this.size - 1) out.push({ x, y: y + 1 });
    return out;
  }

  /** 求 (x,y) 所在串的全部坐标与气数 */
  groupAt(x: number, y: number): { stones: Point[]; liberties: number } {
    const color = this.at(x, y);
    const seen = new Uint8Array(this.size * this.size);
    const stack: Point[] = [{ x, y }];
    const stones: Point[] = [];
    const libSet = new Set<number>();
    seen[this.idx(x, y)] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      stones.push(p);
      for (const n of this.neighbors(p.x, p.y)) {
        const ni = this.idx(n.x, n.y);
        const v = this.stones[ni];
        if (v === EMPTY) {
          libSet.add(ni);
        } else if (v === color && !seen[ni]) {
          seen[ni] = 1;
          stack.push(n);
        }
      }
    }
    return { stones, liberties: libSet.size };
  }

  /**
   * 尝试落子，返回是否合法；合法时就地更新棋盘（含提子）。
   * 自杀手不允许（让子/默认中国规则习惯），pass 永远合法。
   */
  play(move: Move): boolean {
    if (move.pass) return true;
    const { x, y, color } = move;
    if (this.at(x, y) !== EMPTY) return false;
    this.set(x, y, color);
    const foe = opposite(color);
    let captured = 0;
    // 先提对方无气串
    const checked = new Set<number>();
    for (const n of this.neighbors(x, y)) {
      if (this.at(n.x, n.y) !== foe) continue;
      const ni = this.idx(n.x, n.y);
      if (checked.has(ni)) continue;
      const group = this.groupAt(n.x, n.y);
      group.stones.forEach((s) => checked.add(this.idx(s.x, s.y)));
      if (group.liberties === 0) {
        for (const s of group.stones) {
          this.set(s.x, s.y, EMPTY);
          captured++;
        }
      }
    }
    // 再检查自身气（自杀非法，回滚）
    const self = this.groupAt(x, y);
    if (self.liberties === 0) {
      // 回滚
      this.set(x, y, EMPTY);
      return false;
    }
    this.captures[color] += captured;
    return true;
  }

  /** 不落子的合法性检查（用于候选排序） */
  isLegal(x: number, y: number, color: StoneColor): boolean {
    if (this.at(x, y) !== EMPTY) return false;
    const trial = this.clone();
    return trial.play({ x, y, color });
  }

  equals(other: Board): boolean {
    if (other.size !== this.size) return false;
    for (let i = 0; i < this.stones.length; i++) {
      if (this.stones[i] !== other.stones[i]) return false;
    }
    return true;
  }
}

/** 两盘面差异：added 为 B 相对 A 多出的子，removed 为消失的子 */
export interface BoardDiff {
  added: Point[];
  removed: Point[];
}

export function diffBoards(
  before: Uint8Array,
  after: Uint8Array,
  size: number,
): BoardDiff {
  const added: Point[] = [];
  const removed: Point[] = [];
  for (let i = 0; i < size * size; i++) {
    const a = before[i];
    const b = after[i];
    if (a === b) continue;
    const x = i % size;
    const y = Math.floor(i / size);
    if (a === EMPTY && b !== EMPTY) added.push({ x, y });
    else if (a !== EMPTY && b === EMPTY) removed.push({ x, y });
    else added.push({ x, y }); // 颜色翻转（理论上不应出现，标记为新增交由重建处理）
  }
  return { added, removed };
}

/** 按一串 move 重放，返回最终棋盘；中途非法抛错（由调用方保证候选合法） */
export function replay(moves: Move[], size: BoardSize, initial?: Uint8Array): Board {
  const board = new Board(size, initial);
  for (const m of moves) {
    if (!board.play(m)) {
      throw new Error(`非法落子: ${m.color === BLACK ? 'B' : 'W'} (${m.x},${m.y})`);
    }
  }
  return board;
}

/** 坐标转 SGF 字母（0->a，跳过 'i' 是老式约定，SGF 标准实际不跳，这里按标准不跳） */
export function sgfCoord(v: number): string {
  return String.fromCharCode(97 + v);
}
