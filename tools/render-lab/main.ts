// 描画テスト環境の画面。いまは配線の確認だけ — canvas 1 枚を単色で塗る。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

const WIDTH = 960;
const HEIGHT = 540;

async function init(): Promise<void> {
  const canvas = document.getElementById('prepass') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  renderer.setSize(WIDTH, HEIGHT);
  renderer.setClearColor(0x1b3a5a);
  await renderer.init();
  renderer.render(new THREE.Scene(), new THREE.PerspectiveCamera());
}

// 失敗は握り潰さない。canvas が黒いまま無言で残ると、器の不備を絵の問題と読み違える。
init().catch((e: unknown) => {
  document.getElementById('error')!.textContent = String(e);
});
