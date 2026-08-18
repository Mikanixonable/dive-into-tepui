// DOM/THREE 非依存のゲームロジックの回帰テスト エントリポイント。
// `npm run test:unit` から tsconfig.test.json でコンパイル後、これを node 実行する。
import { runAll } from '../physics/harness';
import { register as registerResource } from './resource.test';
import { register as registerResourceClosure } from './resource-closure.test';

registerResource();
registerResourceClosure();

runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
