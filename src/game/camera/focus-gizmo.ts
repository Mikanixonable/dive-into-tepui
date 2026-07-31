// フォーカス候補ラベル(Earth/Moon/Sun/ラグランジュ点)を右クリックしたときの
// フォーカス先選択コンテキストメニュー。
import { ContextMenu } from '../hud/context-menu';

export class FocusGizmo {
  private readonly menu = new ContextMenu();
  private targetKey: string | null = null;

  onMenuFocus: ((targetKey: string) => void) | null = null;

  constructor() {
    this.menu.onSelect = (act) => {
      const tk = this.targetKey;
      this.targetKey = null;
      if (act === 'focus' && tk !== null) this.onMenuFocus?.(tk);
    };
  }

  openMenu(clientX: number, clientY: number, targetKey: string): void {
    this.targetKey = targetKey;
    this.menu.open(clientX, clientY, [
      { label: 'フォーカスを移動', act: 'focus' },
      { label: 'キャンセル', act: 'cancel' },
    ]);
  }

  closeMenu(): void {
    this.menu.close();
    this.targetKey = null;
  }
}
