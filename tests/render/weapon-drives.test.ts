// 機関砲の被駆動部(回転砲身束・給弾スプロケット・デリンクドラム)の回転の回帰テスト。
// 射撃中に回り始め、トリガーを離すと減速して止まること、回転が表示時刻に従い一時停止中は
// 止まること、破壊された武装の駆動部は回らないこと、向きを持つ anchor は定めた軸まわりだけ
// 回ることを見る。時定数そのものは調整値なので固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { WeaponDrives } from '../../src/render/dynamic/ship/weapon-drives';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import type { ShipModuleRenderInput } from '../../src/render/dynamic/ship/ship-render-contract';
import { test } from '../harness';

const BARREL_COUNT = 6;
// 全砲口の合計射撃レート [rounds/s]。
const FIRE_RATE = 60;
// 1フレームの表示時刻の前進 [s]。1フレームの回転が π を超えない細かさにする。
const FRAME = 1 / 120;

// 砲身束・スプロケット・デリンクドラムの anchor を1つずつ持つ武装モデル。
// 送り車は模型の +Y 軸、ドラムは +X 軸まわりなので、anchor の局所 +Z がその向きを向く。
function weaponModel(): THREE.Group {
  const root = new THREE.Group();
  const rotor = new THREE.Object3D();
  rotor.name = 'anchor:barrel-rotor:0';
  rotor.userData.semanticAnchor = 'barrel-rotor:0';
  rotor.userData.barrelCount = BARREL_COUNT;
  root.add(rotor);
  for (const [name, targetAxis] of [
    ['feed-sprocket:0', new THREE.Vector3(0, 1, 0)],
    ['feed-drum', new THREE.Vector3(1, 0, 0)],
  ] as const) {
    const anchor = new THREE.Object3D();
    anchor.name = `anchor:${name}`;
    anchor.userData.semanticAnchor = name;
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetAxis);
    root.add(anchor);
  }
  return root;
}

function weapon(id: string, hp: number): ShipModuleRenderInput {
  return {
    id, modelId: 'gun', kind: 'weapon', hp, maxHp: 100, deployed: null, burning: null,
    transform: { position: v3(), rotation: Q_IDENTITY },
  };
}

function anchors(ship: ModularShipView, id: string, name: string): readonly THREE.Object3D[] {
  const found = ship.semanticAnchors(id, name);
  assert.ok(found.length > 0);
  return found;
}

// anchor の局所 +Z 回りの回転角 [rad]。
function angleOf(rotor: THREE.Object3D): number {
  return 2 * Math.atan2(rotor.quaternion.z, rotor.quaternion.w);
}

// 2つの回転角の差を -π..π へ畳んだもの [rad]。
function angleDelta(from: number, to: number): number {
  const d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) return d - 2 * Math.PI;
  if (d < -Math.PI) return d + 2 * Math.PI;
  return d;
}

// 1隻を frames 回同期し、各フレームの平均角速度 [rad/s] を返す。time は同期の開始表示時刻 [s]。
function spinSpeeds(
  drives: WeaponDrives, ship: ModularShipView, modules: readonly ShipModuleRenderInput[], rotor: THREE.Object3D,
  gunFireRate: number, time: number, frames: number,
): number[] {
  const speeds: number[] = [];
  for (let i = 1; i <= frames; i++) {
    const before = angleOf(rotor);
    drives.sync(ship, modules, gunFireRate, time + i * FRAME);
    speeds.push(angleDelta(before, angleOf(rotor)) / FRAME);
  }
  return speeds;
}

// 1発ごとに砲身が1本ぶん回るときの、1つの砲身束の目標角速度 [rad/s]。
function targetSpeed(gunFireRate: number, rotorCount: number): number {
  return 2 * Math.PI * (gunFireRate / rotorCount) / BARREL_COUNT;
}

export function register(): void {
  test('weapon drives: stay still from rest while not firing', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const drives = new WeaponDrives();
    drives.sync(ship, modules, 0, 0);
    const speeds = spinSpeeds(drives, ship, modules, anchors(ship, 'gun-1', 'barrel-rotor:')[0]!, 0, 0, 120);
    assert.ok(speeds.every((s) => s === 0));
    ship.dispose();
  });

  test('weapon drives: spin up monotonically to the fire rate, then spin down to rest after release', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const rotor = anchors(ship, 'gun-1', 'barrel-rotor:')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    const target = targetSpeed(FIRE_RATE, 1);

    const up = spinSpeeds(drives, ship, modules, rotor, FIRE_RATE, 0, 240);
    for (let i = 1; i < up.length; i++) assert.ok(up[i]! >= up[i - 1]!, `spin-up not monotonic at ${i}`);
    assert.ok(up.every((s) => s <= target * (1 + 1e-9)));
    assert.ok(Math.abs(up[up.length - 1]! - target) < target * 1e-3, `did not reach ${target}: ${up[up.length - 1]}`);

    const down = spinSpeeds(drives, ship, modules, rotor, 0, 240 * FRAME, 1200);
    for (let i = 1; i < down.length; i++) assert.ok(down[i]! <= down[i - 1]!, `spin-down not monotonic at ${i}`);
    assert.ok(down[0]! > 0);
    assert.ok(down[down.length - 1]! < target * 1e-3, `did not stop: ${down[down.length - 1]}`);
    ship.dispose();
  });

  test('weapon drives: the same display time twice does not turn the barrels', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const rotor = anchors(ship, 'gun-1', 'barrel-rotor:')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    spinSpeeds(drives, ship, modules, rotor, FIRE_RATE, 0, 60);
    const pausedAt = 60 * FRAME;
    const angle = angleOf(rotor);
    for (let i = 0; i < 10; i++) drives.sync(ship, modules, FIRE_RATE, pausedAt);
    assert.equal(angleOf(rotor), angle);
    ship.dispose();
  });

  test('weapon drives: a destroyed weapon rotor is not driven and the fire rate goes to the healthy ones', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-live', 100), weapon('gun-dead', 0)];
    ship.sync(modules);
    const live = anchors(ship, 'gun-live', 'barrel-rotor:')[0]!;
    const dead = anchors(ship, 'gun-dead', 'barrel-rotor:')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    const speeds = spinSpeeds(drives, ship, modules, live, FIRE_RATE, 0, 240);
    assert.equal(angleOf(dead), 0);
    const target = targetSpeed(FIRE_RATE, 1);
    assert.ok(Math.abs(speeds[speeds.length - 1]! - target) < target * 1e-3);
    ship.dispose();
  });

  test('weapon drives: feed parts turn only around their declared axis while firing', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const sprocket = anchors(ship, 'gun-1', 'feed-sprocket:')[0]!;
    const drum = anchors(ship, 'gun-1', 'feed-drum')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);

    // 回転軸(anchor 局所 +Z の模型座標での向き)は回転中も変わらない
    const axisOf = (anchor: THREE.Object3D): THREE.Vector3 =>
      new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.quaternion).normalize();
    const lateralOf = (anchor: THREE.Object3D): THREE.Vector3 =>
      new THREE.Vector3(1, 0, 0).applyQuaternion(anchor.quaternion).normalize();
    const sprocketAxis = axisOf(sprocket);
    const drumAxis = axisOf(drum);

    // 終端位相は2πに畳まれるので、フレームごとの変位を累積して回ったかを見る
    let sprocketTurn = 0, drumTurn = 0;
    let prevSprocket = lateralOf(sprocket), prevDrum = lateralOf(drum);
    for (let i = 1; i <= 240; i++) {
      drives.sync(ship, modules, FIRE_RATE, i * FRAME);
      const s = lateralOf(sprocket), d = lateralOf(drum);
      sprocketTurn += s.angleTo(prevSprocket);
      drumTurn += d.angleTo(prevDrum);
      prevSprocket = s; prevDrum = d;
    }

    assert.ok(axisOf(sprocket).angleTo(sprocketAxis) < 1e-9, 'sprocket axis moved');
    assert.ok(axisOf(drum).angleTo(drumAxis) < 1e-9, 'drum axis moved');
    assert.ok(sprocketTurn > Math.PI, `sprocket did not turn: ${sprocketTurn}`);
    assert.ok(drumTurn > Math.PI, `drum did not turn: ${drumTurn}`);
    ship.dispose();
  });

  test('weapon drives: feed parts follow the full fire rate rather than dividing it by rotor count', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const drum = anchors(ship, 'gun-1', 'feed-drum')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    const speeds = spinSpeeds(drives, ship, modules, drum, FIRE_RATE, 0, 240);
    // デリンクドラムは1発ごとに1ステーション(2π/6)回る
    const drumTarget = (2 * Math.PI / 6) * FIRE_RATE;
    assert.ok(Math.abs(speeds[speeds.length - 1]! - drumTarget) < drumTarget * 1e-3);
    ship.dispose();
  });
}
