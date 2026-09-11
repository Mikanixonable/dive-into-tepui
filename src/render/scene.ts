// 描画基盤一式(scene・WebGPU レンダラ・描画パイプライン)を組み、描画先の寸法と設定へ追従させる。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsSettingsData } from './graphics-settings';
import { reversedOpaqueSort, reversedTransparentSort } from './pipeline/reversed-sort';
import { RenderPipeline } from './pipeline/render-pipeline';
import { GpuTimings } from './gpu-timings';
import type { Viewport } from './viewport';

// canvas と同じ寿命を持つ描画基盤一式。GPU 資源を確保するので、1つだけ作って使い回す。
export interface GameScene {
  readonly scene: THREE.Scene;
  readonly renderer: WebGPURenderer;
  readonly gpu: GpuTimings;
  readonly pipeline: RenderPipeline;
  // いま描いているビューポート(直近の syncViewport の値)。
  readonly viewport: Viewport;
  // 描画先の寸法をこのフレームの値へ合わせる。前回と同じなら何もしない。
  readonly syncViewport: (viewport: Viewport) => void;
  // 描画解像度の倍率とパスの品質を設定から取り直す。リサイズをまたいでも維持される。
  readonly applyGraphics: (graphics: GraphicsSettingsData) => void;
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
    canvas, trackTimestamp: true, reversedDepthBuffer: true,
  });
  renderer.setOpaqueSort(reversedOpaqueSort);
  renderer.setTransparentSort(reversedTransparentSort);
  // 解像度の倍率は設定側の値なので、寸法とは別に覚えて掛け直す。
  let resolutionScale = graphics.resolutionScale;
  let current = viewport;
  // レンダラの解像度を、覚えている寸法と倍率から立て直す。
  const applyResolution = () => {
    renderer.setPixelRatio(current.pixelRatio * resolutionScale);
    renderer.setSize(current.width, current.height);
  };

  applyResolution();
  await renderer.init();

  // パスは初期化済みのレンダラを要するので、init() のあとに作る。
  const gpu = new GpuTimings(renderer);
  const pipeline = new RenderPipeline(renderer, graphics, gpu);

  // 描画先の寸法をこのフレームの値へ合わせる。前回と同じなら何もしない。
  const syncViewport = (next: Viewport) => {
    if (next.width === current.width && next.height === current.height && next.pixelRatio === current.pixelRatio) {
      return;
    }
    current = next;
    applyResolution();
  };

  // 描画解像度の倍率とパスの品質を設定から取り直す。
  const applyGraphics = (next: GraphicsSettingsData) => {
    resolutionScale = next.resolutionScale;
    applyResolution();
    pipeline.applyGraphics(next);
  };

  return {
    scene, renderer, gpu, pipeline, syncViewport, applyGraphics,
    get viewport(): Viewport { return current; },
  };
}
