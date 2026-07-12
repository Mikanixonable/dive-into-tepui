import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

export interface GameScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: WebGPURenderer;
  resize: () => void;
}

// 地球半径(約6,400km)から宇宙船(数m)までのスケール差に対応するため
// 対数深度バッファ相当の設定と、遠近カメラのnear/far比を広く取る。
export async function createGameScene(canvas: HTMLCanvasElement): Promise<GameScene> {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1e9,
  );
  camera.position.set(0, 0, 20000);

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
