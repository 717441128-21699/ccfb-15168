// 样例场景库：随机生成带提子的对局（多为残局形态），
// 再按灯光 × 干扰（反光/手/错位/组合）展开成可渲染的样本定义。
import { Rng } from '../src/core/rng';
import { Board, opposite } from '../src/core/rules';
import { BLACK, WHITE, type BoardSize, type Move, type StoneColor } from '../src/core/types';
import {
  LIGHTING_PRESETS,
  randomQuad,
  type GlareConfig,
  type HandConfig,
  type LightingConfig,
  type Quad,
  type RenderConfig,
} from '../src/synth/scene';

export interface GameScenario {
  id: string;
  size: BoardSize;
  moves: Move[];
  /** 每个快照对应的已落子手数 */
  snapshotPlies: number[];
  seed: number;
}

export type ArtifactKind = 'clean' | 'glare' | 'hand' | 'misplace' | 'hard';

export interface SampleSpec {
  id: string;
  scenarioId: string;
  lighting: string;
  artifact: ArtifactKind;
  ply: number;
  stones: Map<number, StoneColor>;
  truth: Uint8Array;
  size: BoardSize;
  quad: Quad;
  glare?: GlareConfig;
  hand?: HandConfig;
  misplaceRatio: number;
  noiseLevel: number;
  seed: number;
  /** 该样本中被手遮挡的交点（渲染后才能精确知道，先给期望区域） */
  handHint?: { u: number; v: number };
}

/** 生成一盘接近残局的随机对局（含提子、少量 pass） */
export function generateGame(id: string, size: BoardSize, rng: Rng, targetPly: number): GameScenario {
  const board = new Board(size);
  const moves: Move[] = [];
  let color: StoneColor = BLACK;
  let consecutivePass = 0;
  let legalStreak = 0;

  while (moves.length < targetPly && consecutivePass < 2) {
    const candidates = legalMovesNear(board, rng, color);
    if (candidates.length === 0 || (legalStreak > 12 && rng.next() < 0.03)) {
      moves.push({ color, x: -1, y: -1, pass: true });
      consecutivePass++;
      color = opposite(color);
      continue;
    }
    consecutivePass = 0;
    const { x, y } = pickWeightedMove(board, candidates, color, rng);
    const trial = board.clone();
    if (!trial.play({ x, y, color })) continue;
    board.play({ x, y, color });
    moves.push({ x, y, color });
    color = opposite(color);
    legalStreak++;
  }

  // 快照：均匀取 5 个时刻，覆盖从开局到残局
  const snapshots = new Set<number>();
  const count = 5;
  for (let k = 1; k <= count; k++) {
    snapshots.add(Math.max(1, Math.round((moves.length * k) / count)));
  }
  return {
    id,
    size,
    moves,
    snapshotPlies: [...snapshots].sort((a, b) => a - b),
    seed: rng.int(1, 1e9),
  };
}

function legalMovesNear(board: Board, rng: Rng, color: StoneColor): Array<{ x: number; y: number }> {
  const hasStone = board.stones.some((v) => v !== 0);
  const out: Array<{ x: number; y: number }> = [];
  if (!hasStone) {
    const c = Math.floor(board.size / 2);
    const around = [
      [c, c],
      [c - 2, c + 1],
      [c + 1, c - 2],
    ];
    for (const [x, y] of around) out.push({ x, y });
    return out;
  }
  // 仅在已有棋子两格范围内选点，模拟真实对局的连贯落子
  const seen = new Set<number>();
  for (let idx = 0; idx < board.stones.length; idx++) {
    if (board.stones[idx] === 0) continue;
    const sx = idx % board.size;
    const sy = Math.floor(idx / board.size);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= board.size || y >= board.size) continue;
        const i = board.idx(x, y);
        if (board.stones[i] !== 0 || seen.has(i)) continue;
        if (board.isLegal(x, y, color)) {
          seen.add(i);
          out.push({ x, y });
        }
      }
    }
  }
  // 少量随机探索，避免棋局缩成一团
  if (rng.next() < 0.12) {
    for (let tries = 0; tries < 8; tries++) {
      const x = rng.int(1, board.size - 2);
      const y = rng.int(1, board.size - 2);
      if (board.stones[board.idx(x, y)] === 0 && board.isLegal(x, y, color)) {
        out.push({ x, y });
        break;
      }
    }
  }
  return out;
}

/** 偏好能提子/紧气/守角的走法 */
function pickWeightedMove(
  board: Board,
  cands: Array<{ x: number; y: number }>,
  color: StoneColor,
  rng: Rng,
): { x: number; y: number } {
  const weighted = cands.map((c) => {
    const trial = board.clone();
    const before = trial.captures[color];
    trial.play({ ...c, color });
    const captured = trial.captures[color] - before;
    const group = trial.groupAt(c.x, c.y);
    let w = 1 + captured * 6 + Math.max(0, 3 - group.liberties) * 1.4;
    // 三三/星位附近略加权
    const edge = Math.min(c.x, c.y, board.size - 1 - c.x, board.size - 1 - c.y);
    if (edge <= 3) w *= 1.1;
    return { ...c, w };
  });
  const total = weighted.reduce((s, d) => s + d.w, 0);
  let r = rng.next() * total;
  for (const d of weighted) {
    r -= d.w;
    if (r <= 0) return { x: d.x, y: d.y };
  }
  return weighted[0];
}

/** 重放到指定手数的棋盘 */
export function boardAtPly(scenario: GameScenario, ply: number): Board {
  const board = new Board(scenario.size);
  for (let i = 0; i < Math.min(ply, scenario.moves.length); i++) {
    const m = scenario.moves[i];
    if (!m.pass) board.play(m);
  }
  return board;
}

function buildGlare(rng: Rng): GlareConfig {
  return {
    u: rng.range(0.2, 0.8),
    v: rng.range(0.2, 0.8),
    radius: rng.range(0.09, 0.2),
    strength: rng.range(0.55, 0.95),
  };
}

function buildHand(rng: Rng, _size: BoardSize): HandConfig {
  // 从棋盘边缘伸入，盖住 1~4 个交点
  const edge = rng.int(0, 3);
  let u = 0;
  let v = 0;
  let angle = 0;
  const t = rng.range(0.15, 0.85);
  if (edge === 0) {
    u = t;
    v = rng.range(0.02, 0.12);
    angle = Math.PI / 2 + rng.gaussian(0, 0.3);
  } else if (edge === 1) {
    u = rng.range(0.88, 0.98);
    v = t;
    angle = Math.PI + rng.gaussian(0, 0.3);
  } else if (edge === 2) {
    u = t;
    v = rng.range(0.88, 0.98);
    angle = -Math.PI / 2 + rng.gaussian(0, 0.3);
  } else {
    u = rng.range(0.02, 0.12);
    v = t;
    angle = rng.gaussian(0, 0.3);
  }
  const tones: Array<[number, number, number]> = [
    [222, 178, 145],
    [196, 142, 108],
    [238, 198, 168],
    [168, 116, 86],
  ];
  return {
    u,
    v,
    angle,
    radiusRatio: rng.range(0.028, 0.05),
    lengthRatio: rng.range(0.32, 0.55),
    skinTone: rng.pick(tones),
  };
}

/**
 * 展开全部样本定义。
 * 每个对局快照 × 3 种灯光，再分别叠加 clean/glare/hand/misplace/hard 干扰。
 */
export function buildSampleSpecs(
  scenarios: GameScenario[],
  rng: Rng,
  W: number,
  H: number,
): SampleSpec[] {
  const specs: SampleSpec[] = [];
  const lightings = Object.values(LIGHTING_PRESETS);

  for (const sc of scenarios) {
    for (const ply of sc.snapshotPlies) {
      const board = boardAtPly(sc, ply);
      const stones = new Map<number, StoneColor>();
      const truth = new Uint8Array(sc.size * sc.size);
      for (let i = 0; i < board.stones.length; i++) {
        if (board.stones[i] !== 0) {
          stones.set(i, board.stones[i] as StoneColor);
          truth[i] = board.stones[i];
        }
      }
      for (const lighting of lightings) {
        const quad = randomQuad(W, H, rng);
        const base: Omit<SampleSpec, 'id' | 'lighting' | 'artifact' | 'glare' | 'hand' | 'misplaceRatio' | 'handHint'> = {
          scenarioId: sc.id,
          ply,
          stones,
          truth,
          size: sc.size,
          quad,
          noiseLevel: rng.range(2.5, 6),
          seed: rng.int(1, 1e9),
        };
        const add = (artifact: ArtifactKind, extra: Partial<SampleSpec>): void => {
          specs.push({
            ...base,
            id: `${sc.id}-p${ply}-${lighting.name}-${artifact}`,
            lighting: lighting.name,
            artifact,
            misplaceRatio: 0,
            ...extra,
          });
        };
        add('clean', {});
        add('glare', { glare: buildGlare(rng) });
        const hand = buildHand(rng, sc.size);
        add('hand', { hand, handHint: { u: hand.u, v: hand.v } });
        add('misplace', { misplaceRatio: 0.5 });
        add('hard', {
          glare: buildGlare(rng),
          hand: buildHand(rng, sc.size),
          misplaceRatio: 0.35,
          noiseLevel: 7,
        });
      }
    }
  }
  return specs;
}

export function specToRenderConfig(
  spec: SampleSpec,
  lighting: LightingConfig,
  width: number,
  height: number,
  ssaa: number,
): RenderConfig {
  return {
    size: spec.size,
    stones: spec.stones,
    width,
    height,
    quad: spec.quad,
    seed: spec.seed,
    lighting,
    glare: spec.glare,
    hand: spec.hand,
    misplaceRatio: spec.misplaceRatio,
    noiseLevel: spec.noiseLevel,
    ssaa,
  };
}

export { BLACK, WHITE };
