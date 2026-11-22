import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../src/core/rules';
import { reconstructBetween, missingMoveCandidates } from '../src/core/reconstruction';
import { BLACK, WHITE, EMPTY, UNKNOWN, type BoardSize, type PhotoObservation } from '../src/core/types';

function obsFromLabels(labels: number[], size: BoardSize): PhotoObservation {
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

test('单帧新增一子：重建出对应落子', () => {
  const board = new Board(9);
  const labels = new Array(81).fill(0);
  labels[22] = BLACK; // (4,2)
  const result = reconstructBetween(board, obsFromLabels(labels, 9), BLACK);
  assert.ok(result.reconstructions.length > 0);
  const moves = result.reconstructions[0].moves;
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0], { color: BLACK, x: 4, y: 2 });
  assert.equal(result.contradictions.length, 0);
});

test('提子场景：白子被围后消失，重建含合法提子序列', () => {
  const board = new Board(9);
  // 构造白单子在 (1,1)，黑已堵三气
  board.play({ color: WHITE, x: 1, y: 1 });
  board.play({ color: BLACK, x: 0, y: 1 });
  board.play({ color: BLACK, x: 2, y: 1 });
  board.play({ color: BLACK, x: 1, y: 0 });
  const labels = new Array(81).fill(0);
  // 终盘：白消失，黑落在 (1,2)，其余黑子保留
  labels[1 * 9 + 0] = BLACK;
  labels[1 * 9 + 2] = BLACK;
  labels[0 * 9 + 1] = BLACK;
  labels[2 * 9 + 1] = BLACK;
  const result = reconstructBetween(board, obsFromLabels(labels, 9), BLACK);
  assert.ok(result.reconstructions.length > 0);
  const trial = board.clone();
  for (const m of result.reconstructions[0].moves) assert.equal(trial.play(m), true);
  assert.equal(trial.at(1, 1), EMPTY);
});

test('UNKNOWN 通配点不产生矛盾', () => {
  const board = new Board(9);
  const labels = new Array(81).fill(0);
  labels[10] = UNKNOWN; // 任意遮挡点
  labels[22] = BLACK;
  const result = reconstructBetween(board, obsFromLabels(labels, 9), BLACK);
  assert.equal(result.contradictions.length, 0);
  assert.ok(result.reconstructions.length > 0);
});

test('两帧间多子：按黑白交替排出合法顺序', () => {
  const board = new Board(9);
  const labels = new Array(81).fill(0);
  labels[4 * 9 + 4] = BLACK;
  labels[4 * 9 + 5] = WHITE;
  const result = reconstructBetween(board, obsFromLabels(labels, 9), BLACK);
  assert.ok(result.reconstructions.length > 0);
  const moves = result.reconstructions[0].moves;
  assert.equal(moves.length, 2);
  assert.equal(moves[0].color, BLACK);
  assert.equal(moves[1].color, WHITE);
});

test('missingMoveCandidates：回到相同盘面的往返序列', () => {
  const board = new Board(9);
  board.play({ color: BLACK, x: 4, y: 4 });
  board.play({ color: WHITE, x: 4, y: 5 });
  const cands = missingMoveCandidates(board, BLACK, 2);
  // 至少不抛错；能找到方案时终盘应与起始一致
  for (const c of cands) {
    const trial = board.clone();
    for (const m of c.moves) trial.play(m);
    assert.deepEqual(Array.from(trial.stones), Array.from(board.stones));
  }
});
