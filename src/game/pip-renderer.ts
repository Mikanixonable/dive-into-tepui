import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import * as C from './const';
import { ACCENT } from './theme';

export type PipRect = { x: number; y: number; w: number; h: number };

export interface PipRenderCtx {
  readonly firing: boolean;
  readonly mapMode: boolean;
  readonly camera: THREE.PerspectiveCamera;
  readonly playerShipObj: THREE.Object3D;
  setMuzzleFlashesVisible(visible: boolean): void;
  updateOverlay(rect: PipRect | null): void;
}

export class PipRenderer {
  private readonly crosshair: HTMLDivElement;
  private readonly fwdVec = new THREE.Vector3();
  private readonly upVec = new THREE.Vector3();
  private readonly targetVec = new THREE.Vector3();
  private prevFiring = false;

  constructor(private readonly _scene: THREE.Scene) {
    this.crosshair = this.createCrosshair();
  }

  syncFineAttitude(
    firing: boolean,
    setFineAttitudeFromFiring: (prevFiring: boolean, nowFiring: boolean) => void,
  ): void {
    setFineAttitudeFromFiring(this.prevFiring, firing);
    this.prevFiring = firing;
  }

  renderFrame(renderer: WebGPURenderer, ctx: PipRenderCtx): void {
    if (!ctx.firing || ctx.mapMode) {
      this.crosshair.style.display = 'none';
      ctx.updateOverlay(null);
      renderer.render(this._scene, ctx.camera);
      return;
    }
    this.renderCombatWithPip(renderer, ctx);
  }

  private renderCombatWithPip(renderer: WebGPURenderer, ctx: PipRenderCtx): void {
    const scene = this._scene;
    const cam = ctx.camera;
    const w = window.innerWidth;
    const h = window.innerHeight;

    const pipSize = Math.min(w, h) * 0.35;
    const pipW = pipSize * 1.5;
    const pipH = pipSize;
    const padding = 20;
    const pipX = w - pipW - padding;
    const pipY = padding;
    const rect = { x: pipX, y: pipY, w: pipW, h: pipH };

    const originalAutoClear = renderer.autoClear;
    const originalFov = cam.fov;
    const originalAspect = cam.aspect;
    const originalPos = cam.position.clone();
    const originalQuat = cam.quaternion.clone();
    const originalPlayerVisible = ctx.playerShipObj.visible;

    renderer.autoClear = false;
    renderer.clear();
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);
    renderer.setScissorTest(true);
    renderer.render(scene, cam);

    this.fwdVec.set(0, 0, 1).applyQuaternion(ctx.playerShipObj.quaternion);
    this.upVec.set(0, 1, 0).applyQuaternion(ctx.playerShipObj.quaternion);
    this.targetVec.copy(ctx.playerShipObj.position).add(this.fwdVec);
    cam.position.copy(ctx.playerShipObj.position);
    cam.up.copy(this.upVec);
    cam.lookAt(this.targetVec);
    cam.fov = C.ZOOM_FOV;
    cam.aspect = pipW / pipH;
    cam.updateProjectionMatrix();

    ctx.playerShipObj.visible = false;
    ctx.setMuzzleFlashesVisible(false);
    try {
      renderer.setViewport(pipX, pipY, pipW, pipH);
      renderer.setScissor(pipX, pipY, pipW, pipH);
      renderer.render(scene, cam);
      ctx.updateOverlay(rect);
    } finally {
      ctx.playerShipObj.visible = originalPlayerVisible;
      ctx.setMuzzleFlashesVisible(true);
      cam.position.copy(originalPos);
      cam.quaternion.copy(originalQuat);
      cam.fov = originalFov;
      cam.aspect = originalAspect;
      cam.updateProjectionMatrix();
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.autoClear = originalAutoClear;
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
