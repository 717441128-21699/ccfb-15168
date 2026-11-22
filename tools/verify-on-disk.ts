// 从磁盘读回生成的 PNG（走完整 PNG 解码，而非内存对象），验证真实文件端到端识别。
//   npx tsx tools/verify-on-disk.ts --samples samples --limit 30
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png-decoder';
import { runPipeline } from '../src/core/pipeline';
import { evaluateLabels, evaluateOcclusion, quadError } from './evaluate';
import type { BoardSize, Quad } from '../src/core/types';

interface Meta {
  id: string;
  size: BoardSize;
  quad: Quad;
  truth: number[];
  occluded: number[];
  artifact: string;
  lighting: string;
  width: number;
  height: number;
}

function main(): void {
  const args = process.argv.slice(2);
  const dir = args[args.indexOf('--samples') + 1] ?? 'samples';
  const limit = Number(args[args.indexOf('--limit') + 1]) || 30;
  const metas = readdirSync(join(dir, 'meta'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, 'meta', f), 'utf8')) as Meta)
    .slice(0, limit);

  let correct = 0;
  let visible = 0;
  let occHandled = 0;
  let occTotal = 0;
  const byArt = new Map<string, { c: number; v: number }>();
  for (const meta of metas) {
    const png = readFileSync(join(dir, 'photos', `${meta.id}.png`));
    const img = decodePng(new Uint8Array(png));
    const obs = runPipeline(img, meta.size, { knownQuad: meta.quad });
    const truth = new Uint8Array(meta.truth);
    const br = evaluateLabels(truth, obs, meta.occluded);
    const occ = evaluateOcclusion(truth, obs, meta.occluded);
    correct += br.correct;
    visible += br.total - meta.occluded.length;
    occHandled += occ.unknownCount + occ.correctConcreteCount;
    occTotal += occ.occludedTotal;
    const qe = quadError(obs.corners, meta.quad, Math.hypot(meta.width, meta.height));
    if (qe > 0.02) throw new Error(`角点误差异常: ${meta.id} ${qe}`);
    const s = byArt.get(meta.artifact) ?? { c: 0, v: 0 };
    s.c += br.correct;
    s.v += br.total - meta.occluded.length;
    byArt.set(meta.artifact, s);
  }
  console.log(`磁盘 PNG 端到端验证（${metas.length} 张，真实解码 + 识别管线）`);
  for (const [art, s] of byArt) {
    console.log(`  ${art.padEnd(10)} 可见准确率 ${(s.c / s.v * 100).toFixed(2)}%`);
  }
  console.log(`整体可见准确率: ${(correct / visible * 100).toFixed(2)}%`);
  console.log(`遮挡处理率: ${occTotal ? ((occHandled / occTotal) * 100).toFixed(1) : 100}%`);
}

main();
