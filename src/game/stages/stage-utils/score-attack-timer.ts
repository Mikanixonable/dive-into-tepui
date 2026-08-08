// スコアアタックの残り時間を管理する。
export class ScoreAttackTimer {
  timeLeft: number;
  // 残り時間を initialTime [s] で開始する。
  constructor(initialTime: number) {
    this.timeLeft = initialTime;
  }

  // 残り時間を減算し、尽きたフレームでちょうど一度だけ onTimeUp を呼ぶ。戻り値は時間切れかどうか。
  update(dt: number, onTimeUp: (phase: 'timeup') => void): boolean {
    if (this.timeLeft <= 0) return false;
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return false;
    this.timeLeft = 0;
    onTimeUp('timeup');
    return true;
  }

  serialize(): number {
    return this.timeLeft;
  }

  restore(timeLeft: number): void {
    this.timeLeft = timeLeft;
  }
}
