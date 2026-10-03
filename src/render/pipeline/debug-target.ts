// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。

// 近傍拡散補正の走査が遮りの画面距離の帯ごとに書く、復元前の補正の表示。並びは帯の番号で、WebGPU の既定の上限で
// 書ける帯の数 5 だけ並べる。
export const BAND_DEBUG_TARGETS = ['band-0', 'band-1', 'band-2', 'band-3', 'band-4'] as const;
export type BandDebugTargetId = (typeof BAND_DEBUG_TARGETS)[number];

export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'specular' | 'correction' | BandDebugTargetId
  | 'bounce-source' | 'material' | 'atmosphere' | 'lens' | 'planet-light';

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
  ['bounce-source', '照り返しの源'],
  ...BAND_DEBUG_TARGETS.map((id, band) => [id, `raw 拡散照度補正(帯 ${band})`] as const),
  ['correction', '拡散照度補正'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];
