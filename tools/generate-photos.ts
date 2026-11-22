// 样例照片生成 CLI：
//   npm run gen:photos -- --out samples --width 960 --height 720 --ssaa 2
// 产物：samples/photos/*.png + samples/meta/*.json + samples/index.json
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Rng } from '../src/core/rng';
import { renderScene, LIGHTING_PRESETS, type RenderedScene } from '../src/synth/scene';
import { encodePng } from '../src/synth/png';
import {
  buildSampleSpecs,
  generateGame,
  specToRenderConfig,
  type GameScenario,
} from './scenarios';
import type { BoardSize } from '../src/core/types';

interface CliArgs {
  out: string;
  width: number;
  height: number;
  ssaa: number;
  games: number;
  maxPly: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: 'samples',
    width: 960,
    height: 720,
    ssaa: 2,
    games: 4,
    maxPly: 140,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--width') args.width = Number(next());
    else if (a === '--height') args.height = Number(next());
    else if (a === '--ssaa') args.ssaa = Number(next());
    else if (a === '--games') args.games = Number(next());
    else if (a === '--max-ply') args.maxPly = Number(next());
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  const photoDir = join(outDir, 'photos');
  const metaDir = join(outDir, 'meta');
  mkdirSync(photoDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });

  const rng = new Rng(20261122);
  const sizes: BoardSize[] = [19, 19, 19, 13, 9];
  const scenarios: GameScenario[] = [];
  for (let g = 0; g < args.games; g++) {
    const size = sizes[g % sizes.length];
    const sc = generateGame(`game-${g + 1}`, size, rng, args.maxPly);
    scenarios.push(sc);
    console.log(`[gen] ${sc.id} size=${size} moves=${sc.moves.length} snapshots=${sc.snapshotPlies.join(',')}`);
  }

  const specs = buildSampleSpecs(scenarios, rng, args.width, args.height);
  const index: Array<Record<string, unknown>> = [];
  let rendered = 0;
  for (const spec of specs) {
    const lighting = LIGHTING_PRESETS[spec.lighting];
    const config = specToRenderConfig(spec, lighting, args.width, args.height, args.ssaa);
    const scene: RenderedScene = renderScene(config);
    const png = encodePng(scene.image, (d) => new Uint8Array(deflateSync(Buffer.from(d))));
    const base = spec.id;
    writeFileSync(join(photoDir, `${base}.png`), png);
    const meta = {
      id: spec.id,
      scenarioId: spec.scenarioId,
      ply: spec.ply,
      size: spec.size,
      width: args.width,
      height: args.height,
      lighting: spec.lighting,
      artifact: spec.artifact,
      seed: spec.seed,
      quad: spec.quad,
      truth: Array.from(scene.truth),
      occluded: scene.occluded,
      misplaceRatio: spec.misplaceRatio,
      noiseLevel: spec.noiseLevel,
    };
    writeFileSync(join(metaDir, `${base}.json`), JSON.stringify(meta, null, 0));
    index.push({ id: base, artifact: spec.artifact, lighting: spec.lighting, size: spec.size, ply: spec.ply });
    rendered++;
    if (rendered % 20 === 0) console.log(`[gen] ${rendered}/${specs.length}`);
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`[done] ${rendered} 张样例 -> ${outDir}`);
}

main();
