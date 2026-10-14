// 時間方向の蓄積に使うフレーム番号の進み方と履歴の上限を求める。

// 前回から同じ番号を描き直すか、次の番号へ進むか、履歴を切るか。
export type FrameStep = 'repeat' | 'advance' | 'cut';

// 変化量 change が履歴の計算で使える値かを検査する。
function assertChange(change: number): void {
  if (Number.isNaN(change) || change < 0) {
    throw new RangeError(`screen-space: invalid change ${change}`);
  }
}

// 前回番号 previous と今回の番号 frame から、履歴を再利用できる進み方を返す。
export function frameStepOf(previous: number | null, frame: number, change: number): FrameStep {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`screen-space: invalid frame ${frame}`);
  }
  if (previous !== null && (!Number.isInteger(previous) || previous < 0)) {
    throw new RangeError(`screen-space: invalid previous frame ${previous}`);
  }
  if (previous !== null && frame === previous) return 'repeat';

  assertChange(change);
  if (previous === null || frame !== previous + 1 || change === Infinity) return 'cut';
  return 'advance';
}

// 時定数 timeConstant [フレーム] と変化量 change から、実数の履歴上限を返す。
export function historyCapOf(timeConstant: number, change: number): number {
  if (!Number.isInteger(timeConstant) || timeConstant < 1) {
    throw new RangeError(`screen-space: invalid time constant ${timeConstant}`);
  }
  assertChange(change);
  return Math.max(1, timeConstant / (1 + change));
}
