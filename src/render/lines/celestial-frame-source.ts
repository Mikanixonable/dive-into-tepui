// 折れ線を座標系相対へ焼き直し、外挿した先端を ECI へ戻すために、線の描画が天体側へ問い合わせる面。
import type { FrameAnchorSource, FrameTransform, ReferenceFrame } from '../../physics/frame';
import type { KinematicState } from '../../physics/kinematic-state';

// 座標系の時刻ごとの剛体運動を答える面。anchors は登録天体でない基準の解決役。
export interface FrameTransformSource {
  transformAt(frame: ReferenceFrame, t: number, anchors: FrameAnchorSource): FrameTransform;
}

// 座標系の剛体運動と、天体の ECI 状態を答える面。
export interface CelestialFrameSource {
  readonly frames: FrameTransformSource;
  // 天体 id の、pivot で厳密に引いた値から時刻 t へ外挿した ECI 位置・速度。
  stateAt(id: string, pivot: number, t?: number): KinematicState;
}
