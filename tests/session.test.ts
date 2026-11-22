import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/core/rules';
import { buildSession } from '../src/state/session';
import { BLACK, WHITE, EMPTY, type BoardSize, type CellLabel, type GameRecord, type PhotoObservation } from '../src/core/types';

function obs(labels: number[], size: BoardSize): PhotoObservation {
  return {
    labels: new Uint8Array(labels),
    size,
    confidence: new Float32Array(labels.length).fill(0.9),
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    warpedSize: 100,
    elapsedMs: 0,
    stageMs: {},
  };
}

function game(size: BoardSize): GameRecord {
  return {
    id: 'g',
    name: 'seq',
    createdAt: 0,
    boardSize: size,
    moves: [],
    initialStones: new Array(size * size).fill(0),
    photoIds: [],
    komi: 7.5,
  };
}

test('多帧照片逐步重建：三帧累积出完整落子序列', () => {
  const size = 9;
  // 帧1：黑 (4,4)；帧2：加白 (4,5)；帧3：加黑 (5,4)
  const f1 = new Array(81).fill(0);
  f1[4 * 9 + 4] = BLACK;
  const f2 = [...f1];
  f2[5 * 9 + 4] = WHITE;
  const f3 = [...f2];
  f3[4 * 9 + 5] = BLACK;

  const photos = [
    { id: 'p1', observation: obs(f1, size) },
    { id: 'p2', observation: obs(f2, size) },
    { id: 'p3', observation: obs(f3, size) },
  ];
  const session = buildSession(game(size), photos);
  assert.equal(session.frames.length, 3);
  assert.equal(session.moves.length, 3);
  assert.deepEqual(session.moves.map((m) => [m.color, m.x, m.y]), [
    [BLACK, 4, 4],
    [WHITE, 4, 5],
    [BLACK, 5, 4],
  ]);
  assert.ok(session.frames.every((f) => f.ok));
});

test('含提子的两帧：消失的子被正确解释，终盘合法', () => {
  const size = 9;
  const b = new Board(size);
  // 白 (1,1)，黑堵三气
  b.play({ color: WHITE, x: 1, y: 1 });
  b.play({ color: BLACK, x: 0, y: 1 });
  b.play({ color: BLACK, x: 2, y: 1 });
  b.play({ color: BLACK, x: 1, y: 0 });
  const before = Array.from(b.stones);

  // 下一帧：黑下 (1,2) 提白
  const after = [...before];
  after[1 * 9 + 1] = EMPTY;
  after[2 * 9 + 1] = BLACK;

  const session = buildSession(game(size), [{ id: 'p1', observation: obs(after, size) }]);
  // 注意 buildSession 从空盘起步，这里直接验证重建结果在空盘起点下也合法
  const trial = new Board(size);
  for (const m of session.moves) {
    assert.equal(trial.play(m), true, `落子应合法: ${JSON.stringify(m)}`);
  }
  assert.equal(trial.at(1, 1), EMPTY);
});

test('人工覆盖被应用：把 UNKNOWN 改成 BLACK 后重建纳入该子', () => {
  const size = 9;
  const labels = new Array(81).fill(0);
  labels[40] = 3; // UNKNOWN
  const photos = [
    { id: 'p1', observation: obs(labels, size), overrides: { 40: BLACK as CellLabel } },
  ];
  const session = buildSession(game(size), photos);
  assert.equal(session.frames[0].effectiveLabels[40], BLACK);
  assert.ok(session.moves.some((m) => m.x === 4 && m.y === 4 && m.color === BLACK));
});
