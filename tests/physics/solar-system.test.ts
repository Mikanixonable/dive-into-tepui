// 太陽系の構築コード(physics/solar-system/)の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { spinRateOf } from '../../src/physics/celestial-motion';
import { CERES } from '../../src/physics/solar-system/dwarf-planets';
import { EARTH } from '../../src/physics/solar-system/earth-system';
import { VENUS } from '../../src/physics/solar-system/inner-planets';
import { URANUS } from '../../src/physics/solar-system/uranus-system';
import { EPOCH_T_OFFSET, SIDEREAL_DAY } from '../../src/physics/solar-system/constants';
import { solarSystemMotions } from '../../src/physics/solar-system/solar-system';

// 重力源配列・天体一覧の順序はこの並びで決まる。並びが変わると重力の総和の丸めが変わって
// 軌道が動き、ラベル・一覧の並びも変わるので、期待値を全件書き下して固定する。
const ALL_IDS: readonly string[] = [
  'earth', 'moon',
  'mercury', 'venus',
  'mars', 'phobos', 'deimos',
  'jupiter', 'metis', 'adrastea', 'amalthea', 'thebe', 'io', 'europa', 'ganymede', 'callisto', 'himalia',
  'elara', 'ananke', 'carme', 'pasiphae', 'sinope',
  'saturn', 'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys',
  'dione', 'rhea', 'titan', 'hyperion', 'iapetus', 'phoebe',
  'uranus', 'puck', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon',
  'neptune', 'triton', 'nereid',
  'ceres', 'vesta', 'pallas', 'pluto', 'charon', 'styx', 'nix', 'kerberos', 'hydra', 'haumea', 'hiiaka',
  'namaka', 'makemake', 'eris', 'dysnomia',
  'halley', 'encke', 'sedna', 'quaoar', 'weywot', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu', 'orcus',
  'vanth', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia', 'europa52', 'davida',
  'juno', 'psyche', 'eunomia', 'sylvia', 'apophis', 'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne',
  'kamooalewa', 'tk7', 'eureka',
  'sun',
];

export function register(): void {
  test('solar-system: solarSystemMotions().all の並びが固定されている', () => {
    const motions = solarSystemMotions('earth', {}, EPOCH_T_OFFSET, null, 2451545);
    assert.deepEqual(motions.all.map((m) => m.id), ALL_IDS);
  });

  test('spinRateOf: 地球は 2π/恒星日', () => {
    const rate = spinRateOf(EARTH);
    assert.ok(rate !== null);
    assert.ok(Math.abs(rate - (2 * Math.PI) / SIDEREAL_DAY) / ((2 * Math.PI) / SIDEREAL_DAY) < 1e-12);
  });

  // 逆行自転は軸を反転せず角速度の符号で表す(spinRotationAt の規約)。
  test('spinRateOf: 逆行自転(金星・天王星)は負', () => {
    assert.ok(spinRateOf(VENUS)! < 0);
    assert.ok(spinRateOf(URANUS)! < 0);
  });

  test('spinRateOf: 自転モデルを持たない天体(ceres)は null', () => {
    assert.equal(spinRateOf(CERES), null);
  });
}
