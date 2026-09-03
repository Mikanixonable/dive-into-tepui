// 開いているプロパティウィンドウ(被選択物・パーツ・軌道線)と空域メニューの台帳。中身を毎フレーム
// 最新化し、被選択物が組んだメニュー項目の実行先として、ゲーム側の操作一式を ObjectCommands の
// 形で差し出す。どのクリックがどの対象に当たったかは、ビュー側が決めて open() へ渡す。
import { Hud } from '../hud/hud';
import type { View } from '../view/view';
import type { Base } from '../dynamic/dynamic-entity/base';
import { ContextMenu, MenuAction } from '../hud/windows';
import {
  PropertyWindow, PropertyWindowContent, PropertyWindowItem,
  type PropertyWindowRelatedItem, type PauseMenu,
} from '../../hud/windows/index';
import { TEMP_WINDOW_GROUP } from '../../hud/overlay-manager';
import { CelestialEntity } from '../celestial/celestial-entity/celestial-entity';
import { ObjectPickable } from './object-pickable';
import type { LinePickable } from './line-pickable';
import type { LinePickables } from './line-pickables';
import { focusTargetId } from '../camera/focus-target';
import { DynamicSystem } from '../dynamic/dynamic-system';
import type { CelestialSystem } from '../celestial/celestial-system';
import { NavTarget } from '../nav-target';
import { CameraSystem } from '../camera/camera-system';
import { PlanEditor } from '../plan/plan-editor';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { Docking } from '../docking/docking';
import type { ActivePlayerController } from '../active-controllable-controller';
import type { FrameControls } from '../hud/frame/frame-controls';
import type { Stage } from '../stages/stage';
import type { Player } from '../player/player';
import type { Targeter } from '../targeter';
import { EmptySpacePickable } from './empty-space-pickable';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { ObjectPickables } from './object-pickables';
import { PartWindows } from './part-windows';
import { OrbitLineWindows } from './orbit-line-windows';
import type { DockState, ObjectCommands } from './object-commands';
import type { KinematicState } from '../../physics/kinematic-state';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';

// 開いているプロパティウィンドウ本体と、その対象。対象は同じ同一性を保ち続けるので、
// 行・項目の再導出も消滅の判定もこの参照を経由する。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly target: ObjectPickable;
}

export class ObjectWindows implements ObjectCommands {
  // 宇宙空間そのものはプロパティを持たないので、右クリックの落ち先には ContextMenu を使う。
  private readonly menu: ContextMenu<ObjectPickable, MenuAction>;
  // 開いているプロパティウィンドウ。対象の id でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly partWindows: PartWindows;
  private readonly orbitLineWindows: OrbitLineWindows;
  private expandedBaseWindowKey: string | null = null;
  // どの被選択物にも当たらなかった右クリックの落ち先。位置を持たないので1つを使い回す。
  private readonly emptySpace: ObjectPickable = new EmptySpacePickable();
  // 直近のマップフォーカス — プロパティウィンドウのバッジ判定に使う。マップを離れている間は
  // 最後にマップ視点だった時点の値のまま据え置く。
  private lastFocusId: string | undefined = undefined;

  // ドッキングの実行先を登録する。登録するまでドッキング関連の項目は効かない。
  setDocking(docking: Docking): void {
    this.docking = docking;
    docking.basePanel.onClose = () => this.collapseBasePanel();
  }
  private docking: Docking | null = null;

  // 候補集合(pickables)と、メニュー項目の実行先を参照として受け取る。
  constructor(
    private readonly hud: Hud,
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly pauseMenu: PauseMenu,
    private readonly pickables: ObjectPickables,
    linePickables: LinePickables,
    private readonly activePlayers: ActivePlayerController,
    private readonly frameControls: FrameControls,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
  ) {
    this.menu = new ContextMenu<ObjectPickable, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => target.runMenu(act, this);
    this.partWindows = new PartWindows(hud, activePlayers);
    this.orbitLineWindows = new OrbitLineWindows(
      hud, linePickables, pickables, this,
      (clientX, clientY, target) => this.open(clientX, clientY, target, pickables.lastSimTime),
    );
    this.hud.enemiesPanel.onSelectRight = (id, clientX, clientY) => {
      const enemy = this.entities.enemies.find((e) => e.id === id);
      if (enemy) this.open(clientX, clientY, enemy, this.pickables.lastSimTime);
    };
    this.hud.targetPanel.onSelectRight = (clientX, clientY) => {
      const target = this.targeter.aliveTarget;
      if (target) this.open(clientX, clientY, target, this.pickables.lastSimTime);
    };
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。一時ウィンドウ(非クリップ)どうしの排他は PropertyWindow 自身が
  // OverlayManager の TEMP_WINDOW_GROUP を通じて保つ。
  open(clientX: number, clientY: number, target: ObjectPickable, simTime: number): void {
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
      entry.target.runMenu(act, this);
      if (act === 'delete' || (!w.clipped && !keepOpen)) this.closeWindow(key);
    };
    w.onClose = () => {
      if (this.expandedBaseWindowKey === key) {
        this.expandedBaseWindowKey = null;
        this.docking?.closePanel();
      }
      this.partWindows.closeFor(entry.target.id);
      this.forgetWindow(key);
    };
  }

  // 軌道線1本のプロパティウィンドウを開く。
  openLine(clientX: number, clientY: number, orbit: LinePickable): void {
    this.orbitLineWindows.open(clientX, clientY, orbit);
  }

  // 何にも当たらなかった右クリックの落ち先。マップ・戦闘のどちらもここへ落ちる。
  openEmptySpaceMenu(clientX: number, clientY: number, simTime: number): void {
    const target = this.emptySpace;
    this.menu.open(clientX, clientY, target, target.menuItems(this, this.celestialSystem, simTime));
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

  private collapseBasePanel(): void {
    if (this.expandedBaseWindowKey !== null) {
      this.windows.get(this.expandedBaseWindowKey)?.win.setExpandedPanel(null);
      this.expandedBaseWindowKey = null;
    }
    this.docking?.closePanel();
  }

  // 開いている全プロパティウィンドウの値を最新化する。対象そのものが消滅していれば
  // (撃破・回収・削除)閉じる — 未来ゴースト時刻で位置が求まらないだけのフレーム
  // (posAt が null)は候補列から外れるだけで消滅ではないので、生存判定は対象の gone で行う。
  sync(simTime: number, displayTime: number): void {
    if (this.cameraSystem.view === 'map') {
      this.lastFocusId = focusTargetId(this.cameraSystem.mapCamera.focus);
    }
    for (const [key, entry] of [...this.windows]) {
      if (entry.target.gone) { this.closeWindow(key); continue; }
      const { title, subtitle, items: menuItems } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRelatedItems(
        this.relatedItemsFor(entry.target, simTime), this.relatedTitleFor(entry.target));
      entry.win.syncRows(
        entry.target.propertyRows(this, this.celestialSystem, simTime, displayTime));
      entry.win.syncItems(menuItems);
      entry.win.syncBadge(entry.target.id === this.lastFocusId);
    }
    this.partWindows.sync();
    this.orbitLineWindows.sync();
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときと、ドッキングで対象が
  // 世界から消えるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
    this.partWindows.close();
    this.orbitLineWindows.close();
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、自身のメニューを取り除く。
  dispose(): void {
    this.close();
    this.menu.dispose();
  }

  // itemsFor の出力をプロパティウィンドウの形へ組み替える: header 項目はタイトル/サブタイトルへ
  // 抜き出す。開いた直後から sync 時と同じ経路(windowParts)で求める。
  private buildContent(target: ObjectPickable, simTime: number): PropertyWindowContent<MenuAction> {
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
    target: ObjectPickable, simTime: number,
  ): { title: string; subtitle?: string; items: PropertyWindowItem<MenuAction>[] } {
    const all = target.menuItems(this, this.celestialSystem, simTime);
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

  // 天体プロパティーの先頭に表示する、現在その天体を周回している物体。
  // 天体は静的な primaryOf、人工物は現在状態から orbitingAttractorOf で判定する。
  private relatedItemsFor(target: ObjectPickable, pivot: number): readonly PropertyWindowRelatedItem[] {
    const activeShip = this.activePlayers.current;
    if (activeShip !== null && target === activeShip) {
      return activeShip.parts.map((part) => ({
        id: part.id,
        label: part.name,
        onFocus: () => this.focus(activeShip.id, `${part.name} を搭載する ${activeShip.name}`),
        onContextMenu: (clientX, clientY) => this.partWindows.open(activeShip, part, clientX, clientY),
      }));
    }
    if (!(target instanceof CelestialEntity)) return [];
    const related: { item: ObjectPickable; label: string }[] = [];
    for (const item of this.pickables.pickables) {
      if (item.id === target.id) continue;
      // 天体・ラグランジュ点の親は静的に決まる。人工物は現在状態から引く。
      const state = item.orbitState;
      const isOrbiting = state === null
        ? this.celestialSystem.bodyParentId(item.id) === target.id
        : orbitingAttractorOf(state, this.celestialSystem.celestialMotions, pivot)?.id === target.id;
      if (isOrbiting) related.push({ item, label: item.name });
    }
    related.sort((a, b) => a.label.localeCompare(b.label));
    return related.map(({ item, label }) => ({
      id: item.id,
      label,
      onFocus: () => {
        this.frameControls.setFocus({ kind: 'object', id: item.id });
        this.hud.hint(`${label} にフォーカス`);
      },
      onContextMenu: (clientX, clientY) => {
        const current = this.pickables.pickables.find((candidate) => candidate.id === item.id);
        if (current) this.open(clientX, clientY, current, this.pickables.lastSimTime);
      },
    }));
  }

  private relatedTitleFor(target: ObjectPickable): string {
    return target === this.activePlayers.current ? '搭載部品' : '周回物体';
  }

  // ------------------------------------------------------------- ObjectCommands

  hint(text: string): void {
    this.hud.hint(text);
  }

  // フォーカスをその対象へ移す。マップは座標系パネル連動(計画中心の追随)込みの経路、
  // 戦闘はその場のカメラだけを動かす。
  focus(id: string, name: string): void {
    if (this.cameraSystem.view === 'map') {
      this.frameControls.setFocus({ kind: 'object', id });
    } else {
      this.cameraSystem.combatCamera.setFocusTarget({ kind: 'object', id });
    }
    this.hud.hint(`${name} にフォーカス`);
  }

  openProperties(target: ObjectPickable, clientX: number, clientY: number): void {
    this.open(clientX, clientY, target, this.pickables.lastSimTime);
  }

  selectBase(base: Base): void {
    this.docking?.selectBase(base);
  }

  // 展開済みの基地パネルを畳むか、その基地のプロパティウィンドウへ新しく開く。基地パネルは
  // 同時に1枚だけなので、別の基地のものが開いていれば先に畳む。
  toggleBasePanel(base: Base): void {
    if (this.expandedBaseWindowKey === base.id) {
      this.collapseBasePanel();
      return;
    }
    const entry = this.windows.get(base.id);
    if (!entry || !this.docking) return;
    this.collapseBasePanel();
    entry.win.setExpandedPanel(this.docking.openPanel(base));
    this.expandedBaseWindowKey = base.id;
    entry.win.bringToFront();
  }

  toggleNavTarget(id: string, name: string): void {
    this.navTarget.toggleTarget(id, name);
  }

  warpTo(t: number): void {
    if (!this.simSpeedManager.startAutoWarpTo(t, this.pickables.lastSimTime)) {
      this.hud.hint('この時刻は既に通過しています');
    }
  }

  addNodeAt(t: number): void {
    this.editor.addNodeAt(t);
  }

  setActivePlayer(ship: Player | null): void {
    if (ship === null) this.activePlayers.setOrNull(null);
    else this.activePlayers.set(ship);
  }

  removePlayer(ship: Player): void {
    this.activePlayers.remove(ship);
  }

  setControlledBase(base: Base | null): void {
    this.activePlayers.setBase(base);
  }

  removeBase(base: Base): void {
    if (this.activePlayers.controlledBase === base) this.activePlayers.setBase(null);
    this.docking?.clearActiveBaseIf(base);
    base.alive = false;
  }

  dock(target: DynamicEntity): void {
    const ship = this.activePlayers.current;
    if (ship) this.docking?.dockTo(ship, target);
  }

  undock(): void {
    const ship = this.activePlayers.current;
    if (ship) this.docking?.undock(ship);
  }

  transferResources(target: Player): void {
    const ship = this.activePlayers.current;
    if (ship) this.docking?.openTransfer(ship, target);
  }

  duplicate(kind: DynamicEntityKind, state: KinematicState): void {
    this.activeStage.authoring?.openObjectPlacerForDuplicate(kind, state);
  }

  openObjectPlacer(): void {
    this.activeStage.authoring?.openObjectPlacer(focusTargetId(this.cameraSystem.mapCamera.focus));
  }

  openSettings(): void {
    this.pauseMenu.toggle(true);
  }

  get activePlayer(): Player | null { return this.activePlayers.current; }
  get controlledBase(): Base | null { return this.activePlayers.controlledBase; }
  get canAuthor(): boolean { return this.activeStage.authoring !== null; }
  get executesPlans(): boolean { return this.activeStage.executesPlans; }
  get view(): View { return this.cameraSystem.view; }

  isNavTarget(id: string): boolean {
    return this.navTarget.id === id;
  }

  canNavTarget(id: string, simTime: number): boolean {
    return this.navTarget.canTarget(id, this.entities, this.celestialSystem, simTime);
  }

  dockState(target: DynamicEntity): DockState {
    const ship = this.activePlayers.current;
    if (ship === null || this.docking === null || ship === target) return 'none';
    if (this.docking.getDockedTarget(ship) === target) return 'docked';
    return this.docking.canDock(ship, target) ? 'dockable' : 'none';
  }

  isBasePanelExpanded(base: Base): boolean {
    return this.expandedBaseWindowKey === base.id;
  }
}
