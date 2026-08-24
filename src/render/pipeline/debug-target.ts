// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。何も import しないので
// render/pipeline/ 側からも game/hud/ 側からも依存を持ち込まずに参照できる。
//
// 'world' は無い — composite パスの通常表示が既に world 色ターゲットをそのまま画面へ出しており、
// 'off' と 'world' は同じ絵になるため。
export type DebugTargetId = 'off' | 'normal' | 'roughness' | 'depth' | 'occlusion' | 'diffuse' | 'specular' | 'material' | 'atmosphere';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const DEBUG_TARGETS: readonly (readonly [DebugTargetId, string])[] = [
  ['off', '通常'],
  ['normal', '法線'],
  ['roughness', '粗さ'],
  ['depth', '深度'],
  ['occlusion', '遮蔽'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['atmosphere', '大気'],
];

// デバッグ表示の選択を書き込む先。game/hud/ が render/pipeline/ の具象クラス(RenderPipeline)を
// import せずに済むよう、この狭い形だけを共有する。
export interface DebugTargetHost {
  debugTarget: DebugTargetId;
}
