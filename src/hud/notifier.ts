// 画面へ一時的な通知（トーストやヒント）を発行するインターフェース。本文だけの短い通知と、見出しを持つ HTML の通知を、
// それぞれ表示時間つきで受け付ける。
export interface Notifier {
  // 本文だけの告知を durationMs 表示する。
  hint(text: string, durationMs?: number): void;
  // 見出しと本文を持つ HTML の告知を durationMs 表示する。
  toast(html: string, durationMs?: number): void;
}
