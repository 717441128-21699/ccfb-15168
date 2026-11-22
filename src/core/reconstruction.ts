// 两帧之间的落子重建：
// 已知前一帧确定盘面 + 当前帧观察（含 UNKNOWN 通配点），
// 搜索一组合法落子（自动处理提子），使终盘与观察一致；
// 搜索给出多个候选方案，供老师在漏拍时选择。
import {
  BLACK,
  WHITE,
  EMPTY,
  UNKNOWN,
  type BoardSize,
  type Move,
  type PhotoObservation,
  type Point,
  type Reconstruction,
  type ReconstructionResult,
  type StoneColor,
} from './types';
import { Board, opposite } from './rules';

interface RequiredAdd {
  idx: number;
  color: StoneColor;
}

export interface ReconstructOptions {
  /** 允许的“看不见的补手”上限（漏拍手数） */
  maxFiller?: number;
  /** 搜索节点预算 */
  nodeBudget?: number;
  /** 返回候选方案数 */
  topK?: number;
}

interface SearchContext {
  size: number;
  requiredAdds: RequiredAdd[];
  requiredEmpty: Set<number>; // 观察中由有子变空（提子）的点
  wildcards: Set<number>;
  observedColor: Int8Array; // 当前帧已知颜色，UNKNOWN 用 -1
  maxDepth: number;
  nodeBudget: number;
  topK: number;
  solutions: Map<string, Reconstruction>;
  nodes: number;
  contradictions: Point[];
}

function boardKey(board: Board, color: StoneColor): string {
  // 位置超紧气（simple ko）去重：盘面 + 行棋方
  return `${color}:${Array.from(board.stones).join('')}`;
}

/** 候选补手：与已有棋子距离 <=2 的空点 + 通配点，按进攻性排序 */
function fillerCandidates(board: Board, ctx: SearchContext): number[] {
  const cand = new Set<number>();
  const { size } = board;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = board.idx(x, y);
      if (board.stones[i] !== EMPTY) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (board.stones[board.idx(nx, ny)] !== EMPTY) {
            near = true;
            break;
          }
        }
      }
      if (near || ctx.wildcards.has(i)) cand.add(i);
    }
  }
  // 优先：能提子 / 紧气的点排在前面，加快找到优解
  return [...cand]
    .map((i) => {
      const x = i % size;
      const y = Math.floor(i / size);
      const trial = board.clone();
      const ok = trial.play({ x, y, color: BLACK }); // 颜色无关的占位试下
      let priority = 0;
      if (ok) {
        priority = trial.captures[BLACK] * 10;
        // 靠近待提点加分
        for (const req of ctx.requiredEmpty) {
          const rx = req % size;
          const ry = Math.floor(req / size);
          if (Math.abs(rx - x) + Math.abs(ry - y) <= 2) priority += 2;
        }
      }
      return { i, priority };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 24)
    .map((d) => d.i);
}

function finalMatches(board: Board, ctx: SearchContext): boolean {
  for (let i = 0; i < board.stones.length; i++) {
    const obs = ctx.observedColor[i];
    if (obs < 0) continue; // 通配点不约束
    if (board.stones[i] !== obs) return false;
  }
  return true;
}

function dfs(
  board: Board,
  color: StoneColor,
  depth: number,
  fillerUsed: number,
  moves: Move[],
  ctx: SearchContext,
  pathPositions: Set<string>,
): void {
  if (ctx.nodes++ > ctx.nodeBudget) return;

  // 终止：所有必落子已下、待提点已空、终盘吻合
  const addsLeft = ctx.requiredAdds.filter((r) => board.stones[r.idx] !== r.color);
  const removalsLeft = [...ctx.requiredEmpty].some((i) => board.stones[i] !== EMPTY);
  if (addsLeft.length === 0 && !removalsLeft && finalMatches(board, ctx)) {
    const key = moves.map((m) => (m.pass ? 'p' : `${m.x},${m.y}`)).join('|');
    if (!ctx.solutions.has(key)) {
      const wildcardCells = ctx.wildcards.size;
      const penalty = fillerUsed * 0.08 + depth * 0.004;
      ctx.solutions.set(key, {
        moves: moves.map((m) => ({ ...m })),
        score: Math.max(0.2, 1 - penalty),
        wildcardCells,
      });
    }
    return;
  }
  if (depth >= ctx.maxDepth) return;

  const key = boardKey(board, color);
  if (pathPositions.has(key)) return; // 简单劫/循环禁止
  pathPositions.add(key);

  const { size } = board;
  // 1) 当前颜色的必落子
  const myRequired = addsLeft.filter((r) => r.color === color);
  const tried = new Set<number>();
  for (const req of myRequired) {
    const x = req.idx % size;
    const y = Math.floor(req.idx / size);
    if (board.stones[req.idx] !== EMPTY) continue; // 还被对方占着，先靠别的手提
    if (tried.has(req.idx)) continue;
    tried.add(req.idx);
    const next = board.clone();
    if (!next.play({ x, y, color })) continue;
    moves.push({ x, y, color });
    dfs(next, opposite(color), depth + 1, fillerUsed, moves, ctx, pathPositions);
    moves.pop();
    if (ctx.nodes > ctx.nodeBudget) break;
  }

  // 2) 没有该色必落子（或必落子暂时被占）-> 补手
  const canFill = fillerUsed < ctx.maxDepth - depth;
  if (canFill && fillerUsed < maxFillerLimit(ctx)) {
    for (const i of fillerCandidates(board, ctx)) {
      if (tried.has(i)) continue;
      const x = i % size;
      const y = Math.floor(i / size);
      const next = board.clone();
      if (!next.play({ x, y, color })) continue;
      moves.push({ x, y, color });
      dfs(next, opposite(color), depth + 1, fillerUsed + 1, moves, ctx, pathPositions);
      moves.pop();
      if (ctx.nodes > ctx.nodeBudget) break;
    }
  }
  pathPositions.delete(key);
}

function maxFillerLimit(ctx: SearchContext): number {
  return ctx.maxDepth - ctx.requiredAdds.length;
}

/**
 * 主入口：从前一帧盘面重建到当前观察之间的落子。
 * @param prevBoard 前一帧（已校对的确定盘面）
 * @param obs 当前帧观察
 * @param colorToMove 当前间隔第一手的颜色
 */
export function reconstructBetween(
  prevBoard: Board,
  obs: PhotoObservation,
  colorToMove: StoneColor,
  options: ReconstructOptions = {},
): ReconstructionResult {
  const size = obs.size;
  const topK = options.topK ?? 3;
  const nodeBudget = options.nodeBudget ?? 25000;
  const maxFiller = options.maxFiller ?? 4;

  const observedColor = new Int8Array(size * size).fill(-1);
  const requiredAdds: RequiredAdd[] = [];
  const requiredEmpty = new Set<number>();
  const wildcards = new Set<number>();
  const contradictions: Point[] = [];

  for (let i = 0; i < size * size; i++) {
    const label = obs.labels[i];
    const before = prevBoard.stones[i];
    const x = i % size;
    const y = Math.floor(i / size);
    if (label === UNKNOWN) {
      wildcards.add(i);
      continue;
    }
    observedColor[i] = label;
    if (before === EMPTY && label !== EMPTY) {
      requiredAdds.push({ idx: i, color: label as StoneColor });
    } else if (before !== EMPTY && label === EMPTY) {
      requiredEmpty.add(i);
    } else if (before !== EMPTY && label !== EMPTY && before !== label) {
      // 颜色直接翻转：必须经过“提掉再落”，登记为先提后落
      requiredEmpty.add(i);
      requiredAdds.push({ idx: i, color: label as StoneColor });
      contradictions.push({ x, y }); // 初判矛盾，若搜索能解释则清除
    }
  }

  // 硬矛盾：必落子点被观察中仍存在的对方子占据且该点不在待提集合
  for (const r of requiredAdds) {
    const occ = prevBoard.stones[r.idx];
    if (occ !== EMPTY && occ !== r.color && !requiredEmpty.has(r.idx)) {
      contradictions.push({ x: r.idx % size, y: Math.floor(r.idx / size) });
    }
  }

  const maxDepth = requiredAdds.length + Math.min(maxFiller, 6) + (requiredEmpty.size ? 2 : 0);
  const ctx: SearchContext = {
    size,
    requiredAdds,
    requiredEmpty,
    wildcards,
    observedColor,
    maxDepth,
    nodeBudget,
    topK,
    solutions: new Map(),
    nodes: 0,
    contradictions,
  };

  dfs(prevBoard.clone(), colorToMove, 0, 0, [], ctx, new Set());

  const reconstructions = [...ctx.solutions.values()]
    .sort((a, b) => b.score - a.score || a.moves.length - b.moves.length)
    .slice(0, topK);

  // 搜索能解释翻转点，则不再视为矛盾
  if (reconstructions.length > 0) {
    ctx.contradictions = ctx.contradictions.filter(
      (p) => !requiredEmpty.has(p.y * size + p.x) || !requiredAdds.some((r) => r.idx === p.y * size + p.x),
    );
  }

  return { reconstructions, contradictions: ctx.contradictions };
}

/**
 * 漏拍场景：两帧观察完全相同（或老师声明中间欠了手数），
 * 生成“离开后回到相同/相近盘面”的候选短序列（典型：打将、劫争往返）。
 */
export function missingMoveCandidates(
  board: Board,
  colorToMove: StoneColor,
  plies: number,
): Reconstruction[] {
  const size = board.size as BoardSize;
  const out: Reconstruction[] = [];
  const startKey = Array.from(board.stones).join('');

  function walk(cur: Board, color: StoneColor, depth: number, moves: Move[]): void {
    if (depth === plies) {
      if (Array.from(cur.stones).join('') === startKey && moves.length > 0) {
        out.push({
          moves: moves.map((m) => ({ ...m })),
          score: Math.max(0.4, 1 - depth * 0.1),
          wildcardCells: 0,
        });
      }
      return;
    }
    const empties: number[] = [];
    for (let i = 0; i < size * size; i++) if (cur.stones[i] === EMPTY) empties.push(i);
    // 限制分支：只看邻接棋子的点
    const near = empties.filter((i) => {
      const x = i % size;
      const y = Math.floor(i / size);
      return cur.neighbors(x, y).some((n) => cur.at(n.x, n.y) !== EMPTY);
    });
    for (const i of near.slice(0, 12)) {
      const x = i % size;
      const y = Math.floor(i / size);
      const next = cur.clone();
      if (!next.play({ x, y, color })) continue;
      moves.push({ x, y, color });
      walk(next, opposite(color), depth + 1, moves);
      moves.pop();
      if (out.length >= 5) return;
    }
  }

  walk(board.clone(), colorToMove, 0, []);
  return out.slice(0, 3);
}

export { BLACK, WHITE };
