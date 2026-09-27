// カメラの注視対象。対象を id で指す形と、座標系へ焼き込んだ固定点を表す形を持つ。
import {
  type FrameAnchorSource, type FramePoint, type FrameRotationSource, type ReferenceFrame, toFramePoint,
} from '../../physics/frame';
import type { SerializedVec3, Vec3 } from '../../math/vec3';
import type { ReferenceFrames } from '../celestial/reference-frames';

export type FocusTarget =
  | { readonly kind: 'object'; readonly id: string }
  | { readonly kind: 'point'; readonly frame: ReferenceFrame; readonly point: FramePoint };

// 'point' は焼き込み先の座標系(center/rotatingWith)と、その座標系相対の点をそのまま持つ。
export type SerializedFocusTarget =
  | { readonly kind: 'object'; readonly id: string }
  | {
    readonly kind: 'point';
    readonly center: string;
    readonly rotatingWith: FrameRotationSource | null;
    readonly point: SerializedVec3;
  };

// 天体・実体・役割を指す対象なら id を返す。固定点には対応する id が無い。
export function focusTargetId(target: FocusTarget): string | undefined {
  return target.kind === 'object' ? target.id : undefined;
}

// ECI 位置 pos を時刻 t の frame に焼き込んだ固定点フォーカスを組む。
export function focusPoint(
  frames: Pick<ReferenceFrames, 'transformAt'>,
  frame: ReferenceFrame,
  pos: Vec3,
  t: number,
  frameAnchors: FrameAnchorSource,
): FocusTarget {
  return { kind: 'point', frame, point: toFramePoint(frames.transformAt(frame, t, frameAnchors), pos) };
}

// ECI 位置 pos を恒星中心の慣性系へ固定したフォーカスを組む。恒星の無い星系では
// ECI 原点の慣性系へ固定する。
export function starInertialFocusPoint(
  frames: Pick<ReferenceFrames, 'inertialFrame' | 'frameOf' | 'transformAt'>,
  starId: string | null,
  pos: Vec3,
  t: number,
  frameAnchors: FrameAnchorSource,
): FocusTarget {
  const frame = starId !== null ? frames.frameOf(starId, null) : frames.inertialFrame;
  return focusPoint(frames, frame, pos, t, frameAnchors);
}
