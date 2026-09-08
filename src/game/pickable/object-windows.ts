// 開いているプロパティウィンドウ(被選択物・搭載部品)と空域メニューの台帳。中身を毎フレーム
// 最新化し、被選択物が組んだメニュー項目のうちいま選べるものを絞って、選ばれた操作を実行する。
// どのクリックがどの対象に当たったかは、ビュー側が決めて open() へ渡す。
import { Hud } from '../hud/hud';
import { ContextMenu, type MenuItem } from '../hud/windows/context-menu';
import type { MenuAction } from '../hud/windows/menu-actions';
import { PropertyWindow } from '../../hud/windows/property-window';
import type { PauseMenu } from '../../hud/windows/pause-menu';
import type {
  PropertyWindowContent, PropertyWindowItem, PropertyWindowRelatedItem,
} from '../../hud/windows/property-window-content';
import { TEMP_WINDOW_GROUP } from '../../hud/overlay-manager';
import { CelestialEntity } from '../celestial/celestial-entity/celestial-entity';
import { focusTargetId, type FocusTarget } from '../camera/focus-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { NavTarget } from '../nav-target';
import { CameraSystem } from '../camera/camera-system';
import type { PlanEditor } from '../plan/plan-editor';
import type { ControlSelection } from '../control-selection';
import type { ObjectAuthoring, Stage } from '../stages/stage';
import { Player } from '../player/player';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import type { Targeter } from '../targeter';
import { EmptySpacePickable } from './empty-space-pickable';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { ViewFrame } from '../view/view-frame';
import { PartWindows } from './part-windows';
import type { InspectedObject } from './inspected-object';

// 開いているプロパティウィンドウ本体と、その対象。対象は同じ同一性を保ち続けるので、
// 行・項目の再導出も消滅の判定もこの参照を経由する。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly target: InspectedObject;
}

export class ObjectWindows {
  // 宇宙空間そのものはプロパティを持たないので、右クリックの落ち先には ContextMenu を使う。
  private readonly menu: ContextMenu<InspectedObject, MenuAction>;
  // 開いているプロパティウィンドウ。対象の id でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly partWindows: PartWindows;
  // どの被選択物にも当たらなかった右クリックの落ち先。位置を持たないので1つを使い回す。
  private readonly emptySpace: InspectedObject = new EmptySpacePickable();
  // 直近のマップフォーカス — プロパティウィンドウのバッジ判定に使う。マップを離れている間は
  // 最後にマップ視点だった時点の値のまま据え置く。
  private lastFocusId: string | undefined = undefined;
  // 直近の sync が受け取った simTime。クリック位置を持たない経路(一覧・パネル)から
  // ウィンドウを開くときの時刻に使う。
  private simTime = 0;

  // activeView はいまのビュー — 候補列と計画の編集口はビューによって変わるので、
  // 構築時ではなく毎回そこから引く。
  constructor(
    private readonly hud: Hud,
    private readonly roster: EntityRoster,
    private readonly celestialBodies: CelestialBodies,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly activeView: () => ViewFrame,
    private readonly pauseMenu: PauseMenu,
    private readonly controlSelection: ControlSelection,
    private readonly setFocus: (target: FocusTarget) => void,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
  ) {
    this.menu = new ContextMenu<InspectedObject, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => this.runAct(target, act);
    this.partWindows = new PartWindows(hud, controlSelection);
    this.hud.enemiesPanel.onSelectRight = (id, clientX, clientY) => {
      const enemy = this.roster.all().filter(isEnemy).find((e) => e.id === id);
      if (enemy) this.open(clientX, clientY, enemy, this.simTime);
    };
    this.hud.targetPanel.onSelectRight = (clientX, clientY) => {
      const target = this.targeter.aliveTarget;
      if (target) this.open(clientX, clientY, target, this.simTime);
    };
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。一時ウィンドウ(非クリップ)どうしの排他は PropertyWindow 自身が
  // OverlayManager の TEMP_WINDOW_GROUP を通じて保つ。
  open(clientX: number, clientY: number, target: InspectedObject, simTime: number): void {
    const key = target.id;
    const existing = this.windows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const w = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.buildContent(target, simTime),
      this.hud.overlayManager, TEMP_WINDOW_GROUP,
    );
    const entry: WindowEntry = { win: w, target };
    this.windows.set(key, entry);
    // 実行時は entry.target(sync のたびに最新化される)を読む — 開いた瞬間の対象を
    // 捕まえたままだと、時刻に依存する操作(ワープ・ノード追加)が古い時刻へ向けて走ってしまう。
    // 操作項目のクリックは、クリップ済みか keepOpen(排他選択肢の切り替え)なら開いたままにする。
    // 「削除」は対象自体が消えるのでどちらでも閉じる。
    w.onSelect = (act, keepOpen) => {
      this.runAct(entry.target, act);
      if (act === 'delete' || (!w.clipped && !keepOpen)) this.closeWindow(key);
    };
    w.onClose = () => {
      this.partWindows.closeFor(entry.target.id);
      this.forgetWindow(key);
    };
  }

  // 何にも当たらなかった右クリックの落ち先。マップ・戦闘のどちらもここへ落ちる。
  openEmptySpaceMenu(clientX: number, clientY: number, simTime: number): void {
    const target = this.emptySpace;
    this.menu.open(clientX, clientY, target, this.offeredItems(target, simTime));
  }

  // 台帳から外すだけで DOM 破棄はしない — ✕ ボタン自身が dispose 済みのときに呼ぶ経路。
  private forgetWindow(key: string): void {
    this.windows.delete(key);
  }

  // ✕ ボタン以外の経路(対象消滅・ビュー離脱)で閉じる。close() 自体が onClose を発火するので、
  // forgetWindow はそちらから呼ばれる。
  private closeWindow(key: string): void {
    const entry = this.windows.get(key);
    if (!entry) return;
    entry.win.close();
  }

  // 開いている全プロパティウィンドウの値を最新化する。対象そのものが消滅していれば
  // (撃破・回収・削除)閉じる — 未来ゴースト時刻で位置が求まらないだけのフレーム
  // (posAt が null)は候補列から外れるだけで消滅ではないので、生存判定は対象の gone で行う。
  sync(simTime: number, displayTime: number): void {
    this.simTime = simTime;
    if (this.cameraSystem.view === 'map') {
      this.lastFocusId = focusTargetId(this.cameraSystem.mapCamera.focus);
    }
    for (const [key, entry] of [...this.windows]) {
      if (entry.target.gone) { this.closeWindow(key); continue; }
      const { title, subtitle, items: menuItems } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRelatedItems(
        this.relatedItemsFor(entry.target, simTime), this.relatedTitleFor(entry.target));
      entry.win.syncRows(entry.target.propertyRows(
        this.celestialBodies, this.controlSelection.current, simTime, displayTime));
      entry.win.syncItems(menuItems);
      entry.win.syncBadge(entry.target.id === this.lastFocusId);
    }
    this.partWindows.sync();
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
    this.partWindows.close();
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、自身のメニューを取り除く。
  dispose(): void {
    this.close();
    this.menu.dispose();
  }

  // itemsFor の出力をプロパティウィンドウの形へ組み替える: header 項目はタイトル/サブタイトルへ
  // 抜き出す。開いた直後から sync 時と同じ経路(windowParts)で求める。
  private buildContent(target: InspectedObject, simTime: number): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    return {
      title, subtitle, icon: target.glyphSvg ?? target.glyph, rows: [], items,
      relatedItems: this.relatedItemsFor(target, simTime),
      relatedTitle: this.relatedTitleFor(target),
      onRename: target.rename ?? undefined,
    };
  }

  // タイトル・サブタイトルは到達まで T+… や所持金など、操作項目は操作対象か・追従状態・
  // 航法ターゲットかなど、どちらも可変な状態に依存するため itemsFor を毎フレーム呼び直す
  // 必要があるが、呼び出しは1回にまとめる(header 項目からタイトル/サブタイトルを抜き出し、
  // 残りを操作項目とする)。
  private windowParts(
    target: InspectedObject, simTime: number,
  ): { title: string; subtitle?: string; items: PropertyWindowItem<MenuAction>[] } {
    const all = this.offeredItems(target, simTime);
    const header = all.find((it) => it.type === 'header');
    // 戦闘ビューで開いたウィンドウは項目ショートカットを持たせない — [F]/[T] は自機の
    // 進行方向リセット/ターゲット選択が既に使っており、同じキーを両方へは配れない。
    const showShortcuts = this.cameraSystem.view === 'map';
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({
        label: it.label, act: it.act as MenuAction,
        shortcut: showShortcuts ? it.shortcut : undefined,
        selected: it.selected, keepOpen: it.keepOpen,
      }));
    return { title: header?.label ?? target.name, subtitle: header?.subLabel, items };
  }

  // 対象が組んだ項目のうち、いま実際に選べるものだけを残す。対象によらない可否
  // (航法ターゲットにできるか・物体を配置できるか・計画を実行できるステージか)は
  // 対象ではなくこのランの状態で決まるので、対象には判定させずここで絞る。
  private offeredItems(target: InspectedObject, simTime: number): readonly MenuItem<MenuAction>[] {
    const all = target.menuItems(
      this.celestialBodies, this.controlSelection.current, this.navTarget.id);
    return all.filter((it) => {
      switch (it.act) {
        case 'target':
          return this.navTarget.canTarget(
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

  // 選ばれた操作を実行する。対象によらない操作はここで済ませ、残りを対象へ渡す。
  private runAct(target: InspectedObject, act: MenuAction): void {
    if (act === 'focus') this.focus(target.id, target.name);
    else if (act === 'target') this.navTarget.toggleTarget(target.id, target.name);
    else if (act === 'openSettings') this.pauseMenu.toggle(true);
    else if (act === 'openObjectPlacer') {
      this.authoring?.openObjectPlacer(focusTargetId(this.cameraSystem.mapCamera.focus));
    } else {
      target.runMenu?.(act, this.controlSelection, this.authoring, this.planEditor);
    }
  }

  // 物体の配置・複製を差し出せるならその口。配置パネルはマップの操作面なので、戦闘ビューでは
  // 持っているステージでも差し出さない。
  private get authoring(): ObjectAuthoring | null {
    return this.cameraSystem.view === 'map' ? this.activeStage.authoring : null;
  }

  // 計画を編集できるならその口。ノードの追加も時間の加速もマップの操作面なので、
  // 戦闘ビューでは差し出さない。
  private get planEditor(): PlanEditor | null {
    return this.activeView().planEditor;
  }

  // 天体プロパティーの先頭に表示する、現在その天体を周回している物体。
  // 天体は静的な primaryOf、人工物は現在状態から orbitingAttractorOf で判定する。
  private relatedItemsFor(target: InspectedObject, pivot: number): readonly PropertyWindowRelatedItem[] {
    const controlled = this.controlSelection.current;
    // 搭載部品を持つのは艦だけなので、操作中の基地では周回物体の一覧へ落ちる。
    if (controlled instanceof Player && target === controlled) {
      return controlled.parts.map((part) => ({
        id: part.id,
        label: part.name,
        onFocus: () => this.focus(controlled.id, `${part.name} を搭載する ${controlled.name}`),
        onContextMenu: (clientX, clientY) => this.partWindows.open(controlled, part, clientX, clientY),
      }));
    }
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
        this.setFocus({ kind: 'object', id: item.id });
        this.hud.hint(`${label} にフォーカス`);
      },
      onContextMenu: (clientX, clientY) => {
        const current = this.activeView().pickables.find((candidate) => candidate.id === item.id);
        if (current) this.open(clientX, clientY, current, this.simTime);
      },
    }));
  }

  private relatedTitleFor(target: InspectedObject): string {
    const controlled = this.controlSelection.current;
    return controlled instanceof Player && target === controlled ? '搭載部品' : '周回物体';
  }

  // フォーカスをその対象へ移す。マップは座標系パネル連動(計画中心の追随)込みの経路、
  // 戦闘はその場のカメラだけを動かす。
  private focus(id: string, name: string): void {
    if (this.cameraSystem.view === 'map') {
      this.setFocus({ kind: 'object', id });
    } else {
      this.cameraSystem.combatCamera.setFocusTarget({ kind: 'object', id });
    }
    this.hud.hint(`${name} にフォーカス`);
  }

  // target のプロパティウィンドウを開く。被選択物が自分の左クリック時の振る舞いから呼ぶ。
  openProperties(target: InspectedObject, clientX: number, clientY: number): void {
    this.open(clientX, clientY, target, this.simTime);
  }
}
