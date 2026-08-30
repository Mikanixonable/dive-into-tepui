// CelestialBodyWindows(celestial-body.ts)の回帰テスト: 全天体・重力源の窓が宣言順と
// 同一時刻の同一参照を守り、天体の運動から求めた値と一致すること。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/constants';
import { len, sub } from '../../src/math/vec3';
import { positionOf, solarSystemParts } from './test-helpers';

export function register(): void {
  const system = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;

  test('celestial-body-windows: celestialBodiesAt は太陽系の宣言順で、地球は静止・半径は赤道半径 R_EARTH_EQ', () => {
    const celestialBodies = system.celestialBodiesAt(1234);
    assert.deepEqual(celestialBodies.map((b) => b.id), ['earth', 'moon', 'mercury', 'venus', 'mars', 'phobos', 'deimos', 'jupiter', 'metis', 'adrastea', 'amalthea', 'thebe', 'io', 'europa', 'ganymede', 'callisto', 'himalia', 'elara', 'ananke', 'carme', 'pasiphae', 'sinope', 'saturn', 'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'hyperion', 'iapetus', 'phoebe', 'uranus', 'puck', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon', 'neptune', 'triton', 'nereid', 'ceres', 'vesta', 'pallas', 'pluto', 'charon', 'styx', 'nix', 'kerberos', 'hydra', 'haumea', 'hiiaka', 'namaka', 'makemake', 'eris', 'dysnomia', 'halley', 'encke', 'sedna', 'quaoar', 'weywot', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu', 'orcus', 'vanth', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia', 'europa52', 'davida', 'juno', 'psyche', 'eunomia', 'sylvia', 'apophis', 'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne', 'kamooalewa', 'tk7', 'eureka', 'sun']);
    assert.equal(celestialBodies[0]!.radius, R_EARTH_EQ);
  });

  test('celestial-body-windows: 同一 t の celestialBodiesAt は同一配列参照を返す', () => {
    const w = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;
    assert.equal(w.celestialBodiesAt(1234), w.celestialBodiesAt(1234));
  });

  test('celestial-body-windows: gravityAttractorsAt は mu が 0 でない天体だけを宣言順で返す', () => {
    const gravity = system.gravityAttractorsAt(1234);
    assert.ok(gravity.every((b) => b.mu !== 0));
    const expected = system.celestialBodiesAt(1234).filter((b) => b.mu !== 0).map((b) => b.id);
    assert.deepEqual(gravity.map((b) => b.id), expected);
    assert.ok(gravity.length > 0 && gravity.length < system.celestialBodiesAt(1234).length);
  });

  test('celestial-body-windows: gravityAttractorsAt の要素は同一 t の celestialBodiesAt と厳密に一致する', () => {
    const t = 4321;
    const all = new Map(system.celestialBodiesAt(t).map((b) => [b.id, b]));
    for (const g of system.gravityAttractorsAt(t)) {
      const a = all.get(g.id)!;
      assert.deepEqual(g.state.r, a.state.r);
      assert.deepEqual(g.state.v, a.state.v);
      assert.equal(g.state.t, a.state.t);
      assert.equal(g.mu, a.mu);
      assert.equal(g.radius, a.radius);
    }
  });

  test('celestial-body-windows: 異なる t では再計算され、値が変わる', () => {
    const w = solarSystemParts({ earth: 0.3, moon: 0.4 }).system;
    const a = w.celestialBodiesAt(0);
    const b = w.celestialBodiesAt(1e5);
    assert.notEqual(a, b);
    const moonA = a.find((x) => x.id === 'moon')!.state.r;
    const moonB = b.find((x) => x.id === 'moon')!.state.r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `月が動いていない: ${len(sub(moonA, moonB))}`);
    // 直近 t を巡回で保持するので、古い t を引き直しても同じ値が返る。
    assert.deepEqual(w.celestialBodiesAt(0), a);
  });

  test('celestial-body-windows: 位相オフセットが違えば同じ時刻でも別の位置になる', () => {
    const a = solarSystemParts({ earth: 0.3, moon: 0.4 });
    const b = solarSystemParts({ earth: 0.3, moon: 2.1 });
    const moonA = a.system.celestialBodiesAt(1234).find((x) => x.id === 'moon')!.state.r;
    const moonB = b.system.celestialBodiesAt(1234).find((x) => x.id === 'moon')!.state.r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `位相オフセットが反映されていない: ${len(sub(moonA, moonB))}`);
    // 窓の時刻キャッシュを経由しても、個体の運動から引いた位置と同じ値を返す。
    assert.deepEqual(moonB, positionOf(b, 'moon', 1234));
  });
}
