// ショートカットキー名をラベル添え用の表記へ変換する(`Escape`→`ESC`、`Delete`→`DEL`、
// それ以外は大文字化)。
export function shortcutKeyLabel(shortcut: string): string {
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  return shortcut.toUpperCase();
}
