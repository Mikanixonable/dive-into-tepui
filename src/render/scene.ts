import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsSettingsData } from './graphics-settings';
import { reversedOpaqueSort, reversedTransparentSort } from './pipeline/reversed-sort';
import { RenderPipeline } from './pipeline/render-pipeline';
import { GpuTimings } from './gpu-timings';

// canvas と同じ寿命を持つ描画基盤一式。GPU 資源を確保するので、1つだけ作って使い回す。
export interface GameScene {
  scene: THREE.Scene;
  renderer: WebGPURenderer;
  gpu: GpuTimings;
  pipeline: RenderPipeline;
  // 描画解像度の倍率とパスの品質を設定から取り直す。リサイズをまたいでも維持される。
  applyGraphics: (graphics: GraphicsSettingsData) => void;
}

// 描画は自機中心のフローティングオリジン(単位: m)。宇宙船(数m)から
// 地球(半径6,371km)・星空シェル(3.5e7m)までを1つの深度レンジに収める。深度は反転
// (near=1 / far=0)して 32bit 浮動小数点で持つので、相対誤差は距離に依らず一定になる。
// カメラ(FocusCamera)は自身の near/far を持ち、このモジュールでは生成しない —
// アスペクト比も各カメラが毎フレーム自己補正する。
export async function createGameScene(canvas: HTMLCanvasElement, graphics: GraphicsSettingsData): Promise<GameScene> {
  const scene = new THREE.Scene();
  // RenderPipeline はカメラのレイヤーを一時的に不透明物/背景へ絞る。Scene 自身が既定の
  // layer 0 だけだと、その時点で子要素の走査まで止まるため、コンテナとして全レイヤーを受ける。
  scene.layers.enableAll();

  // trackTimestamp も reversedDepthBuffer もレンダラ生成時にしか渡せない。前者はデバイスの
  // 要求機能に載るため、後者は深度比較関数が構築時の値だけを読むため — あとから代入すると
  // 投影行列とクリア値だけが反転し、比較関数が非反転のまま取り残される。
  const renderer = new WebGPURenderer({
    canvas, trackTimestamp: true, reversedDepthBuffer: true,
  });
  renderer.setOpaqueSort(reversedOpaqueSort);
  renderer.setTransparentSort(reversedTransparentSort);
  // devicePixelRatio は表示先の切り替えで変わるので、倍率だけを覚えて掛け直す。
  let resolutionScale = graphics.resolutionScale;
  // 画面サイズへ追従する。倍率は覚えているものを掛け直す。
  const resize = () => {
    renderer.setPixelRatio(window.devicePixelRatio * resolutionScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  resize();
  await renderer.init();

  window.addEventListener('resize', resize);

  // パスは初期化済みのレンダラでしか組めないので、init() のあとに作る。
  const gpu = new GpuTimings(renderer);
  const pipeline = new RenderPipeline(renderer, graphics, gpu);

  // 描画解像度の倍率とパスの品質を設定から取り直す。
  const applyGraphics = (next: GraphicsSettingsData) => {
    resolutionScale = next.resolutionScale;
    renderer.setPixelRatio(window.devicePixelRatio * resolutionScale);
    pipeline.applyGraphics(next);
  };

  return { scene, renderer, gpu, pipeline, applyGraphics };
}
