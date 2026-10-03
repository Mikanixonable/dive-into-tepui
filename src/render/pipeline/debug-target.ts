// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。

// 近傍拡散補正の、帯と段ごとの中間ターゲットの種類。band は走査が遮りの画面距離の帯ごとに書く補正(index は帯)、
// representative は代表の面の縮小列、reduced は帯の縮小、merged は拡大と合流の出力(index は段)。
export type ChainTargetKind = 'band' | 'representative' | 'reduced' | 'merged';

// 近傍拡散補正の帯と段の表示。並びは生成順で、WebGPU の既定の上限で書ける帯の数 5 の帯と段まで並べる。
export const CHAIN_DEBUG_TARGETS = [
  { id: 'band-0', kind: 'band', index: 0 },
  { id: 'band-1', kind: 'band', index: 1 },
  { id: 'band-2', kind: 'band', index: 2 },
  { id: 'band-3', kind: 'band', index: 3 },
  { id: 'band-4', kind: 'band', index: 4 },
  { id: 'representative-1', kind: 'representative', index: 1 },
  { id: 'representative-2', kind: 'representative', index: 2 },
  { id: 'representative-3', kind: 'representative', index: 3 },
  { id: 'representative-4', kind: 'representative', index: 4 },
  { id: 'reduced-1', kind: 'reduced', index: 1 },
  { id: 'reduced-2', kind: 'reduced', index: 2 },
  { id: 'reduced-3', kind: 'reduced', index: 3 },
  { id: 'reduced-4', kind: 'reduced', index: 4 },
  { id: 'merged-3', kind: 'merged', index: 3 },
  { id: 'merged-2', kind: 'merged', index: 2 },
  { id: 'merged-1', kind: 'merged', index: 1 },
  { id: 'merged-0', kind: 'merged', index: 0 },
] as const satisfies readonly { readonly id: string; readonly kind: ChainTargetKind; readonly index: number }[];
export type ChainDebugTargetId = (typeof CHAIN_DEBUG_TARGETS)[number]['id'];

// 帯と段の表示の名前。
const CHAIN_LABELS: Readonly<Record<ChainTargetKind, (index: number) => string>> = {
  band: (band) => `raw 拡散照度補正(帯 ${band})`,
  representative: (level) => `代表の面の法線(段 ${level})`,
  reduced: (level) => `縮小した帯の和(段 ${level})`,
  merged: (level) => `合流した拡散照度補正(段 ${level})`,
};

export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'specular' | 'correction' | ChainDebugTargetId
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
  ...CHAIN_DEBUG_TARGETS.map(({ id, kind, index }) => [id, CHAIN_LABELS[kind](index)] as const),
  ['correction', '拡散照度補正'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];
