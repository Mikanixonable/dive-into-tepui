// フォーカス候補ラベル(Earth/Moon/Sun/ラグランジュ点)を右クリックしたときの
// フォーカス先選択コンテキストメニュー。
import { ContextMenu } from '../hud/context-menu';

export class FocusGizmo {
  private readonly menu = new ContextMenu();
  private targetKey: string | null = null;

  onMenuFocus: ((targetKey: string) => void) | null = null;

  // メニューの選択結果を保持中の targetKey へのフォーカス移動に結びつける。
  constructor() {
    this.menu.onSelect = (act) => {
      const tk = this.targetKey;
      this.targetKey = null;
      if (act === 'focus' && tk !== null) this.onMenuFocus?.(tk);
    };
  }

  // targetKey をフォーカス候補として保持し、指定座標にメニューを開く。
  openMenu(clientX: number, clientY: number, targetKey: string): void {
    this.targetKey = targetKey;
    this.menu.open(clientX, clientY, [
      { label: 'フォーカスを移動', act: 'focus' },
      { label: 'キャンセル', act: 'cancel' },
    ]);
  }

  // メニューを閉じ、保持中のフォーカス候補を破棄する。
  closeMenu(): void {
    this.menu.close();
    this.targetKey = null;
  }
}
