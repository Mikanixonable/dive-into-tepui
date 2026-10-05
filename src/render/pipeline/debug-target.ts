// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。

// 近傍拡散補正の帯と段の表示。kind は中間ターゲットの種類 — band は走査が遮りの画面距離の帯ごとに書く補正、
// representative は代表の面の縮小列、reduced は帯の縮小、merged は拡大と合流の出力。level は段、band は帯(帯を映す
// 種類だけ)。並びは生成順(段の中の帯は帯の順)で、WebGPU の既定の上限で書ける帯の数 5 の帯と段まで並べる。帯の
// 縮小の段 m は帯 m〜4 を持つ。
export const CHAIN_DEBUG_TARGETS = [
  { id: 'band-0', kind: 'band', level: 0, band: 0 },
  { id: 'band-1', kind: 'band', level: 0, band: 1 },
  { id: 'band-2', kind: 'band', level: 0, band: 2 },
  { id: 'band-3', kind: 'band', level: 0, band: 3 },
  { id: 'band-4', kind: 'band', level: 0, band: 4 },
  { id: 'representative-0', kind: 'representative', level: 0 },
  { id: 'representative-1', kind: 'representative', level: 1 },
  { id: 'representative-2', kind: 'representative', level: 2 },
  { id: 'representative-3', kind: 'representative', level: 3 },
  { id: 'representative-4', kind: 'representative', level: 4 },
  { id: 'reduced-1-band-1', kind: 'reduced', level: 1, band: 1 },
  { id: 'reduced-1-band-2', kind: 'reduced', level: 1, band: 2 },
  { id: 'reduced-1-band-3', kind: 'reduced', level: 1, band: 3 },
  { id: 'reduced-1-band-4', kind: 'reduced', level: 1, band: 4 },
  { id: 'reduced-2-band-2', kind: 'reduced', level: 2, band: 2 },
  { id: 'reduced-2-band-3', kind: 'reduced', level: 2, band: 3 },
  { id: 'reduced-2-band-4', kind: 'reduced', level: 2, band: 4 },
  { id: 'reduced-3-band-3', kind: 'reduced', level: 3, band: 3 },
  { id: 'reduced-3-band-4', kind: 'reduced', level: 3, band: 4 },
  { id: 'reduced-4-band-4', kind: 'reduced', level: 4, band: 4 },
  { id: 'merged-3', kind: 'merged', level: 3 },
  { id: 'merged-2', kind: 'merged', level: 2 },
  { id: 'merged-1', kind: 'merged', level: 1 },
  { id: 'merged-0', kind: 'merged', level: 0 },
] as const satisfies readonly (
  | { readonly id: string; readonly kind: 'band' | 'reduced'; readonly level: number; readonly band: number }
  | { readonly id: string; readonly kind: 'representative' | 'merged'; readonly level: number }
)[];
export type ChainDebugTarget = (typeof CHAIN_DEBUG_TARGETS)[number];
export type ChainDebugTargetId = ChainDebugTarget['id'];

// 帯と段の表示 target の名前。
function chainLabelOf(target: ChainDebugTarget): string {
  switch (target.kind) {
    case 'band': return `raw 拡散照度補正(帯 ${target.band})`;
    case 'representative': return `代表の面の法線(段 ${target.level})`;
    case 'reduced': return `縮小した帯 ${target.band}(段 ${target.level})`;
    case 'merged': return `合流した拡散照度補正(段 ${target.level})`;
  }
}

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
  ...CHAIN_DEBUG_TARGETS.map((target) => [target.id, chainLabelOf(target)] as const),
  ['correction', '拡散照度補正'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];
