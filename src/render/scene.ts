import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { ExposureController, NEUTRAL_CELESTIAL_EXPOSURE } from './exposure';

export interface GameScene {
  scene: THREE.Scene;
  renderer: WebGPURenderer;
  exposure: ExposureController;
  resize: () => void;
}

// 描画は自機中心のフローティングオリジン(単位: m)。宇宙船(数m)から
// 地球(半径6,371km)・星空シェル(3.5e7m)までを1つの深度レンジに収める。
// カメラ(CombatCameraSystem / OverviewCamera)はそれぞれ自身の near/far を持ち、この
// モジュールでは生成しない — アスペクト比も各カメラが毎フレーム自己補正する。
export async function createGameScene(canvas: HTMLCanvasElement): Promise<GameScene> {
  const scene = new THREE.Scene();

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  // すべての材質入力を線形 sRGB として照明・合成し、最後に表示用 sRGB へ変換する。
  // AgX は太陽・大気・加算発光を同時に扱う際のハイライトを穏やかに圧縮できる。以後の
  // 大気/LUTフェーズはこの出力変換の前にHDR値を返すことを前提とする。
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMappingExposure = NEUTRAL_CELESTIAL_EXPOSURE;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return { scene, renderer, exposure: new ExposureController(), resize };
}
