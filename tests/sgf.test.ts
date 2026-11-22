import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameToSgf, parseSgf } from '../src/core/sgf';
import { BLACK, WHITE, type GameRecord } from '../src/core/types';

test('SGF 序列化包含核心属性与落子', () => {
  const game: GameRecord = {
    id: 'g1',
    name: '测试对局',
    createdAt: Date.UTC(2026, 10, 22),
    boardSize: 9,
    moves: [
      { color: BLACK, x: 2, y: 2 },
      { color: WHITE, x: 6, y: 6 },
      { color: BLACK, x: -1, y: -1, pass: true },
    ],
    initialStones: new Array(81).fill(0),
    photoIds: [],
    komi: 7.5,
  };
  const sgf = gameToSgf(game);
  assert.ok(sgf.includes('GM[1]'));
  assert.ok(sgf.includes('SZ[9]'));
  assert.ok(sgf.includes('KM[7.5]'));
  assert.ok(sgf.includes(';B[cc]'));
  assert.ok(sgf.includes(';W[gg]'));
  assert.ok(sgf.includes(';B[]')); // pass
});

test('SGF 解析回读与序列化一致', () => {
  const game: GameRecord = {
    id: 'g2',
    name: 'roundtrip',
    createdAt: Date.UTC(2026, 0, 1),
    boardSize: 13,
    moves: [
      { color: BLACK, x: 3, y: 5 },
      { color: WHITE, x: 9, y: 11 },
    ],
    initialStones: new Array(169).fill(0),
    photoIds: [],
    komi: 6.5,
  };
  const sgf = gameToSgf(game);
  const parsed = parseSgf(sgf);
  assert.equal(parsed.boardSize, 13);
  assert.equal(parsed.komi, 6.5);
  assert.equal(parsed.moves.length, 2);
  assert.deepEqual(parsed.moves[0], { color: BLACK, x: 3, y: 5 });
  assert.deepEqual(parsed.moves[1], { color: WHITE, x: 9, y: 11 });
});

test('让子初始子用 AB/AW 写出并回读', () => {
  const initial = new Array(81).fill(0);
  initial[20] = BLACK;
  initial[40] = WHITE;
  const game: GameRecord = {
    id: 'g3',
    name: 'handicap',
    createdAt: Date.UTC(2026, 0, 1),
    boardSize: 9,
    moves: [],
    initialStones: initial,
    photoIds: [],
    komi: 0.5,
  };
  const sgf = gameToSgf(game);
  assert.ok(sgf.includes('AB['));
  assert.ok(sgf.includes('AW['));
  const parsed = parseSgf(sgf);
  assert.equal(parsed.initialStones[20], BLACK);
  assert.equal(parsed.initialStones[40], WHITE);
});
