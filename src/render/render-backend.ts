// 描画バックエンド(WebGPU / WebGL2)の判定と、その結果を利用者へどう示すかの決定を持つ。

// 描画に使われているバックエンド。'unavailable' は、どちらの基盤も初期化できなかった状態を表す。
export type RenderBackendKind = 'webgpu' | 'webgl2' | 'unavailable';

// バックエンドの識別フラグから、実際に使われているバックエンドを判定する。
// 初期化済みのレンダラではどちらか一方のフラグが立つ。どちらも立たない入力は、
// 使える基盤が無いものとして 'unavailable' へ写す。
export function renderBackendKindOf(isWebGPUBackend: boolean, isWebGLBackend: boolean): RenderBackendKind {
  if (isWebGPUBackend) return 'webgpu';
  if (isWebGLBackend) return 'webgl2';
  return 'unavailable';
}

// バックエンドに対する利用者への示し方。
// - 'none': 何も示さない
// - 'fallback-notice': WebGL2 で描いている旨を通知する
// - 'unavailable-error': 描画を開始せず、基盤が無いことを示すエラーで止まる
export type RenderBackendNotice = 'none' | 'fallback-notice' | 'unavailable-error';

// バックエンドから、利用者への示し方を決める(SPEC「描画バックエンド」)。
export function renderBackendNoticeOf(kind: RenderBackendKind): RenderBackendNotice {
  switch (kind) {
    case 'webgpu': return 'none';
    case 'webgl2': return 'fallback-notice';
    case 'unavailable': return 'unavailable-error';
  }
}
