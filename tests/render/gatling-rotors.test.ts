// 機関砲の回転砲身束の回転(SPEC/RENDERING.md「モジュール船体の描画」)の回帰テスト。射撃中に回り始め、
// トリガーを離すと減速して止まること、回転が表示時刻に従い一時停止中は止まること、破壊された武装の
// 砲身束は回らないことを見る。時定数そのものは調整値なので固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { GatlingRotors } from '../../src/render/dynamic/ship/gatling-rotors';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import type { ShipModuleRenderInput } from '../../src/render/dynamic/ship/ship-render-contract';
import { test } from '../harness';

const BARREL_COUNT = 6;
// 全砲口の合計射撃レート [rounds/s]。
const FIRE_RATE = 60;
// 1フレームの表示時刻の前進 [s]。1フレームの回転が π を超えない細かさにする。
const FRAME = 1 / 120;

// 砲身束 anchor を1つ持つ武装モデル。
function weaponModel(): THREE.Group {
  const root = new THREE.Group();
  const rotor = new THREE.Object3D();
  rotor.name = 'anchor:barrel-rotor:0';
  rotor.userData.semanticAnchor = 'barrel-rotor:0';
  rotor.userData.barrelCount = BARREL_COUNT;
  root.add(rotor);
  return root;
}

function weapon(id: string, hp: number): ShipModuleRenderInput {
  return {
    id, modelId: 'gun', kind: 'weapon', hp, maxHp: 100, deployed: null, burning: null,
    transform: { position: v3(), rotation: Q_IDENTITY },
  };
}

function rotorOf(ship: ModularShipView, id: string): THREE.Object3D {
  const rotor = ship.semanticAnchors(id, 'barrel-rotor:')[0];
  assert.ok(rotor !== undefined);
  return rotor;
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
  rotors: GatlingRotors, ship: ModularShipView, modules: readonly ShipModuleRenderInput[], rotor: THREE.Object3D,
  gunFireRate: number, time: number, frames: number,
): number[] {
  const speeds: number[] = [];
  for (let i = 1; i <= frames; i++) {
    const before = angleOf(rotor);
    rotors.sync(ship, modules, gunFireRate, time + i * FRAME);
    speeds.push(angleDelta(before, angleOf(rotor)) / FRAME);
  }
  return speeds;
}

// 1発ごとに砲身が1本ぶん回るときの、1つの砲身束の目標角速度 [rad/s]。
function targetSpeed(gunFireRate: number, rotorCount: number): number {
  return 2 * Math.PI * (gunFireRate / rotorCount) / BARREL_COUNT;
}

export function register(): void {
  test('gatling rotors: stay still from rest while not firing', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const rotors = new GatlingRotors();
    rotors.sync(ship, modules, 0, 0);
    const speeds = spinSpeeds(rotors, ship, modules, rotorOf(ship, 'gun-1'), 0, 0, 120);
    assert.ok(speeds.every((s) => s === 0));
    ship.dispose();
  });

  test('gatling rotors: spin up monotonically to the fire rate, then spin down to rest after release', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const rotor = rotorOf(ship, 'gun-1');
    const rotors = new GatlingRotors();
    rotors.sync(ship, modules, FIRE_RATE, 0);
    const target = targetSpeed(FIRE_RATE, 1);

    const up = spinSpeeds(rotors, ship, modules, rotor, FIRE_RATE, 0, 240);
    for (let i = 1; i < up.length; i++) assert.ok(up[i]! >= up[i - 1]!, `spin-up not monotonic at ${i}`);
    assert.ok(up.every((s) => s <= target * (1 + 1e-9)));
    assert.ok(Math.abs(up[up.length - 1]! - target) < target * 1e-3, `did not reach ${target}: ${up[up.length - 1]}`);

    const down = spinSpeeds(rotors, ship, modules, rotor, 0, 240 * FRAME, 1200);
    for (let i = 1; i < down.length; i++) assert.ok(down[i]! <= down[i - 1]!, `spin-down not monotonic at ${i}`);
    assert.ok(down[0]! > 0);
    assert.ok(down[down.length - 1]! < target * 1e-3, `did not stop: ${down[down.length - 1]}`);
    ship.dispose();
  });

  test('gatling rotors: the same display time twice does not turn the barrels', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-1', 100)];
    ship.sync(modules);
    const rotor = rotorOf(ship, 'gun-1');
    const rotors = new GatlingRotors();
    rotors.sync(ship, modules, FIRE_RATE, 0);
    spinSpeeds(rotors, ship, modules, rotor, FIRE_RATE, 0, 60);
    const pausedAt = 60 * FRAME;
    const angle = angleOf(rotor);
    for (let i = 0; i < 10; i++) rotors.sync(ship, modules, FIRE_RATE, pausedAt);
    assert.equal(angleOf(rotor), angle);
    ship.dispose();
  });

  test('gatling rotors: a destroyed weapon rotor is not driven and the fire rate goes to the healthy ones', () => {
    const ship = new ModularShipView(weaponModel);
    const modules = [weapon('gun-live', 100), weapon('gun-dead', 0)];
    ship.sync(modules);
    const live = rotorOf(ship, 'gun-live');
    const dead = rotorOf(ship, 'gun-dead');
    const rotors = new GatlingRotors();
    rotors.sync(ship, modules, FIRE_RATE, 0);
    const speeds = spinSpeeds(rotors, ship, modules, live, FIRE_RATE, 0, 240);
    assert.equal(angleOf(dead), 0);
    const target = targetSpeed(FIRE_RATE, 1);
    assert.ok(Math.abs(speeds[speeds.length - 1]! - target) < target * 1e-3);
    ship.dispose();
  });
}
