// 表示期間の語彙。軌道線・予測パネル・時間軸が「どれだけ先まで/どれだけ過去まで描くか」を
// 同じ選択肢で扱うための鍵と上限。
export const DISPLAY_DURATION_MAX = 365 * 86400; // 手動レンジで指定できる表示期間の上限 [s](1年)

// 周期を持たない軌道(双曲線・放物線)で、1周期の代わりに区間の長さとして使う値 [s]。
export const APERIODIC_ARC_DURATION = 86400;

// 表示期間の選択。'orbit' は起点の軌道周期、'custom' は手動レンジ。
export type DisplayDurationKey = 'orbit' | 'day' | 'tenDay' | 'month' | 'threeMonth' | 'custom';

// 過去方向の表示期間の選択。'none'(既定)は過去を描かない。
export type DisplayPastDurationKey = 'none' | DisplayDurationKey;
