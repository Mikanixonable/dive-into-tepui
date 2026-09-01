// 軌道線(公転軌道・船の軌道・軌道ガイド)のプロパティウィンドウ。1本につき高々1枚を保ち、
// 「所属」欄からその軌道の持ち主のウィンドウを開けるようにする。排他グループを持たせず、
// 被選択物のウィンドウと共存させる。
import { PropertyWindow, type PropertyWindowContent, type PropertyWindowRelatedItem } from '../hud/windows/property-window';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { Hud } from '../hud/hud';
import type { LinePickable } from './line-pickable';
import type { LinePickables } from './line-pickables';
import type { MapCommands } from './map-commands';
import type { MapPickable } from './map-pickable';
import type { MapPickables } from './map-pickables';

const KIND_LABEL: Record<LinePickable['kind'], string> = {
  'orbit-body': '公転軌道', 'orbit-ship': '船の軌道', 'orbit-guide': '軌道ガイド',
};
const CALC_METHOD_LABEL: Record<LinePickable['method'], string> = {
  analytic: '解析軌道', predicted: '予測軌道', guide: '軌道ガイド',
};

export class OrbitLineWindows {
  private readonly windows = new Map<string, PropertyWindow<MenuAction>>();

  // openOwnerWindow は「所属」欄から持ち主のプロパティウィンドウを開く手続き。
  constructor(
    private readonly hud: Hud,
    private readonly linePickables: LinePickables,
    private readonly pickables: MapPickables,
    private readonly commands: MapCommands,
    private readonly openOwnerWindow: (clientX: number, clientY: number, target: MapPickable) => void,
  ) {}

  // 軌道線のウィンドウを開く。既に開いていればクリック位置へ動かして最前面に出すだけにする。
  open(clientX: number, clientY: number, orbit: LinePickable): void {
    const existing = this.windows.get(orbit.key);
    if (existing) {
      existing.moveTo(clientX, clientY);
      existing.bringToFront();
      return;
    }
    const win = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.content(orbit), this.hud.overlayManager,
    );
    this.windows.set(orbit.key, win);
    win.onClose = () => { this.windows.delete(orbit.key); };
  }

  // 開いている各ウィンドウの所属欄を最新化する。線そのものが消えていれば閉じる。
  sync(): void {
    for (const [key, win] of [...this.windows]) {
      const orbit = this.linePickables.pickables.find((candidate) => candidate.key === key);
      if (orbit === undefined) { win.close(); continue; }
      win.syncRelatedItems(this.relatedItems(orbit), '所属');
    }
  }

  // 開いているウィンドウをすべて畳む。
  close(): void {
    for (const win of [...this.windows.values()]) win.close();
  }

  // ウィンドウ1枚ぶんの見出し・行・所属欄。
  private content(orbit: LinePickable): PropertyWindowContent<MenuAction> {
    return {
      title: KIND_LABEL[orbit.kind],
      rows: [{ key: 'method', label: '計算方法', value: CALC_METHOD_LABEL[orbit.method] }],
      items: [],
      relatedItems: this.relatedItems(orbit),
      relatedTitle: '所属',
    };
  }

  // 軌道の所属先(周回天体・船自身・ラグランジュ点/主星/副星)を候補列から引き直す。
  // 候補列に現れていない所属は、その回だけ項目に出ない。
  private relatedItems(orbit: LinePickable): readonly PropertyWindowRelatedItem[] {
    const items: PropertyWindowRelatedItem[] = [];
    for (const ownerId of orbit.ownerKeys) {
      const target = this.pickables.pickables.find((candidate) => candidate.id === ownerId);
      if (target === undefined) continue;
      items.push({
        id: ownerId,
        label: target.name,
        onFocus: () => this.commands.focus(target.id, target.name),
        onContextMenu: (clientX, clientY) => {
          const current = this.pickables.pickables.find((candidate) => candidate.id === ownerId);
          if (current) this.openOwnerWindow(clientX, clientY, current);
        },
      });
    }
    return items;
  }
}
