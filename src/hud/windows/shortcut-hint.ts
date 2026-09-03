// ショートカットキー(KeyboardEvent.code)を、メニュー項目に添える短い表記へ変換する。
export function shortcutKeyLabel(shortcut: string): string {
  if (shortcut === 'Escape') return 'ESC';
  if (shortcut === 'Delete') return 'DEL';
  if (shortcut.startsWith('Key')) return shortcut.slice(3);
  return shortcut.toUpperCase();
}
