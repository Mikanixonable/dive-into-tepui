// 開いているプロパティウィンドウ（選択対象・搭載部品）と空域メニューを管理する台帳。
// 内容を毎フレーム更新し、選択対象の有効メニュー項目を絞り込んで選択された操作を処理する。
import type { Hud } from '../hud/hud';
import { ContextMenu, type MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import { PropertyWindow } from '../../hud/windows/property-window';
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type {
  PropertyWindowContent, PropertyWindowItem, PropertyWindowRelatedItem,
} from '../../hud/windows/property-window-content';
import { UNCLIPPED_WINDOW_GROUP } from '../../hud/overlay-manager';
import { CelestialEntity } from '../celestial/celestial-entity/celestial-entity';
import { focusTargetId } from '../viewer/focus-target';
import type { FocusCameraCommands } from '../viewer/camera-commands';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { NavTargetSource } from '../viewer/nav-target-selection';
import type { NavTargetCommands } from '../viewer/nav-target-commands';
import type { EntityDisplaySource } from '../viewer/entity-display-selection';
import type { EntityDisplayCommands } from '../viewer/entity-display-commands';
import type { MapCameraSource } from '../viewer/camera-selection';
import type { ViewSelectionSource } from '../viewer/view-selection';
import type { PlanEditor } from '../plan/plan-editor';
import type { ControlSelection } from '../control-selection';
import type { Stage } from '../stages/stage';
import { isModularShip } from '../ship/modular-ship';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import type { Targeter } from '../targeter';
import { EmptySpacePickable } from './empty-space-pickable';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { ViewFrame } from '../view/view-frame';
import type { InspectedObject, ObjectAuthoring } from './inspected-object';
import type { ObjectMenuCommands } from './object-menu-commands';
import type { PropertyWindowOpener } from './property-window-opener';
import { objectPickableOf } from './object-pickable';
import type { DisplayWindowManager } from '../display-window-manager';
import type { ModuleWindowOpener } from './module-windows';

// 開いているプロパティウィンドウ本体と、その対象。
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

  // activeView はいまのビュー — 候補列と計画の編集口はビューによって変わるので、
  // 構築時ではなく毎回そこから引く。
  public constructor(
    private readonly hud: Hud,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly navTarget: NavTargetSource,
    private readonly navTargetPresenter: NavTargetPresenter,
    private readonly navTargetCommands: NavTargetCommands,
    private readonly entityDisplay: EntityDisplaySource,
    private readonly entityDisplayCommands: Pick<EntityDisplayCommands, 'toggleTrajectoryLine'>,
    private readonly camera: MapCameraSource,
    private readonly view: Pick<ViewSelectionSource, 'current'>,
    private readonly activeView: () => ViewFrame,
    private readonly pauseMenu: PauseMenu,
    private readonly controlSelection: ControlSelection,
    private readonly mapFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly combatFocusCommands: Pick<FocusCameraCommands, 'setFocus'>,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
    private readonly displayWindowManager: Pick<DisplayWindowManager, 'current'>,
    private readonly moduleWindows: ModuleWindowOpener,
    private readonly commands: ObjectMenuCommands,
  ) {
    this.menu = new ContextMenu<InspectedObject, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => this.runAct(target, act);
  }

  // id で名指しされた敵のプロパティウィンドウを開く。既に消えていれば開かない。
  public openEnemy(id: string, clientX: number, clientY: number): void {
    const enemy = this.roster.all().filter(isEnemy).find((e) => e.id === id);
    const inspected = enemy ? objectPickableOf(enemy) : null;
    if (inspected) this.open(clientX, clientY, inspected);
  }

  // いま固定しているターゲットのプロパティウィンドウを開く。固定していなければ開かない。
  public openTarget(clientX: number, clientY: number): void {
    const target = this.targeter.aliveTarget;
    const inspected = target ? objectPickableOf(target) : null;
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
    const content = this.buildContent(target, this.displayWindowManager.current.simTime);
    const w = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, content,
      this.hud.overlayManager, UNCLIPPED_WINDOW_GROUP,
    );
    const entry: WindowEntry = { win: w, target };
    this.windows.set(key, entry);
    w.onSelect = (act, keepOpen) => {
      this.runAct(entry.target, act);
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
    const items = this.offeredItems(target, this.displayWindowManager.current.simTime);
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
      const { title, subtitle, items: menuItems } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRelatedItems(
        this.relatedItemsFor(entry.target, simTime), this.relatedTitleFor(entry.target));
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

  // 対象から窓1枚ぶんの初期内容を組む。
  private buildContent(target: InspectedObject, simTime: number): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    return {
      title, subtitle, icon: target.glyphSvg ?? target.glyph, rows: [], items,
      relatedItems: this.relatedItemsFor(target, simTime),
      relatedTitle: this.relatedTitleFor(target),
      onRename: target.rename === null ? undefined : (name) => this.commands.rename(target, name),
    };
  }

  // 対象が差し出す項目を、窓のタイトル・サブタイトル(header 項目)と操作項目へ振り分ける。
  // どちらも可変な状態に依存するので、毎フレーム引き直す。
  private windowParts(
    target: InspectedObject, simTime: number,
  ): { title: string; subtitle?: string; items: PropertyWindowItem<MenuAction>[] } {
    const all = this.offeredItems(target, simTime);
    const header = all.find((it) => it.type === 'header');
    // 戦闘ビューで開いたウィンドウは項目ショートカットを持たせない — [F]/[T] は自機の
    // 進行方向リセット/ターゲット選択が既に使っており、同じキーを両方へは配れない。
    const showShortcuts = this.view.current === 'map';
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({
        label: it.label, act: it.act as MenuAction,
        shortcut: showShortcuts ? it.shortcut : undefined,
        selected: it.selected, keepOpen: it.keepOpen,
      }));
    return { title: header?.label ?? target.name, subtitle: header?.subLabel, items };
  }

  // 対象が組んだ項目のうち、いま実際に選べるものだけを残す。
  private offeredItems(target: InspectedObject, simTime: number): readonly MenuItem<MenuAction>[] {
    const all = target.menuItems(
      this.celestialBodies, this.controlSelection.current, this.navTarget.id,
      this.entityDisplay.showsTrajectoryLine(target.id));
    // 対象によらない可否(航法ターゲット・物体の配置・計画の実行ができるか)で間引く。
    return all.filter((it) => {
      switch (it.act) {
        case 'target':
          return this.navTargetPresenter.canTarget(
            target.id, this.roster, this.celestialBodies, simTime);
        case 'duplicate':
        case 'openObjectPlacer':
          return this.authoring !== null;
        case 'planExecCycle':
          return this.activeStage.executesPlans;
        default:
          return true;
      }
    });
  }

  // 選択された操作を処理する。視点や画面表示で完結する操作はその場で実行し、対象固有の操作は
  // 当該フレームの編集インターフェイスとともにコマンドキューへ積む。
  private runAct(target: InspectedObject, act: MenuAction): void {
    if (act === 'focus') this.focus(target.id, target.name);
    else if (act === 'target') this.navTargetCommands.toggle(target.id, target.name);
    else if (act === 'toggleTrajectoryLine') this.entityDisplayCommands.toggleTrajectoryLine(target.id);
    else if (act === 'openSettings') this.pauseMenu.toggle(true);
    else if (act === 'openObjectPlacer') {
      this.authoring?.openObjectPlacer(focusTargetId(this.camera.map.focus));
    } else {
      this.commands.runMenu(target, act, this.authoring, this.planEditor);
    }
  }

  // 物体の配置・複製を差し出せるならその口。配置パネルはマップの操作面なので、戦闘ビューでは
  // 持っているステージでも差し出さない。
  private get authoring(): ObjectAuthoring | null {
    return this.view.current === 'map' ? this.activeStage.authoring : null;
  }

  // 計画を編集できるならその口。マップの操作面なので、戦闘ビューでは null。
  private get planEditor(): PlanEditor | null {
    return this.activeView().planEditor;
  }

  // 窓の先頭に出す関連一覧。操作中の艦自身なら搭載部品、天体ならいまその天体を周回している物体、
  // それ以外は空。
  private relatedItemsFor(target: InspectedObject, pivot: number): readonly PropertyWindowRelatedItem[] {
    const controlled = this.controlSelection.current;
    // 操作対象のモジュール船だけは、プロパティ窓から個別モジュールを開ける。
    if (controlled !== null && isModularShip(controlled) && target.id === controlled.id) {
      return controlled.assembly.modules.map((module) => {
        const label = controlled.assembly.definition(module.id)?.name ?? module.definitionId;
        return {
          id: `module:${controlled.id}:${module.id}`,
          label,
          onFocus: () => this.moduleWindows.openAtDefault(controlled, module.id),
          onContextMenu: (clientX: number, clientY: number) => {
            this.moduleWindows.open(controlled, module.id, clientX, clientY);
          },
        };
      });
    }
    // 天体なら、いまのビューの候補のうちその天体を周回しているものを名前順に並べる。
    if (!(target instanceof CelestialEntity)) return [];
    const related: { item: InspectedObject; label: string }[] = [];
    for (const item of this.activeView().pickables) {
      if (item.id === target.id) continue;
      // 天体・ラグランジュ点の親は静的に決まる。人工物は現在状態から引く。
      const state = item.orbitState;
      const isOrbiting = state === null
        ? this.celestialBodies.bodyParentId(item.id) === target.id
        : orbitingAttractorOf(state, this.celestialBodies.celestialMotions, pivot)?.id === target.id;
      if (isOrbiting) related.push({ item, label: item.name });
    }
    related.sort((a, b) => a.label.localeCompare(b.label));
    return related.map(({ item, label }) => ({
      id: item.id,
      label,
      onFocus: () => {
        this.mapFocusCommands.setFocus({ kind: 'object', id: item.id });
        this.hud.hint(`${label} にフォーカス`);
      },
      onContextMenu: (clientX, clientY) => {
        const current = this.activeView().pickables.find((candidate) => candidate.id === item.id);
        if (current) this.open(clientX, clientY, current);
      },
    }));
  }

  // 関連一覧の見出し。操作中の艦自身を見ているときだけ搭載部品で、それ以外は周回物体。
  private relatedTitleFor(target: InspectedObject): string {
    const controlled = this.controlSelection.current;
    return controlled !== null && isModularShip(controlled) && target.id === controlled.id
      ? '搭載モジュール' : '周回物体';
  }

  // 表示中のビューのカメラの注視を id の対象へ移し、name で知らせる。
  private focus(id: string, name: string): void {
    if (this.view.current === 'map') {
      this.mapFocusCommands.setFocus({ kind: 'object', id });
    } else {
      this.combatFocusCommands.setFocus({ kind: 'object', id });
    }
    this.hud.hint(`${name} にフォーカス`);
  }

  // target のプロパティウィンドウを開く。
  public openProperties(target: InspectedObject, clientX: number, clientY: number): void {
    this.open(clientX, clientY, target);
  }
}
