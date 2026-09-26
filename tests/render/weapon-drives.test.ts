// 機関砲の被駆動部(回転砲身束・給弾スプロケット・デリンクドラム・反動部)の回帰テスト。
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
    ['feed-shoe', new THREE.Vector3(-1, 0, 0)],
  ] as const) {
    const anchor = new THREE.Object3D();
    anchor.name = `anchor:${name}`;
    anchor.userData.semanticAnchor = name;
    anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), targetAxis);
    anchor.position.set(0.3, -1.9, 0.4);
    root.add(anchor);
  }
  const recoil = new THREE.Object3D();
  recoil.name = 'anchor:gun-recoil:0';
  recoil.userData.semanticAnchor = 'gun-recoil:0';
  recoil.userData.recoilTravel = 0.22;
  root.add(recoil);
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

  test('weapon drives: a shot recoils the receiver anchor along -Z and returns it to battery', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const base = recoil.position.clone();
    const baseQuat = recoil.quaternion.clone();
    const drives = new WeaponDrives();
    // cycleDuration 0.2 の発射は、後座時間 0.18 s・急発進 0.036 s の行程を持つ
    const shots = [{ moduleId: 'gun-1', muzzleIndex: 0, firedAt: 1.0, cycleDuration: 0.2 }];
    drives.sync(ship, modules, 0, 1.0, shots);
    assert.ok(recoil.position.distanceTo(base) < 1e-9, 'recoiled before the shot');
    drives.sync(ship, modules, 0, 1.036, shots);
    const peak = base.z - recoil.position.z;
    assert.ok(peak > 0.2, `did not recoil: ${peak}`);
    assert.ok(Math.abs(recoil.position.x - base.x) < 1e-9 && Math.abs(recoil.position.y - base.y) < 1e-9);
    assert.ok(recoil.quaternion.angleTo(baseQuat) < 1e-9, 'recoil anchor rotated');
    drives.sync(ship, modules, 0, 1.1, shots);
    const returning = base.z - recoil.position.z;
    assert.ok(returning < peak && returning > 0, `did not start returning: ${returning}`);
    drives.sync(ship, modules, 0, 1.2, shots);
    assert.ok(recoil.position.distanceTo(base) < 1e-9, 'did not return to battery');
    ship.dispose();
  });

  test('weapon drives: recoil stays at rest without a matching shot record', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const base = recoil.position.clone();
    const drives = new WeaponDrives();
    // 別砲口・別モジュールの記録では動かず、行程を過ぎた古い記録でも動かない
    const stale = [
      { moduleId: 'gun-1', muzzleIndex: 1, firedAt: 1.0, cycleDuration: 0.2 },
      { moduleId: 'gun-2', muzzleIndex: 0, firedAt: 1.0, cycleDuration: 0.2 },
      { moduleId: 'gun-1', muzzleIndex: 0, firedAt: 0.5, cycleDuration: 0.2 },
    ];
    for (const shot of stale) {
      drives.sync(ship, modules, 0, 1.036, [shot]);
      assert.ok(recoil.position.distanceTo(base) < 1e-9, `recoiled for ${shot.moduleId}:${shot.muzzleIndex}`);
    }
    ship.dispose();
  });

  test('weapon drives: a destroyed weapon receiver does not recoil', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 0)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const base = recoil.position.clone();
    const drives = new WeaponDrives();
    const shots = [{ moduleId: 'gun-1', muzzleIndex: 0, firedAt: 1.0, cycleDuration: 0.2 }];
    drives.sync(ship, modules, 0, 1.036, shots);
    assert.ok(recoil.position.distanceTo(base) < 1e-9, 'destroyed receiver recoiled');
    ship.dispose();
  });

  test('weapon drives: the feed shoe reciprocates along its declared axis without rotating', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const shoe = anchors(ship, 'gun-1', 'feed-shoe')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    const basePos = shoe.position.clone();
    const baseQuat = shoe.quaternion.clone();
    // 案内爪は1リンク(32発)で1往復する。起動の遅れを見越して1往復ぶんより長く進め、
    // 最大変位を追う
    let maxDisplacement = 0, minX = basePos.x, maxX = basePos.x;
    for (let i = 1; i <= 200; i++) {
      drives.sync(ship, modules, FIRE_RATE, i * FRAME);
      maxDisplacement = Math.max(maxDisplacement, shoe.position.distanceTo(basePos));
      minX = Math.min(minX, shoe.position.x);
      maxX = Math.max(maxX, shoe.position.x);
    }
    // 変位は -X 向き(anchor 局所 +Z の向き)にだけ出て、回転はしない
    assert.ok(basePos.x - minX > 0.15, `shoe did not stroke inward: ${basePos.x - minX}`);
    assert.ok(maxX - basePos.x < 0.01, `shoe moved the wrong way: ${maxX - basePos.x}`);
    assert.ok(shoe.quaternion.angleTo(baseQuat) < 1e-6, 'shoe rotated');
    assert.ok(maxDisplacement < 0.23, `stroke too large: ${maxDisplacement}`);
    ship.dispose();
  });
}
