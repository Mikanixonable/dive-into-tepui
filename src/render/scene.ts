// 描画基盤一式(scene・WebGPU レンダラ・描画パイプライン)を組み、描画先の寸法と設定へ追従させる。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsSettingsData } from './graphics-settings';
import { reversedOpaqueSort, reversedTransparentSort } from './pipeline/reversed-sort';
import { RenderPipeline } from './pipeline/render-pipeline';
import { GpuTimings } from './gpu-timings';
import { effectivePixelRatio } from './viewport';
import { renderBackendKindOf, type RenderBackendKind } from './render-backend';
import type { DebugTargetId } from './pipeline/debug-target';
import type { Viewport } from './viewport';
import { webGpuRequiredLimits } from './webgpu-required-limits';

// canvas と同じ寿命を持つ描画基盤一式。GPU 資源を確保するので、1つだけ作って使い回す。
export interface GameScene {
  readonly scene: THREE.Scene;
  readonly renderer: WebGPURenderer;
  // 初期化時に実際に選ばれた描画バックエンド。
  readonly backend: RenderBackendKind;
  readonly gpu: GpuTimings;
  readonly pipeline: RenderPipeline;
  // いま描いているビューポート(直近の syncFrame の値)。
  readonly viewport: Viewport;
  // 描画先の寸法と描画設定を、このフレームの値へ合わせる。どちらも前回と同じなら何もしない。
  readonly syncFrame: (
    viewport: Viewport, graphics: GraphicsSettingsData, debugTarget: DebugTargetId,
  ) => void;
}

// 描画バックエンド(WebGPU / WebGL2)のどちらも初期化できなかったことを表す。
// 初期化の失敗のうち、この型で届いたものが「対応する基盤が無い」失敗である。
export class RenderBackendUnavailableError extends Error {
  public constructor(cause: unknown) {
    super('描画バックエンドを初期化できなかった', { cause });
    this.name = 'RenderBackendUnavailableError';
  }
}

// canvas へ描画基盤一式を組む。描画座標は自機中心 [m]。数 m の機体から星殻までを1つの深度
// レンジに収めるため、深度は反転(near=1 / far=0)した 32bit 浮動小数点で持つ。
export async function createGameScene(
  canvas: HTMLCanvasElement, graphics: GraphicsSettingsData, viewport: Viewport,
): Promise<GameScene> {
  const scene = new THREE.Scene();
  // Scene 自身が layer 0 だけだと、カメラのレイヤーを絞ったときに子の走査ごと止まる。
  scene.layers.enableAll();

  // trackTimestamp と reversedDepthBuffer は生成時に渡す。後者をあとから代入すると、深度比較
  // 関数だけが非反転のまま残る。
  const renderer = new WebGPURenderer({
    canvas, trackTimestamp: true, reversedDepthBuffer: true, requiredLimits: await webGpuRequiredLimits(),
  });
  renderer.setOpaqueSort(reversedOpaqueSort);
  renderer.setTransparentSort(reversedTransparentSort);
  // 解像度は寸法と設定の倍率の積なので、どちらも覚えておいて掛け直す。
  let current = viewport;
  let currentGraphics = graphics;
  // レンダラの解像度を、覚えている寸法と倍率から立て直す。
  const applyResolution = () => {
    renderer.setPixelRatio(effectivePixelRatio(current, currentGraphics.resolutionScale));
    renderer.setSize(current.width, current.height);
  };

  applyResolution();
  try {
    await renderer.init();
  } catch (error) {
    // init が失敗するのは、WebGPU とフォールバック先の WebGL2 の両方が初期化できなかった
    // ときだけである(片方の失敗は three がもう片方で吸収する)。基盤が無い失敗として包む。
    throw new RenderBackendUnavailableError(error);
  }
  // 初期化を終えた時点で renderer.backend は実際に選ばれた側を指す。識別フラグは公開型に
  // 出ていないので、gpu-timings と同じく狭い形で読む。
  const backendFlags = renderer.backend as unknown as {
    isWebGPUBackend?: boolean; isWebGLBackend?: boolean;
  };
  const backend = renderBackendKindOf(
    backendFlags.isWebGPUBackend === true, backendFlags.isWebGLBackend === true,
  );

  // パスは初期化済みのレンダラを要するので、init() のあとに作る。
  const gpu = new GpuTimings(renderer);
  const pipeline = new RenderPipeline(renderer, graphics, gpu);

  // 描画先の寸法と描画設定を、このフレームの値へ合わせる。**描画設定は値の同一性で比べる** —
  // 同じ設定のまま組み直すと、影マップなどの GPU 資源を毎フレーム捨てて作り直すことになる。
  // 解像度は寸法か倍率が変わったときだけ立て直す — 描画先を張り直すので、設定が別の参照になるたびに
  // 立て直すと、スライダーを動かしているあいだ引っかかる。
  const syncFrame = (next: Viewport, nextGraphics: GraphicsSettingsData, debugTarget: DebugTargetId) => {
    const rescaled = next.width !== current.width || next.height !== current.height
      || next.pixelRatio !== current.pixelRatio || nextGraphics.resolutionScale !== currentGraphics.resolutionScale;
    const requalified = nextGraphics !== currentGraphics;
    current = next;
    currentGraphics = nextGraphics;
    if (rescaled) applyResolution();
    if (requalified) pipeline.rebuildForGraphics(nextGraphics);
    pipeline.syncDebugTarget(debugTarget);
  };

  return {
    scene, renderer, backend, gpu, pipeline, syncFrame,
    get viewport(): Viewport { return current; },
  };
}
