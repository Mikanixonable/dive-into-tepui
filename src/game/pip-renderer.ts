import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { ACCENT } from './theme';
import { PipCamera } from './camera/pip-camera';

export interface PipRenderCtx {
  readonly renderPip: boolean;
  readonly pipCamera: PipCamera;
  readonly playerShipObj: THREE.Object3D;
  setMuzzleFlashesVisible(visible: boolean): void;
  updateOverlay(rect: PipCamera['rect'] | null): void;
}

export class PipRenderer {
  private readonly crosshair: HTMLDivElement;

  constructor(private readonly _scene: THREE.Scene) {
    this.crosshair = this.createCrosshair();
  }

  renderPip(renderer: WebGPURenderer, ctx: PipRenderCtx): void {
    if (!ctx.renderPip) {
      this.crosshair.style.display = 'none';
      ctx.updateOverlay(null);
      return;
    }

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
      ctx.updateOverlay(ctx.pipCamera.rect);
    } finally {
      ctx.playerShipObj.visible = originalPlayerVisible;
      ctx.setMuzzleFlashesVisible(true);
      renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
      renderer.setScissorTest(false);
      renderer.autoClearColor = originalAutoClearColor;
    }

    this.crosshair.style.display = 'block';
    this.crosshair.style.left = x + w * 0.5 + 'px';
    this.crosshair.style.top = y + h * 0.5 + 'px';
  }

  private createCrosshair(): HTMLDivElement {
    const pipCrosshair = document.createElement('div');
    pipCrosshair.id = 'pip-crosshair';
    pipCrosshair.style.position = 'fixed';
    pipCrosshair.style.pointerEvents = 'none';
    pipCrosshair.style.color = ACCENT;
    pipCrosshair.style.fontSize = '24px';
    pipCrosshair.style.fontFamily = 'sans-serif';
    pipCrosshair.innerText = '+';
    pipCrosshair.style.transform = 'translate(-50%, -50%)';
    pipCrosshair.style.zIndex = '1000';
    pipCrosshair.style.display = 'none';
    document.body.appendChild(pipCrosshair);
    return pipCrosshair;
  }
}
