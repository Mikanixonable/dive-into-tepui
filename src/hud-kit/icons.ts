// ボタンのアイコンに使う SVG(20x20)の一式。色は currentColor、大きさは置いた枠に追従する。
// 文字記号で代用すると、端末が絵文字の字形へ置き換えて大きさ・色・位置が崩れる図案はここへ置く。

const OPEN = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

export const ICON = {
  // 設定(歯車)。
  gear: `${OPEN}<path d="M8.6 4L8.9 2.1H11.1L11.4 4L13.2 4.7L14.9 3.6L16.4 5.1L15.3 6.8L16 8.6L17.9 8.9V11.1L16 11.4L15.3 13.2L16.4 14.9L14.9 16.4L13.2 15.3L11.4 16L11.1 17.9H8.9L8.6 16L6.8 15.3L5.1 16.4L3.6 14.9L4.7 13.2L4 11.4L2.1 11.1V8.9L4 8.6L4.7 6.8L3.6 5.1L5.1 3.6L6.8 4.7Z"/><circle cx="10" cy="10" r="2.6"/></svg>`,
  // 先頭へ戻る。
  skipBack: `${OPEN}<path d="M5 4.5V15.5"/><path d="M15.5 4.5V15.5L8 10Z" fill="currentColor"/></svg>`,
  // 留める(ピン)。
  pin: `${OPEN}<path d="M12 3.5L16.5 8L14.6 8.7L11.8 11.5L12.2 14.2L10.9 15.5L7.5 12.1L3.8 15.8"/><path d="M7.5 12.1L4.5 9.1L5.8 7.8L8.5 8.2L11.3 5.4Z" fill="currentColor" fill-opacity="0.25"/></svg>`,
  // 削除(ごみ箱)。
  trash: `${OPEN}<path d="M3.5 5.5H16.5"/><path d="M8 5.5V3.5H12V5.5"/><path d="M5 5.5L5.8 16.5H14.2L15 5.5"/><path d="M8.5 8.5V13.5M11.5 8.5V13.5"/></svg>`,
  // 施錠(解放されていないもの)。
  lock: `${OPEN}<rect x="4.5" y="9" width="11" height="8" rx="1.6"/><path d="M7 9V6.8A3 3 0 0 1 13 6.8V9"/></svg>`,
} as const;
