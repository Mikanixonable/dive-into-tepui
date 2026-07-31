// 物理関数の回帰テスト エントリポイント。
// `npm run test:physics` から tsconfig.test.json でコンパイル後、これを node 実行する。
import { runAll } from './harness';
import { register as registerVec3 } from './vec3.test';
import { register as registerOrbital } from './orbital.test';
import { register as registerAttitude } from './attitude.test';
import { register as registerAtmosphere } from './atmosphere.test';
import { register as registerEphemeris } from './ephemeris.test';
import { register as registerProjection } from './projection.test';
import { register as registerPredict } from './predict.test';
import { register as registerEnvaccel } from './envaccel.test';
import { register as registerFrame } from './frame.test';
import { register as registerDeque } from './deque.test';
import { register as registerStateQueue } from './state-queue.test';

registerVec3();
registerOrbital();
registerAttitude();
registerAtmosphere();
registerEphemeris();
registerProjection();
registerPredict();
registerEnvaccel();
registerFrame();
registerDeque();
registerStateQueue();

runAll();
