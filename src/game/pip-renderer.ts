// PIP(発砲中の照準ズーム窓)一式: 2度目の描画パスと、窓に重ねるマーカー(PipOverlay)。
// 「このフレームに PIP を出すか」の判定は game が持ち、sync と renderPip の両方へ同じ値が
// 渡ってくる(ここで再判定しない — 判定が二重化すると sync とパスが食い違う)。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { PipCamera } from './camera/pip-camera';
import { MarkerManager } from './marker/marker-manager';
import { PipOverlay } from './marker/pip-overlay';
import type { Enemy } from './orbit-entity/enemy';
import type { Player } from './player/player';

export interface PipRenderCtx {
  readonly renderPip: boolean;
  readonly pipCamera: PipCamera;
  readonly playerShipObj: THREE.Object3D;
  setMuzzleFlashesVisible(visible: boolean): void;
}

export class PipRenderer {
  private readonly overlay: PipOverlay;

  constructor(private readonly _scene: THREE.Scene, markerManager: MarkerManager) {
    this.overlay = new PipOverlay(markerManager);
  }

  // 窓に重ねるマーカーは DOM なので、描画パスではなく sync フェーズで置く。
  sync(active: boolean, player: Player, target: Enemy | null, pipCamera: PipCamera): void {
    this.overlay.sync(active, player, target, pipCamera);
  }

  renderPip(renderer: WebGPURenderer, ctx: PipRenderCtx): void {
    if (!ctx.renderPip) return;

    const { x, y, w, h } = ctx.pipCamera.rect;

    const originalPlayerVisible = ctx.playerShipObj.visible;
    ctx.playerShipObj.visible = false;
    ctx.setMuzzleFlashesVisible(false);
    // この render() はフレーム中2回目の呼び出しになる。既定の autoClear のままだと、
    // WebGPU の render-pass クリアは(色クリアは)ビューポート/シザーに関わらず
    // アタッチメント全体を消してしまうため、setViewport で絞ったつもりでもメイン画面側の
    // 描画結果ごと消えてしまう。色クリアのみ止め、深度クリアは維持して PIP 自身の
    // 奥行き判定は正しく行わせる。
    const originalAutoClearColor = renderer.autoClearColor;
    renderer.autoClearColor = false;
    try {
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.setScissorTest(true);
      renderer.render(this._scene, ctx.pipCamera.camera);
    } finally {
      ctx.playerShipObj.visible = originalPlayerVisible;
      ctx.setMuzzleFlashesVisible(true);
      renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
      renderer.setScissorTest(false);
      renderer.autoClearColor = originalAutoClearColor;
    }
  }
}
