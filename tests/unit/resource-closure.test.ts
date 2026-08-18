// 設備の連鎖が閉じていることの検証(第8版 第1巻 §17-12)。
// 最初から持っている設備と、それが直ちに採れる資源から出発して前方に閉じ、
// RESOURCES のすべてが到達可能であること・その経路が初期の電力で歩けることを確かめる。
import * as assert from 'node:assert/strict';
import { AttractorId } from '../../src/physics/attractor';
import { DEPOSITS, DepositDef, ENEMY_DROPS } from '../../src/game/economy/deposit';
import {
  FACILITIES,
  FACILITY_IDS,
  FacilityDef,
  FacilityId,
  INITIAL_FACILITY_IDS,
} from '../../src/game/economy/facility';
import { RESOURCE_IDS, ResourceId } from '../../src/game/economy/resource';
import { test } from '../physics/harness';

const G0 = 9.80665; // [m/s^2]

// 現実的な質量比の上限(第1巻 §17-12 の 3〜6)。到達可能性は最も有利な側で判定する。
const MASS_RATIO = 6;

// 初期の太陽電池アレイ1面の発電量 [W]。solar-panel に至るまでの経路はこれで歩けねばならない。
const INITIAL_POWER_CAPACITY = FACILITIES['solar-array'].powerOutput;

// 閉包が発散していないことを見るための反復回数の上限。設備数ぶん回れば必ず不動点に達する。
const MAX_ITERATIONS = FACILITY_IDS.length + RESOURCE_IDS.length + 2;

// 推進系1つ。cond を満たす資源を持っていれば、その比推力が使える。
interface PropulsionOption {
  readonly name: string;
  readonly ispSec: number;
  // すべて必要な資源。内側の並びは、そのうち1つで足りる資源。
  readonly requires: readonly (readonly ResourceId[])[];
}

// 第2巻 §15-4 の推進系ごとの比推力。持っている資源で使える段が決まる。
const PROPULSION_OPTIONS: readonly PropulsionOption[] = [
  { name: '固体', ispSec: 250, requires: [['solid-propellant']] },
  { name: '貯蔵性', ispSec: 320, requires: [['hydrazine'], ['nitrogen-tetroxide']] },
  { name: '酸素/シラン', ispSec: 265, requires: [['silane'], ['oxygen']] },
  { name: '極低温(メタン)', ispSec: 370, requires: [['methane'], ['oxygen']] },
  { name: '極低温(水素)', ispSec: 450, requires: [['hydrogen'], ['oxygen']] },
  { name: '核熱', ispSec: 900, requires: [['hydrogen'], ['uranium', 'thorium']] },
  { name: '電気', ispSec: 3000, requires: [['xenon', 'argon'], ['electronics']] },
  { name: '核融合', ispSec: 1e4, requires: [['helium-3'], ['deuterium']] },
];

// 到達可能性の網の節点。DEPOSITS の天体に加え、経由地だけの節点を持つ。
type RouteNode = AttractorId | 'llo' | 'nrho' | 'leo';

// 第2巻 §15-2 の Δv の表。propulsive/aerobrake とも [km/s] で、
// aerobrake は熱シールド(炭素繊維複合材)を積んでいるときだけ使える。
interface RouteLeg {
  readonly from: RouteNode;
  readonly to: RouteNode;
  readonly propulsive: number;
  readonly aerobrake: number | null;
}

const ROUTE_LEGS: readonly RouteLeg[] = [
  { from: 'moon', to: 'llo', propulsive: 1.9, aerobrake: null },
  { from: 'llo', to: 'nrho', propulsive: 0.7, aerobrake: null },
  { from: 'moon', to: 'nrho', propulsive: 2.7, aerobrake: null },
  // 往路 3.4 / 復路 3.2 のうち、区間としては厳しい側を採る。
  { from: 'nrho', to: 'leo', propulsive: 3.4, aerobrake: 0.7 },
  { from: 'leo', to: 'bennu', propulsive: 4.5, aerobrake: null },
  { from: 'leo', to: 'ryugu', propulsive: 4.5, aerobrake: null },
  { from: 'leo', to: 'mars', propulsive: 5.7, aerobrake: 3.6 },
  { from: 'leo', to: 'venus', propulsive: 6.8, aerobrake: 3.5 },
  { from: 'leo', to: 'ceres', propulsive: 9.5, aerobrake: null },
  // プシケは表に無いが小惑星帯にあり、ケレスと同じ段に置く。
  { from: 'leo', to: 'psyche', propulsive: 9.5, aerobrake: null },
  { from: 'leo', to: 'callisto', propulsive: 11.0, aerobrake: 6.5 },
  { from: 'leo', to: 'titan', propulsive: 12.0, aerobrake: 7.5 },
  { from: 'callisto', to: 'io', propulsive: 3.5, aerobrake: null },
  // 木星系の衛星間は表に無い。カリストからの移動として、イオより安い側に置く。
  { from: 'callisto', to: 'ganymede', propulsive: 1.0, aerobrake: null },
  { from: 'callisto', to: 'europa', propulsive: 1.5, aerobrake: null },
  // 木星大気は捕集そのものより脱出が厳しく、そちらが区間の値を決める。
  { from: 'callisto', to: 'jupiter', propulsive: 20.0, aerobrake: null },
];

// 所持資源から出せる Δv [km/s]。持っている推進系のうち最も比推力の高いものを採る。
function deltaVCapability(owned: ReadonlySet<string>): number {
  let best = 0;
  for (const option of PROPULSION_OPTIONS) {
    if (!option.requires.every((group) => group.some((id) => owned.has(id)))) continue;
    best = Math.max(best, option.ispSec);
  }
  return (best * G0 * Math.log(MASS_RATIO)) / 1000;
}

// 今の推進剤で届く天体。月面から出発し、1区間ずつ Δv 能力の範囲で辿れる先を広げる。
// 熱シールドを積めるかどうか(炭素繊維複合材の有無)で使える区間の値が変わるため、
// この判定は所持資源に依存し、閉包の反復のたびに問い直される。
function reachableBodies(owned: ReadonlySet<string>): ReadonlySet<AttractorId> {
  const capability = deltaVCapability(owned);
  const canAerobrake = owned.has('carbon-composite');
  const visited = new Set<RouteNode>(['moon']);
  for (;;) {
    let grew = false;
    for (const leg of ROUTE_LEGS) {
      const cost = canAerobrake && leg.aerobrake !== null ? leg.aerobrake : leg.propulsive;
      if (cost > capability) continue;
      for (const [a, b] of [
        [leg.from, leg.to],
        [leg.to, leg.from],
      ] as const) {
        if (visited.has(a) && !visited.has(b)) {
          visited.add(b);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Set([...visited].filter((n) => n !== 'llo' && n !== 'nrho' && n !== 'leo') as AttractorId[]);
}

interface ClosureResult {
  readonly owned: ReadonlySet<ResourceId>;
  readonly built: ReadonlySet<FacilityId>;
  // 不動点に達するまでに要した反復回数。
  readonly iterations: number;
}

// 初期資源と初期設備から出発し、不動点に達するまで前方に閉じる。
// 設備の集合についても閉じる — 資源だけを追うと、資源はあるがそれを加工する
// 工場を作る手立てが無い、という詰まりを見逃す。
function reachableClosure(
  initial: ReadonlySet<ResourceId>,
  initialFacilities: ReadonlySet<FacilityId>,
  facilities: readonly (readonly [FacilityId, FacilityDef])[],
  deposits: readonly DepositDef[],
  bodiesOf: (owned: ReadonlySet<string>) => ReadonlySet<AttractorId>,
): ClosureResult {
  const owned = new Set<ResourceId>(initial);
  const built = new Set<FacilityId>(initialFacilities);
  // 敵の残骸は天体に紐づかず、月周辺でも遷移軌道でも得られる(§17-3)。
  for (const drop of ENEMY_DROPS) for (const d of drop.drops) owned.add(d.resourceId);
  let iterations = 0;
  for (;;) {
    iterations++;
    assert.ok(iterations <= MAX_ITERATIONS, `閉包が ${MAX_ITERATIONS} 反復で不動点に達しない`);
    const before = owned.size + built.size;
    for (const [id, f] of facilities) {
      if (!built.has(id)) {
        if (!f.buildCost.every((c) => owned.has(c.resourceId))) continue;
        if (!f.requiresFacility.every((r) => built.has(r as FacilityId))) continue;
      }
      if (!f.inputs.every((i) => i.anyOf.some((c) => owned.has(c)))) continue;
      built.add(id);
      for (const o of f.outputs) owned.add(o.resourceId);
    }
    const bodies = bodiesOf(owned);
    for (const d of deposits) {
      if (bodies.has(d.bodyId)) owned.add(d.resourceId);
    }
    if (owned.size + built.size === before) break;
  }
  return { owned, built, iterations };
}

const ALL_FACILITIES = FACILITY_IDS.map((id) => [id, FACILITIES[id]] as const);

function fullClosure(): ClosureResult {
  return reachableClosure(new Set(), new Set(INITIAL_FACILITY_IDS), ALL_FACILITIES, DEPOSITS, reachableBodies);
}

export function register(): void {
  test('closure: 閉包が有限回で不動点に達する', () => {
    const result = fullClosure();
    assert.ok(result.iterations <= MAX_ITERATIONS, `反復回数 ${result.iterations}`);
    // 同じ入力からは同じ不動点が出る。
    const again = fullClosure();
    assert.deepEqual([...again.owned].sort(), [...result.owned].sort());
    assert.deepEqual([...again.built].sort(), [...result.built].sort());
  });

  test('closure: RESOURCES のすべての資源が到達可能である', () => {
    const { owned } = fullClosure();
    const missing = RESOURCE_IDS.filter((id) => !owned.has(id));
    assert.deepEqual(missing, [], `到達できない資源: ${missing.join(', ')}`);
  });

  test('closure: FACILITIES のすべての設備が建設可能である', () => {
    const { built } = fullClosure();
    const missing = FACILITY_IDS.filter((id) => !built.has(id));
    assert.deepEqual(missing, [], `建設できない設備: ${missing.join(', ')}`);
  });

  test('closure: 初期設備だけで最初の一巡が始まる', () => {
    // 初期設備と月の産地だけに閉じても、初期設備がすべて動き出せること。
    const initialOnly = ALL_FACILITIES.filter(([id]) => INITIAL_FACILITY_IDS.includes(id));
    const moonOnly = DEPOSITS.filter((d) => d.bodyId === 'moon');
    const { owned } = reachableClosure(
      new Set(),
      new Set(INITIAL_FACILITY_IDS),
      initialOnly,
      moonOnly,
      () => new Set<AttractorId>(['moon']),
    );
    for (const id of INITIAL_FACILITY_IDS) {
      const f = FACILITIES[id];
      for (const i of f.inputs) {
        assert.ok(
          i.anyOf.some((c) => owned.has(c)),
          `初期設備 ${id} の入力 ${i.anyOf.join('|')} が初期の一組だけでは賄えない`,
        );
      }
    }
  });

  test('closure: 太陽電池に至る経路が初期の発電容量だけで歩ける', () => {
    // 太陽電池アレイは solar-panel さえあれば何基でも建つため、そこに届いた時点で
    // 発電容量は事実上無制限になる。詰まりうるのは solar-panel までの経路だけであり、
    // その経路上の設備はすべて初期の1面ぶんの発電で動かせなければならない。
    const affordable = ALL_FACILITIES.filter(([, f]) => f.powerDraw <= INITIAL_POWER_CAPACITY);
    const { owned, built } = reachableClosure(
      new Set(),
      new Set(INITIAL_FACILITY_IDS),
      affordable,
      DEPOSITS,
      reachableBodies,
    );
    assert.ok(owned.has('solar-panel'), '初期の発電容量だけでは太陽電池に到達できない');

    // 経路上で本当に要る設備 — 1基でも欠けば solar-panel に届かなくなるもの。
    let maxDraw = 0;
    for (const id of built) {
      const without = affordable.filter(([other]) => other !== id);
      const rest = reachableClosure(
        new Set(),
        new Set(INITIAL_FACILITY_IDS.filter((f) => f !== id)),
        without,
        DEPOSITS,
        reachableBodies,
      );
      if (rest.owned.has('solar-panel')) continue;
      maxDraw = Math.max(maxDraw, FACILITIES[id].powerDraw);
    }
    assert.ok(
      maxDraw <= INITIAL_POWER_CAPACITY,
      `太陽電池に至る経路の最大消費電力 ${maxDraw} W が初期の発電容量 ${INITIAL_POWER_CAPACITY} W を超える`,
    );
  });

  test('closure: すべての推進系が資源の到達可能性の上で成立する', () => {
    const { owned } = fullClosure();
    for (const option of PROPULSION_OPTIONS) {
      for (const group of option.requires) {
        assert.ok(
          group.some((id) => owned.has(id)),
          `推進系 ${option.name} の要求資源 ${group.join('|')} に到達できない`,
        );
      }
    }
  });

  test('closure: DEPOSITS のすべての天体に届く', () => {
    const { owned } = fullClosure();
    const bodies = reachableBodies(owned);
    const missing = [...new Set(DEPOSITS.map((d) => d.bodyId))].filter((b) => !bodies.has(b));
    assert.deepEqual(missing, [], `届かない天体: ${missing.join(', ')}`);
  });
}
