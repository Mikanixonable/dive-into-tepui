// 表示物の更新頻度を実時刻で間引く締切。dt を持たない sync 位相から、毎フレームの呼び出しの
// うち一定間隔に1回だけ更新を通すために使う。

export class SyncThrottle {
  private nextAt = 0;

  // intervalMs 間隔で更新を通す締切を作る。
  public constructor(private readonly intervalMs: number) {}

  // nowMs [ms] が締切に達していれば true を返し、次の締切まで進める。達していなければ false。
  public due(nowMs: number): boolean {
    if (nowMs < this.nextAt) return false;
    this.nextAt = nowMs + this.intervalMs;
    return true;
  }
}
