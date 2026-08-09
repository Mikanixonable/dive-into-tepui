// マップ表示の可視性規則(body-visibility.ts)と、ラグランジュ点が力学的に意味を持つかの
// 判定(lagrange.ts + Ephemeris)の回帰テスト。どちらも DOM を持たない純粋な規則なので、
// 「どう見えるか」ではなく「何が見えるべきか」だけをここで固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris } from '../../src/physics/ephemeris';
import { SOLAR_SYSTEM, bodyDef, primaryOf } from '../../src/physics/solar-system';
import {
  TRIANGULAR_STABILITY_MASS_RATIO, collinearClearanceRatio, hasStableTriangularPoints,
} from '../../src/physics/lagrange';
import { DEFAULT_BODY_CLASS_TOGGLES, visibleBodyIds } from '../../src/game/celestial/body-visibility';

const MIN_CLEARANCE = 10;

// 登録天体の主天体に対する質量比。
function massRatio(id: string): number {
  const primary = primaryOf(SOLAR_SYSTEM, id)!;
  const def = bodyDef(SOLAR_SYSTEM, id);
  return def.mu / (bodyDef(SOLAR_SYSTEM, primary).mu + def.mu);
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
      const def = bodyDef(SOLAR_SYSTEM, id);
      const orbit = def.kind === 'planet' ? def.orbit : (def as { orbit: { kepler: { a: number } } }).orbit.kepler;
      return collinearClearanceRatio(massRatio(id), orbit.a, def.radius);
    };
    // しきい値の近くにある系。ここが動くと判定が変わるので明示的に固定する。
    assert.ok(Math.abs(clearance('triton') - 10.63) < 0.1, `トリトン: ${clearance('triton')}`);
    assert.ok(Math.abs(clearance('europa') - 8.69) < 0.1, `エウロパ: ${clearance('europa')}`);
    // L1 が表面すれすれに来る系。
    assert.ok(clearance('phobos') < 2, `フォボス: ${clearance('phobos')}`);
  });

  test('lagrange: Ephemeris はしきい値の内外で共線点の可否を答える', () => {
    const e = new Ephemeris();
    assert.ok(e.hasUsableCollinearPoints('moon', MIN_CLEARANCE));
    assert.ok(e.hasUsableCollinearPoints('titan', MIN_CLEARANCE));
    assert.ok(!e.hasUsableCollinearPoints('phobos', MIN_CLEARANCE));
    assert.ok(!e.hasUsableCollinearPoints('io', MIN_CLEARANCE));
    // 恒星は主天体を持たないので共線点も三角点も持たない。
    assert.ok(!e.hasUsableCollinearPoints('sun', MIN_CLEARANCE));
    assert.ok(!e.hasStableTriangularPoints('sun'));
  });

  test('visibility: 既定では恒星と惑星だけが見える', () => {
    const visible = visibleBodyIds(SOLAR_SYSTEM, 'earth', DEFAULT_BODY_CLASS_TOGGLES);
    for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
      assert.ok(visible.has(id), `${id} は常に見えるべき`);
    }
    for (const id of ['io', 'titan', 'triton', 'ceres', 'halley']) {
      assert.ok(!visible.has(id), `${id} は既定では見えないべき`);
    }
  });

  test('visibility: フォーカス中の天体の子はトグル無しで見える', () => {
    const visible = visibleBodyIds(SOLAR_SYSTEM, 'jupiter', DEFAULT_BODY_CLASS_TOGGLES);
    for (const id of ['io', 'europa', 'ganymede', 'callisto']) {
      assert.ok(visible.has(id), `木星にフォーカスすれば ${id} が見えるべき`);
    }
    // 別の惑星の衛星までは出てこない。
    assert.ok(!visible.has('titan'));
    assert.ok(!visible.has('phobos'));
  });

  test('visibility: フォーカス中の天体の親と兄弟も見える', () => {
    const visible = visibleBodyIds(SOLAR_SYSTEM, 'io', DEFAULT_BODY_CLASS_TOGGLES);
    assert.ok(visible.has('jupiter'), '親');
    assert.ok(visible.has('europa'), '兄弟');
    assert.ok(visible.has('io'), '自分自身');
    assert.ok(!visible.has('titan'), '別の系の衛星は出ない');
  });

  test('visibility: クラストグルを立てるとそのクラスが全数見える', () => {
    const visible = visibleBodyIds(SOLAR_SYSTEM, 'earth', { ...DEFAULT_BODY_CLASS_TOGGLES, satellite: true });
    for (const id of ['moon', 'io', 'titan', 'triton', 'phobos']) {
      assert.ok(visible.has(id), `${id} が見えるべき`);
    }
    assert.ok(!visible.has('ceres'), '別クラスは足されない');
  });

  // 一覧の並び順は FocusMarkers が組むラベル配列そのものなので、階層の導出だけを固定する。
  test('visibility: 親子の深さは主星を 0 として数えられる', () => {
    const depth = (id: string): number => {
      let d = 0;
      for (let cur = primaryOf(SOLAR_SYSTEM, id); cur !== null; cur = primaryOf(SOLAR_SYSTEM, cur)) d++;
      return d;
    };
    assert.equal(depth('sun'), 0);
    assert.equal(depth('jupiter'), 1);
    assert.equal(depth('io'), 2);
  });

  test('visibility: 未登録の id にフォーカスしても恒星・惑星は見え続ける', () => {
    const visible = visibleBodyIds(SOLAR_SYSTEM, 'asteroid-1', DEFAULT_BODY_CLASS_TOGGLES);
    assert.ok(visible.has('earth'));
    assert.ok(visible.has('sun'));
  });
}
