// 表示物の更新頻度を実時刻で間引く締切。sync 位相は dt を受け取らないので、頻度を落としたい
// パネルはこの締切を持ち、毎フレームの呼び出しのうち一定間隔に1回だけ本体の更新へ進む。

export class SyncThrottle {
  private nextAt = 0;

  // intervalMs 間隔で更新を通す締切を作る。
  public constructor(private readonly intervalMs: number) {}

  // 締切に達していれば true を返し、次の締切まで進める。達していなければ false を返す。
  public due(): boolean {
    const now = performance.now();
    if (now < this.nextAt) return false;
    this.nextAt = now + this.intervalMs;
    return true;
  }
}
