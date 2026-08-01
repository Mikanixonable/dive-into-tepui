// マップ上の被選択物(MapPickable)を右クリックしたときのコンテキストメニュー。項目リストは
// 呼び出し側が対象の種別に応じて用意し、選択結果は対象付きで通知する。
import { ContextMenu } from './hud/context-menu';
import { MapPickable } from './map-pick';

export interface MapMenuItem { readonly label: string; readonly act: string; }

export class MapContextGizmo {
  private readonly menu = new ContextMenu();
  private target: MapPickable | null = null;

  onSelect: ((act: string, target: MapPickable) => void) | null = null;

  // メニューの選択結果を保持中の target と結びつけて通知する。
  constructor() {
    this.menu.onSelect = (act) => {
      const t = this.target;
      this.target = null;
      if (t !== null) this.onSelect?.(act, t);
    };
  }

  // target を保持し、items を項目として指定座標にメニューを開く。
  openMenu(clientX: number, clientY: number, target: MapPickable, items: readonly MapMenuItem[]): void {
    this.target = target;
    this.menu.open(clientX, clientY, items.map((it) => ({ label: it.label, act: it.act })));
  }

  // メニューを閉じ、保持中の対象を破棄する。
  closeMenu(): void {
    this.menu.close();
    this.target = null;
  }
}
