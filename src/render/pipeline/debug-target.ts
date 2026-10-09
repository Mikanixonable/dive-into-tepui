// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。
export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'specular' | 'correction' | 'raw-correction'
  | 'denoised-correction'
  | 'reflection-depth' | 'reflection-hit' | 'reflection-distance' | 'reflection-weight'
  | 'bounce-source' | 'material' | 'reflection-level' | 'reflection' | 'atmosphere' | 'lens' | 'planet-light';

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
  ['raw-correction', 'raw 拡散照度補正'],
  ['denoised-correction', '均した拡散照度補正'],
  ['correction', '拡散照度補正'],
  ['reflection-depth', '映り込みの深度'],
  ['reflection-hit', '映り込みの当たり位置'],
  ['reflection-distance', '映り込みの当たり距離'],
  ['reflection-weight', '映り込みの置換重み'],
  ['diffuse', '拡散照度'],
  ['specular', '鏡面照度'],
  ['material', 'マテリアル'],
  ['reflection-level', '映り込みの縮小段'],
  ['reflection', '映り込み'],
  ['atmosphere', '大気'],
  ['lens', 'レンズ'],
];
