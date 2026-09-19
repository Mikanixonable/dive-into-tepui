// 注視対象を、毎フレームそのフレームの ECI 位置と速度へ解決する。
import { add, cross, sub, type Vec3, v3 } from '../../math/vec3';
import {
  type FrameAnchorSource, toInertialPoint,
} from '../../physics/frame';
import type { CelestialBody } from '../../physics/celestial-body';
import type { KinematicState } from '../../physics/kinematic-state';
import type { ReferenceFrames } from '../celestial/reference-frames';
import type { FocusTarget } from '../viewer/focus-target';

// 注視点の候補。ObjectPickable はこの形を構造的に満たすので、呼び出し側はそのまま渡せる。
// ObjectPickable 型を直に受けると three/webgpu を引き込み、DOM 定義の無い型検査が壊れる。
export interface FocusCandidate {
  readonly id: string;
  // 表示時刻の ECI 位置。求まらないフレームは null。
  posAt(displayTime: number): Vec3 | null;
}

export interface FocusResolveState {
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
}

export interface FocusResolveResult {
  readonly pos: Vec3;
  // 注視点の ECI 速度。位置しか答えられない対象(候補配列の点マーカー)と、
  // 位置を直前の解へ保っているフレームでは null。
  readonly vel: Vec3 | null;
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
  // true なら注視対象を見失った(2フレーム連続の解決失敗)。
  readonly lost: boolean;
}

// 注視点を解決する。天体・原点・役割トークン・機体(自艦/敵/基地/弾薬)はその場で直接解決する。
// celestialMotionOf は天体 id の運動を引く関数で、登録されていない id には null を返すこと。
// candidates は、frameAnchors にも天体にも実体を持たない対象(軌道上の点マーカー・
// ラグランジュ点)の位置を引く一覧。
export function resolveFocusTarget(
  focus: FocusTarget,
  candidates: readonly FocusCandidate[],
  displayTime: number,
  frameAnchors: FrameAnchorSource,
  frames: Pick<ReferenceFrames, 'inertialFrame' | 'transformAt'>,
  celestialMotionOf: (id: string) => CelestialBody | null,
  celestialStateOf: (id: string, t: number) => KinematicState,
  state: FocusResolveState,
): FocusResolveResult {
  if (focus.kind === 'point') {
    const transform = frames.transformAt(focus.frame, displayTime, frameAnchors);
    const pos = toInertialPoint(transform, focus.point);
    // 座標系に固定された点なので、ECI 速度は原点の並進と系の回転だけで決まる。
    const vel = add(transform.originVel, cross(transform.omega, sub(pos, transform.origin)));
    return { pos, vel, missingFocusFrames: 0, lastResolvedFocus: pos, lost: false };
  }
  if (focus.id === frames.inertialFrame.center) {
    const pos = v3();
    return { pos, vel: v3(), missingFocusFrames: 0, lastResolvedFocus: pos, lost: false };
  }
  const motion = celestialMotionOf(focus.id);
  if (motion !== null) {
    const { r, v } = celestialStateOf(focus.id, displayTime);
    return { pos: r, vel: v, missingFocusFrames: 0, lastResolvedFocus: r, lost: false };
  }
  const anchored = frameAnchors.stateOf(focus.id, displayTime);
  if (anchored !== null) {
    return {
      pos: anchored.r,
      vel: anchored.v,
      missingFocusFrames: 0,
      lastResolvedFocus: anchored.r,
      lost: false,
    };
  }
  const candidatePos = candidates.find((candidate) => candidate.id === focus.id)?.posAt(displayTime) ?? null;
  if (candidatePos !== null) {
    return { pos: candidatePos, vel: null, missingFocusFrames: 0, lastResolvedFocus: candidatePos, lost: false };
  }
  const missingFocusFrames = state.missingFocusFrames + 1;
  return {
    pos: state.lastResolvedFocus,
    vel: null,
    missingFocusFrames,
    lastResolvedFocus: state.lastResolvedFocus,
    lost: missingFocusFrames >= 2,
  };
}
