// 天空光の放射照度表(sky-irradiance-tables.ts)の回帰テスト。焼いた値の範囲・
// 正午の青みと割合・薄明の残り・夜の 0 を、焼き込み結果の中身で見る。
// 地球の光学と大きさは src の定義から取り、値をここへ写さない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  bakeSkyIrradiance, SKY_IRRADIANCE_ALTITUDE_COUNT, SKY_IRRADIANCE_MU_COUNT,
  SKY_IRRADIANCE_MU_MIN, SkyIrradianceTables,
} from '../../src/render/pipeline/sky-irradiance-tables';
import {
  bakeSunTransmittance, sampleSunTransmittance, SunTransmittanceTables,
} from '../../src/render/pipeline/sun-transmittance-tables';
import { EARTH_ATMOSPHERE_OPTICS, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import * as THREE from 'three/webgpu';
import type { AtmosphereBody } from '../../src/render/atmosphere';

const OPTICS = EARTH_ATMOSPHERE_OPTICS;
const SURFACE_RADIUS = R_EARTH_EQ;

const BODY: AtmosphereBody = {
  center: new THREE.Vector3(),
  surfaceRadius: SURFACE_RADIUS,
  polarAxis: new THREE.Vector3(0, 1, 0),
  polarRatio: 1,
  optics: OPTICS,
  clouds: null,
};

const SUN_TABLE = bakeSunTransmittance(OPTICS, SURFACE_RADIUS);
const SKY = bakeSkyIrradiance(OPTICS, SURFACE_RADIUS, SUN_TABLE);

// 焼いた天空光表を (mu, 高度) へ双線形に引く。
function irradianceAt(mu: number, altitude: number): [number, number, number] {
  const u = Math.min(Math.max((mu - SKY_IRRADIANCE_MU_MIN) / (1 - SKY_IRRADIANCE_MU_MIN), 0), 1)
    * (SKY_IRRADIANCE_MU_COUNT - 1);
  const v = Math.sqrt(Math.min(Math.max(altitude / SKY.altitudeMax, 0), 1))
    * (SKY_IRRADIANCE_ALTITUDE_COUNT - 1);
  const i0 = Math.min(Math.floor(u), SKY_IRRADIANCE_MU_COUNT - 2);
  const j0 = Math.min(Math.floor(v), SKY_IRRADIANCE_ALTITUDE_COUNT - 2);
  const fu = u - i0;
  const fv = v - j0;
  const rgb = [0, 0, 0] as [number, number, number];
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const w = (di === 0 ? 1 - fu : fu) * (dj === 0 ? 1 - fv : fv);
      const at = ((j0 + dj) * SKY_IRRADIANCE_MU_COUNT + (i0 + di)) * 4;
      rgb[0] += w * SKY.data[at]!;
      rgb[1] += w * SKY.data[at + 1]!;
      rgb[2] += w * SKY.data[at + 2]!;
    }
  }
  return rgb;
}

export function register(): void {
  test('sky-irradiance: 焼いた表の値は負にならず、夜の端ではほぼ 0', () => {
    for (let i = 0; i < SKY.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        assert.ok(Number.isFinite(SKY.data[i + c]!), `要素 ${i + c} が非有限: ${SKY.data[i + c]}`);
        assert.ok(SKY.data[i + c]! >= 0, `要素 ${i + c} が負: ${SKY.data[i + c]}`);
      }
    }
    // 太陽が −20° より深く沈んだ端では天空光は尽きる。
    const night = irradianceAt(SKY_IRRADIANCE_MU_MIN, 0);
    const noon = irradianceAt(1, 0);
    const noonMean = (noon[0] + noon[1] + noon[2]) / 3;
    assert.ok(
      (night[0] + night[1] + night[2]) / 3 < noonMean * 0.01,
      `夜側の端が明るすぎる: ${night}`,
    );
  });

  test('sky-irradiance: 正午の地表では天空光は青く、全天日射の数%〜2割', () => {
    const sky = irradianceAt(1, 0);
    const direct = sampleSunTransmittance(SUN_TABLE.data, SUN_TABLE.altitudeMax, 1, 0);
    // 水平面の直射日射は E0·mu·T。天空光との比は晴天の目安(約 10〜15%)の前後を見る。
    const skyMean = (sky[0] + sky[1] + sky[2]) / 3;
    const directMean = (direct[0] + direct[1] + direct[2]) / 3;
    const fraction = skyMean / directMean;
    assert.ok(
      fraction > 0.02 && fraction < 0.3,
      `正午の天空光の割合が目安を外れた: ${(fraction * 100).toFixed(1)}%`,
    );
    // 影の中は空の青で照る — B/R は 1.2 を越える。
    assert.ok(sky[2] / sky[0] > 1.2, `正午の天空光が青くない: B/R=${(sky[2] / sky[0]).toFixed(2)}`);
  });

  test('sky-irradiance: 地平線の下でも薄明の天空光が残り、沈むほど暗くなる', () => {
    // −3〜−6° の薄明では、直射光が尽きた地表にも空の光が残る。
    const twilight3 = irradianceAt(Math.sin(-3 * Math.PI / 180), 0);
    const twilight6 = irradianceAt(Math.sin(-6 * Math.PI / 180), 0);
    const dusk12 = irradianceAt(Math.sin(-12 * Math.PI / 180), 0);
    const meanOf = (rgb: readonly number[]) => (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
    assert.ok(meanOf(twilight3) > 0, '−3° で天空光が 0 になった');
    assert.ok(meanOf(twilight6) > 0, '−6° で天空光が 0 になった');
    assert.ok(meanOf(twilight6) < meanOf(twilight3), '薄明が沈むほど暗くならない');
    assert.ok(meanOf(dusk12) < meanOf(twilight6), '深い薄明が浅い薄明より明るい');
  });

  test('sky-irradiance: 太陽が高いほど天空光は明るく、高度が上がると全天日射のうちの割合が増す', () => {
    const meanOf = (rgb: readonly number[]) => (rgb[0]! + rgb[1]! + rgb[2]!) / 3;
    const mus = [1, 0.7, 0.4, 0.2, 0.1, 0.03];
    let previous = Number.POSITIVE_INFINITY;
    for (const mu of mus) {
      const current = meanOf(irradianceAt(mu, 0));
      assert.ok(current <= previous * (1 + 1e-9), `mu=${mu} で天空光が増えた: ${previous} -> ${current}`);
      previous = current;
    }
  });

  test('sky-irradiance: 空き枠の表は全帯域で 0(寄与なし)で、同じ光学では焼き直さない', () => {
    const sunTables = new SunTransmittanceTables();
    const skyTables = new SkyIrradianceTables(sunTables);
    const empty = skyTables.forEmpty();
    const bits = empty.texture.image.data as Uint16Array;
    assert.deepEqual(
      [...bits.slice(0, 4)].map((v) => THREE.DataUtils.fromHalfFloat(v)),
      [0, 0, 0, 1],
    );
    const first = skyTables.forBody(BODY);
    const second = skyTables.forBody({ ...BODY });
    assert.equal(first.texture, second.texture, '同じ光学で表が焼き直された');
    skyTables.dispose();
    sunTables.dispose();
  });
}
