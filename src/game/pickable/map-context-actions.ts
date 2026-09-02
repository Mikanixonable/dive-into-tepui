// 被選択物(ObjectPickable)への右クリック/左クリック/ダブルクリックの解決と、プロパティ/パーツ/
// 軌道ウィンドウのライフサイクル管理。被選択物が組んだメニュー項目の実行先として、ゲーム側の
// 操作一式を ObjectCommands の形で差し出す。
import { Hud } from '../hud/hud';
import type { WorldView } from '../world-view';
import type { Base } from '../dynamic/dynamic-entity/base';
import {
  ContextMenu, PropertyWindow, PropertyWindowContent, PropertyWindowItem,
  type PropertyWindowRelatedItem,
  MenuAction, type PauseMenu,
} from '../hud/windows';
import { TEMP_WINDOW_GROUP } from '../hud/overlay-manager';
import { CelestialEntity } from '../celestial/celestial-entity/celestial-entity';
import { ObjectPickable, pickFrontmostBody, pickNearest, projectMarker } from './object-pickable';
import { pickNearestLine } from './line-pickable';
import type { LinePickables } from './line-pickables';
import { focusTargetId } from '../camera/focus-target';
import { PhysicalObjectListPanel } from '../hud/panels/physical-object-list-panel';
import type { Input } from '../input/input';
import { pickRadiusSq } from '../input/pointer-precision';
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
import type { MarkerManager } from '../marker/marker-manager';
import type { CelestialMarkers } from '../marker/celestial-markers';
import { EmptySpacePickable } from './empty-space-pickable';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { ObjectPickables } from './object-pickables';
import { pickCombatEntityAtPoint } from './combat-pick';
import { PartWindows } from './part-windows';
import { OrbitLineWindows } from './orbit-line-windows';
import type { DockState, ObjectCommands } from './object-commands';
import type { KinematicState } from '../../physics/kinematic-state';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { rayThroughScreen } from '../../math/projection';

const MAP_PICK_PX_SQ = 600; // マップ上の被選択物(ObjectPickable)の右クリック判定半径の2乗 [px^2]
const ORBIT_LINE_PICK_PX_SQ = 600; // 軌道線(公転軌道・船の軌道・軌道ガイド)の右クリック判定半径の2乗 [px^2]

// pointer:coarse(指先)環境で使う、同じ2つの判定半径の2乗 [px^2]。
const MAP_PICK_PX_SQ_COARSE = 1936;
const ORBIT_LINE_PICK_PX_SQ_COARSE = 1936;

// 開いているプロパティウィンドウ本体と、その対象。対象は同じ同一性を保ち続けるので、
// 行・項目の再導出も消滅の判定もこの参照を経由する。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly target: ObjectPickable;
}

export class MapContextActions implements ObjectCommands {
  // 宇宙空間そのものはプロパティを持たないので、右クリックの落ち先には ContextMenu を使う。
  private readonly menu: ContextMenu<ObjectPickable, MenuAction>;
  // 開いているプロパティウィンドウ。対象の id でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly partWindows: PartWindows;
  private readonly orbitLineWindows: OrbitLineWindows;
  private readonly physicalObjectListPanel: PhysicalObjectListPanel;
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
    private readonly linePickables: LinePickables,
    private readonly activePlayers: ActivePlayerController,
    private readonly frameControls: FrameControls,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
    private readonly markerManager: MarkerManager,
    private readonly celestialMarkers: CelestialMarkers,
  ) {
    this.menu = new ContextMenu<ObjectPickable, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => target.runMenu(act, this);
    this.partWindows = new PartWindows(hud, activePlayers);
    this.orbitLineWindows = new OrbitLineWindows(
      hud, linePickables, pickables, this,
      (clientX, clientY, target) => this.openPropertyWindow(clientX, clientY, target, pickables.lastSimTime),
    );
    this.physicalObjectListPanel = new PhysicalObjectListPanel(hud.mapRoot, celestialSystem);
    // 一覧の行は隠れている対象でも操作できる(SPEC/MAP.md §10) — pickable によるマップ上の
    // 衝突判定はマーカーのヒットテストにだけ適用され、一覧からの id 一致には適用しない。
    this.physicalObjectListPanel.onFocus = (id) => {
      this.focusTarget(id, this.pickables.pickables.find((i) => i.id === id));
    };
    this.physicalObjectListPanel.onNavTarget = (id) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target && this.navTarget.canTarget(id, this.entities, this.celestialSystem, this.pickables.lastSimTime)) {
        this.navTarget.toggleTarget(id, target.name);
      }
    };
    this.physicalObjectListPanel.onSelectRight = (id, clientX, clientY) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target) this.openPropertyWindow(clientX, clientY, target, this.pickables.lastSimTime);
    };
    this.hud.enemiesPanel.onSelectRight = (id, clientX, clientY) => {
      const enemy = this.entities.enemies.find((e) => e.id === id);
      if (enemy) this.openPropertyWindow(clientX, clientY, enemy, this.pickables.lastSimTime);
    };
    this.hud.targetPanel.onSelectRight = (clientX, clientY) => {
      const target = this.targeter.aliveTarget;
      if (target) this.openPropertyWindow(clientX, clientY, target, this.pickables.lastSimTime);
    };
  }

  // 画面上の (x, y) に当たった被選択物。マーカーへ一定のピクセル半径で当て、外れたら
  // 描かれている本体へ視線を通す(SPEC/MAP.md §11)。マーカー段はラベル衝突で非表示に
  // なった対象を外すが、本体段は外さない — 円盤が見えているのに掴めないのは嘘になる。
  private pickAt(candidates: readonly ObjectPickable[], x: number, y: number): ObjectPickable | null {
    const project = this.cameraSystem.activeCameraProjection;
    const displayTime = this.pickables.lastDisplayTime;
    const marker = pickNearest(
      candidates.filter((item) => item.shownOnMap(this.markerManager)),
      (item) => projectMarker(item, displayTime, project),
      x, y, pickRadiusSq(MAP_PICK_PX_SQ, MAP_PICK_PX_SQ_COARSE),
    );
    if (marker !== null) return marker;
    const ray = rayThroughScreen(
      this.cameraSystem.activeViewpoint, x, y, window.innerWidth, window.innerHeight);
    return pickFrontmostBody(candidates, ray, displayTime);
  }

  // 右クリック位置の被選択物(天体・自艦・他艦・ノード等)のプロパティウィンドウを開く。
  // 当たらなければ消費せず、handleEmptySpaceRightClick へ読み進める。
  handleMapRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const target = this.pickAt(this.pickables.pickables, p.x, p.y);
      if (!target) return false;
      this.openPropertyWindow(p.x, p.y, target, simTime);
      return true;
    });
  }

  // 被選択物・ノードハンドルのどちらにも当たらなかった右クリックに対し、表示中の軌道線
  // (公転軌道・船の軌道・軌道ガイド)への当たり判定を試みる。当たれば軌道のプロパティ
  // ウィンドウを開いて消費する。handleEmptySpaceRightClick より前、editor.handleMapPointer
  // より後に呼ぶ(11節の判定順序)。
  handleLineRightClick(input: Input): void {
    input.takeRightClicks((p) => {
      const orbit = pickNearestLine(
        this.linePickables.pickables, p.x, p.y, this.cameraSystem.activeCameraProjection,
        pickRadiusSq(ORBIT_LINE_PICK_PX_SQ, ORBIT_LINE_PICK_PX_SQ_COARSE),
        this.cameraSystem.activeCameraPos, this.celestialSystem.celestialMotions,
        this.pickables.lastDisplayTime,
      );
      if (!orbit) return false;
      this.orbitLineWindows.open(p.x, p.y, orbit);
      return true;
    });
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。一時ウィンドウ(非クリップ)どうしの排他は PropertyWindow 自身が
  // OverlayManager の TEMP_WINDOW_GROUP を通じて保つ。
  private openPropertyWindow(clientX: number, clientY: number, target: ObjectPickable, simTime: number): void {
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

  // 左クリック位置の、選択に応じる被選択物を選ぶ。当たらなければ消費せず、PlanEditor の
  // ノード配置/選択解除に読み進める(呼び出し側が editor.handleMapPointer より先に呼ぶことで、
  // マーカーへの命中をノード配置より優先する)。
  handleLeftClick(input: Input): void {
    input.takeClicks((p) => {
      const target = this.pickAt(
        this.pickables.pickables.filter((i) => i.onMapSelect !== null), p.x, p.y);
      if (!target) return false;
      target.onMapSelect?.(this, p.x, p.y);
      return true;
    });
  }

  // ダブルクリック位置の被選択物へフォーカスを移し、自艦であれば操作対象にも切り替える。
  // 種別を問わず候補列全体から探す。マップ視点でなければ何もしない。
  handleDoubleClick(input: Input): void {
    input.takeDoubleClicks((p) => {
      const target = this.pickAt(this.pickables.pickables, p.x, p.y);
      if (!target) return false;
      this.focusTarget(target.id, target);
      return true;
    });
  }

  // マップ視点のフォーカスを対象へ移す。対象が自艦なら操作対象にもなる(SPEC/MAP.md §10)。
  // マップのダブルクリックと一覧パネルのフォーカス行はどちらもここを通す。id は一覧側が候補列に
  // 頼らず持っている値、target は見つかっていれば名前・種別の解決に使う。
  private focusTarget(id: string, target: ObjectPickable | undefined): void {
    this.frameControls.setFocus({ kind: 'object', id });
    this.hud.hint(`${target?.name ?? id} にフォーカス`);
    target?.onMapFocus?.(this);
  }

  // 何も当たらなかった場合、「空域」として扱う(他のハンドラの後に呼ぶ)。マップ・戦闘の
  // どちらの右クリックも空振りしたら最終的にここへ落ちる — 実装は1つだけ持つ(openEmptySpaceMenu)。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      this.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  private openEmptySpaceMenu(clientX: number, clientY: number, simTime: number): void {
    const target = this.emptySpace;
    this.menu.open(clientX, clientY, target, target.menuItems(this, this.celestialSystem, simTime));
  }

  // 戦闘ビューの右クリック。ヒットした実体があればそのプロパティウィンドウを、なければ
  // 空域設定メニューを開く。
  handleCombatRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const hitEntity = pickCombatEntityAtPoint(
        this.entities, this.cameraSystem.activeViewpoint, this.cameraSystem.activeCameraProjection, p.x, p.y,
      );
      if (hitEntity) {
        this.openPropertyWindow(p.x, p.y, hitEntity, simTime);
      } else {
        this.openEmptySpaceMenu(p.x, p.y, simTime);
      }
      return true;
    });
  }

  // 軌道物体ウィンドウをマップ視点である間は常設で表示し、開いている全プロパティ
  // ウィンドウの値を最新化する。対象そのものが消滅していれば(撃破・回収・削除)閉じる —
  // 未来ゴースト時刻で位置が求まらないだけのフレーム(stateAt が null)は候補列
  // (pickables.pickables)から外れるだけで消滅ではないので、生存判定は対象の alive で行う。
  sync(simTime: number, displayTime: number, player: Player | null): void {
    const mapView = this.cameraSystem.worldView === 'map';
    this.physicalObjectListPanel.setVisible(mapView);
    if (mapView) {
      const items = this.pickables.pickables;
      // 親が無ければ(恒星、もしくは主天体が未登録)載せず、根として扱う。
      const parentOf = new Map<string, string>();
      for (const item of this.celestialMarkers.allItems) {
        const parent = this.celestialSystem.bodyParentId(item.id);
        if (parent !== undefined && parent !== null) parentOf.set(item.id, parent);
      }
      this.lastFocusId = focusTargetId(this.cameraSystem.mapCamera.focus);
      this.physicalObjectListPanel.sync(items, this.lastFocusId, parentOf, player, displayTime);
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

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
    this.partWindows.close();
    this.orbitLineWindows.close();
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、常設の一覧パネルと自身のメニューを取り除く。
  dispose(): void {
    this.close();
    this.menu.dispose();
    this.physicalObjectListPanel.dispose();
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
    const showShortcuts = this.cameraSystem.worldView === 'map';
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
        if (current) this.openPropertyWindow(clientX, clientY, current, this.pickables.lastSimTime);
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
    if (this.cameraSystem.worldView === 'map') {
      this.frameControls.setFocus({ kind: 'object', id });
    } else {
      this.cameraSystem.combatCamera.setFocusTarget({ kind: 'object', id });
    }
    this.hud.hint(`${name} にフォーカス`);
  }

  openProperties(target: ObjectPickable, clientX: number, clientY: number): void {
    this.openPropertyWindow(clientX, clientY, target, this.pickables.lastSimTime);
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
  get worldView(): WorldView { return this.cameraSystem.worldView; }

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
