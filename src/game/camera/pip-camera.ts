// 発砲中に表示するピクチャーインピクチャー(照準ズーム窓)用のカメラ。
// 視点自体は ChaseCamera のガンサイト視点(機首固定、姿勢基準)と同じだが、画面全体では
// なく右上の小矩形(rect)へ独立して描画するため、専用の THREE.PerspectiveCamera を持つ。
// ChaseCamera/MapCamera と同じ update(論理座標を絶対 ECI で算出)/sync(fo 経由で THREE.js
// へ反映)の分離に揃えることで、マーカー投影(ProjectFn)などのインフラを共有できる。
// 実際の renderer.render() 呼び出しは PipRenderer の責務であり、ここでは行わない。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, v3 } from '../../physics/vec3';
import { qRotate } from '../../physics/attitude';
import * as C from '../const';
import { Player } from '../player/player';
import { FloatingOrigin } from '../floating-origin';
import { ndcToScreen, projectToNdc, ViewFrame } from '../../physics/projection';
import { ProjectFn } from './camera-system';

export type PipRect = { x: number; y: number; w: number; h: number; };

// PIP 窓のスクリーン矩形(右上、短辺の35%を基準にした固定レイアウト)。
function computePipRect(): PipRect {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pipSize = Math.min(w, h) * 0.35;
  const pipW = pipSize * 1.5;
  const pipH = pipSize;
  const padding = 20;
  return { x: w - pipW - padding, y: padding, w: pipW, h: pipH };
}

export class PipCamera {
  readonly camera = new THREE.PerspectiveCamera(C.ZOOM_FOV, 1, 2, 6e7);
  rect: PipRect = computePipRect();

  // update() が算出し sync() が camera へ反映する視点の数学状態(絶対 ECI)。
  private position: Vec3 = v3();
  private upDir: Vec3 = v3(0, 1, 0);
  private lookTarget: Vec3 = v3();

  // 自機のガンサイト視点(機首 +Z 方向)を絶対 ECI で算出する。
  update(player: Player): void {
    this.rect = computePipRect();
    const fwd = qRotate(player.att.q, v3(0, 0, 1));
    this.upDir = qRotate(player.att.q, v3(0, 1, 0));
    this.position = player.state.r;
    this.lookTarget = addScaled(player.state.r, fwd, 1000);
  }

  sync(fo: FloatingOrigin): void {
    const camera = this.camera;
    camera.position.copy(fo.RtoThreeV3(this.position));
    camera.up.set(this.upDir.x, this.upDir.y, this.upDir.z);
    camera.lookAt(fo.RtoThreeV3(this.lookTarget));
    const aspect = this.rect.w / this.rect.h;
    if (Math.abs(camera.aspect - aspect) > 1e-6) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  // rect 内のピクセル座標へ投影する ProjectFn(全画面基準の CameraSystem.activeCameraProjection
  // と同じ投影式を rect のオフセット/スケールへ写像しただけ)。
  get projection(): ProjectFn {
    const view: ViewFrame = {
      position: this.position,
      lookTarget: this.lookTarget,
      up: this.upDir,
      fovDeg: C.ZOOM_FOV,
      aspect: this.rect.w / this.rect.h,
    };
    return (worldPos) => ndcToScreen(projectToNdc(view, worldPos), this.rect.w, this.rect.h, this.rect.x, this.rect.y);
  }
}
