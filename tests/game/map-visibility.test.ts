// マップ表示の可視性規則(map/ と CelestialSystem の系の所属)と、ラグランジュ点が力学的に意味を持つかの
// 判定(lagrange.ts + CelestialMotion)の回帰テスト。どちらも DOM を持たない純粋な規則なので、
// 「どう見えるか」ではなく「何が見えるべきか」だけをここで固定する。
import { motionOf, orbitingMotionOf, positionOf, solarSystemParts, TEST_EPOCH } from '../physics/test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  TRIANGULAR_STABILITY_MASS_RATIO, collinearClearanceRatio, hasStableTriangularPoints,
} from '../../src/physics/lagrange';
import { OrbitingMotion } from '../../src/physics/celestial-motion';
import {
  applyMapDisplayMode, mapDisplayModeOf, celestialClassVisible, celestialNameVisible,
  MapDisplayToggles, DEFAULT_MAP_DISPLAY_TOGGLES, nextMapDisplayMode,
} from '../../src/game/map/display-toggles';
import { alwaysFullyVisibleIds } from '../../src/game/map/visibility-policy';
import { CelestialSystem } from '../../src/game/celestial/celestial-system';
import { v3, addScaled } from '../../src/math/vec3';

const MIN_CLEARANCE = 10;

// 現実の太陽系。可視性の規則も静的事実もここから引く。
const PARTS = solarSystemParts();
const SYSTEM = PARTS.system;

// マーカーの点か名前のどちらかが出る天体の集合。クラストグルで足される天体と、恒星・
// フォーカス系・カメラ近傍として無条件に足される天体の和になる。
function visibleBodyIds(
  focusId: string | undefined, toggles: MapDisplayToggles,
  nearbyIds: Iterable<string> = [],
): ReadonlySet<string> {
  const forced = alwaysFullyVisibleIds(SYSTEM, focusId, nearbyIds, toggles);
  const set = new Set<string>();
  for (const body of SYSTEM.entities) {
    const cls = body.bodyClass;
    if (!celestialClassVisible(cls, toggles)) continue;
    if (forced.has(body.id) || celestialNameVisible(cls, toggles)) set.add(body.id);
  }
  return set;
}

// 衛星クラスの Name を畳んだトグル。フォーカス由来・カメラ近傍由来の追加規則は、
// クラストグル自身が既にその天体を足している間は観測できないので、その規則を固定する
// テストはこちらを使う。
const SATELLITES_OFF: MapDisplayToggles = {
  ...DEFAULT_MAP_DISPLAY_TOGGLES, satelliteName: false,
};

// 登録天体の主天体に対する質量比。
function massRatio(id: string): number {
  const motion = motionOf(PARTS, id);
  return motion.def.mu / (motion.primary!.def.mu + motion.def.mu);
}

export function register(): void {
  test('lagrange: Routh の臨界質量比は 27mu(1−mu) = 1 の解と一致する', () => {
    const mu = TRIANGULAR_STABILITY_MASS_RATIO;
    assert.ok(Math.abs(27 * mu * (1 - mu) - 1) < 1e-12, `27mu(1-mu) = ${27 * mu * (1 - mu)}`);
    assert.ok(Math.abs(mu - 0.0385209) < 1e-6, `臨界質量比: ${mu}`);
    // 同値な表現 m1/m2 > (25+3√69)/2 ≈ 24.96 との整合。
    assert.ok(Math.abs((1 - mu) / mu - (25 + 3 * Math.sqrt(69)) / 2) < 1e-9);
  });

  test('lagrange: 質量比が臨界値を跨ぐと三角点の安定性が切り替わる', () => {
    assert.ok(hasStableTriangularPoints(TRIANGULAR_STABILITY_MASS_RATIO * 0.99));
    assert.ok(!hasStableTriangularPoints(TRIANGULAR_STABILITY_MASS_RATIO * 1.01));
    // 地球-月(0.0122)は臨界値の内側、冥王星-カロン相当(0.109)は外側。
    assert.ok(hasStableTriangularPoints(0.0122));
    assert.ok(!hasStableTriangularPoints(0.109));
  });

  test('lagrange: 共線点の余裕は現行レジストリのしきい値の内外を再現する', () => {
    const clearance = (id: string): number => {
      const def = motionOf(PARTS, id).def as { radius: number; orbit: { a?: number; kepler?: { a: number } } };
      const orbit = def.orbit.kepler ?? (def.orbit as { a: number });
      return collinearClearanceRatio(massRatio(id), orbit.a, def.radius);
    };
    // しきい値の近くにある系。ここが動くと判定が変わるので明示的に固定する。
    assert.ok(Math.abs(clearance('triton') - 10.63) < 0.1, `トリトン: ${clearance('triton')}`);
    assert.ok(Math.abs(clearance('europa') - 8.69) < 0.1, `エウロパ: ${clearance('europa')}`);
    // L1 が表面すれすれに来る系。
    assert.ok(clearance('phobos') < 2, `フォボス: ${clearance('phobos')}`);
  });

  test('lagrange: 運動はしきい値の内外で共線点の可否を答える', () => {
    assert.ok(orbitingMotionOf(PARTS, 'moon').hasUsableCollinearPoints(MIN_CLEARANCE));
    assert.ok(orbitingMotionOf(PARTS, 'titan').hasUsableCollinearPoints(MIN_CLEARANCE));
    assert.ok(!orbitingMotionOf(PARTS, 'phobos').hasUsableCollinearPoints(MIN_CLEARANCE));
    assert.ok(!orbitingMotionOf(PARTS, 'io').hasUsableCollinearPoints(MIN_CLEARANCE));
    // 恒星は主天体を持たないので共線点も三角点も持たない(公転運動ですらない)。
    assert.ok(!(motionOf(PARTS, 'sun') instanceof OrbitingMotion));
  });

  test('visibility: 既定では恒星・惑星・準惑星・小天体・衛星が見える', () => {
    const visible = visibleBodyIds('earth', DEFAULT_MAP_DISPLAY_TOGGLES);
    for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
      assert.ok(visible.has(id), `${id} は常に見えるべき`);
    }
    // Name はラベルの混雑抑制が効くので、軌道線と違って全クラス既定で立つ。
    for (const id of ['halley', 'encke', 'vesta', 'io', 'titan', 'triton']) {
      assert.ok(visible.has(id), `${id} は既定で見えるべき`);
    }
    for (const id of ['ceres', 'pluto']) assert.ok(visible.has(id), `${id} は既定で見えるべき`);
    // 衛星クラスを畳めば、フォーカス系の外の衛星は隠れる。
    const noSatellites = visibleBodyIds('earth', SATELLITES_OFF);
    for (const id of ['io', 'titan', 'triton']) {
      assert.ok(!noSatellites.has(id), `${id} は衛星トグル OFF では見えないべき`);
    }
  });

  test('visibility controls: 対象クラスは非表示→ラベル→軌道+ラベルを循環する', () => {
    const orbit = mapDisplayModeOf(DEFAULT_MAP_DISPLAY_TOGGLES, 'planetVisible');
    assert.equal(orbit, 'orbit');
    assert.equal(nextMapDisplayMode(orbit, true), 'hidden');
    assert.equal(nextMapDisplayMode('hidden', true), 'label');
    assert.equal(nextMapDisplayMode('label', true), 'orbit');

    const label = applyMapDisplayMode(DEFAULT_MAP_DISPLAY_TOGGLES, 'planetVisible', 'label');
    assert.equal(label.planetVisible, true);
    assert.equal(label.planetName, true);
    assert.equal(label.planetOrbit, false);

    const hidden = applyMapDisplayMode(label, 'planetVisible', 'hidden');
    assert.equal(mapDisplayModeOf(hidden, 'planetVisible'), 'hidden');
    assert.equal(hidden.planetVisible, false);
    assert.equal(hidden.planetName, false);
    assert.equal(hidden.planetOrbit, false);

    assert.equal(nextMapDisplayMode('hidden', false), 'label');
    assert.equal(nextMapDisplayMode('label', false), 'hidden');
  });

  test('visibility: フォーカス中の天体の子はトグル無しで見える', () => {
    const visible = visibleBodyIds('jupiter', SATELLITES_OFF);
    for (const id of ['io', 'europa', 'ganymede', 'callisto']) {
      assert.ok(visible.has(id), `木星にフォーカスすれば ${id} が見えるべき`);
    }
    // 別の惑星の衛星までは出てこない。
    assert.ok(!visible.has('titan'));
    assert.ok(!visible.has('phobos'));
  });

  test('visibility: フォーカス中の天体の親と兄弟も見える', () => {
    const visible = visibleBodyIds('io', SATELLITES_OFF);
    assert.ok(visible.has('jupiter'), '親');
    assert.ok(visible.has('europa'), '兄弟');
    assert.ok(visible.has('io'), '自分自身');
    assert.ok(!visible.has('titan'), '別の系の衛星は出ない');
  });

  test('visibility: クラストグルを立てるとそのクラスが全数見える', () => {
    const visible = visibleBodyIds('earth', { ...SATELLITES_OFF, satelliteName: true });
    for (const id of ['moon', 'io', 'titan', 'triton', 'phobos']) {
      assert.ok(visible.has(id), `${id} が見えるべき`);
    }
    assert.ok(visible.has('ceres'), '準惑星は既定のトグルで見える');
  });

  // 天体ラベルの並びと字下げはこの深さで決まるので、その導出だけを固定する。
  test('visibility: 親子の深さは主星を 0 として数えられる', () => {
    const depth = (id: string): number => {
      let d = 0;
      for (let cur = motionOf(PARTS, id).primary; cur !== null; cur = cur.primary) d++;
      return d;
    };
    assert.equal(depth('sun'), 0);
    assert.equal(depth('jupiter'), 1);
    assert.equal(depth('io'), 2);
  });

  // 天体を足すたび、新しい天体が「衛星トグルを畳めば出ず、親にフォーカスすると出る」ことを固定する。
  test('visibility: 木星・土星にフォーカスすると、衛星トグルを畳んでもその衛星が現れる', () => {
    const jupiterMoons = ['metis', 'adrastea', 'amalthea', 'thebe', 'himalia', 'elara', 'ananke', 'carme', 'pasiphae', 'sinope'];
    const saturnMoons = ['pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'hyperion', 'iapetus', 'phoebe'];

    const atEarth = visibleBodyIds('earth', SATELLITES_OFF);
    for (const id of [...jupiterMoons, ...saturnMoons, 'nereid']) {
      assert.ok(!atEarth.has(id), `${id} が地球にいる間から見えている`);
    }

    const atJupiter = visibleBodyIds('jupiter', SATELLITES_OFF);
    for (const id of jupiterMoons) assert.ok(atJupiter.has(id), `${id} が木星にフォーカスしても見えない`);

    const atSaturn = visibleBodyIds('saturn', SATELLITES_OFF);
    for (const id of saturnMoons) assert.ok(atSaturn.has(id), `${id} が土星にフォーカスしても見えない`);

    assert.ok(visibleBodyIds('neptune', SATELLITES_OFF).has('nereid'), 'ネレイド');
  });

  test('visibility: 未登録の id にフォーカスしても恒星・惑星は見え続ける', () => {
    const visible = visibleBodyIds('asteroid-1', DEFAULT_MAP_DISPLAY_TOGGLES);
    assert.ok(visible.has('earth'));
    assert.ok(visible.has('sun'));
  });

  test('visibility: focusId が undefined でも恒星・惑星とトグルで足したクラスは見える', () => {
    const visible = visibleBodyIds(undefined, { ...SATELLITES_OFF, satelliteName: true });
    assert.ok(visible.has('earth'));
    assert.ok(visible.has('sun'));
    assert.ok(visible.has('moon'), 'トグルで足したクラスは無条件で見える');
    // フォーカス由来の親子・兄弟の追加が無いことを、衛星トグルを畳んだ状態で確認する。
    const visibleNoSatellites = visibleBodyIds(undefined, SATELLITES_OFF);
    assert.ok(!visibleNoSatellites.has('moon'), 'フォーカスが無ければ親子関係による追加も無い');
  });

  test('visibility: フォーカス解除後もカメラ近傍の惑星系の衛星は見える', () => {
    const nearby = SYSTEM.systemMembersAt(v3(), 0);
    const visible = visibleBodyIds(undefined, SATELLITES_OFF, nearby);
    assert.ok(nearby.includes('earth'));
    assert.ok(nearby.includes('moon'));
    assert.ok(visible.has('moon'), '地球近傍カメラではフォーカス解除後も月を残す');

    // 近傍系ではない衛星は、衛星トグル OFF のままなら絞り込む。
    assert.ok(!visible.has('titan'), '遠方系の衛星まで追加しない');
  });

  test('visibility: フォーカス天体の系に属する位置だけを player 表示対象にする', () => {
    const moon = positionOf(PARTS, 'moon', 0);
    const saturn = positionOf(PARTS, 'saturn', 0);
    // 地球周回と、その子である月周回は地球フォーカスで表示する。一方で土星近傍は除く。
    assert.ok(SYSTEM.isPositionInFocusedSystem('earth', v3(7e6, 0, 0), 0));
    assert.ok(SYSTEM.isPositionInFocusedSystem('earth', addScaled(moon, v3(1, 0, 0), 1e6), 0));
    assert.ok(!SYSTEM.isPositionInFocusedSystem('earth', addScaled(saturn, v3(1, 0, 0), 1e8), 0));
    // 天体以外のフォーカスは系を特定できないため、表示を絞らない。
    assert.ok(SYSTEM.isPositionInFocusedSystem('player-1', addScaled(saturn, v3(1, 0, 0), 1e8), 0));
  });

  test('visibility: 衛星フォーカスでも同じ惑星系の player は表示対象にする', () => {
    const saturn = positionOf(PARTS, 'saturn', 0);
    const titan = positionOf(PARTS, 'titan', 0);
    const jupiter = positionOf(PARTS, 'jupiter', 0);

    // タイタンをフォーカスしても、親惑星の土星周回にいる player は消さない。
    assert.ok(SYSTEM.isPositionInFocusedSystem('titan', addScaled(saturn, v3(1, 0, 0), 1e8), 0));
    // タイタン自身の周回も同じ土星系として扱う。
    assert.ok(SYSTEM.isPositionInFocusedSystem('titan', addScaled(titan, v3(1, 0, 0), 1e6), 0));
    // 木星系の player は土星系の衛星フォーカスでは表示しない。
    assert.ok(!SYSTEM.isPositionInFocusedSystem('titan', addScaled(jupiter, v3(1, 0, 0), 1e8), 0));
  });

  test('systemChainAt: 月の近くでは月→地球→太陽の系列になる', () => {
    const moon = positionOf(PARTS, 'moon', 0);
    // 月の中心そのものは attractorAccel の直接項が距離ゼロで消えるため、月面付近の
    // 1点(中心から1000km)を使う。
    const nearMoon = addScaled(moon, v3(1, 0, 0), 1e6);
    assert.deepEqual(SYSTEM.systemChainAt(nearMoon, 0), ['moon', 'earth', 'sun']);
  });

  test('systemChainAt: 地球の近くでは地球→太陽の系列になる', () => {
    assert.deepEqual(SYSTEM.systemChainAt(v3(), 0), ['earth', 'sun']);
  });

  test('systemChainAt: 太陽の近くでは太陽単独になる', () => {
    const sun = positionOf(PARTS, 'sun', 0);
    assert.deepEqual(SYSTEM.systemChainAt(sun, 0), ['sun']);
  });

  test('systemChainAt: 天体が1体も無ければ空配列', () => {
    const empty = new CelestialSystem([], SYSTEM.entityOf('sun'), {}, TEST_EPOCH);
    assert.deepEqual(empty.systemChainAt(v3(), 0), []);
  });

  test('systemMembersAt: 地球近傍では月が含まれ、太陽の子(恒星の子)は含まれない', () => {
    const members = SYSTEM.systemMembersAt(v3(), 0);
    assert.ok(members.includes('earth'));
    assert.ok(members.includes('moon'), '地球の子である月が足されるべき');
    assert.ok(members.includes('sun'));
    for (const id of ['mercury', 'venus', 'mars', 'jupiter']) {
      assert.ok(!members.includes(id), `${id} は太陽の子なので含まれないべき`);
    }
  });

  test('systemMembersAt: 月近傍では地球と月が含まれ、月自身は重複しない', () => {
    const moon = positionOf(PARTS, 'moon', 0);
    const nearMoon = addScaled(moon, v3(1, 0, 0), 1e6);
    const members = SYSTEM.systemMembersAt(nearMoon, 0);
    assert.ok(members.includes('moon'));
    assert.ok(members.includes('earth'), '月の親である地球が足されるべき');
    assert.ok(members.includes('sun'));
    assert.equal(members.filter((id) => id === 'moon').length, 1, '月は重複しない');
  });
}
