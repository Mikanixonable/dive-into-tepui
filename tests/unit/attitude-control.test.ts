// 姿勢制御の配分(§F9)の回帰テスト。減衰最小二乗による配分、3段の優先順位、フライホイールの
// 飽和とアンローディング、磁気トルカが出せない軸、そして既定の有人艦の手触りの保存を固定する。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { Vec3, len, scale, sub, v3 } from '../../src/physics/vec3';
import { principalMoments } from '../../src/physics/inertia-tensor';
import {
  DESATURATION_START_RATIO, DESATURATION_STOP_RATIO,
  allocateControl, desaturationActive, magneticMomentFor, thrusterSpec, wrenchOf,
} from '../../src/physics/attitude-control';
import type { ActuatorSet, ThrusterSpec } from '../../src/physics/attitude-control';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import { deriveMassProperties } from '../../src/game/vessel/mass-properties';
import { actuatorSetOf } from '../../src/game/vessel/actuator-set';
import { test } from '../physics/harness';

const NO_FORCE = v3();

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

// 対向する6組12基の、3軸とも対称な配置。腕と噴射方向の外積が目的の軸を向くよう組むので、
// どの向きのトルクも厳密に出せ、対になる2基の推力は打ち消し合って並進推力を残さない。
function symmetricCluster(thrust = 100): ThrusterSpec[] {
  const pairs = [
    [v3(0, 1, 0), v3(0, 0, 1)], // y × z = x
    [v3(0, 0, 1), v3(1, 0, 0)], // z × x = y
    [v3(1, 0, 0), v3(0, 1, 0)], // x × y = z
  ] as const;
  const out: ThrusterSpec[] = [];
  for (const [arm, dir] of pairs) {
    for (const s of [1, -1]) {
      for (const t of [1, -1]) out.push(thrusterSpec(scale(arm, s), scale(dir, t), thrust));
    }
  }
  return out;
}

function thrusterOnly(thrusters: readonly ThrusterSpec[]): ActuatorSet {
  return { thrusters, wheel: null, magnetorquer: null };
}

export function register(): void {
  test('配分: 解の存在する配置では要求トルクをそのまま出せる', () => {
    const actuators = thrusterOnly(symmetricCluster(1000));
    for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), v3(-1, 0, 0), v3(0, -1, 0), v3(0, 0, -1)]) {
      const torque = scale(axis, 40);
      const allocation = allocateControl({ torque, force: NO_FORCE }, actuators, v3(), v3(), 0.02, false);
      assert.ok(len(sub(allocation.torque, torque)) < 1e-6 * len(torque), `axis ${JSON.stringify(axis)}`);
      assert.ok(len(allocation.force) < 1e-6 * len(torque), '寄生する並進推力が出ない');
    }
  });

  test('配分: 対向するスラスタが同時に噴かない', () => {
    const thrusters = symmetricCluster(1000);
    const actuators = thrusterOnly(thrusters);
    const allocation = allocateControl(
      { torque: v3(20, -7, 13), force: NO_FORCE }, actuators, v3(), v3(), 0.02, false);
    for (let i = 0; i < thrusters.length; i++) {
      for (let j = i + 1; j < thrusters.length; j++) {
        const opposed = len(sub(thrusters[i]!.position, thrusters[j]!.position)) < 1e-12
          && len(sub(thrusters[i]!.direction, scale(thrusters[j]!.direction, -1))) < 1e-12;
        if (!opposed) continue;
        assert.ok(
          allocation.thrusterForces[i]! === 0 || allocation.thrusterForces[j]! === 0,
          `対向する ${i} と ${j} が同時に噴いている`);
      }
    }
  });

  test('配分: 厳密解の無い偏った配置でも有限の解が返り、最小二乗の意味で最も近い', () => {
    // 1軸ぶんしか出せない配置。他の2軸を要求しても発散せず、出せる成分だけが残る。
    const actuators = thrusterOnly([
      thrusterSpec(v3(0, 0, 1), v3(1, 0, 0), 100),
      thrusterSpec(v3(0, 0, -1), v3(1, 0, 0), 100),
    ]);
    const allocation = allocateControl(
      { torque: v3(0, 0, 50), force: NO_FORCE }, actuators, v3(), v3(), 0.02, false);
    for (const f of allocation.thrusterForces) assert.ok(Number.isFinite(f) && f >= 0);
    assert.ok(Number.isFinite(len(allocation.torque)));
    // このスラスタは z 軸まわりのトルクを出せないので、出せた量は要求より小さい。
    assert.ok(Math.abs(allocation.torque.z) <= 50);
  });

  test('配分: スラスタを積まない機体でも例外にならない', () => {
    const allocation = allocateControl(
      { torque: v3(1, 2, 3), force: NO_FORCE }, thrusterOnly([]), v3(), v3(), 0.02, false);
    assert.deepEqual(allocation.thrusterForces, []);
    assert.deepEqual(allocation.torque, v3());
  });

  test('配分: 最大推力を超える要求は頭打ちになり、出せなかったぶんは捨てる', () => {
    const actuators = thrusterOnly(symmetricCluster(10));
    const allocation = allocateControl(
      { torque: v3(0, 0, 1e6), force: NO_FORCE }, actuators, v3(), v3(), 0.02, false);
    for (let i = 0; i < actuators.thrusters.length; i++) {
      assert.ok(allocation.thrusterForces[i]! <= actuators.thrusters[i]!.maxThrust + 1e-9);
    }
    assert.ok(allocation.torque.z < 1e6);
  });

  test('磁気トルカ: 磁場が無ければ何も出せない', () => {
    const moment = magneticMomentFor(v3(0, 0, 10), v3(), 400);
    assert.deepEqual(moment, v3());
    const actuators: ActuatorSet = {
      thrusters: [], wheel: null, magnetorquer: { maxMagneticMoment: 400, powerDraw: 3.5 },
    };
    const allocation = allocateControl(
      { torque: v3(0, 0, 10), force: NO_FORCE }, actuators, v3(), v3(), 1, false);
    assert.deepEqual(allocation.torque, v3());
    assert.equal(allocation.powerDraw, 0);
  });

  test('磁気トルカ: 磁場に平行な成分は出せず、次の段へ落ちる', () => {
    const field = v3(0, 0, 3e-5);
    const actuators: ActuatorSet = {
      thrusters: [], wheel: null, magnetorquer: { maxMagneticMoment: 400, powerDraw: 3.5 },
    };
    // 磁場に平行な要求 → トルクは 0。
    const parallel = allocateControl(
      { torque: v3(0, 0, 1e-3), force: NO_FORCE }, actuators, v3(), field, 1, false);
    assert.ok(len(parallel.torque) < 1e-15, `${len(parallel.torque)}`);
    // 垂直な要求 → 能力いっぱいまで出る(400 A·m² × 3e-5 T = 1.2e-2 N·m)。
    const perpendicular = allocateControl(
      { torque: v3(1e-3, 0, 0), force: NO_FORCE }, actuators, v3(), field, 1, false);
    assert.ok(relativeError(perpendicular.torque.x, 1e-3) < 1e-9);
    assert.ok(Math.abs(perpendicular.torque.z) < 1e-15, '平行な軸には漏れない');
  });

  test('磁気トルカ: 平行成分は残差としてRCSへ落ちる', () => {
    const field = v3(0, 0, 3e-5);
    const actuators: ActuatorSet = {
      thrusters: symmetricCluster(1000),
      wheel: null,
      magnetorquer: { maxMagneticMoment: 4000, powerDraw: 25 },
    };
    const torque = v3(0, 0, 30);
    const allocation = allocateControl({ torque, force: NO_FORCE }, actuators, v3(), field, 0.02, false);
    // 磁気トルカは z 軸まわりに何も出せないので、全量がスラスタから出る。
    const fromThrusters = wrenchOf(actuators.thrusters, allocation.thrusterForces);
    assert.ok(relativeError(fromThrusters.torque.z, 30) < 1e-6);
    assert.ok(relativeError(allocation.torque.z, 30) < 1e-6);
  });

  test('フライホイール: 最大トルクと蓄積角運動量の上限の両方で頭打ちになる', () => {
    const wheel = { maxTorque: 50, maxAngularMomentum: 100, powerDraw: 60 };
    const actuators: ActuatorSet = { thrusters: [], wheel, magnetorquer: null };
    // 最大トルクで頭打ち。
    const strong = allocateControl(
      { torque: v3(0, 0, 500), force: NO_FORCE }, actuators, v3(), v3(), 0.1, false);
    assert.ok(relativeError(strong.wheelTorque.z, 50) < 1e-12);
    assert.equal(strong.powerDraw, 60);
    // 上限間際からさらに溜める向きの指令は、上限ちょうどで止まる。
    const nearlyFull = v3(0, 0, -99);
    const saturating = allocateControl(
      { torque: v3(0, 0, 50), force: NO_FORCE }, actuators, nearlyFull, v3(), 1, false);
    assert.ok(len(saturating.wheelMomentum) <= 100 + 1e-9, `${len(saturating.wheelMomentum)}`);
    assert.ok(saturating.wheelTorque.z < 50, '上限に届くぶんだけ絞られる');
  });

  test('アンローディング: 開始と終了に別々の閾値を持ち、短周期の往復に落ちない', () => {
    const wheel = { maxTorque: 50, maxAngularMomentum: 100, powerDraw: 60 };
    // 開始の閾値を下回るあいだは始まらない。
    assert.equal(desaturationActive(v3(0, 0, 80), wheel, false), false);
    assert.equal(desaturationActive(v3(0, 0, 86), wheel, false), true);
    // 一度始まったら、終了の閾値を下回るまで続く。
    assert.equal(desaturationActive(v3(0, 0, 80), wheel, true), true);
    assert.equal(desaturationActive(v3(0, 0, 40), wheel, true), true);
    assert.equal(desaturationActive(v3(0, 0, 20), wheel, true), false);
    // 開始したところで止まる状態が存在しない = 1刻みで開始と終了を往復できない。
    assert.ok(DESATURATION_STOP_RATIO < DESATURATION_START_RATIO);
    const start = DESATURATION_START_RATIO * wheel.maxAngularMomentum;
    assert.equal(desaturationActive(v3(0, 0, start + 1e-9), wheel, true), true);
  });

  test('アンローディング: 外部トルクを伴って蓄積角運動量が減る', () => {
    const wheel = { maxTorque: 50, maxAngularMomentum: 100, powerDraw: 60 };
    const actuators: ActuatorSet = {
      thrusters: symmetricCluster(1000), wheel, magnetorquer: null,
    };
    let momentum = v3(0, 0, 95);
    let active = true;
    let steps = 0;
    while (active && steps < 100000) {
      active = desaturationActive(momentum, wheel, active);
      if (!active) break;
      const allocation = allocateControl(
        { torque: NO_FORCE, force: NO_FORCE }, actuators, momentum, v3(), 0.1, true);
      assert.ok(len(allocation.wheelMomentum) < len(momentum) + 1e-12, '蓄積が増えない');
      // 排出中もホイールのトルクは打ち消されるので、機体が受けるトルクは要求(=0)のまま。
      assert.ok(len(allocation.torque) < 1e-6, `net torque ${len(allocation.torque)}`);
      momentum = allocation.wheelMomentum;
      steps++;
    }
    assert.ok(!active, 'アンローディングが終了する');
    assert.ok(len(momentum) <= DESATURATION_STOP_RATIO * wheel.maxAngularMomentum + 1e-9);
  });

  test('アンローディング: 磁気トルカしか無い機体でも、遅いだけで蓄積は減る', () => {
    const wheel = { maxTorque: 50, maxAngularMomentum: 400, powerDraw: 60 };
    const actuators: ActuatorSet = {
      thrusters: [], wheel, magnetorquer: { maxMagneticMoment: 400, powerDraw: 3.5 },
    };
    const field = v3(3e-5, 0, 0); // 蓄積(z)に垂直 = 出せる向き。
    const before = v3(0, 0, 390);
    const after = allocateControl(
      { torque: NO_FORCE, force: NO_FORCE }, actuators, before, field, 1, true).wheelMomentum;
    assert.ok(len(after) < len(before));
    // 1.2e-2 N·m しか出ないので、1秒でその量だけ減る。
    assert.ok(relativeError(len(before) - len(after), 1.2e-2) < 0.01);
  });

  test('アクチュエータ集合: トラスの先のRCSは船体のものより大きなトルクを出す', () => {
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const derived = deriveMassProperties(assembly);
    const parts = assembly.placements.map((placement) => placement.part);
    const set = actuatorSetOf(assembly, parts, derived.centerOfMass);
    assert.ok(set.thrusters.length > 0);
    const onTruss = set.thrusters.filter((t) => Math.abs(t.position.x) > 1.5);
    const onHull = set.thrusters.filter((t) => Math.abs(t.position.x) <= 1.5);
    assert.ok(onTruss.length > 0 && onHull.length > 0);
    // 同じ推力を積んでいるので、腕の長さの差がそのままトルクの差になる。
    const torqueOf = (t: ThrusterSpec): number => len(wrenchOf([t], [t.maxThrust]).torque);
    const farthestTruss = Math.max(...onTruss.map(torqueOf));
    const farthestHull = Math.max(...onHull.map(torqueOf));
    assert.ok(farthestTruss > farthestHull, `truss ${farthestTruss} > hull ${farthestHull}`);
    // トラスの先へ行くほど腕が伸びる。
    const tip = onTruss.reduce((a, b) => (Math.abs(a.position.x) > Math.abs(b.position.x) ? a : b));
    const root = onTruss.reduce((a, b) => (Math.abs(a.position.x) < Math.abs(b.position.x) ? a : b));
    assert.ok(torqueOf(tip) > torqueOf(root));
  });

  test('アクチュエータ集合: 壊れた要素は数えない', () => {
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const derived = deriveMassProperties(assembly);
    const parts = assembly.placements.map((placement) => placement.part);
    const before = actuatorSetOf(assembly, parts, derived.centerOfMass);
    for (const part of parts) if (part.type === 'rcs_thruster' || part.type === 'flywheel') part.hp = 0;
    const after = actuatorSetOf(assembly, parts, derived.centerOfMass);
    assert.equal(after.thrusters.length, 0);
    assert.equal(after.wheel, null);
    assert.ok(before.thrusters.length > 0 && before.wheel !== null);
    for (const part of parts) part.hp = part.maxHp;
  });

  test('手触りの保存: 既定の有人艦は RCS だけで MAX_ANG_ACCEL を出せる', () => {
    // フライホイールが飽和して RCS へ全量が落ちても、押した軸に出る角加速度は変わらない。
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const derived = deriveMassProperties(assembly);
    const parts = assembly.placements.map((placement) => placement.part);
    const set = actuatorSetOf(assembly, parts, derived.centerOfMass);
    const needed = C.MAX_ANG_ACCEL * principalMoments(derived.inertia).z;
    for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1), v3(-1, 0, 0), v3(0, -1, 0), v3(0, 0, -1)]) {
      const torque = scale(axis, needed);
      const allocation = allocateControl(
        { torque, force: NO_FORCE },
        { thrusters: set.thrusters, wheel: null, magnetorquer: null },
        v3(), v3(), 0.02, false);
      // 指令した軸には要求どおりの大きさが出る(直交する軸への漏れは配置の非対称さぶん残る)。
      const along = (allocation.torque.x * axis.x + allocation.torque.y * axis.y + allocation.torque.z * axis.z);
      assert.ok(relativeError(along, needed) < 0.01, `axis ${JSON.stringify(axis)}: ${along} vs ${needed}`);
      assert.ok(len(allocation.force) < 1e-3 * needed, '寄生する並進推力が無視できる');
    }
  });

  test('手触りの保存: 既定の有人艦はフライホイール単独でも MAX_ANG_ACCEL を出せる', () => {
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const derived = deriveMassProperties(assembly);
    const parts = assembly.placements.map((placement) => placement.part);
    const set = actuatorSetOf(assembly, parts, derived.centerOfMass);
    const needed = C.MAX_ANG_ACCEL * principalMoments(derived.inertia).z;
    assert.ok(set.wheel !== null);
    assert.ok(relativeError(set.wheel!.maxTorque, needed) < 1e-12);
    const allocation = allocateControl(
      { torque: v3(0, 0, needed), force: NO_FORCE },
      { thrusters: [], wheel: set.wheel, magnetorquer: null }, v3(), v3(), 1 / 60, false);
    assert.ok(relativeError(allocation.torque.z, needed) < 1e-12);
  });
}
