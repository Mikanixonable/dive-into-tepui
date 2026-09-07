// 画面へ一時的な告知を出す口。何をいつ告げるかは告げる側が決め、どこへどう出すかは
// 実装が持つ。告げたいだけのモジュールが HUD の常設パネル一式を引かずに済む。
export interface Notifier {
  // 本文だけの告知を durationMs 表示する。
  hint(text: string, durationMs?: number): void;
  // 見出しと本文を持つ HTML の告知を durationMs 表示する。
  toast(html: string, durationMs?: number): void;
}
