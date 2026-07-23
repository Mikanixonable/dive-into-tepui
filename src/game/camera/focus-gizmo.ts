// マップラベル(Earth/Moon/Sun/ラグランジュ点)を右クリックしたときの、フォーカス先
// 選択コンテキストメニュー。mapCamera のフォーカス候補に対する UI であり、ノード編集
// (node-gizmo)とは無関係な別責務。フォーカス対象(targetKey)の保持と、フォーカス用
// メニュー項目の定義だけを担う。
import { ContextMenu } from '../map-mode/context-menu';

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
