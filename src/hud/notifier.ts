// 画面へ一時的な通知（トーストやヒント）を発行するインターフェース。本文だけの短い通知と、見出しを持つ HTML の通知を、
// それぞれ表示時間つきで受け付ける。

// 通知の意味上の種別。バッジの記号と警告色を導く。
// - info: 状態変化の確認(既定。SYS バッジ)
// - warn: 拒否・失敗・危険の告知(WARN バッジ + 警告色)
// - nav: フォーカス・ターゲット・ワープなど航法まわりの案内(NAV バッジ)
// - plan: マニューバノード・計画軌道まわりの案内(PLN バッジ)
export type HintKind = 'info' | 'warn' | 'nav' | 'plan';

export interface Notifier {
  // 本文だけの告知を durationMs 表示する。kind は通知の意味上の種別(既定 'info')。
  hint(text: string, durationMs?: number, kind?: HintKind): void;
  // 見出しと本文を持つ HTML の告知を durationMs 表示する。
  toast(html: string, durationMs?: number): void;
}
