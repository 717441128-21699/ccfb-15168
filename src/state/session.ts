// 会话编排：把一串照片观察组合成完整落子序列。
// 职责：应用人工覆盖 -> 相邻帧间落子重建（含提子/漏拍候选）-> 维护确定盘面。
import {
  BLACK,
  WHITE,
  EMPTY,
  UNKNOWN,
  type BoardSize,
  type Cell,
  type CellLabel,
  type GameRecord,
  type Move,
  type PhotoObservation,
  type Reconstruction,
  type StoneColor,
} from '../core/types';
import { Board, opposite } from '../core/rules';
import { reconstructBetween, missingMoveCandidates } from '../core/reconstruction';

export interface FrameState {
  photoId: string;
  observation: PhotoObservation;
  overrides: Record<number, CellLabel>;
  /** 本帧生效标签（观察 + 覆盖） */
  effectiveLabels: Uint8Array;
  /** 与上一帧之间重建出的落子 */
  intervalMoves: Move[];
  /** 漏拍时的候选方案（老师可选） */
  candidates: Reconstruction[];
  /** 无法解释的矛盾点 */
  contradictions: number[];
  /** 重建是否可信（无矛盾且有解） */
  ok: boolean;
}

export interface Session {
  game: GameRecord;
  frames: FrameState[];
  /** 累计落子（所有帧区间拼接） */
  moves: Move[];
}

/** 合并人工覆盖到观察标签 */
export function applyOverrides(
  obs: PhotoObservation,
  overrides: Record<number, CellLabel>,
): Uint8Array {
  const labels = new Uint8Array(obs.labels);
  for (const [k, v] of Object.entries(overrides)) labels[Number(k)] = v;
  return labels;
}

/** 把帧标签包装成 PhotoObservation 供重建使用 */
function asObservation(labels: Uint8Array, size: BoardSize, base: PhotoObservation): PhotoObservation {
  return { ...base, labels, size };
}

/**
 * 逐帧重建整个会话。
 * 第一帧之前的盘面按空盘处理（让子场景可从 game.initialStones 起步）。
 */
export function buildSession(
  game: GameRecord,
  photos: Array<{ id: string; observation?: PhotoObservation; overrides?: Record<number, CellLabel> }>,
): Session {
  const size = game.boardSize;
  const frames: FrameState[] = [];
  const moves: Move[] = [];
  let board = new Board(size, new Uint8Array(game.initialStones));
  let colorToMove: StoneColor = BLACK;

  for (const photo of photos) {
    if (!photo.observation) continue;
    const overrides = photo.overrides ?? {};
    const effectiveLabels = applyOverrides(photo.observation, overrides);
    const obs = asObservation(effectiveLabels, size, photo.observation);

    const result = reconstructBetween(board, obs, colorToMove, { topK: 3 });
    const chosen = result.reconstructions[0];
    const intervalMoves = chosen ? chosen.moves : [];

    // 在棋盘副本上重放本区间，得到新确定盘面
    const nextBoard = board.clone();
    let replayOk = true;
    for (const m of intervalMoves) {
      if (!nextBoard.play(m)) {
        replayOk = false;
        break;
      }
    }

    const frame: FrameState = {
      photoId: photo.id,
      observation: photo.observation,
      overrides,
      effectiveLabels,
      intervalMoves,
      candidates: result.reconstructions,
      contradictions: result.contradictions.map((p) => p.y * size + p.x),
      ok: replayOk && result.contradictions.length === 0 && result.reconstructions.length > 0,
    };
    frames.push(frame);
    moves.push(...intervalMoves);
    if (intervalMoves.length > 0) {
      const last = intervalMoves[intervalMoves.length - 1];
      colorToMove = opposite(last.color);
    }
    board = nextBoard;
  }

  return { game, frames, moves };
}

/** 老师在某帧选择了某个候选方案：重算该帧之后的所有区间 */
export function chooseCandidate(
  session: Session,
  frameIndex: number,
  candidateIndex: number,
): Session {
  const frame = session.frames[frameIndex];
  if (!frame || !frame.candidates[candidateIndex]) return session;
  // 候选选择通过修改 game.moves 无法持久化区间差异，这里直接替换并重排
  const newFrames = session.frames.map((f, i) =>
    i === frameIndex
      ? { ...f, intervalMoves: frame.candidates[candidateIndex].moves }
      : f,
  );
  const moves: Move[] = [];
  for (const f of newFrames) moves.push(...f.intervalMoves);
  return { ...session, frames: newFrames, moves };
}

/** 漏拍候选：两帧盘面相同但中间欠了手数时，生成回到同盘面的短序列 */
export function suggestMissingMoves(
  board: Board,
  colorToMove: StoneColor,
  plies: number,
): Reconstruction[] {
  return missingMoveCandidates(board, colorToMove, plies);
}

/** 当前确定盘面（重放全部落子） */
export function currentBoard(moves: Move[], size: BoardSize, initial?: Cell[]): Board {
  const board = new Board(size, initial ? new Uint8Array(initial) : undefined);
  for (const m of moves) if (!m.pass) board.play(m);
  return board;
}

export function labelName(label: CellLabel): string {
  return label === EMPTY ? '空' : label === BLACK ? '黑' : label === WHITE ? '白' : '未知';
}

export { UNKNOWN };
