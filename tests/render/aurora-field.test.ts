import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AuroraField } from '../../src/render/aurora-field';
import { v3 } from '../../src/math/vec3';

// 磁極を傾けた地球と同じ配置。太陽の向きを磁気方位へ落とす経路を通すのに要る。
const TILTED_POLE = {
  ovalLatitudeDeg: 66,
  magneticPoleLatitudeDeg: 80.65,
  magneticPoleLongitudeDeg: -72.68,
  geomSeed: 0,
  colorSeed: 0,
  phaseOffset: 0,
  sign: 1,
} as const;

export function register(): void {
  test('aurora field: same display time is deterministic and bounded', () => {
    const field = new AuroraField({ ovalLatitudeDeg: 66, geomSeed: 1.3, colorSeed: 2.7, phaseOffset: 1, sign: 1 });
    const a = field.frameAt(1.2, 42);
    const b = field.frameAt(1.2, 42);
    assert.deepEqual(a, b);
    assert.ok(a.intensity >= 0 && a.intensity <= 1);
    assert.ok(a.greenEmission >= 0 && a.greenEmission <= 1);
    assert.ok(a.redEmission >= 0 && a.redEmission <= 1);
  });

  test('aurora field: day side is continuously brighter than night side', () => {
    const field = new AuroraField({ ovalLatitudeDeg: 66, geomSeed: 0, colorSeed: 0, phaseOffset: 0, sign: 1 });
    assert.ok(field.frameAt(0, 3).intensity > field.frameAt(Math.PI, 3).intensity);
  });

  test('aurora field: geomagnetic pole and magnetic local time affect the frame', () => {
    const field = new AuroraField({
      ovalLatitudeDeg: 66,
      magneticPoleLatitudeDeg: 80.65,
      magneticPoleLongitudeDeg: -72.68,
      geomSeed: 0,
      colorSeed: 0,
      phaseOffset: 0,
      sign: 1,
    });
    const noon = field.frameAt(0, 3, 0);
    const midnight = field.frameAt(0, 3, Math.PI);
    assert.equal(noon.magneticPoleLatitudeDeg, 80.65);
    assert.equal(noon.magneticLocalTime, 0);
    assert.equal(midnight.magneticLocalTime, 12);
    assert.ok(Number.isFinite(noon.longitudeDeg));
    assert.ok(noon.intensity > midnight.intensity);
  });

  test('aurora field: 昼夜の変調は太陽の子午線に対して止まる', () => {
    const field = new AuroraField(TILTED_POLE);
    const turn = 0.7;
    // 太陽の向きと観測する方位を同じだけ回せば、磁気地方時は動かない。
    for (const theta of [0, 1.9, Math.PI, 5.4]) {
      const before = field.frameAt(theta, 0, 0);
      const after = field.frameAt(theta + turn, 0, turn);
      assert.ok(Math.abs(after.magneticLocalTime - before.magneticLocalTime) < 1e-9, `MLT at ${theta}`);
    }
    // 同じ方位でも、太陽がそちらを向いていれば昼側の山、半周ずれていれば夜側の谷になる。
    // **明るさは同じ theta どうしで比べる** — theta で変わる活動度を挟むと昼夜の差が埋もれる。
    for (const theta of [0, 1.9, Math.PI, 5.4]) {
      const facingSun = field.frameAt(theta, 0, theta);
      const facingAway = field.frameAt(theta, 0, theta + Math.PI);
      assert.equal(facingSun.magneticLocalTime, 0, `MLT at ${theta}`);
      assert.ok(facingSun.intensity > facingAway.intensity, `intensity at ${theta}`);
    }
  });

  test('aurora field: 太陽の子午線は磁極の傾きを織り込んだ磁気方位で測る', () => {
    const field = new AuroraField(TILTED_POLE);
    // 磁極そのものの向きは方位が退化するので、傾きの効きは赤道上の向きで見る。
    const sunAtPrimeMeridian = field.solarMeridianFor(v3(1, 0, 0));
    const sunAtQuarterTurn = field.solarMeridianFor(v3(0, 0, 1));
    // 地理経度をそのまま渡していれば 0 と π/2 になる。磁極が傾いている分だけずれる。
    assert.ok(Math.abs(sunAtPrimeMeridian) > 1e-3, `${sunAtPrimeMeridian}`);
    // 赤道上で 90° 離れた 2 方向は、磁気方位でも 90° 前後を保つ(磁極の傾きぶんだけ縮む)。
    const separation = Math.abs(sunAtQuarterTurn - sunAtPrimeMeridian);
    assert.ok(separation > 1 && separation < Math.PI, `${separation}`);
    // 太陽が磁極の真上なら、赤道上の向きで測るより方位が定まらないので、有限であることだけを見る。
    assert.ok(Number.isFinite(field.solarMeridianFor(v3(0, 1, 0))));
  });
}
