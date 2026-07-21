import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import * as C from './const';
import { ACCENT } from './theme';

export type PipRect = { x: number; y: number; w: number; h: number; };

export interface PipRenderCtx {
  readonly renderPip: boolean;
  readonly camera: THREE.PerspectiveCamera;
  readonly playerShipObj: THREE.Object3D;
  setMuzzleFlashesVisible(visible: boolean): void;
  updateOverlay(rect: PipRect | null): void;
}

export class PipRenderer {
  private readonly crosshair: HTMLDivElement;
  private readonly pipCamera = new THREE.PerspectiveCamera();
  private readonly fwdVec = new THREE.Vector3();
  private readonly upVec = new THREE.Vector3();
  private readonly targetVec = new THREE.Vector3();

  constructor(private readonly _scene: THREE.Scene) {
    this.crosshair = this.createCrosshair();
  }

  private setupPipCamera(pipW: number, pipH: number, pos: THREE.Vector3, att: THREE.Quaternion): void {
    this.fwdVec.set(0, 0, 1).applyQuaternion(att);
    this.upVec.set(0, 1, 0).applyQuaternion(att);
    this.targetVec.copy(pos).add(this.fwdVec);
    this.pipCamera.position.copy(pos);
    this.pipCamera.up.copy(this.upVec);
    this.pipCamera.lookAt(this.targetVec);
    this.pipCamera.fov = C.ZOOM_FOV;
    this.pipCamera.aspect = pipW / pipH;
    this.pipCamera.updateProjectionMatrix();
  }

  renderPip(renderer: WebGPURenderer, ctx: PipRenderCtx): void {
    if (!ctx.renderPip) {
      this.crosshair.style.display = 'none';
      ctx.updateOverlay(null);
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;

    const pipSize = Math.min(w, h) * 0.35;
    const pipW = pipSize * 1.5;
    const pipH = pipSize;
    const padding = 20;
    const pipX = w - pipW - padding;
    const pipY = padding;
    const rect = { x: pipX, y: pipY, w: pipW, h: pipH };

    this.setupPipCamera(pipW, pipH, ctx.playerShipObj.position, ctx.playerShipObj.quaternion);

    const originalPlayerVisible = ctx.playerShipObj.visible;
    ctx.playerShipObj.visible = false;
    ctx.setMuzzleFlashesVisible(false);
    try {
      renderer.setViewport(pipX, pipY, pipW, pipH);
      renderer.setScissor(pipX, pipY, pipW, pipH);
      renderer.setScissorTest(true);
      renderer.render(this._scene, this.pipCamera);
      ctx.updateOverlay(rect);
    } finally {
      ctx.playerShipObj.visible = originalPlayerVisible;
      ctx.setMuzzleFlashesVisible(true);
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
    }

    this.crosshair.style.display = 'block';
    this.crosshair.style.left = pipX + pipW * 0.5 + 'px';
    this.crosshair.style.top = pipY + pipH * 0.5 + 'px';
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
