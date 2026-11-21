// 軌道線(公転軌道・船の軌道・軌道ガイド)のプロパティウィンドウ。1本につき高々1枚を保ち、
// 「所属」欄からその軌道の持ち主のウィンドウを開けるようにする。被選択物のウィンドウと共存する。
import { PropertyWindow } from '../../hud-kit/windows/property-window';
import { WindowLedger } from '../../hud-kit/windows/window-ledger';
import type { InspectedObject } from './inspected-object';
import type { PropertyWindowContent, PropertyWindowRelatedItem } from '../../hud-kit/windows/property-window-content';
import type { MenuAction } from '../menu-actions';
import type { HudLayers } from '../hud/hud-layers';
import type { LinePickable } from './line-pickable';
import type { LinePickables } from './line-pickable-set';
import type { ObjectPickables } from './object-pickable-set';

const KIND_LABEL: Record<LinePickable['kind'], string> = {
  'orbit-body': '公転軌道', 'orbit-ship': '船の軌道', 'orbit-guide': '軌道ガイド',
  'orbit-slot': '軌道標識',
};
const CALC_METHOD_LABEL: Record<LinePickable['method'], string> = {
  analytic: '解析軌道', numeric: '予測軌道', guide: '軌道ガイド',
};

export class OrbitLineWindows {
  private readonly windows = new WindowLedger<MenuAction, { readonly win: PropertyWindow<MenuAction> }>();

  // focusOwner / openOwnerWindow は「所属」欄から持ち主へ注視を移す・そのプロパティ
  // ウィンドウを開く手続き。
  public constructor(
    private readonly hud: HudLayers,
    private readonly linePickables: LinePickables,
    private readonly pickables: ObjectPickables,
    private readonly focusOwner: (id: string, name: string) => void,
    private readonly openOwnerWindow: (clientX: number, clientY: number, target: InspectedObject) => void,
  ) {}

  // 軌道線のウィンドウを開く。既に開いていれば、それをクリック位置へ動かして最前面に出す。
  public open(clientX: number, clientY: number, orbit: LinePickable): void {
    this.windows.open(orbit.key, clientX, clientY, () => ({
      win: new PropertyWindow<MenuAction>(
        clientX, clientY, this.content(orbit), this.hud.overlayManager,
      ),
    }));
  }

  // 開いている各ウィンドウの所属欄を最新化する。線そのものが消えていれば閉じる。
  public sync(): void {
    for (const [key, entry] of [...this.windows.entryList()]) {
      const orbit = this.linePickables.pickables.find((candidate) => candidate.key === key);
      if (orbit === undefined) { entry.win.close(); continue; }
      entry.win.syncRelatedItems(this.relatedItems(orbit), '所属');
    }
  }

  // 開いているウィンドウをすべて畳む。
  public close(): void {
    this.windows.closeAll();
  }

  // ウィンドウ1枚ぶんの見出し・行・所属欄。
  private content(orbit: LinePickable): PropertyWindowContent<MenuAction> {
    return {
      title: KIND_LABEL[orbit.kind],
      kindCode: 'ORB',
      kindLabel: 'TRAJECTORY',
      monitorWhenClipped: true,
      rows: [{
        key: 'method', label: '計算方法', value: CALC_METHOD_LABEL[orbit.method], presentation: 'hero',
      }],
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
        onFocus: () => this.focusOwner(target.id, target.name),
        // 右クリックした時点の対象を引き直して開く。
        onContextMenu: (clientX, clientY) => {
          const current = this.pickables.pickables.find((candidate) => candidate.id === ownerId);
          if (current) this.openOwnerWindow(clientX, clientY, current);
        },
      });
    }
    return items;
  }
}
