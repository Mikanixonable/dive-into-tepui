// MapCamera の注視対象。天体候補列から毎フレーム引く 'object' と、座標系に焼き込んだ
// 固定点を表す 'point' の判別共用体。
import { FramePoint, ReferenceFrame, toFramePoint } from '../../physics/frame';
import { Vec3 } from '../../physics/vec3';
import type { Ephemeris } from '../../physics/ephemeris';

export type FocusTarget =
  | { readonly kind: 'object'; readonly id: string }
  | { readonly kind: 'point'; readonly frame: ReferenceFrame; readonly point: FramePoint };

// 天体 id に対応する対象なら id を返す。'point' には対応する天体 id が無い。
export function focusTargetId(target: FocusTarget): string | undefined {
  return target.kind === 'object' ? target.id : undefined;
}

// ECI 位置 pos(時刻 t)を frame に焼き込んだ固定点フォーカスを組む。
export function focusPoint(ephemeris: Ephemeris, frame: ReferenceFrame, pos: Vec3, t: number): FocusTarget {
  const tf = ephemeris.frameTransformAt(frame, t, ephemeris.celestialBodiesAt(t));
  return { kind: 'point', frame, point: toFramePoint(tf, pos) };
}
