// 機関砲の被駆動部(回転砲身束・給弾部・送り路・後座部)の回帰テスト。
// 射撃中に回り始め、トリガーを離すと減速して止まること、駆動が表示時刻に従い一時停止中は
// 止まること、破壊された武装の駆動部は回らないこと、向きを持つ anchor は定めた軸だけに沿って
// 動くこと、後座が砲架の前進位置と後座量の間に収まり追従部品が後座量どおりに動くことを見る。
// 時定数そのものは調整値なので固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { WeaponDrives, type WeaponRecoilInput } from '../../src/render/dynamic/ship/weapon-drives';
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
  return root;
}

const RECOIL_TRAVEL = 0.4;
const SPRING_REST_LENGTH = 0.7;
const LEVER_RATE = -2;

// 後座 anchor と、その後座量に追従する圧縮部品・リンクを1つずつ持つ武装モデル。
function recoilModel(): THREE.Group {
  const root = new THREE.Group();
  const recoil = new THREE.Object3D();
  recoil.name = 'anchor:gun-recoil:0';
  recoil.userData = { semanticAnchor: 'gun-recoil:0', recoilTravel: RECOIL_TRAVEL };
  recoil.position.set(0, 0, 0.3);
  root.add(recoil);
  const spring = new THREE.Object3D();
  spring.name = 'anchor:gun-recoil-compress:0:0';
  spring.userData = { semanticAnchor: 'gun-recoil-compress:0:0', restLength: SPRING_REST_LENGTH };
  spring.position.set(1, -0.6, 0.5);
  root.add(spring);
  const lever = new THREE.Object3D();
  lever.name = 'anchor:gun-recoil-lever:0:0';
  lever.userData = { semanticAnchor: 'gun-recoil-lever:0:0', leverRate: LEVER_RATE };
  lever.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
  root.add(lever);
  return root;
}

// 表示時刻 time [s] に、burstStart から burstEnd まで連射した砲口 0 の直近発射記録。
function lastShot(time: number, burstStart: number, burstEnd: number): readonly WeaponRecoilInput[] {
  const interval = 1 / FIRE_RATE;
  const index = Math.floor((Math.min(time, burstEnd) - burstStart) / interval + 1e-9);
  if (index < 0) return [];
  return [{ moduleId: 'gun-1', muzzleIndex: 0, firedAt: burstStart + index * interval, cycleDuration: interval }];
}

// 指定 hp の武装モジュールの render input。transform は原点・無回転。
function weapon(id: string, hp: number): ShipModuleRenderInput {
  return {
    id, modelId: 'gun', kind: 'weapon', hp, maxHp: 100, deployed: null, burning: null,
    transform: { position: v3(), rotation: Q_IDENTITY },
  };
}

// モジュール id の接頭辞 name の anchor。1つも無ければその場で失敗にする。
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

  test('weapon drives: the feed shoe reciprocates along its declared axis without rotating', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const shoe = anchors(ship, 'gun-1', 'feed-shoe')[0]!;
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    const basePos = shoe.position.clone();
    const baseQuat = shoe.quaternion.clone();
    // 案内爪は1リンク(40発)で1往復する。起動の遅れを見越して1往復ぶんより長く進め、
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

  test('weapon drives: a conveyor advances one pitch per round along its axis and wraps within a pitch', () => {
    const pitch = 0.33;
    // 送り路の anchor を +Y を送り方向にして1つ持つ武装モデル。
    const model = (): THREE.Group => {
      const root = new THREE.Group();
      const conveyor = new THREE.Object3D();
      conveyor.name = 'anchor:feed-conveyor';
      conveyor.userData = { semanticAnchor: 'feed-conveyor', conveyorPitch: pitch };
      conveyor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
      root.add(conveyor);
      return root;
    };
    const ship = new ModularShipView(model);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const conveyor = anchors(ship, 'gun-1', 'feed-conveyor')[0]!;
    const basePos = conveyor.position.clone();
    const drives = new WeaponDrives();
    drives.sync(ship, modules, FIRE_RATE, 0);
    let travelled = 0;
    let previous = 0;
    for (let i = 1; i <= 240; i++) {
      drives.sync(ship, modules, FIRE_RATE, i * FRAME);
      const offset = conveyor.position.clone().sub(basePos);
      assert.ok(Math.abs(offset.x) < 1e-9 && Math.abs(offset.z) < 1e-9, 'conveyor left its axis');
      assert.ok(offset.y >= -1e-9 && offset.y < pitch, `conveyor offset ${offset.y} outside one pitch`);
      travelled += ((offset.y - previous) % pitch + pitch) % pitch;
      previous = offset.y;
    }
    // 起動の遅れのぶん、十分に回ったあとの送り量は発射数ぶんに届かない
    assert.ok(travelled > pitch * FIRE_RATE * 240 * FRAME * 0.5, `conveyor barely moved: ${travelled}`);
    assert.ok(travelled <= pitch * FIRE_RATE * 240 * FRAME * (1 + 1e-9), `conveyor overran: ${travelled}`);
    ship.dispose();
  });

  test('weapon drives: recoil stays between battery and full travel, reaches it, and returns to battery', () => {
    const ship = new ModularShipView(recoilModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const battery = recoil.position.z;
    const drives = new WeaponDrives();
    let maxDisplacement = 0;
    // 1 ms 刻みで、0.1 s から 1.3 s まで連射し、その後 3 s 置く
    const step = 0.001;
    for (let i = 0; i <= 4.3 / step; i++) {
      const time = i * step;
      const firing = time >= 0.1 && time < 1.3;
      drives.sync(ship, modules, firing ? FIRE_RATE : 0, time, lastShot(time, 0.1, 1.29));
      const displacement = battery - recoil.position.z;
      assert.ok(displacement >= -1e-9, `recoil ran forward of battery at ${time}: ${displacement}`);
      assert.ok(displacement <= RECOIL_TRAVEL + 1e-9, `recoil exceeded travel at ${time}: ${displacement}`);
      maxDisplacement = Math.max(maxDisplacement, displacement);
    }
    assert.ok(maxDisplacement > 0.9 * RECOIL_TRAVEL, `recoil did not reach its travel: ${maxDisplacement}`);
    assert.ok(battery - recoil.position.z < 1e-3 * RECOIL_TRAVEL, `recoil did not return: ${battery - recoil.position.z}`);
    ship.dispose();
  });

  test('weapon drives: recoil holds still while the display time is paused', () => {
    const ship = new ModularShipView(recoilModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const drives = new WeaponDrives();
    const pausedAt = 0.1 + 40 * FRAME + 0.003;
    for (let i = 0; i * FRAME < pausedAt; i++) drives.sync(ship, modules, FIRE_RATE, i * FRAME, lastShot(i * FRAME, 0.1, 2));
    drives.sync(ship, modules, FIRE_RATE, pausedAt, lastShot(pausedAt, 0.1, 2));
    const held = recoil.position.z;
    for (let i = 0; i < 10; i++) drives.sync(ship, modules, FIRE_RATE, pausedAt, lastShot(pausedAt, 0.1, 2));
    assert.equal(recoil.position.z, held);
    ship.dispose();
  });

  test('weapon drives: recoil followers compress and turn by the recoil displacement', () => {
    const ship = new ModularShipView(recoilModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const recoil = anchors(ship, 'gun-1', 'gun-recoil:')[0]!;
    const spring = anchors(ship, 'gun-1', 'gun-recoil-compress:')[0]!;
    const lever = anchors(ship, 'gun-1', 'gun-recoil-lever:')[0]!;
    const battery = recoil.position.z;
    const leverBase = lever.quaternion.clone();
    const drives = new WeaponDrives();
    for (let i = 0; i <= 1.0 / FRAME; i++) {
      const time = i * FRAME;
      drives.sync(ship, modules, FIRE_RATE, time, lastShot(time, 0.1, 2));
      const displacement = battery - recoil.position.z;
      // 固定端から見た可動端は、後座した機関部と同じだけ縮む
      assert.ok(Math.abs(SPRING_REST_LENGTH * spring.scale.z - (SPRING_REST_LENGTH - displacement)) < 1e-9);
      const turn = leverBase.clone().invert().multiply(lever.quaternion);
      const angle = 2 * Math.atan2(turn.z, turn.w);
      assert.ok(Math.abs(angle - displacement * LEVER_RATE) < 1e-9, `lever angle ${angle} vs ${displacement * LEVER_RATE}`);
    }
    ship.dispose();
  });
}
