// MapCamera の注視対象と、その解決。対象を id で指す 'object' と、座標系に焼き込んだ固定点を
// 表す 'point' の判別共用体を持ち、毎フレームそれを ECI 位置へ解決する。
import { FrameAnchorSource, FramePoint, ReferenceFrame, toFramePoint, toInertialPoint } from '../../physics/frame';
import { Vec3, v3 } from '../../math/vec3';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { KinematicState } from '../../physics/kinematic-state';
import type { ReferenceFrames } from '../celestial/reference-frames';

export type FocusTarget =
  | { readonly kind: 'object'; readonly id: string }
  | { readonly kind: 'point'; readonly frame: ReferenceFrame; readonly point: FramePoint };

// 天体 id に対応する対象なら id を返す。'point' には対応する天体 id が無い。
export function focusTargetId(target: FocusTarget): string | undefined {
  return target.kind === 'object' ? target.id : undefined;
}

// ECI 位置 pos(時刻 t)を frame に焼き込んだ固定点フォーカスを組む。
export function focusPoint(
  frames: ReferenceFrames, frame: ReferenceFrame, pos: Vec3, t: number, frameAnchors: FrameAnchorSource,
): FocusTarget {
  const tf = frames.transformAt(frame, t, frameAnchors);
  return { kind: 'point', frame, point: toFramePoint(tf, pos) };
}

// 注視点の候補。MapPickable はこの形を構造的に満たすので、呼び出し側はそのまま渡せる。
// **MapPickable 型そのものを受け取ってはいけない** — map-pickable.ts は camera-system.ts を
// 型 import しており、それが three/webgpu を引き込む。tsconfig.test.json の include へ
// map-pickable.ts が入ると型検査が DOM 定義を要求して壊れる。
export interface FocusCandidate {
  readonly id: string;
  // 表示時刻の ECI 位置。求まらないフレームは null。
  mapPosAt(displayTime: number): Vec3 | null;
}

export interface FocusResolveState {
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
}

export interface FocusResolveResult {
  readonly pos: Vec3;
  readonly missingFocusFrames: number;
  readonly lastResolvedFocus: Vec3;
  // true なら焦点そのものを origin へ差し戻す(2フレーム連続の解決失敗)。
  readonly fallToOrigin: boolean;
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
  frames: ReferenceFrames,
  celestialMotionOf: (id: string) => CelestialMotion | null,
  celestialStateOf: (id: string, t: number) => KinematicState,
  state: FocusResolveState,
): FocusResolveResult {
  if (focus.kind === 'point') {
    const tf = frames.transformAt(focus.frame, displayTime, frameAnchors);
    const pos = toInertialPoint(tf, focus.point);
    return { pos, missingFocusFrames: state.missingFocusFrames, lastResolvedFocus: pos, fallToOrigin: false };
  }
  if (focus.id === frames.inertialFrame.center) {
    const pos = v3();
    return { pos, missingFocusFrames: 0, lastResolvedFocus: pos, fallToOrigin: false };
  }
  const motion = celestialMotionOf(focus.id);
  if (motion !== null) {
    const pos = celestialStateOf(focus.id, displayTime).r;
    return { pos, missingFocusFrames: 0, lastResolvedFocus: pos, fallToOrigin: false };
  }
  const anchored = frameAnchors.stateOf(focus.id, displayTime);
  if (anchored !== null) {
    return { pos: anchored.r, missingFocusFrames: 0, lastResolvedFocus: anchored.r, fallToOrigin: false };
  }
  const candidatePos = candidates.find((c) => c.id === focus.id)?.mapPosAt(displayTime) ?? null;
  if (candidatePos !== null) {
    return { pos: candidatePos, missingFocusFrames: 0, lastResolvedFocus: candidatePos, fallToOrigin: false };
  }
  const missingFocusFrames = state.missingFocusFrames + 1;
  if (missingFocusFrames >= 2) {
    return { pos: v3(), missingFocusFrames, lastResolvedFocus: state.lastResolvedFocus, fallToOrigin: true };
  }
  return { pos: state.lastResolvedFocus, missingFocusFrames, lastResolvedFocus: state.lastResolvedFocus, fallToOrigin: false };
}
