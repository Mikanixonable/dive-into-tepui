// DOM/THREE 非依存のゲームロジックの回帰テスト エントリポイント。
// `npm run test:unit` から tsconfig.test.json でコンパイル後、これを node 実行する。
import { runAll } from '../physics/harness';
import { register as registerBlueprint } from './blueprint-validation.test';
import { register as registerCapabilities } from './capabilities.test';
import { register as registerHeatShield } from './heat-shield.test';
import { register as registerMassProperties } from './mass-properties.test';
import { register as registerProducibility } from './producibility.test';
import { register as registerResource } from './resource.test';
import { register as registerResourceClosure } from './resource-closure.test';
import { register as registerVesselParts } from './vessel-parts.test';

registerResource();
registerProducibility();
registerResourceClosure();
registerCapabilities();
registerVesselParts();
registerMassProperties();
registerHeatShield();
registerBlueprint();

runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
