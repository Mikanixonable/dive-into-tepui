// 再突入時に機首前方へ出るプラズマ状の燃焼エフェクト。強度は動圧から毎フレーム導けるため状態を持たない。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, lenSq, norm } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';

const PLASMA_CORE_COLOR = 0xfff2d9;
const PLASMA_OUTER_COLOR = 0xff7a1f;

export class ReentryEffects {
  private readonly core = new Billboard(PLASMA_CORE_COLOR);
  private readonly outer = new Billboard(PLASMA_OUTER_COLOR);

  // core/outer ビルボードを scene に登録する。
  constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  // 燃焼の表示を qdyn に応じた強度で速度方向前方に同期する。alive=false または
  // 強度 0 では隠す。
  sync(fo: FloatingOrigin, r: Vec3, v: Vec3, qdyn: number, alive: boolean, camera: CameraSystem): void {
    const t = (qdyn - C.REENTRY_GLOW_MIN_Q) / (C.REENTRY_GLOW_FULL_Q - C.REENTRY_GLOW_MIN_Q);
    const intensity = Math.max(0, Math.min(1, t));
    if (!alive || intensity <= 0) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    // 衝撃波は対気速度方向に立つので、向きは ECI の絶対速度で決める。
    if (lenSq(v) <= 1e-6) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    const dir = norm(v);
    const camQuat = camera.activeCamera.quaternion;
    const sc = 1.5 + 3.5 * intensity;
    this.core.sync(fo.RtoThreeV3(addScaled(r, dir, 3.0)), sc * 1.4, 0.75 * intensity, camQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(r, dir, 5.5)), sc * 3.2, 0.35 * intensity, camQuat);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh);
    this.core.dispose();
    this.outer.dispose();
  }
}
