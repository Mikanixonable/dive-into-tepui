// マップ上の被選択物(MapPickable)まわり一式 — このフレームの候補列の組み立て、右クリックの
// 解決、種別ごとのメニュー項目、選ばれた操作の各所有者への配分。候補列は1本だけ持つ:
// 種類ごとに列を分けると、片方しか見ない消費側が出て「メニューには出るがフォーカスは効かない」
// ように割れる。
import * as C from './const';
import { Hud } from './hud/hud';
import { fmtAmmoStatus, fmtDist, fmtEnergy, fmtSpeed, fmtTime } from './hud/utils';
import { orbitInfo, relativeInfo } from './hud/orbit-info';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { PropertyRow, PropertyWindow, PropertyWindowContent, PropertyWindowItem } from './hud/property-window';
import { MenuAction, MenuCommon } from './hud/menu-actions';
import { celestialBodyName } from './hud/frame-labels';
import { lagrangeParentId } from './hud/object-groups';
import { MapPickable, pickNearest } from './map-pick';
import { focusTargetId } from './camera/focus-target';
import { ObjectListPanel } from './object-list-panel';
import type { Input } from './input/input';
import { pickRadiusSq } from './input/pointer-precision';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import { SimSpeedManager } from './sim-speed-manager';
import type { SettingsPanel } from './hud/settings-panel';
import type { CombatTarget } from './targeter';
import type { DisplayWindow } from './display-window-manager';
import type { Docking } from './docking';
import type { Game } from './game';
import { Player, planExecutionLabel, type PlanExecutionMode } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import { len, sub, v3 } from '../physics/vec3';
import type { ObjectType } from './creative/ship-placer-panel';
import type { KinematicState } from '../physics/kinematic-state';
import { Attractor, orbitalElementsOf, strongestAttractor } from '../physics/attractor';
import { isOccluded } from '../physics/occlusion';
import { apsisAltitudes } from '../physics/elements';
import { bodyDef, primaryOf } from '../physics/solar-system';
import { isPositionInFocusedSystem, systemMembersAt } from './celestial/body-visibility';
import { MapVisibilityPolicy } from './celestial/map-visibility';
import type { PerfCounts } from '../perf-meter';

interface PickHandler {
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[];
  run(act: MenuAction, target: MapPickable): void;
}

type MutableMapPickable = { -readonly [K in keyof MapPickable]: MapPickable[K] };

// 軌道計画の実行モードの巡回順。ボタン1つで次のモードへ進める。
const PLAN_EXECUTION_MODES: readonly PlanExecutionMode[] = ['off', 'instant', 'powered'];

// クリップされていないプロパティウィンドウが同時に高々1枚しか開かないための排他グループ名。
// クリップ状態の遷移ごとの出し入れは PropertyWindow 自身が OverlayManager へ宣言する。
const PROPERTY_WINDOW_TEMP_GROUP = 'property-window-temp';

// 開いているプロパティウィンドウ本体と、開いた時点の対象。rows/items の再導出はこの target
// (毎フレーム候補列から更新されうる)を経由するので、対象が消滅したかどうかの判定にも使える。
interface WindowEntry {
  readonly win: PropertyWindow<MenuAction>;
  target: MapPickable;
}

export class MapPicker {
  // 'empty-space' は宇宙空間そのものでプロパティを持たないので、従来どおり ContextMenu を使う。
  private readonly menu: ContextMenu<MapPickable, MenuAction>;
  // 開いているプロパティウィンドウ。`${kind}:${id}` でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly objectListPanel: ObjectListPanel;
  private readonly candidateItems: MutableMapPickable[] = [];
  private readonly visibleItems: MutableMapPickable[] = [];
  private readonly itemRecords = new Map<string, MutableMapPickable>();
  private readonly activeRecordKeys = new Set<string>();
  private items: readonly MapPickable[] = this.candidateItems;
  private lastSimTime = 0;
  private _visibilityPolicy: MapVisibilityPolicy | null = null;

  // このフレームの被選択物候補。refresh の後に読む。
  get pickables(): readonly MapPickable[] { return this.items; }

  // このフレームの表示・選択可否。refresh の後に読む(refresh 前は null)。
  get visibilityPolicy(): MapVisibilityPolicy | null { return this._visibilityPolicy; }

  // Docking は MapPicker より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void { this.docking = docking; }
  private docking: Docking | null = null;

  // 候補の供給元と、メニュー項目の実行先を参照として受け取る。
  constructor(
    private readonly game: Game,
    private readonly hud: Hud,
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly settingsPanel: SettingsPanel,
  ) {
    this.menu = new ContextMenu<MapPickable, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => {
      const handler = this.handlers[target.kind];
      if (handler) handler.run(act, target);
    };
    this.objectListPanel = new ObjectListPanel(hud.layers.panel, ephemeris.registry);
    this.objectListPanel.onSelect = (id) => {
      const target = this.items.find((i) => i.id === id);
      if (target) this.objectListPanel.select(id);
    };
    this.objectListPanel.onFocus = (id) => {
      this.game.frameControls.setFocus({ kind: 'object', id });
      this.hud.hint(`${this.items.find((i) => i.id === id)?.name ?? id} にフォーカス`);
    };
    this.objectListPanel.onNavTarget = (id) => {
      const target = this.items.find((i) => i.id === id);
      if (target && this.navTarget.canTarget(id, this.entities, this.ephemeris, this.lastSimTime)) this.navTarget.toggleTarget(id, target.name);
    };
    this.objectListPanel.onSelectRight = (id, clientX, clientY) => {
      const target = this.items.find((i) => i.id === id);
      if (target) this.openPropertyWindow(clientX, clientY, target, this.lastSimTime);
    };
  }

  // マップの天体ラベル(表示のみ)と航法ターゲットの AN/DN を求め直したうえで、このフレームの
  // 候補列を組み直す(表示中の天体・ラグランジュ点 + 生存中の自艦・敵船・弾薬・基地 + AN/DN
  // アイコン + 近地点・遠地点アイコン)。天体側も表示と同じ MapVisibilityPolicy を通し、
  // 非表示にした対象を選べない状態にする。物理積分の後に呼ぶ: 積分前に組むと、同フレームで
  // sync されるメッシュと座標が1ステップずれる。
  refresh(displayWindow: DisplayWindow): void {
    if (!this.cameraSystem.overviewMode) return;
    const { simTime, displayTime } = displayWindow;
    this.lastSimTime = simTime;
    const focusId = focusTargetId(this.cameraSystem.overviewCamera.focus);
    const attractors = this.ephemeris.attractorsAt(simTime);
    const displayAttractors = this.ephemeris.attractorsAt(displayTime);
    const visibilityPolicy = new MapVisibilityPolicy(
      this.ephemeris.registry,
      this.cameraSystem.bodyClassToggles,
      focusId,
      systemMembersAt(this.ephemeris.registry, this.cameraSystem.activeCameraPos, displayAttractors),
    );
    this._visibilityPolicy = visibilityPolicy;
    this.cameraSystem.focusMarkers.update(
      displayTime, focusId, this.cameraSystem.bodyClassToggles,
      this.cameraSystem.activeCameraPos, visibilityPolicy,
    );
    this.navTarget.update(this.game.player, this.entities, this.ephemeris, displayWindow);

    // 船の位置は表示時刻の displayState — 機体メッシュや敵マーカーと同じ未来ゴースト位置に揃える。
    this.candidateItems.length = 0;
    this.visibleItems.length = 0;
    this.activeRecordKeys.clear();
    for (const item of this.cameraSystem.focusMarkers.bodyPickables(displayTime, visibilityPolicy)) {
      this.appendPickable(item);
    }
    for (const ship of this.entities.players) {
      if (!visibilityPolicy.entity('player', ship === this.game.player).pickable) continue;
      const pos = ship.displayState(displayTime)?.r;
      if (pos) {
        const center = strongestAttractor(ship.state.r, attractors);
        const el = ship.orbitalElementsAround(center);
        const pe = el ? fmtDist(apsisAltitudes(el).pe) : '—';
        this.addCandidate(
          ship.id, ship.name, pos, 'player',
          `HP ${Math.round(ship.hp)}/${Math.round(ship.maxHp)} · PE ${pe}`,
          ship === this.game.player ? -100 : 0,
        );
      }
    }
    for (const enemy of this.entities.enemies) {
      if (!enemy.alive || !visibilityPolicy.entity('ship').pickable) continue;
      const pos = enemy.displayState(displayTime)?.r;
      if (pos) this.addCandidate(enemy.id, enemy.name, pos, 'ship');
    }
    for (const ammo of this.entities.ammos) {
      if (!ammo.alive || !visibilityPolicy.entity('ammo').pickable) continue;
      const pos = ammo.displayState(displayTime)?.r;
      if (pos) this.addCandidate(ammo.id, ammo.name, pos, 'ammo');
    }
    for (const base of this.entities.bases) {
      if (!base.alive || !visibilityPolicy.entity('base').pickable) continue;
      const pos = base.displayState(displayTime)?.r;
      if (pos) this.addCandidate(
        base.id, base.name, pos, 'base', `格納 ${base.baseState.dockedShips.length} 隻`,
      );
    }
    for (const item of this.navTarget.mapPickables()) this.appendPickable(item);
    for (const item of this.editor.planDisplay.apsisMarkers) this.appendPickable(item);
    for (const e of this.entities.all()) {
      if (e.equatorNodes) for (const item of e.equatorNodes.mapPickables()) this.appendPickable(item);
    }

    // 自艦からの距離は一覧の実用順と補助情報にだけ使う。軌道予測はここで増やさない。
    const viewer = this.game.player?.state;
    if (viewer) for (const item of this.candidateItems) {
      const d = len(sub(item.pos, viewer.r));
      // 相対速度は対の速度を持つ敵艦にだけ意味がある。
      const status = item.kind === 'ship' ? `${d < 2e5 ? '接近' : '距離'} ${fmtDist(d)} · ${fmtSpeed(len(sub(this.entities.findEnemy(item.id)?.state.v ?? viewer.v, viewer.v)))}` : item.kind === 'ammo' ? `${fmtDist(d)}${d <= C.AMMO_PICKUP_RADIUS ? ' · 回収可能' : ''}` : item.kind === 'base' ? `${fmtDist(d)} · ドック候補` : item.kind === 'body' ? `${fmtDist(d)} · ${celestialBodyName(strongestAttractor(item.pos, attractors).id)}` : item.detail;
      item.detail = status;
      item.distance = d;
      // 所属系は天体以外にしか意味を持たない(天体は系そのものを表す行として常に一覧へ出す)。
      // 判定は最強天体から親を辿るぶん高価なので、読まれない天体候補では省く。
      item.inFocusedSystem = item.kind === 'body'
        ? undefined
        : isPositionInFocusedSystem(this.ephemeris.registry, focusId, item.pos, attractors);
    }

    // マップビューでは player だけ、フォーカス天体の系に所属するかで候補を絞る。表示側と
    // 同じ判定なので、地球の裏側の player は表示・選択でき、土星系の player はどちらにも
    // 現れない。他の候補は従来どおり天体遮蔽でピック対象から除く。
    for (const item of this.candidateItems) {
      const included = item.kind === 'player'
        ? item.inFocusedSystem ?? isPositionInFocusedSystem(this.ephemeris.registry, focusId, item.pos, attractors)
        : !isOccluded(this.cameraSystem.activeCameraPos, item.pos, attractors);
      if (included) this.visibleItems.push(item);
    }
    this.items = this.visibleItems;
    for (const key of this.itemRecords.keys()) {
      if (!this.activeRecordKeys.has(key)) this.itemRecords.delete(key);
    }
  }

  private appendPickable(item: MapPickable): void {
    this.addCandidate(
      item.id, item.name, item.pos, item.kind, item.detail, item.priority,
      item.time, item.pickable,
    );
  }

  private addCandidate(
    id: string, name: string, pos: MapPickable['pos'], kind: MapPickable['kind'],
    detail?: string, priority?: number, time?: number, pickable?: boolean,
  ): void {
    const key = `${kind}:${id}`;
    this.activeRecordKeys.add(key);
    let item = this.itemRecords.get(key);
    if (item === undefined) {
      item = { id, name, pos, kind };
      this.itemRecords.set(key, item);
    } else {
      item.id = id;
      item.name = name;
      item.pos = pos;
      item.kind = kind;
    }
    // 候補が同じ id で別種別へ変わる場合や、前フレームだけ持っていた補助値が残らない
    // ように、候補へ追加するたびに全ての派生フィールドを上書きする。
    item.detail = detail;
    item.distance = undefined;
    item.priority = priority;
    item.time = time;
    item.inFocusedSystem = undefined;
    item.pickable = pickable;
    this.candidateItems.push(item);
  }

  // 右クリック位置の最寄り候補を探し、当たればその種別に応じたプロパティウィンドウを開いて消費する。
  handleRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      const target = pickNearest(
        this.items, p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE),
      );
      if (!target) return false;
      this.openPropertyWindow(p.x, p.y, target, simTime);
      return true;
    });
  }

  // 対象1つにつきウィンドウは高々1枚: 既存があればクリック位置へ動かして最前面に出すだけで
  // 新規には開かない。一時ウィンドウ(非クリップ)どうしの排他は PropertyWindow 自身が
  // OverlayManager の PROPERTY_WINDOW_TEMP_GROUP を通じて保つ。
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
      this.hud.overlayManager, PROPERTY_WINDOW_TEMP_GROUP,
    );
    const entry: WindowEntry = { win: w, target };
    this.windows.set(key, entry);
    // 実行時は entry.target(sync のたびに最新化される)を読む — 開いた瞬間の対象を
    // 捕まえたままだと、時刻に依存する操作(ワープ・ノード追加)が古い時刻へ向けて走ってしまう。
    // 操作項目のクリックは、クリップ済みか keepOpen(排他選択肢の切り替え)なら開いたままにする。
    // 「削除」は対象自体が消えるのでどちらでも閉じる。
    w.onSelect = (act, keepOpen) => {
      const handler = this.handlers[entry.target.kind];
      if (handler) handler.run(act, entry.target);
      if (act === 'delete' || (!w.clipped && !keepOpen)) this.closeWindow(key);
    };
    w.onClose = () => this.forgetWindow(key);
  }

  // windows のキー。kind をまたいで id が衝突しないよう種別込みにする。
  private windowKey(target: MapPickable): string {
    return `${target.kind}:${target.id}`;
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

  // 左クリック位置の最寄りの自艦・基地を選択する。当たらなければ消費せず、PlanEditor の
  // ノード配置/選択解除に読み進める(呼び出し側が editor.handleMapPointer より先に呼ぶことで、
  // マーカーへの命中をノード配置より優先する)。
  handleLeftClick(input: Input): void {
    input.takeClicks((p) => {
      const candidates = this.items.filter((i) => i.kind === 'player' || i.kind === 'base');
      const target = pickNearest(candidates, p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE));
      if (!target) return false;
      this.selectPickable(target, p.x, p.y);
      return true;
    });
  }

  // ダブルクリック位置の最寄りの被選択物へフォーカスを移し、自艦であれば操作対象にも切り替える。
  // 種別を問わず候補列全体から探す。ラベル衝突で非表示になった天体は、表示されている別のラベルの
  // 背後から拾わない。
  handleDoubleClick(input: Input): void {
    input.takeDoubleClicks((p) => {
      const target = pickNearest(
        this.items.filter((item) => item.pickable !== false),
        p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE),
      );
      if (!target) return false;
      this.game.frameControls.setFocus({ kind: 'object', id: target.id });
      this.hud.hint(`${target.name} にフォーカス`);
      if (target.kind === 'player') {
        const ship = this.entities.findPlayer(target.id);
        if (ship) {
          this.game.activePlayers.set(ship);
          this.hud.hint(`${target.name} を操作対象に設定`);
        }
      }
      return true;
    });
  }

  // 単クリックは選択までに留める: 自艦はプロパティウィンドウを開くだけで操作対象は変えず、
  // 基地も selectBase のみ呼んでドックビューへは遷移しない。取り消せない操作は明示の項目
  // (プロパティウィンドウ)かダブルクリックに限る。
  private selectPickable(target: MapPickable, clientX: number, clientY: number): void {
    this.objectListPanel.select(target.id);
    if (target.kind === 'player') {
      this.openPropertyWindow(clientX, clientY, target, this.lastSimTime);
    } else if (target.kind === 'base') {
      const base = this.entities.findBase(target.id);
      if (!base) return;
      this.docking?.selectBase(base);
      this.hud.hint(`${target.name} を選択`);
    }
  }

  // 何も当たらなかった場合、「空域」として扱う（他のハンドラの後に呼ぶ）。マップ・戦闘の
  // どちらの右クリックも空振りしたら最終的にここへ落ちる — 実装は1つだけ持つ(openEmptySpaceMenu)。
  handleEmptySpaceRightClick(input: Input, simTime: number): void {
    input.takeRightClicks((p) => {
      this.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  private openEmptySpaceMenu(clientX: number, clientY: number, simTime: number): void {
    const target: MapPickable = { id: 'empty', name: '宇宙空間', pos: v3(0, 0, 0), kind: 'empty-space' };
    this.menu.open(clientX, clientY, target, this.itemsFor(target, simTime));
  }

  // 戦闘ビューの右クリック。マップと同じ被選択物の仕組みで敵・自艦を拾い、当たれば同じ
  // プロパティウィンドウを開く(同じ対象は常に同じ窓 — §7-2)。外れれば空域メニューへ落ちる。
  handleCombatRightClick(
    input: Input, targets: readonly CombatTarget[], project: ProjectFn, simTime: number,
  ): void {
    input.takeRightClicks((p) => {
      const picked = this.game.targeter.pickTargetAt(p, targets, project);
      if (picked) this.openPropertyWindow(p.x, p.y, this.combatTargetPickable(picked), simTime);
      else this.openEmptySpaceMenu(p.x, p.y, simTime);
      return true;
    });
  }

  // CombatTarget(Enemy | Player)を、対応する MapPickable の kind へ変換する。
  private combatTargetPickable(target: CombatTarget): MapPickable {
    const kind = target instanceof Player ? 'player' : 'ship';
    return { id: target.id, name: target.name, pos: target.state.r, kind };
  }

  // 軌道オブジェクトウィンドウをマップ視点である間は常設で表示し、開いている全プロパティ
  // ウィンドウの値を最新化する。対象そのものが消滅していれば(撃破・回収・削除)閉じる —
  // 未来ゴースト時刻で位置が求まらないだけのフレーム(displayState が null)は候補列
  // (this.items)から外れるだけで消滅ではないので、生存判定は対象の alive で行う。
  sync(simTime: number, attractors: readonly Attractor[], player: Player | null): void {
    const overviewMode = this.cameraSystem.overviewMode;
    this.objectListPanel.setVisible(overviewMode);
    // マップを離れると ViewManager.closeMap() が開いているウィンドウを閉じる。
    // 戦闘中は候補列を更新せず、ウィンドウもないため、毎フレームの Map 生成と行導出を省く。
    if (!overviewMode && this.windows.size === 0) return;
    if (overviewMode) {
      // ラグランジュ点は自分を持つ天体(衛星ならその衛星自身)、それ以外の天体は主星/主天体を
      // 親とする — 親が無ければ(恒星、もしくは主天体が未登録)undefined のままにして根として扱う。
      const registry = this.ephemeris.registry;
      const parentOf = new Map<string, string>();
      for (const l of this.cameraSystem.focusMarkers.allLabels) {
        const parent = l.isLagrange ? lagrangeParentId(l.id) : primaryOf(registry, l.id);
        if (parent !== null) parentOf.set(l.id, parent);
      }
      this.objectListPanel.sync(this.items, focusTargetId(this.cameraSystem.overviewCamera.focus), parentOf);
    }

    const byKey = new Map(this.items.map((i) => [this.windowKey(i), i]));
    for (const [key, entry] of [...this.windows]) {
      if (this.isTargetGone(entry.target)) { this.closeWindow(key); continue; }
      // 候補列に載っていれば最新の位置を反映し、載っていなければ開いた時点の対象のまま
      // 据え置く(rows の導出はどの種別も実体の state を直接読むので、位置の鮮度は無関係)。
      entry.target = byKey.get(key) ?? entry.target;
      const { title, subtitle, items } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRows(this.buildRows(entry.target, attractors, player, simTime));
      entry.win.syncItems(items);
    }
  }

  // 負荷確認ウィンドウが読む、マップ視点かどうかとその候補列/ラベル数。
  perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'> {
    const overviewMode = this.cameraSystem.overviewMode;
    return {
      mapMode: overviewMode,
      mapItems: overviewMode ? this.items.length : 0,
      mapLabels: overviewMode ? this.cameraSystem.focusMarkers.shownLabelCount : 0,
    };
  }

  // ウィンドウの対象そのものが消滅したかどうか。生きている実体を指す種別は alive を直接見て、
  // 未来ゴースト時刻で位置が求まらないだけの休止フレームでは閉じないようにする。それ以外の
  // 種別(天体・アプシス・AN/DN)は実体を持たないので、候補列に載っているかで判定する。
  private isTargetGone(target: MapPickable): boolean {
    switch (target.kind) {
      case 'player': return this.entities.findPlayer(target.id) === undefined;
      case 'ship': return !(this.entities.findEnemy(target.id)?.alive ?? false);
      case 'ammo': return !(this.entities.ammos.find((a) => a.id === target.id)?.alive ?? false);
      case 'base': return !(this.entities.findBase(target.id)?.alive ?? false);
      default: return !this.items.some((i) => this.windowKey(i) === this.windowKey(target));
    }
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
  }

  private readonly handlers: Record<MapPickable['kind'], PickHandler> = {
    'body': {
      itemsFor: (target, simTime) => {
        const registry = this.ephemeris.registry;
        let subLabel = '天体・ラグランジュ点';
        const lagrangeMatch = target.id.match(/^(.+)-l[1-5]$/);
        if (lagrangeMatch) {
          const secondary = lagrangeMatch[1]!;
          const primary = primaryOf(registry, secondary);
          subLabel = primary === null
            ? 'ラグランジュ点'
            : `${celestialBodyName(primary)}-${celestialBodyName(secondary)} ラグランジュ点`;
        } else if (target.id === this.ephemeris.originId) subLabel = '母星 (中心天体)';
        else if (target.id === 'moon') subLabel = '衛星 (月)';
        else if (target.id === this.ephemeris.starId) subLabel = `恒星 (${target.name})`;
        return [
          { type: 'header', label: target.name, subLabel },
          MenuCommon.focus(),
          ...this.navTargetItems(target, simTime),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runBodyShip(act, target),
    },
    'ship': {
      itemsFor: (target, simTime) => [
        ...this.combatTargetLockItems(this.entities.findEnemy(target.id)),
        MenuCommon.focus(),
        ...this.navTargetItems(target, simTime),
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const enemy = this.entities.findEnemy(target.id);
          if (enemy) enemy.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else if (act === 'targetPrimary' || act === 'targetSecondary') {
          this.runTargetLock(act, this.entities.findEnemy(target.id));
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'ammo': {
      itemsFor: (target, simTime) => [
        MenuCommon.focus(),
        ...this.navTargetItems(target, simTime),
        ...this.duplicateItems(),
        { label: '削除', act: 'delete' },
        MenuCommon.cancel(),
      ],
      run: (act, target) => {
        if (act === 'delete') {
          const ammo = this.entities.ammos.find(a => a.id === target.id);
          if (ammo) ammo.alive = false;
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'apsis': {
      itemsFor: (target, simTime) => {
        const apsisTime = target.time;
        const apsisLabel = target.id === 'apsisAp' ? '遠点 (Ap)' : '近点 (Pe)';
        const apsisSubLabel = apsisTime !== undefined ? `到達まで T+${fmtTime(apsisTime - simTime)}` : undefined;
        return [
          { type: 'header', label: apsisLabel, subLabel: apsisSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'relnode': {
      itemsFor: (target, simTime) => {
        const relTime = target.time;
        const relLabel = target.id === 'nav-an' ? '昇交点 (AN)' : '降交点 (DN)';
        const targetName = this.navTarget.name ?? '対象';
        const relSubLabel = `対 ${targetName}面` + (relTime !== undefined ? ` / T+${fmtTime(relTime - simTime)}` : '');
        return [
          { type: 'header', label: relLabel, subLabel: relSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'eqnode': {
      itemsFor: (target, simTime) => {
        const eqTime = target.time;
        const isAn = target.id.endsWith('-eqan');
        const centerName = celestialBodyName(strongestAttractor(target.pos, this.ephemeris.attractorsAt(simTime)).id);
        const eqLabel = `${centerName}赤道${isAn ? '昇' : '降'}交点 (${isAn ? 'EqAN' : 'EqDN'})`;
        const eqSubLabel = eqTime !== undefined ? `到達まで T+${fmtTime(eqTime - simTime)}` : undefined;
        return [
          { type: 'header', label: eqLabel, subLabel: eqSubLabel },
          MenuCommon.warp(),
          MenuCommon.addNode(),
          MenuCommon.focus(),
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => this.runApsisRelnode(act, target),
    },
    'player': {
      itemsFor: (target, simTime) => {
        const ship = this.entities.findPlayer(target.id);
        const isActive = ship === this.game.player;
        const activate: readonly MenuItem<MenuAction>[] = [
          isActive ? { label: '操作対象を解除', act: 'deactivate' } : { label: '操作対象にする', act: 'activate' },
        ];
        const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
        // 計画を実行するステージだけに出す。駆動源が無いところで選ばせても何も起きない。
        const mode = ship?.planExecution ?? 'off';
        const planExec: readonly MenuItem<MenuAction>[] = this.game.activeStage.executesPlans
          ? [{ label: `軌道計画の実行: ${planExecutionLabel(mode)}`, act: 'planExecCycle', keepOpen: true }]
          : [];
        return [
          ...this.combatTargetLockItems(ship),
          ...planExec,
          ...activate,
          MenuCommon.focus(),
          ...this.navTargetItems(target, simTime),
          ...this.duplicateItems(),
          ...remove,
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        if (act === 'activate') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) this.game.activePlayers.set(ship);
        } else if (act === 'deactivate') {
          if (this.entities.findPlayer(target.id) === this.game.player) this.game.activePlayers.setOrNull(null);
        } else if (act === 'planExecCycle') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) {
            const next = PLAN_EXECUTION_MODES[(PLAN_EXECUTION_MODES.indexOf(ship.planExecution) + 1) % PLAN_EXECUTION_MODES.length]!;
            ship.planExecution = next;
          }
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else if (act === 'delete') {
          const ship = this.entities.findPlayer(target.id);
          if (ship) this.game.activePlayers.remove(ship);
        } else if (act === 'targetPrimary' || act === 'targetSecondary') {
          this.runTargetLock(act, this.entities.findPlayer(target.id));
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'empty-space': {
      itemsFor: () => {
        const placeItem: readonly MenuItem<MenuAction>[] = this.game.activeStage.authoring
          ? [{ label: 'オブジェクトを配置する', act: 'openShipPlacer', shortcut: 'Enter' }]
          : [];
        return [
          ...placeItem,
          { label: '設定メニューを開く', act: 'openSettings' },
          MenuCommon.cancel(),
        ];
      },
      run: (act) => {
        if (act === 'openShipPlacer') {
          this.game.activeStage.authoring?.openShipPlacer(
            focusTargetId(this.game.cameraSystem.overviewCamera.focus));
        } else if (act === 'openSettings') {
          this.settingsPanel.toggle(true);
        }
      },
    },
    'base': {
      itemsFor: (target) => {
        const base = this.entities.findBase(target.id);
        const subLabel = base
          ? `基地 / 所持金: ${base.baseState.money.toLocaleString()} Cr / 格納船: ${base.baseState.dockedShips.length}隻`
          : '基地';
        return [
          { type: 'header', label: base?.name ?? target.name, subLabel },
          { label: 'ドックビューを開く', act: 'openDock' },
          MenuCommon.focus(),
          ...this.navTargetItems(target, 0),
          ...this.duplicateItems(),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const base = this.entities.findBase(target.id);
        if (act === 'delete') {
          if (base) {
            this.docking?.clearActiveBaseIf(base);
            base.alive = false;
          }
        } else if (act === 'openDock') {
          if (base) this.docking?.activate(base);
          else this.hud.hint('基地が見つかりません');
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
  };

  // 被選択物の種別に応じたコンテキストメニュー項目。
  private itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    const handler = this.handlers[target.kind];
    return handler ? handler.itemsFor(target, simTime) : [];
  }

  // 対象を航法ターゲットにする/解除する項目。軌道面が定まらない対象(地球・太陽自身など)
  // では選んでも AN/DN が出ないので項目自体を出さない。
  private navTargetItems(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[] {
    if (target.id === this.navTarget.id) return [MenuCommon.navTarget(true)];
    const canTarget = this.navTarget.canTarget(target.id, this.entities, this.ephemeris, simTime);
    return canTarget ? [MenuCommon.navTarget(false)] : [];
  }

  // 「複製」項目。複製先が艦艇配置パネルなので、それを持つステージだけに出す。
  private duplicateItems(): readonly MenuItem<MenuAction>[] {
    return this.game.activeStage.authoring ? [MenuCommon.duplicate()] : [];
  }

  // ターゲット固定/第二ターゲット固定の項目。戦闘ターゲットとして戦える対象(生存中の
  // 敵・自艦)にだけ出し、マップビューでは出さない(視界占有を抑える — §7-2)。
  private combatTargetLockItems(entity: CombatTarget | null | undefined): readonly MenuItem<MenuAction>[] {
    if (this.cameraSystem.overviewMode || !entity || !entity.alive) return [];
    const targeter = this.game.targeter;
    return [
      MenuCommon.targetPrimary(targeter.target === entity),
      MenuCommon.targetSecondary(targeter.secondaryTarget === entity),
    ];
  }

  // ターゲット固定/第二ターゲット固定を、押した時点の設定と比べてトグルする。
  private runTargetLock(act: 'targetPrimary' | 'targetSecondary', entity: CombatTarget | null | undefined): void {
    if (!entity) return;
    const targeter = this.game.targeter;
    if (act === 'targetPrimary') targeter.setPrimaryTarget(targeter.target === entity ? null : entity);
    else targeter.setSecondaryTarget(targeter.secondaryTarget === entity ? null : entity);
  }

  // 対象の現在状態を軌道要素へ逆算し、その値をプリセットして艦艇配置パネルを開く。
  private runDuplicate(target: MapPickable): void {
    const authoring = this.game.activeStage.authoring;
    if (!authoring) return;
    const source = this.duplicateSourceFor(target);
    if (!source) return;
    authoring.openShipPlacerForDuplicate(source.objectType, source.state);
  }

  // MapPickable を、複製できる実体の種類とその現在状態へ解決する。複製できない種別(天体・
  // 近点/遠点アイコン・相対AN/DN)ではメニュー自体を出していないので、ここに到達しない。
  private duplicateSourceFor(target: MapPickable): { objectType: ObjectType; state: KinematicState } | null {
    switch (target.kind) {
      case 'player': {
        const ship = this.entities.findPlayer(target.id);
        return ship ? { objectType: 'player', state: ship.state } : null;
      }
      case 'ship': {
        const enemy = this.entities.findEnemy(target.id);
        return enemy ? { objectType: 'enemy', state: enemy.state } : null;
      }
      case 'ammo': {
        const ammo = this.entities.ammos.find((a) => a.id === target.id);
        return ammo ? { objectType: 'ammo', state: ammo.state } : null;
      }
      case 'base': {
        const base = this.entities.findBase(target.id);
        return base ? { objectType: 'base', state: base.state } : null;
      }
      default:
        return null;
    }
  }

  // itemsFor の出力をプロパティウィンドウの形へ組み替える: header 項目はタイトル/サブタイトルへ
  // 抜き出す。開いた直後から sync 時と同じ経路(windowParts)で求める。
  private buildContent(target: MapPickable, simTime: number): PropertyWindowContent<MenuAction> {
    const { title, subtitle, items } = this.windowParts(target, simTime);
    return { title, subtitle, rows: [], items, onRename: this.renameHandlerFor(target) };
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
    const all = this.itemsFor(target, simTime);
    const header = all.find((it) => it.type === 'header');
    const items = all
      .filter((it) => it.type !== 'header' && it.act !== undefined)
      .map((it) => ({ label: it.label, act: it.act as MenuAction, shortcut: it.shortcut, selected: it.selected, keepOpen: it.keepOpen }));
    return { title: header?.label ?? target.name, subtitle: header?.subLabel, items };
  }

  // 種別ごとのプロパティ行。値の導出は sync フェーズで毎フレーム呼び直す(表示専用のため)。
  private buildRows(
    target: MapPickable, attractors: readonly Attractor[], player: Player | null, simTime: number,
  ): PropertyRow[] {
    switch (target.kind) {
      case 'player': return this.playerRows(target, attractors);
      case 'ship': return this.shipRows(target, attractors, player);
      case 'base': return this.baseRows(target, attractors, player);
      case 'ammo': return this.ammoRows(target, attractors, player);
      case 'body': return this.bodyRows(target, attractors, player);
      case 'apsis': return this.apsisRows(target, attractors, simTime);
      case 'relnode': case 'eqnode': return this.nodeRows(target, attractors, simTime);
      case 'empty-space': return [];
    }
  }

  // 基準天体・高度・速度・AP/PE/INC/PRD の軌道要素一式。ship/base/ammo/player 共通で使う。
  // 「軌道」グループにまとめ、ウィンドウ先頭の折り畳みセクションへ描かれる。
  private orbitRows(entity: GameEntity, attractors: readonly Attractor[]): PropertyRow[] {
    const oi = orbitInfo(entity, attractors);
    const group = '軌道';
    return [
      { key: 'center', label: '基準天体', value: oi.centerName, group },
      { key: 'alt', label: '高度', value: fmtDist(oi.alt), group },
      { key: 'spd', label: '速度', value: fmtSpeed(oi.spd), group },
      { key: 'ap', label: '遠地点 AP', value: fmtDist(oi.apAlt), group },
      { key: 'pe', label: '近地点 PE', value: fmtDist(oi.peAlt), group },
      {
        key: 'inc', label: '傾斜角 INC',
        value: isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---', group,
      },
      { key: 'prd', label: '周期 PRD', value: fmtTime(oi.period), group },
    ];
  }

  // 名前は既にウィンドウのタイトルにあるので行には含めない。装甲・電力・弾薬を主要行とし、
  // それ以外(操作対象か・計画追従)は詳細トグル、軌道要素は「軌道」グループの下に畳む。
  private playerRows(target: MapPickable, attractors: readonly Attractor[]): PropertyRow[] {
    const ship = this.entities.findPlayer(target.id);
    if (!ship) return [];
    return [
      {
        key: 'operated', label: '操作対象か', value: ship === this.game.player ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(ship.planExecution), collapsible: true },
      { key: 'hp', label: '装甲', value: `${Math.floor(ship.hp)} / ${ship.maxHp}` },
      { key: 'temp', label: '温度', value: `${ship.thermal.hullTemp.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(ship.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(ship.roundsInMag, ship.magsLeft, ship.reloadTimer) },
      ...this.orbitRows(ship, attractors),
    ];
  }

  // 自艦がいなければ距離・接近速度・相対速度・相対傾斜角の行はそもそも出さない。
  // 装甲・距離・接近速度を主要行とし、相対速度は詳細トグル、軌道要素・相対傾斜角は「軌道」グループの下に畳む。
  private shipRows(target: MapPickable, attractors: readonly Attractor[], player: Player | null): PropertyRow[] {
    const enemy = this.entities.findEnemy(target.id);
    if (!enemy) return [];
    const rel = player ? relativeInfo(player, enemy, attractors) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(enemy.hp)} / ${enemy.maxHp}` }];
    if (rel) {
      rows.push(
        { key: 'dist', label: '距離', value: fmtDist(rel.dist) },
        { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
        { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), collapsible: true },
      );
    }
    rows.push(...this.orbitRows(enemy, attractors));
    if (rel) {
      rows.push({
        key: 'relinc', label: '相対傾斜 [AN/DN]',
        value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道',
      });
    }
    return rows;
  }

  // 自艦がいなければ距離の行は出さない。軌道要素は「軌道」グループの下に畳む。
  private baseRows(target: MapPickable, attractors: readonly Attractor[], player: Player | null): PropertyRow[] {
    const base = this.entities.findBase(target.id);
    if (!base) return [];
    const rows: PropertyRow[] = [
      { key: 'money', label: '所持金', value: `${base.baseState.money.toLocaleString()} Cr` },
      { key: 'ships', label: '格納艦数', value: `${base.baseState.dockedShips.length}` },
    ];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(base.state.r, player.state.r))) });
    rows.push(...this.orbitRows(base, attractors));
    return rows;
  }

  // 自艦がいなければ距離の行は出さない。軌道要素は「軌道」グループの下に畳む。
  private ammoRows(target: MapPickable, attractors: readonly Attractor[], player: Player | null): PropertyRow[] {
    const ammo = this.entities.ammos.find((a) => a.id === target.id);
    if (!ammo) return [];
    const rows: PropertyRow[] = [];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(ammo.state.r, player.state.r))) });
    rows.push(...this.orbitRows(ammo, attractors));
    return rows;
  }

  // 実在の天体(現在のレジストリに登録された ID)なら種別・μ・半径・(公転していれば)軌道要素を、
  // ラグランジュ点なら種別のみを出す。
  private bodyRows(target: MapPickable, attractors: readonly Attractor[], player: Player | null): PropertyRow[] {
    const registry = this.ephemeris.registry;
    const rows: PropertyRow[] = [];
    if (player) rows.push({ key: 'dist', label: '自艦からの距離', value: fmtDist(len(sub(target.pos, player.state.r))) });
    if (!(target.id in registry)) {
      rows.push({ key: 'kind', label: '種別', value: 'ラグランジュ点' });
      return rows;
    }
    const def = bodyDef(registry, target.id);
    const kindLabel = def.kind === 'star' ? '恒星' : def.kind === 'planet' ? '惑星' : '衛星';
    rows.push(
      { key: 'kind', label: '種別', value: kindLabel },
      { key: 'mu', label: 'μ', value: `${def.mu.toExponential(3)} m³/s²` },
      { key: 'radius', label: '半径', value: fmtDist(def.radius) },
    );
    if (def.kind === 'star') return rows;
    const primary = attractors.find((b) => b.id === primaryOf(registry, def.id));
    const self = attractors.find((b) => b.id === def.id);
    const el = primary && self ? orbitalElementsOf(self.state, primary) : null;
    if (!el) return rows;
    const apsis = apsisAltitudes(el);
    rows.push(
      { key: 'ap', label: '遠地点 AP', value: fmtDist(apsis.ap), group: '軌道' },
      { key: 'pe', label: '近地点 PE', value: fmtDist(apsis.pe), group: '軌道' },
      { key: 'inc', label: '傾斜角 INC', value: `${el.incDeg.toFixed(2)}°`, group: '軌道' },
      { key: 'prd', label: '周期 PRD', value: fmtTime(el.period), group: '軌道' },
    );
    return rows;
  }

  // Pe/Ap の別・AN/DN の別はタイトル側(header)に既に出ているので、ここには乗せない。
  private apsisRows(target: MapPickable, attractors: readonly Attractor[], simTime: number): PropertyRow[] {
    const center = strongestAttractor(target.pos, attractors);
    const alt = len(sub(target.pos, center.state.r)) - center.radius;
    const rows: PropertyRow[] = [{ key: 'alt', label: '高度', value: fmtDist(alt) }];
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  // AN/DN の別はタイトル側(header)に既に出ているので、ここでは対象名と通過時刻のみ出す。
  private nodeRows(target: MapPickable, attractors: readonly Attractor[], simTime: number): PropertyRow[] {
    const targetName = target.kind === 'relnode'
      ? (this.navTarget.name ?? '対象')
      : celestialBodyName(strongestAttractor(target.pos, attractors).id);
    const rows: PropertyRow[] = [{ key: 'target', label: '対象', value: targetName }];
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  private runBodyShip(act: MenuAction, target: MapPickable): void {
    if (act === 'focus') {
      this.game.frameControls.setFocus({ kind: 'object', id: target.id });
      this.hud.hint(`${target.name} にフォーカス`);
    } else if (act === 'navTarget') {
      this.navTarget.toggleTarget(target.id, target.name);
    }
  }

  private runApsisRelnode(act: MenuAction, target: MapPickable): void {
    if (act === 'warp') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null && !this.simSpeedManager.startAutoWarpTo(t, this.game.simTime)) {
        this.hud.hint('この時刻は既に通過しています');
      }
    } else if (act === 'addNode') {
      const t = target.time ?? (target.kind === 'apsis'
        ? this.editor.planDisplay.apsisTimeOf(target.id)
        : this.navTarget.passTimeOf(target.id));
      if (t !== null) this.editor.addNodeAt(t);
      else this.hud.hint('この時刻の計画軌道が求まりません');
    } else {
      this.runBodyShip(act, target);
    }
  }
}
