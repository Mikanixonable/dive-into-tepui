// 被選択物(MapPickable)への右クリック/左クリック/ダブルクリックの解決と、プロパティ/パーツ/
// 軌道ウィンドウのライフサイクル管理。候補集合と表示可否は map-pickables.ts の MapPickables
// から読み、メニュー項目の構築・実行は MapPickableMenu、プロパティ行の構築は MapPropertyRows
// が持つ — 「何が選べるか」「選んだらどうなるか」「どう表示するか」を分けている。
import { Hud } from '../hud/hud';
import { Base } from '../dynamic/dynamic-entity/base';
import {
  ContextMenu, PropertyWindow, PropertyWindowContent, PropertyWindowItem,
  type PropertyWindowRelatedItem,
  MenuAction, type PauseMenu,
} from '../hud/windows';
import { TEMP_WINDOW_GROUP } from '../hud/overlay-manager';
import { isLagrangeId, lagrangeParentId } from '../celestial/lagrange-id';
import { pickGlyph } from '../marker/pick-glyphs';
import { MapPickable, pickNearest } from './map-pickable';
import { LinePickable, pickNearestLine } from './line-pickable';
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
import { Player } from '../player/player';
import type { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import type { Targeter } from '../targeter';
import { v3 } from '../../math/vec3';
import { CelestialMotion } from '../../physics/celestial-motion';
import { orbitingAttractorOf } from '../../physics/attractor';
import type { MapPickables } from './map-pickables';
import type { Part } from '../dynamic/dynamic-entity/parts';
import { pickCombatEntityAtPoint } from './combat-pickable';
import { MapPropertyRows } from './map-property-rows';
import { bodyParentId, MapPickableMenu } from './map-pickable-menu';
import type { KinematicState } from '../../physics/kinematic-state';

const MAP_PICK_PX_SQ = 600; // マップ上の被選択物(MapPickable)の右クリック判定半径の2乗 [px^2]
const ORBIT_LINE_PICK_PX_SQ = 600; // 軌道線(公転軌道・船の軌道・軌道ガイド)の右クリック判定半径の2乗 [px^2]

const MAP_PICK_PX_SQ_COARSE = 1936;
const ORBIT_LINE_PICK_PX_SQ_COARSE = 1936;

// 開いているプロパティウィンドウ本体と、開いた時点の対象。rows/items の再導出はこの target
// (毎フレーム候補列から更新されうる)を経由するので、対象が消滅したかどうかの判定にも使える。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  target: MapPickable;
}

interface PartWindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly shipId: string;
  readonly partId: string;
}

interface LineWindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  readonly orbitKey: string;
}

const ORBIT_PICK_KIND_LABEL: Record<LinePickable['kind'], string> = {
  'orbit-body': '公転軌道', 'orbit-ship': '船の軌道', 'orbit-guide': '軌道ガイド',
};
const ORBIT_CALC_METHOD_LABEL: Record<LinePickable['method'], string> = {
  analytic: '解析軌道', predicted: '予測軌道', guide: '軌道ガイド',
};

export class MapContextActions {
  // 'empty-space' は宇宙空間そのものでプロパティを持たないので、従来どおり ContextMenu を使う。
  private readonly menu: ContextMenu<MapPickable, MenuAction>;
  // 開いているプロパティウィンドウ。`${kind}:${id}` でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly partWindows = new Map<string, PartWindowEntry>();
  private readonly lineWindows = new Map<string, LineWindowEntry>();
  private readonly physicalObjectListPanel: PhysicalObjectListPanel;
  private readonly propertyRows: MapPropertyRows;
  private readonly pickableMenu: MapPickableMenu;
  private expandedBaseWindowKey: string | null = null;
  // 直近のマップフォーカス — プロパティウィンドウのバッジ判定に使う。マップを離れている間は
  // 最後にマップ視点だった時点の値のまま据え置く。
  private lastFocusId: string | undefined = undefined;

  // Docking は MapContextActions より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void {
    this.docking = docking;
    docking.basePanel.onClose = () => this.collapseBasePanel();
    this.pickableMenu.setDocking(docking);
  }
  private docking: Docking | null = null;

  setControlledBaseHandler(handler: (base: Base | null) => void, getControlledBase: () => Base | null): void {
    this.pickableMenu.setControlledBaseHandler(handler, getControlledBase);
  }

  // 候補集合(pickables)と、メニュー項目の実行先を参照として受け取る。
  constructor(
    private readonly hud: Hud,
    private readonly entities: DynamicSystem,
    private readonly celestialSystem: CelestialSystem,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    editor: PlanEditor,
    simSpeedManager: SimSpeedManager,
    pauseMenu: PauseMenu,
    private readonly pickables: MapPickables,
    private readonly linePickables: LinePickables,
    private readonly activePlayers: ActivePlayerController,
    private readonly frameControls: FrameControls,
    activeStage: Stage,
    private readonly targeter: Targeter,
  ) {
    this.menu = new ContextMenu<MapPickable, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => this.pickableMenu.run(act, target);
    this.propertyRows = new MapPropertyRows(entities, activePlayers, celestialSystem, navTarget);
    this.pickableMenu = new MapPickableMenu(
      hud, entities, celestialSystem, navTarget, cameraSystem, editor, simSpeedManager, pauseMenu, pickables,
      activePlayers, frameControls, activeStage, (target) => this.expandedBaseWindowKey === this.windowKey(target),
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
      if (enemy) this.openPropertyWindow(clientX, clientY, this.entityToPickable(enemy), this.pickables.lastSimTime);
    };
    this.hud.targetPanel.onSelectRight = (clientX, clientY) => {
      const target = this.targeter.aliveTarget;
      if (target) this.openPropertyWindow(clientX, clientY, this.entityToPickable(target), this.pickables.lastSimTime);
    };
  }

  // 右クリック位置の最寄りの被選択物(天体・自艦・他艦・ノード等)のプロパティウィンドウを開く。
  // 当たらなければ消費せず、handleEmptySpaceRightClick へ読み進める。
  // ラベル衝突で非表示になった天体は、表示されている別のラベルの背後から拾わない。
  handleMapRightClick(input: Input, simTime: number): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeRightClicks((p) => {
      const candidates = this.pickables.pickables.filter((item) => item.pickable !== false);
      const target = pickNearest(
        candidates, p.x, p.y, this.cameraSystem.activeCameraProjection,
        pickRadiusSq(MAP_PICK_PX_SQ, MAP_PICK_PX_SQ_COARSE),
      );
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
    if (!this.cameraSystem.overviewMode) return;
    input.takeRightClicks((p) => {
      const orbit = pickNearestLine(
        this.linePickables.pickables, p.x, p.y, this.cameraSystem.activeCameraProjection,
        pickRadiusSq(ORBIT_LINE_PICK_PX_SQ, ORBIT_LINE_PICK_PX_SQ_COARSE),
      );
      if (!orbit) return false;
      this.openOrbitPropertyWindow(p.x, p.y, orbit);
      return true;
    });
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。一時ウィンドウ(非クリップ)どうしの排他は PropertyWindow 自身が
  // OverlayManager の TEMP_WINDOW_GROUP を通じて保つ。
  private openPropertyWindow(clientX: number, clientY: number, target: MapPickable, simTime: number): void {
    const key = this.windowKey(target);
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
      if (act === 'toggleBasePanel' && entry.target.kind === 'base') {
        this.toggleBasePanel(key, entry);
        return;
      }
      this.pickableMenu.run(act, entry.target);
      if (act === 'delete' || (!w.clipped && !keepOpen)) this.closeWindow(key);
    };
    w.onClose = () => {
      if (this.expandedBaseWindowKey === key) {
        this.expandedBaseWindowKey = null;
        this.docking?.closePanel();
      }
      this.closePartWindowsForShip(entry.target.kind === 'player' ? entry.target.id : '');
      this.forgetWindow(key);
    };
  }

  // windows のキー。kind をまたいで id が衝突しないよう種別込みにする。
  private windowKey(target: MapPickable): string {
    return `${target.kind}:${target.id}`;
  }

  private partWindowKey(shipId: string, partId: string): string {
    return `part:${shipId}:${partId}`;
  }

  private openPartPropertyWindow(ship: Player, part: Part, clientX: number, clientY: number): void {
    const key = this.partWindowKey(ship.id, part.id);
    const existing = this.partWindows.get(key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const w = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.partWindowContent(ship, part), this.hud.overlayManager,
    );
    const entry: PartWindowEntry = { win: w, shipId: ship.id, partId: part.id };
    this.partWindows.set(key, entry);
    w.onSelect = (act) => {
      const currentShip = this.entities.findPlayer(entry.shipId);
      const currentPart = currentShip?.parts.find((candidate) => candidate.id === entry.partId);
      if (!currentShip || !currentPart) return;
      this.setPartDeployment(currentShip, currentPart, act === 'deployPart');
    };
    w.onClose = () => this.partWindows.delete(key);
  }

  // openPartPropertyWindow と同じパターン: 専用 Map で管理し、排他グループを持たせず
  // メインのプロパティウィンドウと共存させる。操作項目は持たない(12.1節)。
  private openOrbitPropertyWindow(clientX: number, clientY: number, orbit: LinePickable): void {
    const existing = this.lineWindows.get(orbit.key);
    if (existing) {
      existing.win.moveTo(clientX, clientY);
      existing.win.bringToFront();
      return;
    }
    const w = new PropertyWindow<MenuAction>(
      this.hud.layers.window, clientX, clientY, this.orbitWindowContent(orbit), this.hud.overlayManager,
    );
    const entry: LineWindowEntry = { win: w, orbitKey: orbit.key };
    this.lineWindows.set(orbit.key, entry);
    w.onClose = () => this.lineWindows.delete(orbit.key);
  }

  private orbitWindowContent(orbit: LinePickable): PropertyWindowContent<MenuAction> {
    return {
      title: ORBIT_PICK_KIND_LABEL[orbit.kind],
      rows: [{ key: 'method', label: '計算方法', value: ORBIT_CALC_METHOD_LABEL[orbit.method] }],
      items: [],
      relatedItems: this.relatedItemsForOrbit(orbit),
      relatedTitle: '所属',
    };
  }

  // 軌道の所属先(周回天体・船自身・ラグランジュ点/主星/副星)を、既存の MapPickable 候補列から
  // 引き直して関連項目にする。候補列に現れていない(表示・選択の対象から外れている)所属は
  // その回だけ出さない。
  private relatedItemsForOrbit(orbit: LinePickable): readonly PropertyWindowRelatedItem[] {
    const items: PropertyWindowRelatedItem[] = [];
    for (const ownerKey of orbit.ownerKeys) {
      const target = this.pickables.pickables.find((candidate) => this.windowKey(candidate) === ownerKey);
      if (!target) continue;
      items.push({
        id: ownerKey,
        label: target.name,
        onFocus: () => {
          this.frameControls.setFocus({ kind: 'object', id: target.id });
          this.hud.hint(`${target.name} にフォーカス`);
        },
        onContextMenu: (clientX, clientY) => {
          const current = this.pickables.pickables.find((candidate) => this.windowKey(candidate) === ownerKey);
          if (current) this.openPropertyWindow(clientX, clientY, current, this.pickables.lastSimTime);
        },
      });
    }
    return items;
  }

  private closePartWindowsForShip(shipId: string): void {
    for (const entry of this.partWindows.values()) {
      if (entry.shipId === shipId) entry.win.close();
    }
  }

  private partWindowContent(ship: Player, part: Part): PropertyWindowContent<MenuAction> {
    const deployable = part.type === 'radiator' || part.type === 'solar_panel';
    const items: PropertyWindowItem<MenuAction>[] = deployable
      ? [{ label: '展開', act: 'deployPart', keepOpen: true }, { label: '収納', act: 'stowPart', keepOpen: true }]
      : [];
    return {
      title: part.name,
      subtitle: `取り付け艦: ${ship.name}`,
      rows: [
        { key: 'name', label: '部品名', value: part.name },
        { key: 'ship', label: '取り付け艦', value: ship.name },
        { key: 'wear', label: '損耗度', value: this.partWearText(part) },
      ],
      items,
    };
  }

  private partWearText(part: Part): string {
    const wear = part.maxHp > 0 ? Math.max(0, Math.min(1, 1 - part.hp / part.maxHp)) : 1;
    return `${(wear * 100).toFixed(1)}% (${Math.floor(part.hp)} / ${part.maxHp})`;
  }

  private setPartDeployment(ship: Player, part: Part, deployed: boolean): void {
    const sameTypeParts = ship.parts.filter((candidate) => candidate.type === part.type);
    const side = sameTypeParts.indexOf(part) === 0 ? 'up' : 'down';
    if (part.type === 'radiator') ship.radiator.setDeployed(side, deployed);
    if (part.type === 'solar_panel') ship.power.setDeployed(side, deployed);
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

  private toggleBasePanel(key: string, entry: WindowEntry): void {
    if (this.expandedBaseWindowKey === key) {
      this.collapseBasePanel();
      return;
    }
    const base = this.entities.findBase(entry.target.id);
    if (!base || !this.docking) return;
    this.collapseBasePanel();
    entry.win.setExpandedPanel(this.docking.openPanel(base));
    this.expandedBaseWindowKey = key;
    entry.win.bringToFront();
  }

  private collapseBasePanel(): void {
    if (this.expandedBaseWindowKey !== null) {
      this.windows.get(this.expandedBaseWindowKey)?.win.setExpandedPanel(null);
      this.expandedBaseWindowKey = null;
    }
    this.docking?.closePanel();
  }

  // 左クリック位置の最寄りの自艦・基地を選択する。当たらなければ消費せず、PlanEditor の
  // ノード配置/選択解除に読み進める(呼び出し側が editor.handleMapPointer より先に呼ぶことで、
  // マーカーへの命中をノード配置より優先する)。マップ視点でなければ何もしない。
  handleLeftClick(input: Input): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeClicks((p) => {
      const candidates = this.pickables.pickables.filter((i) => (i.kind === 'player' || i.kind === 'base') && i.pickable !== false);
      const target = pickNearest(candidates, p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(MAP_PICK_PX_SQ, MAP_PICK_PX_SQ_COARSE));
      if (!target) return false;
      this.selectPickable(target, p.x, p.y);
      return true;
    });
  }

  // ダブルクリック位置の最寄りの被選択物へフォーカスを移し、自艦であれば操作対象にも切り替える。
  // 種別を問わず候補列全体から探す。ラベル衝突で非表示になった天体は、表示されている別のラベルの
  // 背後から拾わない。マップ視点でなければ何もしない。
  handleDoubleClick(input: Input): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeDoubleClicks((p) => {
      const target = pickNearest(
        this.pickables.pickables.filter((item) => item.pickable !== false),
        p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(MAP_PICK_PX_SQ, MAP_PICK_PX_SQ_COARSE),
      );
      if (!target) return false;
      this.focusTarget(target.id, target);
      return true;
    });
  }

  // マップ視点のフォーカスを対象へ移す。対象が自艦なら操作対象にもなる(SPEC/MAP.md §10)。
  // マップのダブルクリックと一覧パネルのフォーカス行はどちらもここを通す。id は一覧側が候補列に
  // 頼らず持っている値、target は見つかっていれば名前・種別の解決に使う。
  private focusTarget(id: string, target: MapPickable | undefined): void {
    this.frameControls.setFocus({ kind: 'object', id });
    this.hud.hint(`${target?.name ?? id} にフォーカス`);
    if (target?.kind === 'player') {
      const ship = this.entities.findPlayer(target.id);
      if (ship) {
        this.activePlayers.set(ship);
        this.hud.hint(`${target.name} を操作対象に設定`);
      }
    }
  }

  // 単クリックは選択までに留める: 自艦はプロパティウィンドウを開くだけで操作対象は変えず、
  // 基地も selectBase のみ呼んで基地パネルは展開しない。取り消せない操作は明示の項目
  // (プロパティウィンドウ)かダブルクリックに限る。
  private selectPickable(target: MapPickable, clientX: number, clientY: number): void {
    if (target.kind === 'player') {
      this.openPropertyWindow(clientX, clientY, target, this.pickables.lastSimTime);
    } else if (target.kind === 'base') {
      const base = this.entities.findBase(target.id);
      if (!base) return;
      this.docking?.selectBase(base);
      this.hud.hint(`${target.name} を選択`);
    }
  }

  // 何も当たらなかった場合、「空域」として扱う(他のハンドラの後に呼ぶ)。マップ・戦闘の
  // どちらの右クリックも空振りしたら最終的にここへ落ちる — 実装は1つだけ持つ(openEmptySpaceMenu)。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeRightClicks((p) => {
      this.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  private openEmptySpaceMenu(clientX: number, clientY: number, simTime: number): void {
    const target: MapPickable = { id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' };
    this.menu.open(clientX, clientY, target, this.pickableMenu.itemsFor(target, simTime));
  }

  // 戦闘ビューの右クリック。ヒットした実体があればそのプロパティウィンドウを、なければ
  // 空域設定メニューを開く。
  handleCombatRightClick(
    input: Input, simTime: number, overviewMode: boolean,
  ): void {
    if (overviewMode) return;
    input.takeRightClicks((p) => {
      const hitEntity = pickCombatEntityAtPoint(
        this.entities, this.cameraSystem.activeViewpoint, this.cameraSystem.activeCameraProjection, p.x, p.y,
      );
      if (hitEntity) {
        this.openPropertyWindow(p.x, p.y, this.entityToPickable(hitEntity), simTime);
      } else {
        this.openEmptySpaceMenu(p.x, p.y, simTime);
      }
      return true;
    });
  }

  private entityToPickable(entity: DynamicEntity): MapPickable {
    if (entity instanceof Player) {
      return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'player' };
    }
    if (entity instanceof Base) {
      return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'base' };
    }
    return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'ship' };
  }

  // 軌道物体ウィンドウをマップ視点である間は常設で表示し、開いている全プロパティ
  // ウィンドウの値を最新化する。対象そのものが消滅していれば(撃破・回収・削除)閉じる —
  // 未来ゴースト時刻で位置が求まらないだけのフレーム(stateAt が null)は候補列
  // (pickables.pickables)から外れるだけで消滅ではないので、生存判定は対象の alive で行う。
  sync(simTime: number, celestialBodies: readonly CelestialMotion[], player: Player | null): void {
    const overviewMode = this.cameraSystem.overviewMode;
    this.physicalObjectListPanel.setVisible(overviewMode);
    // マップを離れると ViewManager.closeMap() が開いているウィンドウを閉じる。
    // 戦闘中は候補列を更新せず、ウィンドウもないため、毎フレームの Map 生成と行導出を省く。
    if (!overviewMode && this.windows.size === 0 && this.partWindows.size === 0 && this.lineWindows.size === 0) return;
    const items = this.pickables.pickables;
    if (overviewMode) {
      // ラグランジュ点は自分を持つ天体(衛星ならその衛星自身)、それ以外の天体は主星/主天体を
      // 親とする — 親が無ければ(恒星、もしくは主天体が未登録)undefined のままにして根として扱う。
      const parentOf = new Map<string, string>();
      for (const l of this.cameraSystem.focusMarkers.allLabels) {
        const parent = l.isLagrange
          ? lagrangeParentId(l.id) : this.celestialSystem.entityOf(l.id).motion.primary?.id ?? null;
        if (parent !== null) parentOf.set(l.id, parent);
      }
      this.lastFocusId = focusTargetId(this.cameraSystem.mapCamera.focus);
      this.physicalObjectListPanel.sync(items, this.lastFocusId, parentOf);
    }

    const byKey = new Map(items.map((i) => [this.windowKey(i), i]));
    for (const [key, entry] of [...this.windows]) {
      if (this.isTargetGone(entry.target)) { this.closeWindow(key); continue; }
      // 候補列に載っていれば最新の位置を反映し、載っていなければ開いた時点の対象のまま
      // 据え置く(rows の導出はどの種別も実体の state を直接読むので、位置の鮮度は無関係)。
      entry.target = byKey.get(key) ?? entry.target;
      const { title, subtitle, items: menuItems } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRelatedItems(
        this.relatedItemsFor(entry.target, celestialBodies, simTime),
        this.relatedTitleFor(entry.target));
      entry.win.syncRows(
        this.propertyRows.rowsFor(entry.target, celestialBodies, simTime, player, simTime));
      entry.win.syncItems(menuItems);
      entry.win.syncBadge(entry.target.id === this.lastFocusId);
    }
    for (const entry of [...this.partWindows.values()]) {
      const ship = this.entities.findPlayer(entry.shipId);
      const part = ship?.parts.find((candidate) => candidate.id === entry.partId);
      if (!ship || !part || !ship.alive || ship !== this.activePlayers.current) {
        entry.win.close();
        continue;
      }
      entry.win.syncHeader(part.name, `取り付け艦: ${ship.name}`);
      entry.win.syncRows([
        { key: 'name', label: '部品名', value: part.name },
        { key: 'ship', label: '取り付け艦', value: ship.name },
        { key: 'wear', label: '損耗度', value: this.partWearText(part) },
      ]);
      entry.win.syncItems(this.partWindowContent(ship, part).items);
    }
    for (const [key, entry] of [...this.lineWindows]) {
      const orbit = this.linePickables.pickables.find((candidate) => candidate.key === key);
      if (!orbit) { entry.win.close(); continue; }
      entry.win.syncRelatedItems(this.relatedItemsForOrbit(orbit), '所属');
    }
  }

  // ウィンドウの対象そのものが消滅したかどうか。生きている実体を指す種別は alive を直接見て、
  // 未来ゴースト時刻で位置が求まらないだけの休止フレームでは閉じないようにする。それ以外の
  // 種別(天体・アプシス・AN/DN)は実体を持たないので、候補列に載っているかで判定する。
  private isTargetGone(target: MapPickable): boolean {
    switch (target.kind) {
      case 'player': return this.entities.findPlayer(target.id) === undefined;
      case 'ship': return !(this.entities.findEnemy(target.id)?.alive ?? false);
      case 'ammo': return !(
        this.entities.ammoPickups.find((ammoPickup) => ammoPickup.id === target.id)?.alive ?? false
      );
      case 'fuel': return !(
        this.entities.rcsFuelPickups.find((pickup) => pickup.id === target.id)?.alive ?? false
      );
      case 'base': return !(this.entities.findBase(target.id)?.alive ?? false);
      default: return !this.pickables.pickables.some((i) => this.windowKey(i) === this.windowKey(target));
    }
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
    for (const entry of [...this.partWindows.values()]) entry.win.close();
    for (const entry of [...this.lineWindows.values()]) entry.win.close();
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、常設の一覧パネルと自身のメニューを取り除く。
  dispose(): void {
    this.close();
    this.menu.dispose();
    this.physicalObjectListPanel.dispose();
  }

  // itemsFor の出力をプロパティウィンドウの形へ組み替える: header 項目はタイトル/サブタイトルへ
  // 抜き出す。開いた直後から sync 時と同じ経路(windowParts)で求める。
  private buildContent(target: MapPickable, simTime: number): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    return {
      title, subtitle, icon: pickGlyph(target.kind, target.id, this.celestialSystem), rows: [], items,
      relatedItems: this.relatedItemsFor(target, this.celestialSystem.celestialMotions, simTime),
      relatedTitle: this.relatedTitleFor(target),
      onRename: this.renameHandlerFor(target),
    };
  }

  // 改名できる種別(自艦・基地)にだけコールバックを渡す。対象は id で引き直す —
  // ウィンドウを開いた時点の MapPickable を直接束縛すると、以後の位置更新で
  // 別の実体を指してしまう。
  private renameHandlerFor(target: MapPickable): ((name: string) => void) | undefined {
    if (target.kind === 'player') {
      return (name) => { const ship = this.entities.findPlayer(target.id); if (ship) ship.name = name; };
    }
    if (target.kind === 'base') {
      return (name) => { const base = this.entities.findBase(target.id); if (base) base.name = name; };
    }
    return undefined;
  }

  // タイトル・サブタイトルは到達まで T+… や所持金など、操作項目は操作対象か・追従状態・
  // 航法ターゲットかなど、どちらも可変な状態に依存するため itemsFor を毎フレーム呼び直す
  // 必要があるが、呼び出しは1回にまとめる(header 項目からタイトル/サブタイトルを抜き出し、
  // 残りを操作項目とする)。
  private windowParts(
    target: MapPickable, simTime: number,
  ): { title: string; subtitle?: string; items: PropertyWindowItem<MenuAction>[] } {
    const all = this.pickableMenu.itemsFor(target, simTime);
    const header = all.find((it) => it.type === 'header');
    // 戦闘ビューで開いたウィンドウは項目ショートカットを持たせない — [F]/[T] は自機の
    // 進行方向リセット/ターゲット選択が既に使っており、同じキーを両方へは配れない。
    const showShortcuts = this.cameraSystem.overviewMode;
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({
        label: it.label, act: it.act as MenuAction,
        shortcut: showShortcuts ? it.shortcut : undefined,
        selected: it.selected, keepOpen: it.keepOpen,
      }));
    const isOrbitPoint = target.kind === 'apsis' || target.kind === 'relnode' || target.kind === 'eqnode';
    const subtitle = (target.ownerName && !isOrbitPoint) ? `所属: ${target.ownerName}` : header?.subLabel;
    return { title: header?.label ?? target.name, subtitle, items };
  }

  // 天体プロパティーの先頭に表示する、現在その天体を周回している物体。
  // 天体は静的な primaryOf、人工物は現在状態から orbitingAttractorOf で判定する。
  private relatedItemsFor(
    target: MapPickable, celestialBodies: readonly CelestialMotion[], pivot: number,
  ): readonly PropertyWindowRelatedItem[] {
    if (target.kind === 'player') {
      const ship = this.entities.findPlayer(target.id);
      if (!ship || ship !== this.activePlayers.current) return [];
      return ship.parts.map((part) => ({
        id: part.id,
        label: part.name,
        onFocus: () => {
          this.frameControls.setFocus({ kind: 'object', id: ship.id });
          this.hud.hint(`${part.name} を搭載する ${ship.name} にフォーカス`);
        },
        onContextMenu: (clientX, clientY) => this.openPartPropertyWindow(ship, part, clientX, clientY),
      }));
    }
    if (target.kind !== 'body' || isLagrangeId(target.id) || !this.celestialSystem.has(target.id)) return [];
    const related: { item: MapPickable; label: string }[] = [];
    for (const item of this.pickables.pickables) {
      if (item.id === target.id) continue;
      let isOrbiting = false;
      if (item.kind === 'body') {
        isOrbiting = bodyParentId(this.celestialSystem, item.id) === target.id;
      } else {
        const state = this.stateOfPickable(item);
        isOrbiting = state !== null
          && orbitingAttractorOf(state, celestialBodies, pivot)?.id === target.id;
      }
      if (isOrbiting) related.push({ item, label: item.name });
    }
    related.sort((a, b) => a.label.localeCompare(b.label));
    return related.map(({ item, label }) => ({
      id: this.windowKey(item),
      label,
      onFocus: () => {
        this.frameControls.setFocus({ kind: 'object', id: item.id });
        this.hud.hint(`${label} にフォーカス`);
      },
      onContextMenu: (clientX, clientY) => {
        const current = this.pickables.pickables.find((candidate) => this.windowKey(candidate) === this.windowKey(item));
        if (current) this.openPropertyWindow(clientX, clientY, current, this.pickables.lastSimTime);
      },
    }));
  }

  private relatedTitleFor(target: MapPickable): string {
    return target.kind === 'player' && this.entities.findPlayer(target.id) === this.activePlayers.current
      ? '搭載部品' : '周回物体';
  }

  private stateOfPickable(item: MapPickable): KinematicState | null {
    switch (item.kind) {
      case 'player': return this.entities.findPlayer(item.id)?.state ?? null;
      case 'ship': return this.entities.findEnemy(item.id)?.state ?? null;
      case 'ammo': return this.entities.ammoPickups.find((ammo) => ammo.id === item.id)?.state ?? null;
      case 'fuel': return this.entities.rcsFuelPickups.find((pickup) => pickup.id === item.id)?.state ?? null;
      case 'base': return this.entities.findBase(item.id)?.state ?? null;
      default: return null;
    }
  }
}
