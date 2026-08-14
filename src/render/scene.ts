import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import type { GraphicsSettings } from './graphics-settings';

export interface GameScene {
  scene: THREE.Scene;
  renderer: WebGPURenderer;
  resize: () => void;
  // 描画解像度を devicePixelRatio の倍率で与える。リサイズをまたいでも維持される。
  setResolutionScale: (scale: number) => void;
}

// 描画は自機中心のフローティングオリジン(単位: m)。宇宙船(数m)から
// 地球(半径6,371km)・星空シェル(3.5e7m)までを1つの深度レンジに収める。
// カメラ(CombatCameraSystem / OverviewCamera)はそれぞれ自身の near/far を持ち、この
// モジュールでは生成しない — アスペクト比も各カメラが毎フレーム自己補正する。
export async function createGameScene(canvas: HTMLCanvasElement, graphics: GraphicsSettings): Promise<GameScene> {
  const scene = new THREE.Scene();

  // antialias も trackTimestamp もレンダラ生成時にしか渡せない。前者は設定変更が次回起動から
  // 効く理由で、後者はデバイスの要求機能に載るため負荷確認ウィンドウの開閉では切り替えられない。
  // 常時オンで払う時刻印の費用は、閉窓時のフレーム間隔の実測でばらつきに埋もれた。
  const renderer = new WebGPURenderer({
    canvas, antialias: graphics.current.antialias, trackTimestamp: true,
  });
  // devicePixelRatio は表示先の切り替えで変わるので、倍率だけを覚えて掛け直す。
  let resolutionScale = 1;
  // 描画解像度を devicePixelRatio の何倍にするかを与える。
  const setResolutionScale = (scale: number) => {
    resolutionScale = scale;
    renderer.setPixelRatio(window.devicePixelRatio * scale);
  };
  // 画面サイズへ追従する。倍率は覚えているものを掛け直す。
  const resize = () => {
    renderer.setPixelRatio(window.devicePixelRatio * resolutionScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  setResolutionScale(1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  await renderer.init();

  window.addEventListener('resize', resize);

  const gameScene: GameScene = { scene, renderer, resize, setResolutionScale };
  graphics.bindResolutionTarget(gameScene);
  return gameScene;
}
