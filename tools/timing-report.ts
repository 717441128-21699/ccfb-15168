// 计时报告：每张照片识别管线各阶段耗时，目标手机端 2 秒内出结果。
// Node 侧测 CPU 参考实现；WebGL2 路径在浏览器实测（见 src/webgl），这里给相对倍率。
import { Rng } from '../src/core/rng';
import { renderScene, LIGHTING_PRESETS } from '../src/synth/scene';
import { runPipeline } from '../src/core/pipeline';
import { generateGame, specToRenderConfig, buildSampleSpecs } from './scenarios';
import { percentile } from './evaluate';
import type { BoardSize } from '../src/core/types';

interface Args {
  games: number;
  width: number;
  height: number;
  warped: number;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { games: 4, width: 720, height: 540, warped: 768 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') a.games = Number(argv[++i]);
    else if (argv[i] === '--width') a.width = Number(argv[++i]);
    else if (argv[i] === '--height') a.height = Number(argv[++i]);
    else if (argv[i] === '--warped') a.warped = Number(argv[++i]);
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rng = new Rng(20261122);
  const sizes: BoardSize[] = [19, 19, 13, 9];
  const scenarios = [];
  for (let g = 0; g < args.games; g++) {
    scenarios.push(generateGame(`t-${g}`, sizes[g % sizes.length] as BoardSize, rng, 120));
  }
  const specs = buildSampleSpecs(scenarios, rng, args.width, args.height).slice(0, 40);

  const totals: number[] = [];
  const detect: number[] = [];
  const warp: number[] = [];
  const classify: number[] = [];
  for (const spec of specs) {
    const cfg = specToRenderConfig(spec, LIGHTING_PRESETS[spec.lighting], args.width, args.height, 1);
    const scene = renderScene(cfg);
    // 预热一次（JIT/缓存）
    runPipeline(scene.image, spec.size, { knownQuad: spec.quad, warpedSize: args.warped });
    const obs = runPipeline(scene.image, spec.size, { knownQuad: spec.quad, warpedSize: args.warped });
    totals.push(obs.elapsedMs);
    detect.push(obs.stageMs.detect);
    warp.push(obs.stageMs.warp);
    classify.push(obs.stageMs.classify);
  }
  const sort = (a: number[]) => [...a].sort((x, y) => x - y);
  console.log('========== 识别管线计时（Node CPU 参考实现）==========');
  console.log(`照片: ${totals.length} 张  输入: ${args.width}x${args.height}  校正图: ${args.warped}px`);
  console.log('阶段          p50(ms)   p95(ms)   最大(ms)');
  const row = (name: string, a: number[]) =>
    console.log(name.padEnd(12), String(percentile(sort(a), 0.5).toFixed(1)).padStart(8), String(percentile(sort(a), 0.95).toFixed(1)).padStart(9), String(Math.max(...a).toFixed(1)).padStart(9));
  row('检测+校正', detect.map((d, i) => d + warp[i]));
  row('分类', classify);
  row('总计', totals);
  console.log('');
  console.log(`p95 总计 ${percentile(sort(totals), 0.95).toFixed(0)}ms，约束 <2000ms：`, percentile(sort(totals), 0.95) < 2000 ? '达标' : '未达标');
}

main();
