// 設計から導いた姿勢制御アクチュエータ集合(§F9)の回帰テスト。取り付け位置が形状ツリーから
// 解けていること、壊れた要素が数から外れること、そして既定の有人艦の姿勢応答が
// MAX_ANG_ACCEL のまま保たれることを固定する。配分そのものは tests/physics が持つ。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { len, scale, v3 } from '../../src/physics/vec3';
import { principalMoments } from '../../src/physics/inertia-tensor';
import { allocateControl, wrenchOf } from '../../src/physics/attitude-control';
import type { ThrusterSpec } from '../../src/physics/attitude-control';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import { deriveMassProperties, propellantStoreOf } from '../../src/game/vessel/mass-properties';
import { actuatorSetOf } from '../../src/game/vessel/actuator-set';
import { test } from '../physics/harness';

const NO_FORCE = v3();

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

// 既定の有人艦の形状・搭載要素・アクチュエータ集合。
function crewedActuators(): ReturnType<typeof actuatorSetOf> {
  const assembly = crewedAssembly(C.PLAYER_MAX_HP);
  const derived = deriveMassProperties(assembly);
  return actuatorSetOf(assembly, assembly.placements.map((p) => p.part), derived.centerOfMass);
}

export function register(): void {
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
    const derived = deriveMassProperties(assembly, propellantStoreOf(assembly));
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
    const derived = deriveMassProperties(assembly, propellantStoreOf(assembly));
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
