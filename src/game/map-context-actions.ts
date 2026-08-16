// 被選択物(MapPickable)への右クリック/左クリック/ダブルクリックの解決、種別ごとの
// メニュー項目・プロパティウィンドウの構築、選ばれた操作の各所有者への配分。候補集合と
// 表示可否は map-pickables.ts の MapPickables から読む — 「何が選べるか」と「選んだら
// どうなるか」を分けている。
import { Hud } from './hud/hud';
import { Base } from './game-entity/base';
import { fmtAmmoStatus, fmtDist, fmtEnergy, fmtSpeed, fmtTime } from './hud/utils';
import { orbitInfo, relativeInfo } from './hud/orbit-info';
import { ContextMenu, MenuItem } from './hud/context-menu';
import { PropertyRow, PropertyWindow, PropertyWindowContent, PropertyWindowItem } from './hud/property-window';
import { MenuAction, MenuCommon } from './hud/menu-actions';
import { celestialBodyName } from './hud/frame-labels';
import { lagrangeParentId } from './hud/object-groups';
import { MapPickable, pickNearest } from './map-pickable';
import { focusTargetId } from './camera/focus-target';
import { ObjectListPanel } from './hud/object-list-panel';
import type { Input } from './input/input';
import { pickRadiusSq } from './input/pointer-precision';
import { EntityManager } from './simulation/entity-manager';
import { Ephemeris } from '../physics/ephemeris';
import { NavTarget } from './nav-target';
import { CameraSystem } from './camera/camera-system';
import { PlanEditor } from './plan/plan-editor';
import { SimSpeedManager } from './sim-speed-manager';
import type { PauseMenu } from './hud/pause-menu';
import { Targeter, type CombatTarget } from './targeter';
import type { Docking } from './docking';
import type { ActivePlayerController } from './active-player-controller';
import type { FrameControls } from './hud/frame-controls';
import type { Stage } from './stages/stage';
import { Player, planExecutionLabel, type PlanExecutionMode } from './player/player';
import type { GameEntity } from './game-entity/game-entity';
import { add, cross, len, norm, scale, sub, v3 } from '../physics/vec3';
import { metersPerPixel } from '../physics/projection';
import type { ObjectType } from './creative/object-placer-panel';
import type { KinematicState } from '../physics/kinematic-state';
import { Attractor, orbitalElementsOf, strongestAttractor } from '../physics/attractor';
import { apsisAltitudes } from '../physics/elements';
import { bodyDef, primaryOf } from '../physics/solar-system';
import * as C from './const';
import type { MapPickables } from './map-pickables';

interface PickHandler {
  itemsFor(target: MapPickable, simTime: number): readonly MenuItem<MenuAction>[];
  run(act: MenuAction, target: MapPickable): void;
}

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

export class MapContextActions {
  // 'empty-space' は宇宙空間そのものでプロパティを持たないので、従来どおり ContextMenu を使う。
  private readonly menu: ContextMenu<MapPickable, MenuAction>;
  // 開いているプロパティウィンドウ。`${kind}:${id}` でオブジェクト1つにつき高々1枚に保つ
  // (一時ウィンドウの排他自体は OverlayManager が持つ — ここは対象との対応づけのみ)。
  private readonly windows = new Map<string, WindowEntry>();
  private readonly objectListPanel: ObjectListPanel;

  // Docking は MapContextActions より後に生成されるので、生成後に登録する。
  setDocking(docking: Docking): void { this.docking = docking; }
  private docking: Docking | null = null;

  setControlledBaseHandler(handler: (base: Base | null) => void, getControlledBase: () => Base | null): void {
    this.controlBaseHandler = handler;
    this.getControlledBase = getControlledBase;
  }
  private controlBaseHandler: ((base: Base | null) => void) | null = null;
  private getControlledBase: (() => Base | null) | null = null;

  // 候補集合(pickables)と、メニュー項目の実行先を参照として受け取る。
  constructor(
    private readonly hud: Hud,
    private readonly entities: EntityManager,
    private readonly ephemeris: Ephemeris,
    private readonly navTarget: NavTarget,
    private readonly cameraSystem: CameraSystem,
    private readonly editor: PlanEditor,
    private readonly simSpeedManager: SimSpeedManager,
    private readonly pauseMenu: PauseMenu,
    private readonly pickables: MapPickables,
    private readonly activePlayers: ActivePlayerController,
    private readonly frameControls: FrameControls,
    private readonly activeStage: Stage,
    private readonly targeter: Targeter,
  ) {
    this.menu = new ContextMenu<MapPickable, MenuAction>(hud.layers.popup, hud.overlayManager);
    this.menu.onSelect = (act, target) => {
      const handler = this.handlers[target.kind];
      if (handler) handler.run(act, target);
    };
    this.objectListPanel = new ObjectListPanel(hud.mapRoot, ephemeris.registry);
    this.objectListPanel.onSelect = (id) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target) this.objectListPanel.select(id);
    };
    this.objectListPanel.onFocus = (id) => {
      this.frameControls.setFocus({ kind: 'object', id });
      this.hud.hint(`${this.pickables.pickables.find((i) => i.id === id)?.name ?? id} にフォーカス`);
    };
    this.objectListPanel.onNavTarget = (id) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target && this.navTarget.canTarget(id, this.entities, this.ephemeris, this.pickables.lastSimTime)) {
        this.navTarget.toggleTarget(id, target.name);
      }
    };
    this.objectListPanel.onSelectRight = (id, clientX, clientY) => {
      const target = this.pickables.pickables.find((i) => i.id === id);
      if (target) this.openPropertyWindow(clientX, clientY, target, this.pickables.lastSimTime);
    };
  }

  // 右クリック位置の最寄りの被選択物(天体・自艦・他艦・ノード等)のプロパティウィンドウを開く。
  // 当たらなければ消費せず、handleEmptySpaceRightClick へ読み進める。
  // ラベル衝突で非表示になった天体は、表示されている別のラベルの背後から拾わない。
  handleMapRightClick(input: Input, simTime: number): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeRightClicks((p) => {
      const target = pickNearest(
        this.pickables.pickables, p.x, p.y, this.cameraSystem.activeCameraProjection,
        pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE),
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
  // マーカーへの命中をノード配置より優先する)。マップ視点でなければ何もしない。
  handleLeftClick(input: Input): void {
    if (!this.cameraSystem.overviewMode) return;
    input.takeClicks((p) => {
      const candidates = this.pickables.pickables.filter((i) => i.kind === 'player' || i.kind === 'base');
      const target = pickNearest(candidates, p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE));
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
        p.x, p.y, this.cameraSystem.activeCameraProjection, pickRadiusSq(C.MAP_PICK_PX_SQ, C.MAP_PICK_PX_SQ_COARSE),
      );
      if (!target) return false;
      this.frameControls.setFocus({ kind: 'object', id: target.id });
      this.hud.hint(`${target.name} にフォーカス`);
      if (target.kind === 'player') {
        const ship = this.entities.findPlayer(target.id);
        if (ship) {
          this.activePlayers.set(ship);
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
    this.menu.open(clientX, clientY, target, this.itemsFor(target, simTime));
  }

  // 戦闘ビューの右クリック。カメラの視点・画角・実体サイズ(Base 100m / Enemy 90m / Player 5m)から
  // 画面上の視覚半径を正確に求め、機体・基地の表示領域へのヒット判定を行う。
  // ヒットしなかった場合(背景・空域)は空域設定メニューを開く。
  handleCombatRightClick(
    input: Input, simTime: number, overviewMode: boolean,
  ): void {
    if (overviewMode) return;
    input.takeRightClicks((p) => {
      const hitEntity = this.pickCombatEntityAtPoint(p.x, p.y);
      if (hitEntity) {
        this.openPropertyWindow(p.x, p.y, this.entityToPickable(hitEntity), simTime);
      } else {
        this.openEmptySpaceMenu(p.x, p.y, simTime);
      }
      return true;
    });
  }

  // 画面上の右クリック座標(clientX, clientY)において、実体の 3D モデル表示領域にヒットした GameEntity を返す
  private pickCombatEntityAtPoint(clientX: number, clientY: number): GameEntity | null {
    const view = this.cameraSystem.activeViewpoint;
    const project = this.cameraSystem.activeCameraProjection;
    const viewportHeight = window.innerHeight;

    const candidates: { entity: GameEntity; radius: number }[] = [
      ...this.entities.players.filter((p) => p.alive).map((p) => ({ entity: p, radius: p.radius || 5 })),
      ...this.entities.enemies.filter((e) => e.alive).map((e) => ({ entity: e, radius: e.radius || 90 })),
      ...this.entities.bases.filter((b) => b.alive).map((b) => ({ entity: b, radius: b.radius || 100 })),
    ];

    let bestEntity: GameEntity | null = null;
    let minDepth = Infinity;

    for (const item of candidates) {
      const entity = item.entity;
      const pos = entity.state.r;
      const proj = project(pos);
      if (!proj.front) continue;

      const dx = clientX - proj.x;
      const dy = clientY - proj.y;
      const distSq = dx * dx + dy * dy;

      // カメラから対象までの視線奥行き距離
      const depth = len(sub(pos, view.position));

      // この距離における 1 ピクセルあたりの実距離 [m/px]
      const mpp = metersPerPixel(view, pos, viewportHeight);

      // 3D モデルの物理半径を画面上のピクセル半径へ投影
      // クリック操作の最小許容値として 12px、実サイズに基づく投影ピクセル半径を適用
      const visualRadiusPx = Math.max(12, item.radius / Math.max(1e-6, mpp));

      if (distSq <= visualRadiusPx * visualRadiusPx) {
        if (entity instanceof Base) {
          // 基地の場合は BVH メッシュRay判定による精緻なヒットテストを実施
          const camFwd = norm(sub(view.lookTarget, view.position));
          const camUp = norm(view.up);
          const camRight = norm(cross(camFwd, camUp));
          const offsetX = (clientX - window.innerWidth / 2) * mpp;
          const offsetY = -(clientY - window.innerHeight / 2) * mpp;
          const rayTarget = add(add(add(view.position, scale(camFwd, depth)), scale(camRight, offsetX)), scale(camUp, offsetY));
          const rayDir = norm(sub(rayTarget, view.position));
          const hit = entity.raycast(view.position, rayDir, depth * 2, 1);
          if (!hit) continue; // 実際のメッシュへの非命中の場合は判定を落とす
        }
        if (depth < minDepth) {
          minDepth = depth;
          bestEntity = entity;
        }
      }
    }

    return bestEntity;
  }

  private entityToPickable(entity: GameEntity): MapPickable {
    if (entity instanceof Player) {
      return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'player' };
    }
    if (entity instanceof Base) {
      return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'base' };
    }
    return { id: entity.id, name: entity.name, pos: entity.state.r, kind: 'ship' };
  }

  // 軌道オブジェクトウィンドウをマップ視点である間は常設で表示し、開いている全プロパティ
  // ウィンドウの値を最新化する。対象そのものが消滅していれば(撃破・回収・削除)閉じる —
  // 未来ゴースト時刻で位置が求まらないだけのフレーム(displayState が null)は候補列
  // (pickables.pickables)から外れるだけで消滅ではないので、生存判定は対象の alive で行う。
  sync(simTime: number, attractors: readonly Attractor[], player: Player | null): void {
    const overviewMode = this.cameraSystem.overviewMode;
    this.objectListPanel.setVisible(overviewMode);
    // マップを離れると ViewManager.closeMap() が開いているウィンドウを閉じる。
    // 戦闘中は候補列を更新せず、ウィンドウもないため、毎フレームの Map 生成と行導出を省く。
    if (!overviewMode && this.windows.size === 0) return;
    const items = this.pickables.pickables;
    if (overviewMode) {
      // ラグランジュ点は自分を持つ天体(衛星ならその衛星自身)、それ以外の天体は主星/主天体を
      // 親とする — 親が無ければ(恒星、もしくは主天体が未登録)undefined のままにして根として扱う。
      const registry = this.ephemeris.registry;
      const parentOf = new Map<string, string>();
      for (const l of this.cameraSystem.focusMarkers.allLabels) {
        const parent = l.isLagrange ? lagrangeParentId(l.id) : primaryOf(registry, l.id);
        if (parent !== null) parentOf.set(l.id, parent);
      }
      this.objectListPanel.sync(items, focusTargetId(this.cameraSystem.mapCamera.focus), parentOf);
    }

    const byKey = new Map(items.map((i) => [this.windowKey(i), i]));
    for (const [key, entry] of [...this.windows]) {
      if (this.isTargetGone(entry.target)) { this.closeWindow(key); continue; }
      // 候補列に載っていれば最新の位置を反映し、載っていなければ開いた時点の対象のまま
      // 据え置く(rows の導出はどの種別も実体の state を直接読むので、位置の鮮度は無関係)。
      entry.target = byKey.get(key) ?? entry.target;
      const { title, subtitle, items: menuItems } = this.windowParts(entry.target, simTime);
      entry.win.syncHeader(title, subtitle);
      entry.win.syncRows(this.buildRows(entry.target, attractors, player, simTime));
      entry.win.syncItems(menuItems);
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
      case 'base': return !(this.entities.findBase(target.id)?.alive ?? false);
      default: return !this.pickables.pickables.some((i) => this.windowKey(i) === this.windowKey(target));
    }
  }

  // 開いたままのメニュー・ウィンドウを畳む。マップビューを離れるときに呼ぶ。
  close(): void {
    this.menu.close();
    for (const key of [...this.windows.keys()]) this.closeWindow(key);
  }

  // 開いているメニュー・ウィンドウを畳んだうえで、常設の一覧パネルと自身のメニューを取り除く。
  dispose(): void {
    this.close();
    this.menu.dispose();
    this.objectListPanel.dispose();
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
          const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
          if (ammoPickup) ammoPickup.alive = false;
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
        const activeShip = this.activePlayers.current;
        const isActive = ship === activeShip;
        const activate: readonly MenuItem<MenuAction>[] = [
          isActive ? { label: '操作対象を解除', act: 'deactivate' } : { label: '操作対象にする', act: 'activate' },
        ];
        const remove: readonly MenuItem<MenuAction>[] = isActive ? [] : [{ label: '削除', act: 'delete' }];
        const mode = ship?.planExecution ?? 'off';
        const planExec: readonly MenuItem<MenuAction>[] = this.activeStage.executesPlans
          ? [{ label: `軌道計画の実行: ${planExecutionLabel(mode)}`, act: 'planExecCycle', keepOpen: true }]
          : [];

        const dockItems: MenuItem<MenuAction>[] = [];
        if (activeShip && ship && !isActive && this.docking) {
          const isDocked = this.docking.getDockedTarget(activeShip) === ship;
          if (isDocked) {
            dockItems.push(MenuCommon.transferResources(), MenuCommon.undock());
          } else if (this.docking.canDock(activeShip, ship)) {
            dockItems.push(MenuCommon.dock());
          }
        }

        return [
          ...this.combatTargetLockItems(ship),
          ...dockItems,
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
        const activeShip = this.activePlayers.current;
        const ship = this.entities.findPlayer(target.id);
        if (act === 'dock') {
          if (activeShip && ship) this.docking?.dockTo(activeShip, ship);
        } else if (act === 'undock') {
          if (activeShip) this.docking?.undock(activeShip);
        } else if (act === 'transferResources') {
          if (activeShip && ship) this.docking?.openTransfer(activeShip, ship);
        } else if (act === 'activate') {
          if (ship) this.activePlayers.set(ship);
        } else if (act === 'deactivate') {
          if (ship === this.activePlayers.current) this.activePlayers.setOrNull(null);
        } else if (act === 'planExecCycle') {
          if (ship) {
            const next = PLAN_EXECUTION_MODES[(PLAN_EXECUTION_MODES.indexOf(ship.planExecution) + 1) % PLAN_EXECUTION_MODES.length]!;
            ship.planExecution = next;
          }
        } else if (act === 'duplicate') {
          this.runDuplicate(target);
        } else if (act === 'delete') {
          if (ship) this.activePlayers.remove(ship);
        } else if (act === 'targetPrimary' || act === 'targetSecondary') {
          this.runTargetLock(act, ship);
        } else {
          this.runBodyShip(act, target);
        }
      },
    },
    'empty-space': {
      itemsFor: () => {
        const placeItem: readonly MenuItem<MenuAction>[] = this.activeStage.authoring && this.cameraSystem.overviewMode
          ? [{ label: 'オブジェクトを配置する', act: 'openObjectPlacer', shortcut: 'Enter' }]
          : [];
        return [
          ...placeItem,
          { label: '設定メニューを開く', act: 'openSettings' },
          MenuCommon.cancel(),
        ];
      },
      run: (act) => {
        if (act === 'openObjectPlacer') {
          this.activeStage.authoring?.openObjectPlacer(
            focusTargetId(this.cameraSystem.mapCamera.focus));
        } else if (act === 'openSettings') {
          this.pauseMenu.toggle(true);
        }
      },
    },
    'base': {
      itemsFor: (target) => {
        const base = this.entities.findBase(target.id);
        const activeShip = this.activePlayers.current;
        const isControlled = base && this.getControlledBase ? this.getControlledBase() === base : false;
        const subLabel = base
          ? `基地 / 所持金: ${base.baseState.money.toLocaleString()} Cr / 格納艦艇: ${base.baseState.dockedVessels.length}隻`
          : '基地';

        const dockItems: MenuItem<MenuAction>[] = [];
        if (activeShip && base && this.docking) {
          const isDocked = this.docking.getDockedTarget(activeShip) === base;
          if (isDocked) {
            dockItems.push(MenuCommon.transferResources(), MenuCommon.storeInBase(), MenuCommon.undock());
          } else if (this.docking.canDock(activeShip, base)) {
            dockItems.push(MenuCommon.dock());
          }
        }

        const controlItem: readonly MenuItem<MenuAction>[] = base
          ? [isControlled
            ? { label: '操作を解除', act: 'deactivateBase' }
            : { label: '基地を操作', act: 'activateBase' }]
          : [];

        return [
          { type: 'header', label: base?.name ?? target.name, subLabel },
          ...controlItem,
          ...dockItems,
          { label: '基地ビューを開く', act: 'openDock' },
          MenuCommon.focus(),
          ...this.navTargetItems(target, 0),
          ...this.duplicateItems(),
          { label: '削除', act: 'delete' },
          MenuCommon.cancel(),
        ];
      },
      run: (act, target) => {
        const base = this.entities.findBase(target.id);
        const activeShip = this.activePlayers.current;
        if (act === 'activateBase') {
          if (base && this.controlBaseHandler) this.controlBaseHandler(base);
        } else if (act === 'deactivateBase') {
          if (this.controlBaseHandler) this.controlBaseHandler(null);
        } else if (act === 'dock') {
          if (activeShip && base) this.docking?.dockTo(activeShip, base);
        } else if (act === 'undock') {
          if (activeShip) this.docking?.undock(activeShip);
        } else if (act === 'storeInBase') {
          if (activeShip && base) this.docking?.storeInBase(activeShip, base);
        } else if (act === 'transferResources') {
          if (activeShip && base) this.docking?.openTransfer(activeShip, base);
        } else if (act === 'delete') {
          if (base) {
            if (this.getControlledBase?.() === base) this.controlBaseHandler?.(null);
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
    return this.activeStage.authoring ? [MenuCommon.duplicate()] : [];
  }

  // ターゲット固定/第二ターゲット固定の項目。戦闘ターゲットとして戦える対象(生存中の
  // 敵・自艦)にだけ出し、マップビューでは出さない(視界占有を抑える — §7-2)。
  private combatTargetLockItems(entity: CombatTarget | null | undefined): readonly MenuItem<MenuAction>[] {
    if (this.cameraSystem.overviewMode || !entity || !entity.alive) return [];
    const targeter = this.targeter;
    return [
      MenuCommon.targetPrimary(targeter.target === entity),
      MenuCommon.targetSecondary(targeter.secondaryTarget === entity),
    ];
  }

  // ターゲット固定/第二ターゲット固定を、押した時点の設定と比べてトグルする。
  private runTargetLock(act: 'targetPrimary' | 'targetSecondary', entity: CombatTarget | null | undefined): void {
    if (!entity) return;
    const targeter = this.targeter;
    if (act === 'targetPrimary') targeter.setPrimaryTarget(targeter.target === entity ? null : entity);
    else targeter.setSecondaryTarget(targeter.secondaryTarget === entity ? null : entity);
  }

  // 対象の現在状態を軌道要素へ逆算し、その値をプリセットして艦艇配置パネルを開く。
  private runDuplicate(target: MapPickable): void {
    const authoring = this.activeStage.authoring;
    if (!authoring) return;
    const source = this.duplicateSourceFor(target);
    if (!source) return;
    authoring.openObjectPlacerForDuplicate(source.objectType, source.state);
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
        const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
        return ammoPickup ? { objectType: 'ammo', state: ammoPickup.state } : null;
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
    const subtitle = target.ownerName ? `所属: ${target.ownerName}` : header?.subLabel;
    return { title: header?.label ?? target.name, subtitle, items };
  }

  // 種別ごとのプロパティ行。値の導出は sync フェーズで毎フレーム呼び直す(表示専用のため)。
  private buildRows(
    target: MapPickable, attractors: readonly Attractor[], player: Player | null, simTime: number,
  ): PropertyRow[] {
    switch (target.kind) {
      case 'player': return this.playerRows(target, attractors);
      case 'ship': return this.shipRows(target, attractors, player);
      case 'base': return this.baseRows(target, attractors, player);
      case 'ammo': return this.ammoPickupRows(target, attractors, player);
      case 'body': return this.bodyRows(target, attractors, player);
      case 'apsis': return this.apsisRows(target, attractors, simTime);
      case 'relnode': case 'eqnode': return this.nodeRows(target, attractors, simTime);
      case 'empty-space': return [];
    }
  }

  // 基準天体・高度・速度・AP/PE/INC/PRD の軌道要素一式。軌道上の実体種別間で共通化する。
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
        key: 'operated', label: '操作対象か', value: ship === this.activePlayers.current ? 'はい' : 'いいえ', collapsible: true,
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
      { key: 'vessels', label: '格納艦艇数', value: `${base.baseState.dockedVessels.length}` },
    ];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(base.state.r, player.state.r))) });
    rows.push(...this.orbitRows(base, attractors));
    return rows;
  }

  // 自艦がいなければ距離の行は出さない。軌道要素は「軌道」グループの下に畳む。
  private ammoPickupRows(
    target: MapPickable,
    attractors: readonly Attractor[],
    player: Player | null,
  ): PropertyRow[] {
    const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
    if (!ammoPickup) return [];
    const rows: PropertyRow[] = [];
    if (player) {
      rows.push({
        key: 'dist',
        label: '距離',
        value: fmtDist(len(sub(ammoPickup.state.r, player.state.r))),
      });
    }
    rows.push(...this.orbitRows(ammoPickup, attractors));
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
    const rows: PropertyRow[] = [];
    if (target.ownerName) rows.push({ key: 'owner', label: '所属軌道', value: target.ownerName });
    rows.push({ key: 'alt', label: '高度', value: fmtDist(alt) });
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  // AN/DN の別はタイトル側(header)に既に出ているので、ここでは対象名と通過時刻のみ出す。
  private nodeRows(target: MapPickable, attractors: readonly Attractor[], simTime: number): PropertyRow[] {
    const targetName = target.kind === 'relnode'
      ? (this.navTarget.name ?? '対象')
      : celestialBodyName(strongestAttractor(target.pos, attractors).id);
    const rows: PropertyRow[] = [];
    if (target.ownerName) rows.push({ key: 'owner', label: '所属軌道', value: target.ownerName });
    rows.push({ key: 'target', label: '対象', value: targetName });
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  private runBodyShip(act: MenuAction, target: MapPickable): void {
    if (act === 'focus') {
      this.frameControls.setFocus({ kind: 'object', id: target.id });
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
      if (t !== null && !this.simSpeedManager.startAutoWarpTo(t, this.pickables.lastSimTime)) {
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
