// 物理関数の回帰テスト エントリポイント。
// `npm run test:physics` から tsconfig.test.json でコンパイル後、これを node 実行する。
import { runAll } from './harness';
import { register as registerVec3 } from './vec3.test';
import { register as registerOrbital } from './orbital.test';
import { register as registerAttitude } from './attitude.test';
import { register as registerTimeStep } from './time-step.test';
import { register as registerSweptSphere } from './swept-sphere.test';
import { register as registerAtmosphere } from './atmosphere.test';
import { register as registerEphemeris } from './ephemeris.test';
import { register as registerProjection } from './projection.test';
import { register as registerEnvaccel } from './envaccel.test';
import { register as registerFrame } from './frame.test';
import { register as registerDeque } from './deque.test';
import { register as registerStateQueue } from './state-queue.test';
import { register as registerOrbitEntity } from './orbit-entity.test';
import { register as registerHalo } from './halo.test';

registerVec3();
registerOrbital();
registerAttitude();
registerTimeStep();
registerSweptSphere();
registerAtmosphere();
registerEphemeris();
registerProjection();
registerEnvaccel();
registerFrame();
registerDeque();
registerStateQueue();
registerOrbitEntity();
registerHalo();

runAll();
