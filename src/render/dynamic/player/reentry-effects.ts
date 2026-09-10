// 再突入時に機首前方へ出るプラズマ状の燃焼エフェクト。動圧から発光の強さと大きさを求め、
// 対気速度方向の前方へ置く発光ビルボード2枚(コア+アウター)を所有する。
import * as THREE from 'three/webgpu';
import { addScaled, lenSq, norm } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { Billboard } from '../../billboard';
import {
  REENTRY_CORE_BRIGHTNESS, REENTRY_CORE_COLOR, REENTRY_CORE_OFFSET, REENTRY_CORE_SIZE_RATIO,
  REENTRY_OUTER_BRIGHTNESS, REENTRY_OUTER_COLOR, REENTRY_OUTER_OFFSET, REENTRY_OUTER_SIZE_RATIO,
  REENTRY_SIZE_MIN, REENTRY_SIZE_SPAN,
} from '../../vfx-style';
import { FloatingOrigin } from '../../camera/floating-origin';

const REENTRY_GLOW_MIN_Q = 200; // 燃焼エフェクトが出始める動圧 [Pa]
const REENTRY_GLOW_FULL_Q = 2e4; // 燃焼エフェクトが最大強度になる動圧 [Pa]

export class ReentryEffects {
  private readonly core = new Billboard(REENTRY_CORE_COLOR);
  private readonly outer = new Billboard(REENTRY_OUTER_COLOR);

  // core/outer ビルボードを scene に登録する。
  public constructor(scene: THREE.Scene) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  // 燃焼の表示を qdyn(動圧 [Pa])に応じた強度で速度方向前方に同期する。state は機体を置く
  // 表示時刻の運動状態で、引けないフレームは null。visible=false・強度 0・無速度では隠す。
  public sync(
    fo: FloatingOrigin, state: KinematicState | null, qdyn: number,
    visible: boolean, cameraQuat: THREE.Quaternion,
  ): void {
    const t = (qdyn - REENTRY_GLOW_MIN_Q) / (REENTRY_GLOW_FULL_Q - REENTRY_GLOW_MIN_Q);
    const intensity = Math.max(0, Math.min(1, t));
    // 衝撃波は対気速度方向に立つので、向きは ECI の絶対速度で決める。
    if (state === null || !visible || intensity <= 0 || lenSq(state.v) <= 1e-6) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    const dir = norm(state.v);
    const sc = REENTRY_SIZE_MIN + REENTRY_SIZE_SPAN * intensity;
    this.core.sync(fo.RtoThreeV3(addScaled(state.r, dir, REENTRY_CORE_OFFSET)),
      sc * REENTRY_CORE_SIZE_RATIO, REENTRY_CORE_BRIGHTNESS * intensity, cameraQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(state.r, dir, REENTRY_OUTER_OFFSET)),
      sc * REENTRY_OUTER_SIZE_RATIO, REENTRY_OUTER_BRIGHTNESS * intensity, cameraQuat);
  }

  // core/outer ビルボードを scene から取り除き解放する。
  public dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh);
    this.core.dispose();
    this.outer.dispose();
  }
}
