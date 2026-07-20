// stage0(訓練ステージ)のスコアアタック残り時間を管理する。Stage0 専用のヘルパーであり、
// Stage0 インスタンスが自身のフィールドとして直接保持する。
export class ScoreAttackTimer {
  timeLeft: number;
  constructor(initialTime: number) {
    this.timeLeft = initialTime;
  }

  // 残り時間を減算し、尽きたフレームでちょうど一度だけ onTimeUp を呼ぶ。
  // 戻り値はこのフレームで尽きたかどうか(呼び出し元が付随処理を行うかの判定に使う)。
  update(dt: number, onTimeUp: (phase: 'timeup') => void): boolean {
    if (this.timeLeft <= 0) return false;
    this.timeLeft -= dt;
    if (this.timeLeft > 0) return false;
    this.timeLeft = 0;
    onTimeUp('timeup');
    return true;
  }
}
