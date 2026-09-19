// 残り時間 [s]。
export type SerializedScoreAttackTimer = number;

// スコアアタックの残り時間を管理する。
export class ScoreAttackTimer {
  // 残り時間 timeLeft [s] から始める。
  public constructor(private _timeLeft: number) {}

  // 残り時間 [s]。
  public get timeLeft(): number { return this._timeLeft; }

  // 直列化した残り時間から復元する。
  public static deserialize(serialized: SerializedScoreAttackTimer): ScoreAttackTimer {
    return new ScoreAttackTimer(serialized);
  }

  // 残り時間を dt [s] だけ減らす。0 で止まる。
  public update(dt: number): void {
    this._timeLeft = Math.max(0, this._timeLeft - dt);
  }

  // 残り時間を直列化した形へ畳む。
  public serialize(): SerializedScoreAttackTimer {
    return this._timeLeft;
  }
}
