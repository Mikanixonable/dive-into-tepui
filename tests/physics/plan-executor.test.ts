// plan-executor.ts の状態機械そのものの回帰テスト(閉形式の数式は plan-executor-math.test.ts)。
// PlanExecutorShip/PlanExecutorHud/PlanExecutorSimSpeed(plan-executor.ts が公開する構造的な型)
// を満たすだけのフェイクで駆動する — Player/Hud/SimSpeedManager 自体は使わない。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { PlanExecutor, PlanExecutorHud, PlanExecutorShip, PlanExecutorSimSpeed } from '../../src/game/plan/plan-executor';
import { Plan } from '../../src/game/plan/plan';
import { Attitude, qFromForwardUp } from '../../src/physics/attitude';
import { kinematicState, orbitAxes } from '../../src/physics/kinematic-state';
import { Vec3, add, v3 } from '../../src/physics/vec3';
import { diagonalInertia } from '../../src/physics/inertia-tensor';

// 円軌道もどきの状態(r=(1e7,0,0), v=(0,7000,0))を起点に、燃料無制限・全開加速度100m/s^2の
// フェイク艦を作る。
function makeShip(): PlanExecutorShip {
  return {
    state: kinematicState(0, v3(1e7, 0, 0), v3(0, 7000, 0)),
    att: { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia: diagonalInertia(v3(1, 1, 1)) },
    alive: true,
    planExecution: 'powered',
    plan: new Plan(),
    mass: 1000,
    totalThrust: 100_000, // accel = 100 m/s^2
    totalFuelConsumptionRate: 0,
    torque: v3(),
    thrust: null,
    consumeFuel: () => 1,
  };
}

const openGate: PlanExecutorSimSpeed = { canShipAct: true };
const closedGate: PlanExecutorSimSpeed = { canShipAct: false };
const hud: PlanExecutorHud = { hint: () => {} };

// armed へ確実に入れるため、目標 fwd/up からその場で厳密解を作って att.q に据える
// (PD 制御の収束を待たずに済ませる)。
function alignExactly(ship: PlanExecutorShip, fwd: Vec3, up: Vec3): void {
  const q = qFromForwardUp(fwd, up);
  assert.ok(q !== null, 'test setup: fwd/up must not be singular');
  ship.att = { ...ship.att, q: q! };
}

export function register(): void {
  test('PlanExecutor: 目標Δvがほぼ0でノード時刻が目前ならその場で完了しthrustはnull', () => {
    const ship = makeShip();
    ship.plan.addNode(kinematicState(0.02, ship.state.r, ship.state.v), ship.state);
    const executor = new PlanExecutor(hud);

    executor.update(ship, 0.1, 0, openGate);

    assert.equal(ship.thrust, null);
    assert.equal(ship.plan.nodes.length, 0, 'ノードが消化されている');
  });

  test('PlanExecutor: バーン中にノード(Δv編集)が差し替わるとthrustが残らない(regression C)', () => {
    const ship = makeShip();
    const dv = v3(0, 0, 200); // r=(1e7,0,0) と平行にならない向き(法線方向)
    const node = kinematicState(50, ship.state.r, add(ship.state.v, dv));
    ship.plan.addNode(node, ship.state);
    const executor = new PlanExecutor(hud);

    const fwd = v3(0, 0, 1); // norm(dv)
    const up = ship.state.r;
    alignExactly(ship, fwd, up);

    // armed へ(角度誤差ほぼ0)。ノード時刻に近いので猶予窓は問題にならない。
    executor.update(ship, 0.1, 49, openGate);
    // 点火予定時刻(dv=200, accel=100 -> 燃焼2秒、点火は node.t-1=49)に到達させて点火する。
    executor.applyIgnitionAndCutoff(ship, 49, openGate);
    assert.ok(ship.thrust !== null, 'test setup: 点火できていること');

    // 同じ実行時刻のまま Δv を編集(Plan.applyNodeDv は同じ t の新しい KinematicState を作る)。
    ship.plan.applyNodeDv(0, v3(0, 500, 0));
    assert.notEqual(ship.plan.firstNode(), node, 'test setup: ノード参照が差し替わっていること');

    executor.update(ship, 0.1, 49, openGate);
    assert.equal(ship.thrust, null, '差し替え直後は古いthrustが残っていないこと');
  });

  test('PlanExecutor: 純ラジアル方向のΔvでもslewを抜けてarmedへ進む(regression D)', () => {
    const ship = makeShip();
    const dv = v3(50, 0, 0); // state.r と平行 = 純ラジアル方向
    ship.plan.addNode(kinematicState(1, ship.state.r, add(ship.state.v, dv)), ship.state);
    const executor = new PlanExecutor(hud);

    // 動径方向を up にすると特異点になるので、軌道面法線へフォールバックした先で厳密に合わせる。
    const nrm = orbitAxes(ship.state).nrm;
    alignExactly(ship, v3(1, 0, 0), nrm);

    executor.update(ship, 0.1, 0, openGate);
    // armed に入っていれば nextEventTime は有限の点火予定時刻を返す。slew に留まっていれば null。
    assert.notEqual(executor.nextEventTime(ship, 0, openGate), null);
  });

  test('PlanExecutor: ノード時刻がはるか先なら現在のΔvが小さくても点火・完了しない(regression F)', () => {
    const ship = makeShip();
    // 現在の速度とノードの目標速度がほぼ一致(=前回の周回のたまたまの再現)だが、
    // ノード自体の実行時刻は遥か未来。
    const node = kinematicState(10_000, ship.state.r, ship.state.v);
    ship.plan.addNode(node, ship.state);
    const executor = new PlanExecutor(hud);

    executor.update(ship, 0.1, 0, openGate);

    assert.equal(ship.thrust, null);
    assert.equal(ship.plan.nodes.length, 1, 'ノードが消化されていないこと');
    assert.equal(executor.nextEventTime(ship, 0, openGate), null, 'armed に入っていないこと');
  });

  test('PlanExecutor: 高warpでゲートが閉じている間はnextEventTimeがnull(regression H)', () => {
    const ship = makeShip();
    const dv = v3(0, 0, 200); // r=(1e7,0,0) と平行にならない向き(法線方向)
    ship.plan.addNode(kinematicState(50, ship.state.r, add(ship.state.v, dv)), ship.state);
    const executor = new PlanExecutor(hud);

    alignExactly(ship, v3(0, 0, 1), ship.state.r);
    executor.update(ship, 0.1, 49, openGate);
    assert.notEqual(executor.nextEventTime(ship, 49, openGate), null, 'test setup: ゲートが開いていればarmed');

    executor.update(ship, 0.1, 49, closedGate);
    assert.equal(executor.nextEventTime(ship, 49, closedGate), null);
  });

  test('PlanExecutor: ゲートが閉じている間はapplyIgnitionAndCutoffの遮断判定も走らない(regression I)', () => {
    const ship = makeShip();
    const dv = v3(0, 0, 200); // r=(1e7,0,0) と平行にならない向き(法線方向)
    const node = kinematicState(50, ship.state.r, add(ship.state.v, dv));
    ship.plan.addNode(node, ship.state);
    const executor = new PlanExecutor(hud);

    alignExactly(ship, v3(0, 0, 1), ship.state.r);
    executor.update(ship, 0.1, 49, openGate);
    executor.applyIgnitionAndCutoff(ship, 49, openGate);
    assert.ok(ship.thrust !== null, 'test setup: 点火できていること');

    // 高warpでゲートが閉じている間、実際には燃焼していないのに軌道力学だけの速度変化で
    // 射影が0を切った(=遮断条件を満たした)状況を模す。
    ship.state = kinematicState(49, ship.state.r, node.v);
    executor.update(ship, 0.1, 49, closedGate);
    executor.applyIgnitionAndCutoff(ship, 49, closedGate);

    assert.equal(ship.thrust, null, 'ゲートが閉じている間は推力が止まる');
    assert.equal(ship.plan.nodes.length, 1, 'ゲートが閉じている間はノードが消化されないこと');
  });

  test('PlanExecutor: 点火後、update() を挟んでもthrustが非nullのまま維持される(regression A)', () => {
    const ship = makeShip();
    const dv = v3(0, 0, 200); // r=(1e7,0,0) と平行にならない向き(法線方向)
    ship.plan.addNode(kinematicState(50, ship.state.r, add(ship.state.v, dv)), ship.state);
    const executor = new PlanExecutor(hud);

    alignExactly(ship, v3(0, 0, 1), ship.state.r);
    executor.update(ship, 0.1, 49, openGate);
    executor.applyIgnitionAndCutoff(ship, 49, openGate);
    assert.ok(ship.thrust !== null, 'test setup: 点火できていること');

    // 操作更新で thrust がリセットされた状態を模す。
    ship.thrust = null;
    executor.update(ship, 0.1, 49, openGate);
    assert.ok(ship.thrust !== null, 'update() が燃焼中の thrust を書き直していること');
  });

  test('PlanExecutor: 燃焼中に艦が破壊されるとapplyIgnitionAndCutoffがthrustを戻す(regression K)', () => {
    const ship = makeShip();
    const dv = v3(0, 0, 200); // r=(1e7,0,0) と平行にならない向き(法線方向)
    ship.plan.addNode(kinematicState(50, ship.state.r, add(ship.state.v, dv)), ship.state);
    const executor = new PlanExecutor(hud);

    alignExactly(ship, v3(0, 0, 1), ship.state.r);
    executor.update(ship, 0.1, 49, openGate);
    executor.applyIgnitionAndCutoff(ship, 49, openGate);
    assert.ok(ship.thrust !== null, 'test setup: 点火できていること');

    // alive は読み取り専用(PlanExecutor は書かない)なので、破壊後の艦は同じ plan/state を
    // 指す別オブジェクトとして渡す — targetNode は Plan のノード参照で同一性判定するため、
    // ship オブジェクト自体の同一性は問わない。
    const destroyed: PlanExecutorShip = { ...ship, alive: false };
    executor.applyIgnitionAndCutoff(destroyed, 49.1, openGate);
    assert.equal(destroyed.thrust, null);
    assert.deepEqual(destroyed.torque, v3());
  });

  test('PlanExecutor: 大きな姿勢転回が要るときは接近ウィンドウが転回時間ぶん広がる(regression L)', () => {
    const ship = makeShip();
    // 小さいΔvだが、初期姿勢(単位クォータニオン=+Z向き)からほぼ180°の反転が要る向き。
    const dv = v3(0, 0, -1);
    ship.plan.addNode(kinematicState(12, ship.state.r, add(ship.state.v, dv)), ship.state);
    const executor = new PlanExecutor(hud);

    // 燃焼時間見積りだけの猶予窓(NODE_APPROACH_LEAD=10s + burnDuration≈0.01s)では
    // node.t-simTime=12s は外側になるはずだが、転回時間(180°, MAX_ANG_ACCEL)を
    // 足した窓の内側には入る。
    executor.update(ship, 0.1, 0, openGate);
    assert.notDeepEqual(ship.torque, v3(), '転回時間を含めた窓の内側なので整列トルクが出ていること');
  });
}
