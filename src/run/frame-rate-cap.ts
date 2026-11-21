// 描画品質設定のフレームレート上限で、rAF のコールバックを描くか見送るかを決める。
// 見送ったときは前に描いた時刻を進めず、次に描くフレームの経過時間に含める — そうすれば上限は
// シミュレーション時間の進みを変えない。

// 画面の更新間隔の揺れを吸収する余裕 [ms]。120 Hz の 1 フレーム(8.3 ms)の半分 — 30 fps の上限で
// 60 Hz の画面なら 2 回に 1 回が確実に描かれ、揺れで 1 回余計に見送って 20 fps へ落ちることがない。
const FRAME_INTERVAL_SLACK_MS = 4;

// 前に描いたフレームの時刻 lastDrawnMs から nowMs までが、上限 capFps の間隔に届いていなければ真。
// capFps が 0 なら上限なし(常に偽)。
export function skipsFrame(nowMs: number, lastDrawnMs: number, capFps: number): boolean {
  if (capFps <= 0) return false;
  return nowMs - lastDrawnMs < 1000 / capFps - FRAME_INTERVAL_SLACK_MS;
}
