// ショートカットキー(KeyboardEvent.code)を、メニュー項目に添える短い表記へ変換する。
// 主たるポインタが粗い環境では、項目そのものがタッチの操作部品でありキー名は案内に
// ならないので、添え字を出さない(空文字列を返す)。
export function shortcutKeyLabel(shortcut: string, coarse: boolean): string {
  if (coarse) return '';
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  if (shortcut.startsWith('Key')) return shortcut.slice(3);
  return shortcut.toUpperCase();
}
