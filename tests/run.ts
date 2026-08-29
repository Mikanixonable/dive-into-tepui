// 回帰テストのエントリポイント。tsconfig.test.json でコンパイル後、これを node 実行する。
//   node tests/dist/tests/run.js <層> [名前の一部]
// 層はテスト対象が属する src/ のフォルダ名(physics / math / game / render)、
// または全層を走らせる all。名前の一部を渡すと、それを含むケースだけを走らせる。
import './repo-assets';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runAll } from './harness';

// webpack 用に `require` がグローバル宣言されているので、node の require はここで作る。
const nodeRequire = createRequire(__filename);

const LAYERS = ['physics', 'math', 'game', 'render'] as const;
type Layer = typeof LAYERS[number];

function isLayer(name: string): name is Layer {
  return (LAYERS as readonly string[]).includes(name);
}

// 層のディレクトリから *.test.js を集め、それぞれの register() を呼ぶ。手で並べた登録表を
// 持たないので、テストを足しただけで走る。register を持たないファイルは黙って走らないままに
// なるので、投げて気付かせる。
function registerLayer(layer: Layer): void {
  const dir = join(__dirname, layer);
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.test.js')) continue;
    const mod = nodeRequire(join(dir, file)) as { register?: () => void };
    if (typeof mod.register !== 'function') throw new Error(`${layer}/${file} does not export register()`);
    mod.register();
  }
}

const [layerArg, filter] = process.argv.slice(2);
if (layerArg !== undefined && layerArg !== 'all' && !isLayer(layerArg)) {
  console.error(`unknown layer ${JSON.stringify(layerArg)}; expected one of ${LAYERS.join(' / ')} / all`);
  process.exit(1);
}

for (const layer of layerArg === undefined || layerArg === 'all' ? LAYERS : [layerArg]) {
  registerLayer(layer);
}

runAll(filter).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
