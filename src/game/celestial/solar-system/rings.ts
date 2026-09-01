// 環系の帯を [km] 単位の表から組む補助と、環を持つ天体の環系定義。
import { RingArcDef, RingBandDef, RingOpticsDef, RingSystemDef } from '../../../physics/celestial-body-def';

const KM = 1e3;

function ringOptics(
  normalOpticalDepth: number,
  singleScatteringAlbedo: number,
  phaseG: number,
  volumetric?: RingOpticsDef['volumetric'],
): RingOpticsDef {
  return { normalOpticalDepth, singleScatteringAlbedo, phaseG, volumetric };
}

// [km] 単位の帯を RingBandDef([m])へ変換する。optics は全帯で明示的に持つ。
function ringBand(
  innerKm: number,
  outerKm: number,
  thicknessKm: number,
  optics: RingOpticsDef,
  arcs?: readonly RingArcDef[],
): RingBandDef {
  return { innerRadius: innerKm * KM, outerRadius: outerKm * KM, thickness: thicknessKm * KM, optics, arcs };
}

// 出典: https://en.wikipedia.org/wiki/Rings_of_Jupiter 。ハロー環とゴサマー環(アマルテア・
// テーベ)は厚みが半径の 1〜10% あり扁平トーラスとして描く(RingBandDef.thickness > 0)。
// 主環は厚み 30〜300 km に対し半径 12 万 km 台で扁平トーラスと呼べるほどではないので平坦。
export const JUPITER_RINGS: RingSystemDef = {
  bands: [
    ringBand(92000, 122500, 12500, ringOptics(1e-7, 0.55, 0.72, { radialScale: 1, verticalScale: 1 })), // ハロー環
    ringBand(122500, 129000, 0, ringOptics(8e-6, 0.6, 0.65)), // 主環
    ringBand(129000, 182000, 2300, ringOptics(1e-7, 0.55, 0.78, { radialScale: 1, verticalScale: 1 })), // アマルテア・ゴサマー環
    ringBand(129000, 226000, 8400, ringOptics(1e-7, 0.55, 0.78, { radialScale: 1, verticalScale: 1 })), // テーベ・ゴサマー環
  ],
};

// 出典: https://en.wikipedia.org/wiki/Rings_of_Saturn (一次は Planetary Rings Node)。
// D〜A 環は観測代表値で分割し、視覚用PNG alphaを光学tauとして使わない。F/G 環は幅の薄い
// 細環、E 環は厚みを持つ内径付き拡散構造(Enceladus 近傍〜外縁で3,000〜60,000 km程度とされる
// 範囲の目安値)、フェーベ環は土星本体の200倍の直径を持つ桁違いの巨大構造として登録する。
export const SATURN_RINGS: RingSystemDef = {
  bands: [
    ringBand(66900, 74600, 0, ringOptics(1e-3, 0.45, 0.2)), // D 環: 代表値 1e-5〜1e-3
    ringBand(74600, 91975, 0, ringOptics(0.2, 0.45, 0.15)), // C 環: 代表値 0.05〜0.35
    ringBand(91975, 117507, 0, ringOptics(1.3, 0.55, 0.05)), // B 環: 代表値 0.4〜2.5
    ringBand(117507, 122340, 0, ringOptics(0.03, 0.45, 0.1)), // カッシーニの間隙
    ringBand(122340, 136775, 0, ringOptics(0.6, 0.5, 0.05)), // A 環: 代表値 0.4〜1.0
    ringBand(139930, 140430, 0, ringOptics(0.1, 0.45, 0.2)), // F 環
    ringBand(166000, 175000, 0, ringOptics(1e-6, 0.5, 0.65)), // G 環
    ringBand(180000, 480000, 40000, ringOptics(3e-6, 0.55, 0.78, { radialScale: 1, verticalScale: 1 })), // E 環
    ringBand(4.0e6, 1.3e7, 0, ringOptics(2e-8, 0.55, 0.9)), // フェーベ環
  ],
};

// 出典: https://en.wikipedia.org/wiki/Rings_of_Uranus 。13 環すべてを個別の帯として登録する
// (ζ・ν・μ は範囲そのものが表の値、他は中心半径 ± 表の幅の中間値)。幅が半径の 1/10,000
// 以上あり annulus として描くとサブピクセルになるため、視角判定(sync 側)で線に落ちる。
export const URANUS_RINGS: RingSystemDef = {
  bands: [
    ringBand(37850, 41350, 0, ringOptics(0.8, 0.35, 0.1)), // ζ
    ringBand(41837 - 1.9 / 2, 41837 + 1.9 / 2, 0, ringOptics(3, 0.35, 0.1)), // 6
    ringBand(42234 - 3.4 / 2, 42234 + 3.4 / 2, 0, ringOptics(2, 0.35, 0.1)), // 5
    ringBand(42570 - 3.4 / 2, 42570 + 3.4 / 2, 0, ringOptics(2, 0.35, 0.1)), // 4
    ringBand(44718 - 7.4 / 2, 44718 + 7.4 / 2, 0, ringOptics(1.5, 0.35, 0.1)), // α
    ringBand(45661 - 8.75 / 2, 45661 + 8.75 / 2, 0, ringOptics(1.5, 0.35, 0.1)), // β
    ringBand(47175 - 2.3 / 2, 47175 + 2.3 / 2, 0, ringOptics(1.5, 0.35, 0.1)), // η
    ringBand(47627 - 4.15 / 2, 47627 + 4.15 / 2, 0, ringOptics(6, 0.35, 0.1)), // γ
    ringBand(48300 - 5.1 / 2, 48300 + 5.1 / 2, 0, ringOptics(1.5, 0.35, 0.1)), // δ
    ringBand(50023 - 1.5 / 2, 50023 + 1.5 / 2, 0, ringOptics(3, 0.35, 0.1)), // λ
    ringBand(51149 - 58.05 / 2, 51149 + 58.05 / 2, 0, ringOptics(8, 0.35, 0.1)), // ε
    ringBand(66100, 69900, 0, ringOptics(3e-5, 0.55, 0.75)), // ν
    ringBand(86000, 103000, 0, ringOptics(1.1e-5, 0.55, 0.75)), // μ
  ],
};

// 出典: https://en.wikipedia.org/wiki/Rings_of_Neptune 。アダムス環だけがアーク構造
// (フラテルニテ/エガリテ1/エガリテ2/リベルテ/クラージュ)を持つ — 経度は 1989-08-18 の
// 固定系での実測値だが、この実装ではアーク自身の公転を追わず環に静止させたまま描く(非目標)。
export const NEPTUNE_RINGS: RingSystemDef = {
  bands: [
    ringBand(40900, 42900, 0, ringOptics(0.002, 0.45, 0.45)), // ガレ環
    ringBand(53200 - 113 / 2, 53200 + 113 / 2, 0, ringOptics(0.004, 0.45, 0.45)), // ル・ヴェリエ環
    ringBand(53200, 57200, 0, ringOptics(0.002, 0.45, 0.45)), // ラッセル環
    ringBand(57200 - 25, 57200 + 25, 0, ringOptics(0.002, 0.45, 0.45)), // アラゴ環
    ringBand(62932 - 32.5 / 2, 62932 + 32.5 / 2, 0, ringOptics(0.05, 0.5, 0.55), [
      { fromDeg: 247, toDeg: 257, opticalDepthScale: 1.8 }, // フラテルニテ
      { fromDeg: 261, toDeg: 264, opticalDepthScale: 1.8 }, // エガリテ1
      { fromDeg: 265, toDeg: 266, opticalDepthScale: 1.8 }, // エガリテ2
      { fromDeg: 276, toDeg: 280, opticalDepthScale: 1.8 }, // リベルテ
      { fromDeg: 284.5, toDeg: 285.5, opticalDepthScale: 1.8 }, // クラージュ
    ]), // アダムス環
  ],
};

// 長半径 a [m] から、周回天体の平均運動をケプラー第3法則で世紀あたりの度へ換算する。

// 出典: Braga-Ribas et al., Nature 508, 72 (2014)。C1R は半径391km・幅約7km、
// C2R は半径405km・幅約3km。
export const CHARIKLO_RINGS: RingSystemDef = {
  bands: [
    ringBand(391 - 3.5, 391 + 3.5, 0, ringOptics(0.4, 0.45, 0.1)), // C1R
    ringBand(405 - 1.5, 405 + 1.5, 0, ringOptics(0.06, 0.45, 0.1)), // C2R
  ],
};

// 出典: Morgado et al., A&A 2023。Q1R は半径約4100km(幅は方位角で変動するため代表値100km)、
// Q2R は半径2520km・幅約10km。
export const QUAOAR_RINGS: RingSystemDef = {
  bands: [
    ringBand(4100 - 50, 4100 + 50, 0, ringOptics(0.04, 0.45, 0.15)), // Q1R
    ringBand(2520 - 5, 2520 + 5, 0, ringOptics(0.004, 0.45, 0.15)), // Q2R
  ],
};
