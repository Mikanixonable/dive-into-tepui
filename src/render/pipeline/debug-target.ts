// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。何も import しないので
// render/pipeline/ 側からも game/hud/ 側からも依存を持ち込まずに参照できる。
//
// 'world' は無い — composite パスの通常表示が既に world 色ターゲットをそのまま画面へ出しており、
// 'off' と 'world' は同じ絵になるため。
export type DebugTargetId = 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth' | 'shadow' | 'shadow-slot' | 'occlusion' | 'diffuse' | 'specular' | 'material' | 'atmosphere' | 'lens';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const DEBUG_TARGETS: readonly (readonly [DebugTargetId, string])[] = [
  ['off', '通常'],
  ['normal', '法線'],
  ['roughness', '粗さ'],
  ['basecolor', 'ベース色'],
  ['metalness', '金属度'],
  ['emissive', '自己発光'],
  ['depth', '深度'],
  ['shadow', '影'],
  ['shadow-slot', '影スロット'],
  ['occlusion', '遮蔽'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];

// デバッグ表示の選択を書き込む先。選択欄を持つ側が render/pipeline/ の具象クラス
// (RenderPipeline)を import せずに済むよう、この狭い形だけを共有する。
export interface DebugTargetHost {
  debugTarget: DebugTargetId;
}
