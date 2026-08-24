// 分離式ブースターの順序、最後尾限定の燃焼、燃料切れ途中の平均推力、保存復元を検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  BoosterStack,
  boosterAverageAcceleration,
  type BoosterStage,
} from '../../src/game/player/booster-stack';

function stage(id: string, fuel = 10, ignited = false): BoosterStage {
  return {
    id,
    dryMass: 100,
    fuel,
    maxFuel: 10,
    thrust: 1_000,
    fuelRate: 2,
    ignited,
  };
}

export function register(): void {
  test('booster stack: attach は船体側から最後尾の順序を保つ', () => {
    const stack = new BoosterStack([stage('core')]);
    stack.attach(stage('outer-a'));
    stack.attach(stage('outer-b'));
    assert.deepEqual(stack.stages.map((s) => s.id), ['core', 'outer-a', 'outer-b']);
    assert.equal(stack.totalMass, 330);
  });

  test('booster stack: 点火・燃焼は最後尾だけ', () => {
    const stack = new BoosterStack([stage('inner'), stage('outer')]);
    assert.equal(stack.toggleIgnition(), true);
    const result = stack.step(1);
    assert.equal(result.thrust, 1_000);
    assert.equal(stack.stages[0]?.fuel, 10, '内側段は燃えない');
    assert.equal(stack.stages[1]?.fuel, 8);
  });

  test('booster stack: 燃料切れがフレーム途中なら平均推力を燃焼割合で返す', () => {
    const stack = new BoosterStack([stage('outer', 2)]);
    assert.equal(stack.toggleIgnition(), true);
    const result = stack.step(2); // 1秒で燃料が尽き、残り1秒は推力なし
    assert.equal(result.fuelConsumed, 2);
    assert.equal(result.burnRatio, 0.5);
    assert.equal(result.averageThrust, 500);
    assert.equal(result.thrust, 500);
    assert.equal(stack.stages[0]?.fuel, 0);
    assert.equal(stack.stages[0]?.ignited, false);
  });

  test('booster stack: 空スタック/空燃料段は点火せず、detach は null', () => {
    const empty = new BoosterStack();
    assert.equal(empty.toggleIgnition(), false);
    assert.deepEqual(empty.step(1), {
      thrust: 0, averageThrust: 0, burnRatio: 0, fuelConsumed: 0, burning: false,
    });
    assert.equal(empty.detachOutermost(), null);

    const dry = new BoosterStack([stage('dry', 0)]);
    assert.equal(dry.toggleIgnition(), false);
    assert.equal(dry.stages[0]?.ignited, false);
  });

  test('booster stack: detachOutermost は最後尾の状態を完全に移して pop', () => {
    const stack = new BoosterStack([stage('inner'), stage('outer')]);
    stack.toggleIgnition();
    stack.step(0.25);
    const detached = stack.detachOutermost();
    assert.ok(detached);
    assert.equal(detached.id, 'outer');
    assert.equal(detached.fuel, 9.5);
    assert.equal(detached.ignited, true);
    assert.deepEqual(stack.stages.map((s) => s.id), ['inner']);
  });

  test('booster stack: セーブ用 plain data は独立コピーでラウンドトリップする', () => {
    const stack = new BoosterStack([stage('inner'), stage('outer', 4, true)]);
    const data = stack.exportData();
    data.stages[1]!.fuel = 0;
    assert.equal(stack.stages[1]?.fuel, 4);

    const restored = BoosterStack.importData(stack.exportData());
    assert.deepEqual(restored.exportData(), stack.exportData());
    assert.notEqual(restored.stages[0], stack.stages[0]);
  });

  test('booster stack: 読み出した段の書き換えでは内部状態を壊せない', () => {
    const stack = new BoosterStack([stage('outer')]);
    const exposed = stack.stages[0]!;
    exposed.fuel = 0;
    exposed.ignited = true;
    assert.equal(stack.stages[0]?.fuel, 10);
    assert.equal(stack.totalMass, 110);
  });

  test('booster stack: 段の質量・燃料不変条件を拒否する', () => {
    assert.throws(() => new BoosterStack([stage('bad', 11)]), RangeError);
    assert.throws(() => new BoosterStack([{ ...stage('bad'), dryMass: -1 }]), RangeError);
    assert.throws(() => new BoosterStack([{ ...stage('bad'), id: '' }]), TypeError);
  });

  test('booster stack: 可変質量の平均加速度はロケット方程式のΔvと一致する', () => {
    const stack = new BoosterStack([stage('outer', 10, true)]);
    const massBefore = 110;
    const dt = 2;
    const result = stack.step(dt);
    const massAfter = 106;
    const averageAcceleration = boosterAverageAcceleration(result, massBefore, massAfter);
    // ve=thrust/fuelRate=500m/s、Δv=ve ln(m0/m1)。平均加速度はΔv/dt。
    const expected = 500 * Math.log(massBefore / massAfter) / dt;
    assert.ok(Math.abs(averageAcceleration - expected) < 1e-12);
  });
}
