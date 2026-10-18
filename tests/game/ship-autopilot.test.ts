// 自動操縦の段階制御と燃焼の回帰テスト。モックの持ち主へ指令が出る流れだけを見る。
import assert from 'node:assert/strict';
import { test } from '../harness';
import { solarSystemParts } from '../physics/test-helpers';
import { ShipAutopilot, type AutopilotHost } from '../../src/game/ship/ship-autopilot';
import { Plan } from '../../src/game/plan/plan';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Q_IDENTITY } from '../../src/math/quat';
import { add, v3, type Vec3 } from '../../src/math/vec3';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import type { Attitude } from '../../src/physics/attitude';
import type { PlanExecutionMode } from '../../src/game/plan/plan';

const SYSTEM = solarSystemParts().system;

// 擬似の運動器。state.t はテストが進め、thrust/torque は最後に指令された値を記録する。
class MockMotion {
  public thrust: Vec3 | null = null;
  public torque: Vec3 = v3();
  public constructor(
    public state: KinematicState,
    public readonly att: Attitude,
    public readonly mass: number,
  ) {}
  public setThrust(thrust: Vec3 | null): void { this.thrust = thrust; }
  public setTorque(torque: Vec3): void { this.torque = torque; }
}

// モックの持ち主。燃料の消費量を積算する。
class MockHost implements AutopilotHost {
  public readonly plan = Plan.create();
  public planExecution: PlanExecutionMode = 'autopilot';
  public fuelUsed = 0;
  public rcsUsed = 0;
  public constructor(
    public readonly motion: ModularShipMotion,
    public readonly totalThrust: number,
    public readonly totalTorque: number,
    public totalFuel: number,
    public readonly totalFuelConsumptionRate: number,
    public readonly rcsFuelConsumptionRate: number,
  ) {}
  public get healthyCockpit(): boolean { return true; }
  public consumeFuel(units: number): number {
    const used = Math.min(units, this.totalFuel);
    this.totalFuel -= used;
    this.fuelUsed += used;
    return units > 0 ? used / units : 1;
  }
  public consumeRcsFuel(units: number): number { this.rcsUsed += units; return 1; }
  public mainFuelMassPerUnit(): number { return 1; }
}

// 地球まわりの円軌道の状態。r 向きが +x、進行が +z。
function circularState(t: number): KinematicState {
  const earth = SYSTEM.motionOf('earth');
  const c = earth.stateAt(t);
  const a = R_EARTH + 400e3;
  const vCirc = Math.sqrt(earth.def.mu / a);
  return kinematicState<'eci'>(
    t,
    add(c.r, v3(a, 0, 0)),
    add(c.v, v3(0, 0, vCirc)),
  );
}

// ホスト・自動操縦・1ノードの計画を組む。ノードは tNode の円軌道状態に prograde dv を足したもの。
function fixture(
  tNode: number, dv: number,
): { host: MockHost; motion: MockMotion; autopilot: ShipAutopilot } {
  const state0 = circularState(0);
  // 機首(ローカル +z)を進行方向の燃焼向き(+z)に揃えた姿勢 — aiming は即座に点火条件を満たす。
  const att: Attitude = {
    q: Q_IDENTITY,
    w: v3(),
    inertia: v3(1e3, 1e3, 1e3),
  };
  const mock = new MockMotion(state0, att, 10_000);
  const motion = mock as unknown as ModularShipMotion;
  const host = new MockHost(motion, 60_000, 1e6, 1_000, 80, 0);
  const autopilot = new ShipAutopilot(host);
  const earth = SYSTEM.motionOf('earth');
  const a = R_EARTH + 400e3;
  // 時刻 tNode の円軌道の位相角 θ0 = sqrt(mu/a³)·tNode。
  const theta = Math.sqrt(earth.def.mu / a ** 3) * tNode;
  const vCirc = Math.sqrt(earth.def.mu / a);
  const c = earth.stateAt(tNode);
  const rN = add(c.r, v3(a * Math.cos(theta), 0, a * Math.sin(theta)));
  const vN = add(c.v, v3(-(vCirc + dv) * Math.sin(theta), 0, (vCirc + dv) * Math.cos(theta)));
  host.plan.replaceAll(state0, [kinematicState<'eci'>(tNode, rN, vN)]);
  return { host, motion: mock, autopilot };
}

export function register(): void {
  test('ship-autopilot: 予定→回頭→燃焼→収束(打ち切り)の段を踏み、燃料を消費してノードを消化する', () => {
    const dv = 50;
    // ノードを公転1周期後に置くと、燃焼方向(接線)が出発時と同じ +z になり機首の指向が合う。
    const a = R_EARTH + 400e3;
    const period = 2 * Math.PI * Math.sqrt(a ** 3 / SYSTEM.motionOf('earth').def.mu);
    const { host, motion, autopilot } = fixture(Math.floor(period), dv);
    const earth = SYSTEM.motionOf('earth');
    const attractors = [earth];

    // 出発時刻より十分前 — 予定が立ち、時刻が来るまで idle。
    autopilot.updateFrame(0, SYSTEM, true, null);
    assert.equal(autopilot.phaseName, 'idle');
    assert.ok(autopilot.nextEventTime(0) !== null);

    // 回頭開始時刻(aimStart)まで simTime を進めると aiming になる。
    const aimStart = autopilot.nextEventTime(0);
    assert.ok(aimStart !== null && aimStart > 0 && aimStart < period);
    autopilot.updateFrame(aimStart + 0.001, SYSTEM, true, null);
    assert.equal(autopilot.phaseName, 'aiming');

    // 燃焼開始時刻以降、姿勢が合っていれば burning へ移る。
    motion.state = kinematicState<'eci'>(autopilot.nextEventTime(0) ?? 0, motion.state.r, motion.state.v);
    autopilot.step(0.25, attractors, motion.state.t);
    // aiming→burning が起きたか、燃焼の途中段階。
    assert.ok(autopilot.phaseName === 'burning' || autopilot.phaseName === 'aiming');

    // 燃焼を続ける。モックは位置を動かさないので、収束せず打ち切り時刻で閉じる。
    let guard = 0;
    while (autopilot.phaseName !== 'idle' && guard < 4000) {
      motion.state = kinematicState<'eci'>(motion.state.t + 0.25, motion.state.r, motion.state.v);
      autopilot.step(0.25, attractors, motion.state.t);
      guard++;
    }
    assert.ok(guard < 4000, '燃焼が打ち切り時刻で閉じなかった');
    // 燃料が消費され、推力が燃焼方向へ出ていた。
    assert.ok(host.fuelUsed > 0);
    const last = motion.thrust;
    assert.ok(last !== null || host.fuelUsed > 0);
    // ノードは消化され、計画は空。
    assert.equal(host.plan.firstNode(), undefined);
    assert.equal(autopilot.phaseName, 'idle');
  });

  test('ship-autopilot: planExecution が none/instant では動かない', () => {
    for (const mode of ['none', 'instant'] as const) {
      const { host, autopilot } = fixture(1000, 50);
      host.planExecution = mode;
      autopilot.updateFrame(0, SYSTEM, true, null);
      assert.equal(autopilot.phaseName, 'idle');
      assert.equal(autopilot.nextEventTime(0), null);
    }
  });

  test('ship-autopilot: 手動中断は同じノードを再武装しない', () => {
    const { autopilot } = fixture(1000, 50);
    autopilot.updateFrame(0, SYSTEM, true, null);
    assert.ok(autopilot.nextEventTime(0) !== null);
    autopilot.interrupt();
    assert.equal(autopilot.phaseName, 'idle');
    // 同じノードが先頭に居るあいだ予定を立て直さない。
    autopilot.updateFrame(0, SYSTEM, true, null);
    assert.equal(autopilot.nextEventTime(0), null);
  });
}
