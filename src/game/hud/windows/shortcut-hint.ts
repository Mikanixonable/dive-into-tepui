// ショートカットキー(KeyboardEvent.code)をラベル添え用の表記へ変換する
// (`Escape`→`ESC`、`Delete`→`DEL`、`KeyX`→`X`、それ以外は大文字化)。
export function shortcutKeyLabel(shortcut: string): string {
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  if (shortcut.startsWith('Key')) return shortcut.slice(3);
  return shortcut.toUpperCase();
}
