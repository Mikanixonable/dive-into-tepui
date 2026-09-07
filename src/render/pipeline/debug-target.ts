// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。
export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'specular' | 'material' | 'atmosphere' | 'lens';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const DEBUG_TARGETS: readonly (readonly [DebugTargetId, string])[] = [
  ['off', '通常'],
  ['normal', '法線'],
  ['roughness', '粗さ'],
  ['basecolor', 'ベース色'],
  ['metalness', '金属度'],
  ['emissive', '自己発光'],
  ['depth', '深度'],
  ['shadow-map', '影マップ'],
  ['shadow-map-slot', '影マップのスロット'],
  ['shadow', '影'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];

// デバッグ表示の選択を書き込む先。
export interface DebugTargetHost {
  debugTarget: DebugTargetId;
}
