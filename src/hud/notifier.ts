// 画面へ一時的な通知(出来事)を発行するインターフェース。本文だけの短い通知と、HTML の通知を、
// それぞれ表示時間つきで受け付ける。通知は時間で消える出来事で、条件が戻るまで続く状態(警報)は含まない。

// 通知の意味上の種別。バッジの語と記号を導く。どれも色を持たない。
// - info: 状態変化の確認(既定。SYS バッジ)
// - denied: 操作の拒否・失敗の理由(不可バッジ + ⊘)
// - nav: フォーカス・ターゲット・ワープなど航法まわりの案内(NAV バッジ)
// - plan: マニューバノード・計画軌道まわりの案内(PLN バッジ)
// - cleared: 警告から戻った警報の解除(解除バッジ + ✓)
export type HintKind = 'info' | 'denied' | 'nav' | 'plan' | 'cleared';

export interface Notifier {
  // 本文だけの通知を durationMs 表示する。kind は通知の意味上の種別(既定 'info')。
  hint(text: string, durationMs?: number, kind?: HintKind): void;
  // HTML の通知を durationMs 表示する。
  toast(html: string, durationMs?: number): void;
}
