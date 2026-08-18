// 通信圏(§13)の回帰テスト。見通し・到達距離・多段中継の閉包という3つの条件が、
// それぞれ独立に圏内外を決めることを固定する。
import * as assert from 'node:assert/strict';
import { activeRelays, isInCommRange, type CommOccluder, type CommRelay } from '../../src/game/comms/coverage';
import { initialCommStations } from '../../src/game/comms/comm-stations';
import {
  ALWAYS_IN_COVERAGE, canAutopilot, isOperable,
  type CapabilityVessel, type CoverageQuery,
} from '../../src/game/vessel/capabilities';
import { COMM_MODULE_SPECS, createCommModule, crewedParts } from '../../src/game/vessel/vessel-parts';
import { createPart } from '../../src/game/game-entity/parts';
import type { AnyPart } from '../../src/game/game-entity/parts';
import { Ephemeris } from '../../src/physics/ephemeris';
import { len, sub } from '../../src/physics/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3, Vec3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

const KM = 1000;

function relay(id: string, x: number, range: number, isGround = false): CommRelay {
  return { id, pos: v3(x, 0, 0), range, isGround };
}

// 半径 r の球を x に置いた遮蔽天体。
function body(x: number, r: number): CommOccluder {
  return { radius: r, state: kinematicState(0, v3(x, 0, 0), v3()) };
}

const NO_BODIES: readonly CommOccluder[] = [];

// 通信基地1つだけの網。x=0 に置き、到達距離を呼び出し側が決める。
function groundOnly(range: number): readonly CommRelay[] {
  return activeRelays([relay('ground', 0, range, true)], NO_BODIES);
}

function at(x: number): Vec3 {
  return v3(x, 0, 0);
}

export function register(): void {
  test('通信基地が1つも無ければ、どこにいても圏外になる', () => {
    const relays = [relay('sat-a', 1000 * KM, 5000 * KM), relay('sat-b', 2000 * KM, 5000 * KM)];
    assert.deepEqual(activeRelays(relays, NO_BODIES), []);
    assert.equal(isInCommRange(at(1000 * KM), activeRelays(relays, NO_BODIES), 5000 * KM, NO_BODIES), false);
  });

  test('天体に遮られた見通しは圏外になる', () => {
    const active = groundOnly(10000 * KM);
    const pos = at(4000 * KM);
    // 遮る天体が無ければ圏内。
    assert.equal(isInCommRange(pos, active, 10000 * KM, NO_BODIES), true);
    // 基地と機体のちょうど中間に、視線を塞ぐ球を置くと圏外になる。
    const blocked = [body(2000 * KM, 500 * KM)];
    assert.equal(isInCommRange(pos, active, 10000 * KM, blocked), false);
    // 視線から外れた位置にある同じ大きさの球は遮らない。
    const aside: readonly CommOccluder[] = [{ radius: 500 * KM, state: kinematicState(0, v3(2000 * KM, 2000 * KM, 0), v3()) }];
    assert.equal(isInCommRange(pos, active, 10000 * KM, aside), true);
  });

  test('到達距離は機体側と中継点側の小さいほうで決まる', () => {
    const dist = 500 * KM;
    const near = 100 * KM;
    const far = 1000 * KM;
    // 中継点が強力でも、機体の通信モジュールが小型なら届かない。
    assert.equal(isInCommRange(at(dist), groundOnly(far), near, NO_BODIES), false);
    // 逆に機体が強力でも、中継点の到達距離が短ければ届かない。
    assert.equal(isInCommRange(at(dist), groundOnly(near), far, NO_BODIES), false);
    // 両側とも足りていれば届く。
    assert.equal(isInCommRange(at(dist), groundOnly(far), far, NO_BODIES), true);
    // 小さいほうが距離をちょうど満たす場合も届く。
    assert.equal(isInCommRange(at(near), groundOnly(far), near, NO_BODIES), true);
    // 通信モジュールを積んでいない(到達距離0)機体は圏内にならない。
    assert.equal(isInCommRange(at(0), groundOnly(far), 0, NO_BODIES), false);
  });

  test('基地と繋がっていない孤立した中継点は誰も圏内にしない', () => {
    const reach = 1000 * KM;
    // 基地から 5000 km 離れた場所に、強力だが誰とも繋がらない中継点を置く。
    const relays = [
      relay('ground', 0, reach, true),
      relay('orphan', 5000 * KM, 100000 * KM),
    ];
    const active = activeRelays(relays, NO_BODIES);
    assert.deepEqual(active.map((r) => r.id), ['ground']);
    // その中継点のすぐ傍にいる機体も圏外のままである。
    assert.equal(isInCommRange(at(5000 * KM), active, 100000 * KM, NO_BODIES), false);
  });

  test('基地から2ホップ先の中継点が有効になる', () => {
    const reach = 1200 * KM;
    const relays = [
      relay('ground', 0, reach, true),
      relay('hop1', 1000 * KM, reach),
      relay('hop2', 2000 * KM, reach),
    ];
    const active = activeRelays(relays, NO_BODIES);
    assert.deepEqual([...active.map((r) => r.id)].sort(), ['ground', 'hop1', 'hop2']);
    // hop2 は基地から直接は届かない(2000 km > 1200 km)。中継の連鎖でだけ有効になる。
    assert.equal(isInCommRange(at(2000 * KM), groundOnly(reach), reach, NO_BODIES), false);
    // 有効になった hop2 のおかげで、その先の機体まで圏が伸びる。
    assert.equal(isInCommRange(at(3000 * KM), active, reach, NO_BODIES), true);
    // 中継の途中(hop1)を抜くと連鎖が切れ、hop2 は有効でなくなる。
    const broken = activeRelays([relays[0]!, relays[2]!], NO_BODIES);
    assert.deepEqual(broken.map((r) => r.id), ['ground']);
  });

  test('連鎖の途中が天体に遮られると、その先の中継点は有効にならない', () => {
    const reach = 1200 * KM;
    const relays = [
      relay('ground', 0, reach, true),
      relay('hop1', 1000 * KM, reach),
      relay('hop2', 2000 * KM, reach),
    ];
    // ground と hop1 の間を塞ぐ。hop1 が落ちれば hop2 も落ちる。
    const blocked = [body(500 * KM, 200 * KM)];
    assert.deepEqual(activeRelays(relays, blocked).map((r) => r.id), ['ground']);
  });
}

// 通信基地2つだけの初期状態を、実際の天体暦の上で組む。
function initialNetwork(t: number): {
  readonly active: readonly CommRelay[];
  readonly attractors: readonly CommOccluder[];
  readonly coverage: CoverageQuery;
  readonly ephemeris: Ephemeris;
} {
  const ephemeris = new Ephemeris();
  const attractors = ephemeris.attractorsAt(t);
  const active = activeRelays([...initialCommStations(ephemeris, t)], attractors);
  const coverage: CoverageQuery = {
    inCoverage: (pos, range) => isInCommRange(pos, active, range, attractors),
  };
  return { active, attractors, coverage, ephemeris };
}

// 部品一覧と位置だけを持つ、能力判定に必要な最小の機体。
function vesselAt(parts: readonly AnyPart[], pos: Vec3): CapabilityVessel {
  return { parts, state: { r: pos } };
}

export function registerInitialCoverage(): void {
  test('初期の通信網は月面基地と NRHO 基地の2点だけで、どちらも起点になる', () => {
    const { active } = initialNetwork(0);
    assert.equal(active.length, 2);
    assert.equal(active.every((r) => r.isGround), true);
  });

  test('初期の通信圏では地球低軌道が距離で圏外になり、月の傍は圏内になる', () => {
    const t = 0;
    const { active, attractors, coverage, ephemeris } = initialNetwork(t);
    const large = COMM_MODULE_SPECS.large.range;

    // 地球低軌道。地球-月間の距離があるため、大型モジュールを積んでいても届かない。
    const earth = ephemeris.positionOf('earth', t);
    const leo = { x: earth.x + 6.8e6, y: earth.y, z: earth.z } as Vec3;
    assert.equal(coverage.inCoverage(leo, large), false);

    // 月面基地のすぐ傍(月の表側の地表から 100 km)は、小型モジュールでも圏内。
    const nearBase = active.find((r) => r.id.includes('moon'))!;
    const toEarth = sub(earth, nearBase.pos);
    const scaleTo100km = 1e5 / len(toEarth);
    const justAbove = {
      x: nearBase.pos.x + toEarth.x * scaleTo100km,
      y: nearBase.pos.y + toEarth.y * scaleTo100km,
      z: nearBase.pos.z + toEarth.z * scaleTo100km,
    } as Vec3;
    assert.equal(isInCommRange(justAbove, active, COMM_MODULE_SPECS.small.range, attractors), true);

  });

  test('月面基地だけでは月の裏側が圏外になり、NRHO 基地がそこを覆う', () => {
    const t = 0;
    const ephemeris = new Ephemeris();
    const attractors = ephemeris.attractorsAt(t);
    const stations = initialCommStations(ephemeris, t);
    const moonBase = stations.find((r) => r.id.includes('moon'))!;
    const moon = ephemeris.attractorAt('moon', t);

    // 月面基地の対蹠点の 100 km 上空。基地は月面に立っているので、自分の乗る月に遮られる。
    const down = sub(moon.state.r, moonBase.pos);
    const outward = (moon.radius + 1e5) / len(down);
    const farSide = {
      x: moon.state.r.x + down.x * outward,
      y: moon.state.r.y + down.y * outward,
      z: moon.state.r.z + down.z * outward,
    } as Vec3;

    const large = COMM_MODULE_SPECS.large.range;
    const moonOnly = activeRelays([moonBase], attractors);
    assert.equal(isInCommRange(farSide, moonOnly, large, attractors), false);
    // 月の外側(地球-月 L2)に居る NRHO 基地からは見通せる。
    assert.equal(isInCommRange(farSide, activeRelays([...stations], attractors), large, attractors), true);
  });

  test('圏外の無人機は自動操縦できず、有人機は圏外でも操作できる', () => {
    const { coverage, ephemeris } = initialNetwork(0);
    const earth = ephemeris.positionOf('earth', 0);
    const leo = { x: earth.x + 6.8e6, y: earth.y, z: earth.z } as Vec3;

    const drone = vesselAt([
      createPart('autopilot', { name: 'Autopilot', maxHp: 10, hp: 10 }),
      createCommModule('large'),
    ], leo);
    assert.equal(canAutopilot(drone, ALWAYS_IN_COVERAGE), true, 'test setup: 装置は揃っていること');
    assert.equal(canAutopilot(drone, coverage), false);
    assert.equal(isOperable(drone, coverage), false);

    const crewed = vesselAt(crewedParts(1000), leo);
    assert.equal(isOperable(crewed, coverage), true);
  });
}
