// render/pipeline/ の中間ターゲットを画面全体へ映すデバッグ表示の選択肢。
export type DebugTargetId =
  | 'off' | 'normal' | 'roughness' | 'basecolor' | 'metalness' | 'emissive' | 'depth'
  | 'shadow-map' | 'shadow-map-slot' | 'shadow' | 'diffuse' | 'direct-specular' | 'far-specular'
  | 'correction' | 'raw-correction' | 'denoised-correction'
  | 'bounce-source' | 'material' | 'reflection-source'
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
  ['bounce-source', '照り返しの源'],
  ['raw-correction', 'raw 拡散照度補正'],
  ['denoised-correction', '均した拡散照度補正'],
  ['correction', '拡散照度補正'],
  ['diffuse', '拡散照度'],
  ['direct-specular', '直接の鏡面照度'],
  ['far-specular', '遠方の鏡面照度'],
  ['material', 'マテリアル'],
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
