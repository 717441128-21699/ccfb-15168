import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/core/rng';
import { renderScene, LIGHTING_PRESETS, randomQuad } from '../src/synth/scene';
import { runPipeline } from '../src/core/pipeline';
import { generateGame, boardAtPly, specToRenderConfig, buildSampleSpecs } from '../tools/scenarios';
import { evaluateLabels } from '../tools/evaluate';
import { UNKNOWN } from '../src/core/types';

test('端到端：合成干净照片识别准确率 >= 99%（可见交点）', () => {
  const rng = new Rng(123);
  const sc = generateGame('e2e', 19, rng, 80);
  const specs = buildSampleSpecs([sc], rng, 560, 420).filter(
    (s) => s.artifact === 'clean' && s.lighting === 'neutral',
  );
  let totalCorrect = 0;
  let totalVisible = 0;
  for (const spec of specs.slice(0, 4)) {
    const cfg = specToRenderConfig(spec, LIGHTING_PRESETS.neutral, 560, 420, 1);
    const scene = renderScene(cfg);
    const obs = runPipeline(scene.image, spec.size, { knownQuad: spec.quad });
    const br = evaluateLabels(scene.truth, obs, scene.occluded);
    totalCorrect += br.correct;
    totalVisible += br.total - scene.occluded.length;
  }
  const acc = totalCorrect / totalVisible;
  assert.ok(acc >= 0.99, `干净照片可见准确率仅 ${acc}`);
});

test('手遮挡照片：遮挡交点应判 UNKNOWN 而非乱猜', () => {
  const rng = new Rng(456);
  const sc = generateGame('e2e-hand', 13, rng, 50);
  const specs = buildSampleSpecs([sc], rng, 560, 420).filter((s) => s.artifact === 'hand');
  const spec = specs[0];
  const cfg = specToRenderConfig(spec, LIGHTING_PRESETS[spec.lighting], 560, 420, 1);
  const scene = renderScene(cfg);
  const obs = runPipeline(scene.image, spec.size, { knownQuad: spec.quad });
  assert.ok(scene.occluded.length > 0, '样例应确实存在遮挡交点');
  const unknownOrCorrect = scene.occluded.filter(
    (i) => obs.labels[i] === UNKNOWN || obs.labels[i] === scene.truth[i],
  ).length;
  const handled = unknownOrCorrect / scene.occluded.length;
  assert.ok(handled >= 0.8, `遮挡处理率仅 ${handled}`);
});

test('已知四角时透视校正对齐，盘面棋子可被还原', () => {
  const rng = new Rng(789);
  const sc = generateGame('e2e-warp', 9, rng, 30);
  const board = boardAtPly(sc, sc.snapshotPlies[2]);
  const stones = new Map<number, number>();
  for (let i = 0; i < board.stones.length; i++) {
    if (board.stones[i] !== 0) stones.set(i, board.stones[i]);
  }
  const quad = randomQuad(480, 360, rng);
  const scene = renderScene({
    size: 9,
    stones: stones as never,
    width: 480,
    height: 360,
    quad,
    seed: 999,
    lighting: LIGHTING_PRESETS.neutral,
    ssaa: 1,
  });
  const obs = runPipeline(scene.image, 9, { knownQuad: quad });
  // 所有真实棋子都应被识别为对应颜色（允许极少数误差，但棋子集合召回要高）
  let hit = 0;
  let real = 0;
  for (let i = 0; i < scene.truth.length; i++) {
    if (scene.truth[i] === 0) continue;
    real++;
    if (obs.labels[i] === scene.truth[i]) hit++;
  }
  assert.ok(hit / real >= 0.95, `透视下棋子召回仅 ${hit / real}`);
});
