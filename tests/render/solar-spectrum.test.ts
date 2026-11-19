// 直射日光の色を、独立な分光モデル(render/solar-spectrum.ts)と、エンジン側が焼く
// 直射表(sun-transmittance-tables.ts。GPU が読むのと同じ中身)とで並べて比べる調査用の
// 回帰テスト。値の表は console へ出し、検証は参照モデルの健全性とエンジン側の
// 不変量(単調性・波長順・高度効果)に留める — 誤差の絶対値ではなく振舞いを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  cctMcCamy, linearSrgbToXyz, sunlightColor,
} from '../../src/render/solar-spectrum';
import {
  bakeSunTransmittance, sampleSunTransmittance,
} from '../../src/render/pipeline/sun-transmittance-tables';
import { EARTH_ATMOSPHERE_OPTICS, R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';

// エンジン側の焼き込み済み直射表(地球の光学から 1 枚)。
const SUN_TABLE = bakeSunTransmittance(EARTH_ATMOSPHERE_OPTICS, R_EARTH_EQ);

// エンジンの直射日光の色 = 焼いた表を (太陽の天頂角余弦・高度) で引いた値(白い太陽を仮定)。
function engineSunColor(elevationDeg: number, altitudeM: number): number[] {
  const mu = Math.sin(elevationDeg * Math.PI / 180);
  return [...sampleSunTransmittance(SUN_TABLE.data, SUN_TABLE.altitudeMax, mu, altitudeM)];
}

// 線形 sRGB の色を色度と CCT にする。
function cctOf(rgb: readonly number[]): { x: number; y: number; cct: number } {
  const [x, y, z] = linearSrgbToXyz(rgb[0]!, rgb[1]!, rgb[2]!);
  const sum = x + y + z;
  return { x: x / sum, y: y / sum, cct: cctMcCamy(x / sum, y / sum) };
}

const fmt = (value: number, digits = 4): string => value.toFixed(digits).padStart(9);
const fmtRgb = (rgb: readonly number[]): string => {
  const max = Math.max(rgb[0]!, rgb[1]!, rgb[2]!, 1e-12);
  return `(${(rgb.map((v) => v / max).map((v) => v.toFixed(3)).join(','))})`;
};

export function register(): void {
  test('solar-spectrum: 参照モデルの直射日光は白から橙へ沈み、実測の目安に入る', () => {
    // 実測の目安(仰角→直射日光の CCT): 60° ≈ 5500 K、10° ≈ 4000 K、3° ≈ 3000 K、
    // 1° ≈ 2200 K、地平線 ≈ 1900 K 前後(大気状態で ±数百 K 動く)。
    const expectations: [number, number, number][] = [
      [60, 4800, 6500], [10, 3300, 4800], [3, 2200, 3400], [1, 1700, 2600], [0, 1500, 2400],
    ];
    for (const [elevation, low, high] of expectations) {
      const color = sunlightColor(elevation);
      assert.ok(
        color.cct >= low && color.cct <= high,
        `仰角 ${elevation}° の参照 CCT が目安域 [${low},${high}] 外: ${color.cct.toFixed(0)} K`,
      );
    }
    // 天頂近くはほぼ白(彩度が低い)で、沈むほど赤みが増す(CCT は単調に下がる)。
    // **CCT の単調性は仰角 1° までで見る** — その先は残る光の色度が黒体軌跡を外れ
    // (オゾンが緑〜橙を抉るので紫側へ寄る)、McCamy の相関温度が定義として不安定になる。
    const sequence = [90, 60, 30, 20, 10, 5, 3, 2, 1, 0.5, 0].map((e) => sunlightColor(e));
    const cctSequence = [90, 60, 30, 20, 10, 5, 3, 2, 1].map((e) => sunlightColor(e).cct);
    for (let i = 1; i < cctSequence.length; i++) {
      assert.ok(
        cctSequence[i]! < cctSequence[i - 1]!,
        `参照 CCT が仰角とともに下がらない: ${cctSequence[i - 1]} -> ${cctSequence[i]}`,
      );
    }
    for (let i = 1; i < sequence.length; i++) {
      assert.ok(
        sequence[i]!.luminance < sequence[i - 1]!.luminance,
        `参照の相対輝度が仰角とともに下がらない`,
      );
    }
  });

  test('solar-spectrum: エンジンと参照の直射日光の色の比較表(調査)', () => {
    const elevations = [90, 60, 30, 20, 10, 5, 3, 2, 1, 0.5, 0];
    const altitudes = [0, 2e3, 5e3, 10e3];
    // エンジン側のミー柱と同じエーロゾル量を参照へ与えたときの比較 — 実装のずれと、
    // 入力となる光学定数の差(地球の宣言値は標準の晴天値よりずっと薄い)を切り分ける。
    const engineAerosol = { aerosolDepth550: EARTH_ATMOSPHERE_OPTICS.mie * EARTH_ATMOSPHERE_OPTICS.mieScaleHeight };
    const lines: string[] = [];
    lines.push('仰角 | 高度km | 参照CCT 参照輝度 参照RGB | 同柱量CCT | エンジンCCT 輝度 RGB | CCT誤差(標準/同柱量)');
    for (const elevation of elevations) {
      for (const altitudeM of altitudes) {
        const reference = sunlightColor(elevation, altitudeM);
        const sameInput = sunlightColor(elevation, altitudeM, engineAerosol);
        const engine = engineSunColor(elevation, altitudeM);
        const engineZenith = engineSunColor(90, altitudeM);
        const engineCct = cctOf(engine);
        const engineY = linearSrgbToXyz(engine[0]!, engine[1]!, engine[2]!)[1]!;
        const zenithY = linearSrgbToXyz(engineZenith[0]!, engineZenith[1]!, engineZenith[2]!)[1]!;
        const cctError = engineCct.cct / reference.cct - 1;
        const inputError = engineCct.cct / sameInput.cct - 1;
        lines.push([
          `${String(elevation).padStart(4)} | ${String(altitudeM / 1e3).padStart(5)} |`,
          `${fmt(reference.cct, 0)} ${fmt(reference.luminance, 3)} ${fmtRgb(reference.rgb)} |`,
          `${fmt(sameInput.cct, 0)} |`,
          `${fmt(engineCct.cct, 0)} ${fmt(engineY / zenithY, 3)} ${fmtRgb(engine)} |`,
          `${(cctError * 100).toFixed(1).padStart(6)}% ${(inputError * 100).toFixed(1).padStart(6)}%`,
        ].join(''));
      }
    }
    // 調査表は出力へ。
    console.log(`\n${lines.join('\n')}\n`);

    // 不変量: エンジンも仰角とともに CCT が下がり、地平線では R>G>B の順を保つ。
    const sequence = elevations.map((e) => cctOf(engineSunColor(e, 0)).cct);
    for (let i = 1; i < sequence.length; i++) {
      assert.ok(sequence[i]! <= sequence[i - 1]! * 1.02, `エンジン CCT が逆転: ${sequence[i - 1]} -> ${sequence[i]}`);
    }
    const horizon = engineSunColor(0, 0);
    assert.ok(horizon[0]! > horizon[1]! && horizon[1]! > horizon[2]!, `波長順が乱れている: ${horizon}`);
  });

  test('solar-spectrum: オゾンとエーロゾル抜きの参照で、各成分の寄与を切り分ける(調査)', () => {
    const elevations = [20, 10, 5, 3, 1, 0];
    const lines: string[] = ['仰角 | 全成分CCT | オゾン抜きCCT | レイリーのみCCT | エンジンCCT'];
    for (const elevation of elevations) {
      const full = sunlightColor(elevation);
      const noOzone = sunlightColor(elevation, 0, { ozone: false });
      const rayleighOnly = sunlightColor(elevation, 0, { aerosol: false, ozone: false });
      const engine = cctOf(engineSunColor(elevation, 0));
      lines.push(
        `${String(elevation).padStart(4)} | ${fmt(full.cct, 0)} | ${fmt(noOzone.cct, 0)} | ${fmt(rayleighOnly.cct, 0)} | ${fmt(engine.cct, 0)}`,
      );
    }
    console.log(`\n${lines.join('\n')}\n`);
    // オゾンは Chappuis 帯(緑〜橙、約 500〜700 nm)を吸収するので、取り除くと残る光は
    // 橙へ寄り、CCT が下がる(低仰角で符号が分かれる程度の差しか生じない)。
    for (const elevation of elevations.filter((e) => e >= 1)) {
      const full = sunlightColor(elevation).cct;
      const noOzone = sunlightColor(elevation, 0, { ozone: false }).cct;
      assert.ok(noOzone < full, `仰角 ${elevation}° でオゾンの効果が逆: ${full} vs ${noOzone}`);
    }
  });
}
