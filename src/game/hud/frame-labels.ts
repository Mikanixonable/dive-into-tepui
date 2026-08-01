// 座標系(Frame)の表示名。座標系を選ばせる SegmentedControl がそのまま項目として渡す。
import { Frame } from '../../physics/frame';

export const FRAME_ITEMS: readonly (readonly [Frame, string])[] = [
  ['inertial', '慣性系'],
  ['sunRotating', '太陽回転系'],
  ['moonRotating', '月回転系'],
];
