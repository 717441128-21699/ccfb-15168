// 准确率报告（内存合成 -> 真实识别管线，不经过磁盘 PNG）：
//   npm run test:accuracy -- --games 6 --width 720 --height 540
import { Rng } from '../src/core/rng';
import { renderScene, LIGHTING_PRESETS, type RenderedScene } from '../src/synth/scene';
import { runPipeline } from '../src/core/pipeline';
import {
  buildSampleSpecs,
  generateGame,
  specToRenderConfig,
  type GameScenario,
} from './scenarios';
import {
  evaluateLabels,
  evaluateOcclusion,
  quadError,
  type AccuracyBreakdown,
} from './evaluate';
import type { BoardSize, Quad } from '../src/core/types';


interface Args {
  games: number;
  width: number;
  height: number;
  ssaa: number;
  maxPly: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { games: 6, width: 720, height: 540, ssaa: 2, maxPly: 150 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') a.games = Number(argv[++i]);
    else if (argv[i] === '--width') a.width = Number(argv[++i]);
    else if (argv[i] === '--height') a.height = Number(argv[++i]);
    else if (argv[i] === '--ssaa') a.ssaa = Number(argv[++i]);
    else if (argv[i] === '--max-ply') a.maxPly = Number(argv[++i]);
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rng = new Rng(20261122);
  const sizes: BoardSize[] = [19, 19, 19, 13, 9, 19];
  const scenarios: GameScenario[] = [];
  for (let g = 0; g < args.games; g++) {
    scenarios.push(generateGame(`acc-${g + 1}`, sizes[g % sizes.length], rng, args.maxPly));
  }
  const specs = buildSampleSpecs(scenarios, rng, args.width, args.height);
  const diagonal = Math.hypot(args.width, args.height);

  const byArtifact = new Map<string, { n: number; acc: number; strict: number; quad: number; occHandled: number; occTotal: number }>();
  const byLighting = new Map<string, { n: number; correct: number; total: number }>();
  let grandCorrect = 0;
  let grandTotal = 0;
  let grandUnknown = 0;
  let grandWrong = 0;
  const worst: Array<{ id: string; acc: number; unknown: number; wrong: number }> = [];

  for (const spec of specs) {
    const lighting = LIGHTING_PRESETS[spec.lighting];
    const cfg = specToRenderConfig(spec, lighting, args.width, args.height, args.ssaa);
    const scene: RenderedScene = renderScene(cfg);
    const obs = runPipeline(scene.image, spec.size, { knownQuad: spec.quad });
    const br: AccuracyBreakdown = evaluateLabels(scene.truth, obs, scene.occluded);
    const occ = evaluateOcclusion(scene.truth, obs, scene.occluded);
    const qe = quadError(obs.corners, spec.quad as Quad, diagonal);

    grandCorrect += br.correct;
    grandTotal += br.total;
    grandUnknown += br.unknown;
    grandWrong += br.wrong;
    worst.push({ id: spec.id, acc: br.visibleAccuracy, unknown: br.unknown, wrong: br.wrong });

    const art = byArtifact.get(spec.artifact) ?? { n: 0, acc: 0, strict: 0, quad: 0, occHandled: 0, occTotal: 0 };
    art.n++;
    art.acc += br.visibleAccuracy;
    art.strict += br.strictAccuracy;
    art.quad += qe;
    art.occHandled += occ.unknownCount + occ.correctConcreteCount;
    art.occTotal += occ.occludedTotal;
    byArtifact.set(spec.artifact, art);

    const li = byLighting.get(spec.lighting) ?? { n: 0, correct: 0, total: 0 };
    li.n++;
    li.correct += br.correct;
    li.total += br.total - scene.occluded.length;
    byLighting.set(spec.lighting, li);
  }

  console.log('========== 交叉点识别准确率报告 ==========');
  console.log(`样本照片: ${specs.length} 张（${args.games} 盘对局 × 快照 × 3 灯光 × 5 干扰类型）`);
  console.log(`分辨率: ${args.width}x${args.height} SSAA=${args.ssaa}`);
  console.log('');
  console.log('按干扰类型：');
  console.log('类型        样本   可见准确率   严格准确率   角点归一误差   遮挡处理率');
  for (const [name, s] of [...byArtifact].sort()) {
    const occRate = s.occTotal ? s.occHandled / s.occTotal : 1;
    console.log(
      `${name.padEnd(10)}  ${String(s.n).padStart(4)}   ${(s.acc / s.n * 100).toFixed(3).padStart(7)}%   ${(s.strict / s.n * 100).toFixed(3).padStart(7)}%     ${(s.quad / s.n).toFixed(4)}      ${(occRate * 100).toFixed(1)}%`,
    );
  }
  console.log('');
  console.log('按灯光：');
  for (const [name, s] of byLighting) {
    console.log(`${name.padEnd(10)} 样本=${s.n}  可见准确率=${(s.correct / s.total * 100).toFixed(3)}%`);
  }
  console.log('');
  const visibleCorrect = grandCorrect;
  void visibleCorrect;
  console.log(`全量严格准确率（UNKNOWN 计错）: ${(grandCorrect / grandTotal * 100).toFixed(3)}%`);
  console.log(`UNKNOWN: ${grandUnknown}  错误: ${grandWrong}  总交点: ${grandTotal}`);
  console.log('');
  worst.sort((a, b) => a.acc - b.acc);
  console.log('最差 8 张：');
  for (const w of worst.slice(0, 8)) {
    console.log(`  ${w.id}  可见准确率=${(w.acc * 100).toFixed(2)}% UNKNOWN=${w.unknown} WRONG=${w.wrong}`);
  }
}

main();
