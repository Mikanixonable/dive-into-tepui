export type SerializedScoreAttackTimer = number;

// スコアアタックの残り時間を管理する。
export class ScoreAttackTimer {
  // 残り時間 timeLeft [s] から始める。
  public constructor(public timeLeft: number) {}

  // 直列化した残り時間から復元する。
  public static deserialize(serialized: SerializedScoreAttackTimer): ScoreAttackTimer {
    return new ScoreAttackTimer(serialized);
  }

  // 残り時間を減算し、尽きたフレームでちょうど一度だけ true を返す。
  public update(dt: number): boolean {
    if (this.timeLeft <= 0) return false;
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return false;
    this.timeLeft = 0;
    return true;
  }

  // 残り時間を直列化した形へ畳む。
  public serialize(): SerializedScoreAttackTimer {
    return this.timeLeft;
  }
}
