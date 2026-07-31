import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

export interface GameScene {
  scene: THREE.Scene;
  renderer: WebGPURenderer;
  resize: () => void;
}

// 描画は自機中心のフローティングオリジン(単位: m)。宇宙船(数m)から
// 地球(半径6,371km)・星空シェル(3.5e7m)までを1つの深度レンジに収める。
// カメラ(ChaseCamera / OverviewCamera)はそれぞれ自身の near/far を持ち、この
// モジュールでは生成しない — アスペクト比も各カメラが毎フレーム自己補正する。
export async function createGameScene(canvas: HTMLCanvasElement): Promise<GameScene> {
  const scene = new THREE.Scene();

  // WebGPU レンダラを初期化する
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  // ウィンドウのリサイズにレンダラのサイズを追随させる。
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return { scene, renderer, resize };
}
