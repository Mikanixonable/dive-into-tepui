// 開いているプロパティウィンドウ（選択対象・搭載部品）と空域メニューを管理する台帳。
// メニューの可否や関連対象の導出は ObjectWindowActions に委ね、ここは窓の寿命と同期を所有する。
import type { Hud } from '../hud/hud';
import { ContextMenu } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import { PropertyWindow } from '../../hud/windows/property-window';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { ControlSelection } from '../control-selection';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { DisplayWindowManager } from '../display-window-manager';
import { focusTargetId } from '../viewer/focus-target';
import { UNCLIPPED_WINDOW_GROUP } from '../../hud/overlay-manager';
import { EmptySpacePickable } from './empty-space-pickable';
import type { InspectedObject } from './inspected-object';
import type { PropertyWindowOpener } from './property-window-opener';
import type { ObjectWindowActions } from './object-window-actions';

interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly target: InspectedObject;
}

export class ObjectWindows implements PropertyWindowOpener {
  // 宇宙空間そのものはプロパティを持たないので、右クリックの落ち先には ContextMenu を使う。
  private readonly menu: ContextMenu<InspectedObject, MenuAction>;
  // 開いているプロパティウィンドウ。対象の id で、オブジェクト1つにつき高々1枚に保つ。
  private readonly windows = new Map<string, WindowEntry>();
  // どの被選択物にも当たらなかった右クリックの落ち先。位置を持たないので1つを使い回す。
  private readonly emptySpace: InspectedObject = new EmptySpacePickable();

  public constructor(
    private readonly hud: Hud,
    private readonly celestialBodies: CelestialBodies,
    private readonly camera: MapCameraSource,
    private readonly controlSelection: ControlSelection,
    private readonly displayWindowManager: Pick<DisplayWindowManager, 'current'>,
    private readonly actions: ObjectWindowActions,
  ) {
    this.menu = new ContextMenu<InspectedObject, MenuAction>(hud.overlayManager);
    this.menu.onSelect = (act, target) => this.actions.runAct(target, act);
  }

  // 指定された ID の敵のプロパティウィンドウを開く。既に消えていれば開かない。
  public openEnemy(id: string, clientX: number, clientY: number): void {
    const inspected = this.actions.inspectedEnemy(id);
    if (inspected) this.open(clientX, clientY, inspected);
  }

  // いま固定しているターゲットのプロパティウィンドウを開く。固定していなければ開かない。
  public openTarget(clientX: number, clientY: number): void {
    const inspected = this.actions.inspectedTarget();
    if (inspected) this.open(clientX, clientY, inspected);
  }

  // target のプロパティウィンドウを (clientX, clientY) に開く。対象1つにつき高々1枚で、既に
  // 開いていればその窓をクリック位置へ動かして最前面に出す。
  public open(clientX: number, clientY: number, target: InspectedObject): void {
    const key = target.id;
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const content = this.actions.buildContent(
      target, this.displayWindowManager.current.simTime, this,
    );
    const w = new PropertyWindow<MenuAction>(
      clientX, clientY, content,
      this.hud.overlayManager, UNCLIPPED_WINDOW_GROUP,
    );
    const entry: WindowEntry = { win: w, target };
    this.windows.set(key, entry);
    w.onSelect = (act, keepOpen) => {
      this.actions.runAct(entry.target, act);
      // 「削除」は対象自体が消えるので、クリップ済みの窓でも閉じる。
      if (act === 'delete' || (!w.clipped && !keepOpen)) this.closeWindow(key);
    };
    w.onClose = () => {
      this.forgetWindow(key);
    };
  }

  // 何にも当たらなかった右クリックの位置 (clientX, clientY) に空域メニューを開く。
  public openEmptySpaceMenu(clientX: number, clientY: number): void {
    const target = this.emptySpace;
    const items = this.actions.offeredItems(target, this.displayWindowManager.current.simTime);
    this.menu.open(clientX, clientY, target, items);
  }

  // 閉じ終わったウィンドウを台帳から外す。
  private forgetWindow(key: string): void {
    this.windows.delete(key);
  }

  // key のウィンドウを閉じる。開いていなければ何もしない。
  private closeWindow(key: string): void {
    const entry = this.windows.get(key);
    if (!entry) return;
    entry.win.close();
  }

  // 開いている全プロパティウィンドウの値を最新化し、対象が消滅(gone)していれば閉じる。位置が
  // 求まらないだけのフレーム(posAt が null)は消滅ではない。
  public sync(): void {
    const { simTime, displayTime } = this.displayWindowManager.current;
    // バッジはマップのカメラが注視している対象の窓に付ける。
    const mapFocusId = focusTargetId(this.camera.map.focus);
    for (const [key, entry] of [...this.windows]) {
      if (entry.target.gone) { this.closeWindow(key); continue; }
      const { title, subtitle, items: menuItems } = this.actions.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRelatedItems(
        this.actions.relatedItemsFor(entry.target, simTime, this),
        this.actions.relatedTitleFor(entry.target),
      );
      entry.win.syncRows(entry.target.propertyRows(
        this.celestialBodies, this.controlSelection.current, simTime, displayTime));
      entry.win.syncItems(menuItems);
      entry.win.syncBadge(entry.target.id === mapFocusId);
    }
  }

  // 開いたままのメニュー・ウィンドウを畳む。
  public close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、自身のメニューを取り除く。
  public dispose(): void {
    this.close();
    this.menu.dispose();
  }

  // target のプロパティウィンドウを開く。
  public openProperties(target: InspectedObject, clientX: number, clientY: number): void {
    this.open(clientX, clientY, target);
  }
}
