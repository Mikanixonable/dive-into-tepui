// 再突入時に機首前方へ出るプラズマ状の燃焼エフェクト。強度は動圧から毎フレーム導けるため状態を持たない。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, lenSq, norm } from '../../math/vec3';
import { Billboard } from '../../render/billboard';
import {
  REENTRY_CORE_BRIGHTNESS, REENTRY_CORE_COLOR, REENTRY_CORE_OFFSET, REENTRY_CORE_SIZE_RATIO,
  REENTRY_OUTER_BRIGHTNESS, REENTRY_OUTER_COLOR, REENTRY_OUTER_OFFSET, REENTRY_OUTER_SIZE_RATIO,
  REENTRY_SIZE_MIN, REENTRY_SIZE_SPAN,
} from '../../render/vfx-style';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../camera/floating-origin';
import * as C from '../const';

export class ReentryEffects {
  private readonly core = new Billboard(REENTRY_CORE_COLOR);
  private readonly outer = new Billboard(REENTRY_OUTER_COLOR);

  // core/outer ビルボードを scene に登録する。
  constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  // 燃焼の表示を qdyn に応じた強度で速度方向前方に同期する。visible=false または
  // 強度 0 では隠す。
  sync(fo: FloatingOrigin, r: Vec3, v: Vec3, qdyn: number, visible: boolean, camera: CameraSystem): void {
    const t = (qdyn - C.REENTRY_GLOW_MIN_Q) / (C.REENTRY_GLOW_FULL_Q - C.REENTRY_GLOW_MIN_Q);
    const intensity = Math.max(0, Math.min(1, t));
    if (!visible || intensity <= 0) {
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
    const sc = REENTRY_SIZE_MIN + REENTRY_SIZE_SPAN * intensity;
    this.core.sync(fo.RtoThreeV3(addScaled(r, dir, REENTRY_CORE_OFFSET)),
      sc * REENTRY_CORE_SIZE_RATIO, REENTRY_CORE_BRIGHTNESS * intensity, camQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(r, dir, REENTRY_OUTER_OFFSET)),
      sc * REENTRY_OUTER_SIZE_RATIO, REENTRY_OUTER_BRIGHTNESS * intensity, camQuat);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh);
    this.core.dispose();
    this.outer.dispose();
  }
}
