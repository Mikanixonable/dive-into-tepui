// 物理関数の回帰テスト エントリポイント。
// `npm run test:physics` から tsconfig.test.json でコンパイル後、これを node 実行する。
import { runAll } from './harness';
import { register as registerVec3 } from './vec3.test';
import { register as registerOrbital } from './orbital.test';
import { register as registerAttitude } from './attitude.test';
import { register as registerAtmosphere } from './atmosphere.test';
import { register as registerEphemeris } from './ephemeris.test';

registerVec3();
registerOrbital();
registerAttitude();
registerAtmosphere();
registerEphemeris();

runAll();
