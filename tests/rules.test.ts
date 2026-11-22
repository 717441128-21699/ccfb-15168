import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board, opposite, diffBoards, replay } from '../src/core/rules';
import { BLACK, WHITE, EMPTY, type BoardSize, type Move } from '../src/core/types';

test('落子与基本占盘', () => {
  const b = new Board(9);
  assert.equal(b.play({ color: BLACK, x: 4, y: 4 }), true);
  assert.equal(b.at(4, 4), BLACK);
  assert.equal(b.play({ color: BLACK, x: 4, y: 4 }), false); // 占用点非法
});

test('提子：围住单子后移除', () => {
  const b = new Board(9);
  // 白棋下在 (1,1)，黑棋堵其四气
  b.play({ color: WHITE, x: 1, y: 1 });
  b.play({ color: BLACK, x: 0, y: 1 });
  b.play({ color: BLACK, x: 2, y: 1 });
  b.play({ color: BLACK, x: 1, y: 0 });
  assert.equal(b.at(1, 1), WHITE);
  b.play({ color: BLACK, x: 1, y: 2 });
  assert.equal(b.at(1, 1), EMPTY); // 被提
  assert.equal(b.captures[BLACK], 1);
});

test('自杀手非法并回滚', () => {
  const b = new Board(9);
  // 黑棋围出 (0,0) 的三侧，白下进去无气
  b.play({ color: BLACK, x: 1, y: 0 });
  b.play({ color: BLACK, x: 0, y: 1 });
  assert.equal(b.play({ color: WHITE, x: 0, y: 0 }), false);
  assert.equal(b.at(0, 0), EMPTY);
});

test('opposite 颜色翻转', () => {
  assert.equal(opposite(BLACK), WHITE);
  assert.equal(opposite(WHITE), BLACK);
});

test('diffBoards 识别新增与消失', () => {
  const before = new Uint8Array([0, 0, 0, 0]);
  const after = new Uint8Array([BLACK, 0, WHITE, 0]);
  const diff = diffBoards(before, after, 2);
  assert.equal(diff.added.length, 2);
  assert.equal(diff.removed.length, 0);
});

test('replay 重放一串合法落子得到终盘', () => {
  const moves: Move[] = [
    { color: BLACK, x: 2, y: 2 },
    { color: WHITE, x: 6, y: 6 },
    { color: BLACK, x: 3, y: 2 },
    { color: WHITE, pass: true, x: -1, y: -1 },
  ];
  const board = replay(moves, 9 as BoardSize);
  assert.equal(board.at(2, 2), BLACK);
  assert.equal(board.at(6, 6), WHITE);
  assert.equal(board.at(3, 2), BLACK);
});
