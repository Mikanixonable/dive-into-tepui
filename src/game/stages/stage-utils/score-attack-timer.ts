// スコアアタックの残り時間を管理する。
export class ScoreAttackTimer {
  timeLeft: number;
  // 残り時間を initialTime [s] で開始する。
  constructor(initialTime: number) {
    this.timeLeft = initialTime;
  }

  // 残り時間を減算し、尽きたフレームでちょうど一度だけ true を返す。
  update(dt: number): boolean {
    if (this.timeLeft <= 0) return false;
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return false;
    this.timeLeft = 0;
    return true;
  }

  serialize(): number {
    return this.timeLeft;
  }
}
