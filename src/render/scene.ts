import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

export interface GameScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: WebGPURenderer;
  resize: () => void;
}

// 描画は自機中心のフローティングオリジン(単位: m)。宇宙船(数m)から
// 地球(半径6,371km)・星空シェル(3.5e7m)までを1つの深度レンジに収める。
// near=2m なら地平線距離(~2,400km)での深度誤差も大気シェルの厚みより
// 十分小さく、対数深度バッファなしで z-fighting を回避できる。
export async function createGameScene(canvas: HTMLCanvasElement): Promise<GameScene> {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    2,
    6e7,
  );
  camera.position.set(0, 0, 40);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, resize };
}
