// physics/ の id にゲームで使う日本語表示名を対応させる表。座標系(Frame)は選ばせる
// SegmentedControl がそのまま項目として渡し、天体(AttractorId)は他モジュールの
// 同種の表がここを参照する。
import { Frame } from '../../physics/frame';
import { AttractorId } from '../../physics/attractor';

export const FRAME_ITEMS: readonly (readonly [Frame, string])[] = [
  ['inertial', '慣性系'],
  ['sunRotating', '太陽回転系'],
  ['moonRotating', '月回転系'],
];

export const ATTRACTOR_NAMES: Record<AttractorId, string> = {
  earth: '地球',
  moon: '月',
  sun: '太陽',
};
