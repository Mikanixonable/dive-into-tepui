// 物理関数の回帰テスト エントリポイント。
// `npm run test:physics` から tsconfig.test.json でコンパイル後、これを node 実行する。
// 引数を1つ渡すと、名前にそれを含むケースだけを走らせる。
import './repo-assets';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runAll } from './harness';

// コンパイル済みの同居ディレクトリから *.test.js を集め、それぞれの register() を呼ぶ。
// 手で並べた登録表を持たないので、テストを足しただけで走る。register を持たないファイルは
// 黙って走らないままになるので、投げて気付かせる。
function registerAll(): void {
  const dir = __dirname;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.test.js')) continue;
    const mod = require(join(dir, file)) as { register?: () => void };
    if (typeof mod.register !== 'function') throw new Error(`${file} does not export register()`);
    mod.register();
  }
}

registerAll();

runAll(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
