// CelestialMotions(役割ごとの天体一覧)の回帰テスト: 一覧が宣言順を守り、
// 天体1体が pivot ごとに引き直した値と一致すること。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/constants';
import { len, sub } from '../../src/math/vec3';
import { positionOf, solarSystemParts } from './test-helpers';

export function register(): void {
  const system = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;

  test('celestialMotions: celestialMotions は太陽系の宣言順で、地球は静止・半径は赤道半径 R_EARTH_EQ', () => {
    const celestialBodies = system.celestialMotions;
    assert.deepEqual(celestialBodies.map((b) => b.id), ['earth', 'moon', 'mercury', 'venus', 'mars', 'phobos', 'deimos', 'jupiter', 'metis', 'adrastea', 'amalthea', 'thebe', 'io', 'europa', 'ganymede', 'callisto', 'himalia', 'elara', 'ananke', 'carme', 'pasiphae', 'sinope', 'saturn', 'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'hyperion', 'iapetus', 'phoebe', 'uranus', 'puck', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon', 'neptune', 'triton', 'nereid', 'ceres', 'vesta', 'pallas', 'pluto', 'charon', 'styx', 'nix', 'kerberos', 'hydra', 'haumea', 'hiiaka', 'namaka', 'makemake', 'eris', 'dysnomia', 'halley', 'encke', 'sedna', 'quaoar', 'weywot', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu', 'orcus', 'vanth', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia', 'europa52', 'davida', 'juno', 'psyche', 'eunomia', 'sylvia', 'apophis', 'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne', 'kamooalewa', 'tk7', 'eureka', 'sun']);
    assert.equal(celestialBodies[0]!.def.radius, R_EARTH_EQ);
  });

  test('celestialMotions: 同一 t の celestialMotions は同一配列参照を返す', () => {
    const w = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;
    assert.equal(w.celestialMotions, w.celestialMotions);
  });

  test('celestialMotions: gravityAttractorsAt は mu が 0 でない天体だけを宣言順で返す', () => {
    const gravity = system.gravityMotions;
    assert.ok(gravity.every((b) => b.def.mu !== 0));
    const expected = system.celestialMotions.filter((b) => b.def.mu !== 0).map((b) => b.id);
    assert.deepEqual(gravity.map((b) => b.id), expected);
    assert.ok(gravity.length > 0);
  });

  test('celestialMotions: gravityAttractorsAt の要素は同一 t の celestialBodiesAt と厳密に一致する', () => {
    const t = 4321;
    const all = new Map(system.celestialMotions.map((b) => [b.id, b]));
    for (const g of system.gravityMotions) {
      const a = all.get(g.id)!;
      assert.deepEqual(g.stateAt(t).r, a.stateAt(t).r);
      assert.deepEqual(g.stateAt(t).v, a.stateAt(t).v);
      assert.equal(g.stateAt(t).t, t);
      assert.equal(g.def.mu, a.def.mu);
      assert.equal(g.def.radius, a.def.radius);
    }
  });

  test('celestialMotions: 異なる pivot では引き直され、値が変わる', () => {
    const w = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;
    const moon = w.celestialMotions.find((x) => x.id === 'moon')!;
    const moonA = moon.stateAt(0).r;
    const moonB = moon.stateAt(3 * 86400).r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `月が動いていない: ${len(sub(moonA, moonB))}`);
    // 直近 pivot を巡回で保持するので、古い pivot を引き直しても同じ値が返る。
    assert.deepEqual(moon.stateAt(0).r, moonA);
  });

  test('celestialMotions: 位相オフセットが違えば同じ時刻でも別の位置になる', () => {
    const a = solarSystemParts({ earth: 0.3, moon: 0.4 });
    const b = solarSystemParts({ earth: 0.3, moon: 2.1 });
    const moonA = a.system.celestialMotions.find((x) => x.id === 'moon')!.stateAt(5000).r;
    const moonB = b.system.celestialMotions.find((x) => x.id === 'moon')!.stateAt(5000).r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `位相オフセットが反映されていない: ${len(sub(moonA, moonB))}`);
    // 窓の時刻キャッシュを経由しても、個体の運動から引いた位置と同じ値を返す。
    assert.deepEqual(moonB, positionOf(b, 'moon', 5000));
  });
}
