// 被弾の瞬間に戦闘ビューの視点を短く揺らす演出(SPEC CAMERA.md「6. 被弾の揺れ」)。
// kick で揺れを立て、offset が実時間で減衰した回転オフセットを返す。揺れるのは表示の
// 視点だけで、照準・ガンサイト・機首の向きには掛からない。
import { norm, cross, add, sub, scale, len } from '../../math/vec3';
import { qFromAxisAngle, qMul, qRotate } from '../../math/quat';
import type { Viewpoint } from '../../math/projection';

const SHAKE_SECONDS = 0.3;
// 最大角 [rad]。ガンサイトズーム中は画角の比でさらに小さくする。
const SHAKE_MAX_RAD = (1.4 * Math.PI) / 180;

// 揺れの回転成分 [rad]。
export interface ShakeOffset {
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
}

export class HitShake {
  private age = SHAKE_SECONDS;
  private dirYaw = 0;
  private dirPitch = 0;
  private rollSign = 1;
  public rand: () => number = Math.random;

  // 揺れを立て直す。向きは毎回無作為に振る。
  public kick(): void {
    const angle = this.rand() * 2 * Math.PI;
    this.dirYaw = Math.cos(angle);
    this.dirPitch = Math.sin(angle) * 0.6;
    this.rollSign = this.rand() < 0.5 ? -1 : 1;
    this.age = 0;
  }

  // 実時間の経過 dt [s] で減衰させ、いまの回転オフセット [rad] を返す。収束後は null。
  public offset(dt: number): ShakeOffset | null {
    this.age = Math.min(SHAKE_SECONDS, this.age + Math.max(0, dt));
    if (this.age >= SHAKE_SECONDS) return null;
    const t = this.age / SHAKE_SECONDS;
    // 最初が最も大きく、終わりへ向けて2次で収まる。
    const amp = SHAKE_MAX_RAD * (1 - t) * (1 - t);
    return { yaw: this.dirYaw * amp, pitch: this.dirPitch * amp, roll: this.rollSign * amp * 0.8 };
  }
}

// view の注視方向と上方向へ shake の回転を掛けた複製を返す。位置は動かさない。
// amp はズームなど外からの減衰率(1 でそのまま)。
export function shakenViewpoint(view: Viewpoint, shake: ShakeOffset, amp: number): Viewpoint {
  const fwd = norm(sub(view.lookTarget, view.position));
  const right = norm(cross(fwd, view.up));
  const up = cross(right, fwd);
  const q = qMul(
    qMul(qFromAxisAngle(right, shake.pitch * amp), qFromAxisAngle(up, -shake.yaw * amp)),
    qFromAxisAngle(fwd, shake.roll * amp),
  );
  const dist = len(sub(view.lookTarget, view.position));
  return {
    ...view,
    lookTarget: add(view.position, scale(qRotate(q, fwd), dist)),
    up: qRotate(q, up),
  };
}
