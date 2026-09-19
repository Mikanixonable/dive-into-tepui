// 操作対象を1フレーム動かす操作量と、単発で効く命令の語彙。機体の軸と装備の名前で書く。

// 機体座標系の並進6方向。
export const THRUST_DIRECTIONS = ['forward', 'backward', 'left', 'right', 'up', 'down'] as const;
export type ThrustDirection = (typeof THRUST_DIRECTIONS)[number];

// 噴射が打ち消し合う対向の方向。
export const OPPOSITE_THRUST_DIRECTION: Readonly<Record<ThrustDirection, ThrustDirection>> = {
  forward: 'backward',
  backward: 'forward',
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};

// 機体の姿勢を変える回転6方向。
export const ROTATION_DIRECTIONS = [
  'pitchUp', 'pitchDown', 'yawLeft', 'yawRight', 'rollLeft', 'rollRight',
] as const;
export type RotationDirection = (typeof ROTATION_DIRECTIONS)[number];

// 1度の受け付けで1度だけ効く操作のうち、対象の軸を伴わないもの。
export const PILOT_COMMAND_KINDS = [
  'rcsDampToggle', 'progradeReset', 'fineAttitudeToggle', 'progradeHoldToggle',
  'throttleLow', 'throttleMid', 'throttleHigh', 'throttleMax',
  'radiatorDeployLeft', 'radiatorDeployRight', 'solarDeployLeft', 'solarDeployRight',
  'reload',
] as const;
export type PilotCommandKind = (typeof PILOT_COMMAND_KINDS)[number];

// 単発で効く操作。噴射ラッチの反転だけが、反転する軸を伴う。
export type PilotCommand =
  | { readonly kind: PilotCommandKind }
  | { readonly kind: 'thrustLatchToggle'; readonly direction: ThrustDirection };

// そのフレームに操作対象が受け取る操作量。
export interface PilotControls {
  // 押されている並進方向。
  readonly thrust: ReadonlySet<ThrustDirection>;
  // 押されている回転方向。
  readonly rotation: ReadonlySet<RotationDirection>;
  // 引き金を引いているか。
  readonly firing: boolean;
  // このフレームに受け付けた単発の命令を、受け付けた順に並べたもの。
  readonly commands: readonly PilotCommand[];
}

// 対になる2方向が同時に押されているか。噴射の緊急停止の合図として使う。
export function thrustKillSwitchActive(thrust: ReadonlySet<ThrustDirection>): boolean {
  return THRUST_DIRECTIONS.some(
    (direction) => thrust.has(direction) && thrust.has(OPPOSITE_THRUST_DIRECTION[direction]),
  );
}
