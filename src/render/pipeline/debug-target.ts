// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。

import { GRAPHICS_FIELDS } from '../graphics-settings';

// 近傍拡散補正の帯と段の表示。kind は中間ターゲットの種類 — band は走査が遮りの画面距離の帯ごとに書く補正、
// representative は代表の面の縮小列、reduced は帯の縮小、merged は拡大と合流の出力。level は段、band は帯(帯を映す
// 種類だけ)。
export type ChainDebugTarget =
  | { readonly id: `band-${number}`; readonly kind: 'band'; readonly level: 0; readonly band: number }
  | { readonly id: `representative-${number}`; readonly kind: 'representative'; readonly level: number }
  | {
    readonly id: `reduced-${number}-band-${number}`; readonly kind: 'reduced'; readonly level: number;
    readonly band: number;
  }
  | { readonly id: `merged-${number}`; readonly kind: 'merged'; readonly level: number }
  | { readonly id: `merged-share-${number}`; readonly kind: 'merged-share'; readonly level: number };

// from 以上 to 未満の整数の並び。
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, offset) => from + offset);
}

const MAX_BAND_COUNT = GRAPHICS_FIELDS.screenSpace.knobs.screenSpaceBandCount.max;

// 並びは生成順(段の中の帯は帯の順)で、描画設定の均しの段数の上限まで並べる。
export const CHAIN_DEBUG_TARGETS: readonly ChainDebugTarget[] = [
  ...range(0, MAX_BAND_COUNT).map((band): ChainDebugTarget => ({ id: `band-${band}`, kind: 'band', level: 0, band })),
  ...range(0, MAX_BAND_COUNT).map((level): ChainDebugTarget => (
    { id: `representative-${level}`, kind: 'representative', level })),
  ...range(1, MAX_BAND_COUNT).flatMap((level) => range(level, MAX_BAND_COUNT).map((band): ChainDebugTarget => (
    { id: `reduced-${level}-band-${band}`, kind: 'reduced', level, band }))),
  ...range(0, MAX_BAND_COUNT - 1).reverse().flatMap((level): ChainDebugTarget[] => [
    { id: `merged-${level}`, kind: 'merged', level },
    { id: `merged-share-${level}`, kind: 'merged-share', level },
  ]),
];
export type ChainDebugTargetId = ChainDebugTarget['id'];

// 帯と段の表示 target の名前。
function chainLabelOf(target: ChainDebugTarget): string {
  switch (target.kind) {
    case 'band': return `raw 拡散照度補正(帯 ${target.band})`;
    case 'representative': return `代表の面の法線(段 ${target.level})`;
    case 'reduced': return `縮小した帯 ${target.band}(段 ${target.level})`;
    case 'merged': return `合流した拡散照度補正(段 ${target.level})`;
    case 'merged-share': return `均された割合 A(段 ${target.level})`;
  }
}

export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'direct-specular' | 'far-specular'
  | 'correction' | ChainDebugTargetId
  | 'bounce-source' | 'reflection-source'
  | 'reflection-depth' | 'raw-reflection-weight' | 'raw-reflection-distance' | 'raw-reflection'
  | 'denoised-reflection-weight' | 'denoised-reflection-distance' | 'denoised-reflection' | 'reflection-denoise-level'
  | 'atmosphere' | 'lens' | 'planet-light';

// 通常だけを先頭の例外とし、以後は各 target が本番フレームで生成される依存順に並べる。
export const DEBUG_TARGETS: readonly (readonly [DebugTargetId, string])[] = [
  ['off', '通常'],
  ['shadow-map', '影マップ'],
  ['shadow-map-slot', '影マップのスロット'],
  ['normal', '法線'],
  ['roughness', '粗さ'],
  ['basecolor', 'ベース色'],
  ['metalness', '金属度'],
  ['emissive', '自己発光'],
  ['depth', '深度'],
  ['shadow', '影'],
  ['planet-light', '天体照の光源テクスチャ'],
  ['diffuse', '遠方の拡散照度'],
  ['direct-specular', '直接の鏡面照度'],
  ['far-specular', '遠方の鏡面照度'],
  ['bounce-source', '照り返しの源'],
  ...CHAIN_DEBUG_TARGETS.map((target) => [target.id, chainLabelOf(target)] as const),
  ['correction', '拡散照度補正'],
  ['reflection-source', '映り込みの像の元'],
  ['reflection-depth', '映り込みの深度'],
  ['raw-reflection-weight', 'raw 映り込みの置換重み'],
  ['raw-reflection-distance', 'raw 映り込みの当たり距離'],
  ['raw-reflection', 'raw 映り込み'],
  ['denoised-reflection-weight', '均した映り込みの置換重み'],
  ['denoised-reflection-distance', '均した映り込みの当たり距離'],
  ['denoised-reflection', '均した映り込み'],
  ['reflection-denoise-level', '映り込みの均しの段'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];
