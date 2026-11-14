// 移流前の湿度の源へ掛ける環境変調。気団・対流の活発度・気候から、段間の乗法の鎖の強さ κ と
// 包絡を方向ごとに組む — 熱帯で段を結び付けて間欠的な場にし、温帯以降の細かい段を痩せさせる。
// 値はすべて見えのための調整値。
import { float, smoothstep } from 'three/tsl';
import { extratropicalAt } from './air-mass';
import { latitudeOf } from './sphere-frame';
import type { AirMass } from './air-mass';
import type { ClimateMap } from './climate-map';
import type { ConvectiveActivity } from './convective-activity';
import type { HumidityModulation } from './weather-transport';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 変調の係数表。coupling(κ)は、1 つ粗い段の実現値を細かい段の振幅へ掛ける乗法の鎖の強さ —
// κ = 熱帯 ×(base + (活発度 − ACTIVITY_MID) ×ACT) − 温帯 ×(折り目 ×BAND + POLAR)。
// envelope は、低周波の段(NoiseOctave.envelope)の振幅の倍率を 1 + 熱帯の海 ×TROPIC で振る。
// 押し縮まりが立ち上がる幅は、温帯の前線(1.65 から)と熱帯の雨帯(5 から)のあいだを覆う広さ。
// 活発度の中立点は海上の平年程度の値。
const ORGANIZATION_FOLD_ONSET = 1.8;
const ORGANIZATION_FOLD_WIDTH = 1.4;
const ORGANIZATION_ACTIVITY_MID = 0.55;
const SURFACE_COUPLING_BASE = 0.7;
const SURFACE_COUPLING_ACTIVITY = 0.5;
const SURFACE_COUPLING_FOLD = 0.3;
const UPPER_COUPLING_BASE = 0.7;
const UPPER_COUPLING_ACTIVITY = 0.4;
const UPPER_COUPLING_FOLD = 0.2;
// 包絡は熱帯では正・温帯以降では負にする — 段の応答係数を正に取れば、熱帯では段の振幅が
// 膨らみ、温帯以降では痩せる。温帯以降の細かい段の散らばりは実写より大きいので、
// そこを削る向きが必要。
const SURFACE_ENVELOPE_TROPIC = 0.7;
const SURFACE_ENVELOPE_POLAR = 0.8;
const UPPER_ENVELOPE_TROPIC = 0.3;
const UPPER_ENVELOPE_POLAR = 0.6;

export class HumidityModulator {
  // airMass は気団の場、convectiveActivity は対流の活発度の場、climate はこの天体の気候。
  public constructor(
    private readonly airMass: AirMass,
    private readonly convectiveActivity: ConvectiveActivity,
    private readonly climate: ClimateMap,
  ) {}

  // 単位方向 direction における変調。pressureLift は気圧の偏差が生む上昇流 [m/s]。
  // 帯(前線・雨帯)は移流前の湿度の勾配を含むので源の場では引けず、折り目の代理に気団の
  // 押し縮まりを使い、活発度も帯の項を除いて引く。上昇流も帯が立てる分を欠いた気圧の項だけを渡す。
  public at(direction: Vec3Node, pressureLift: FloatNode): HumidityModulation {
    const latitude = latitudeOf(direction);
    const extratropical = extratropicalAt(latitude);
    const airMass = this.airMass.at(direction, latitude);
    const land = this.climate.landFraction(direction);
    const activity = this.convectiveActivity.at(
      direction, pressureLift, airMass.warmth.mul(extratropical), land, float(0));
    const fold = smoothstep(
      ORGANIZATION_FOLD_ONSET, ORGANIZATION_FOLD_ONSET + ORGANIZATION_FOLD_WIDTH, airMass.compression);
    // κ は熱帯に限る。被覆率の間欠性が不足するのは熱帯だけで、温帯以降はむしろ過剰 — 前線の
    // 折り目では温帯側だけ κ を削る(熱帯の雨帯は組織化した対流の座なので削らない)。地表側は
    // 陸に限る — 海上では κ が小さい粒の散らばりを増やして、かえって間欠性の実写との差を
    // 広げることが実測で分かった(陸では対流の集団化が観測どおり改善する)。
    const tropical = extratropical.oneMinus();
    const coupling = (base: number, activityGain: number, foldGain: number): FloatNode =>
      tropical.mul(float(base).add(activity.sub(ORGANIZATION_ACTIVITY_MID).mul(activityGain)))
        .sub(fold.mul(extratropical).mul(foldGain));
    return {
      surfaceCoupling: land.mul(
        coupling(SURFACE_COUPLING_BASE, SURFACE_COUPLING_ACTIVITY, SURFACE_COUPLING_FOLD)),
      surfaceEnvelope: tropical.mul(land.oneMinus()).mul(SURFACE_ENVELOPE_TROPIC)
        .sub(extratropical.mul(SURFACE_ENVELOPE_POLAR)),
      upperCoupling: coupling(UPPER_COUPLING_BASE, UPPER_COUPLING_ACTIVITY, UPPER_COUPLING_FOLD),
      upperEnvelope: tropical.mul(UPPER_ENVELOPE_TROPIC).sub(extratropical.mul(UPPER_ENVELOPE_POLAR)),
    };
  }
}
