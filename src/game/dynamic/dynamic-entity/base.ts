// 軌道上の拠点。艦艇のドッキングと格納、部品と資金の保有、そこからの発艦を持つ。
import * as THREE from 'three/webgpu';
import type { View } from '../../view/view';
import { DynamicEntity } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import { EntityIdAllocator } from './entity-id';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { Attitude } from '../../../physics/attitude';
import { qRotate } from '../../../math/quat';
import { add, len, sub, v3, Vec3 } from '../../../math/vec3';
import type { Ray } from '../../../math/ray';
import type { AnyPart, Part } from './parts';
import { partFromSaveData } from './parts';
import { Player } from '../../player/player';
import { buildBaseModel } from '../../../render/base-station-model';
import type { Hud } from '../../hud/hud';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import type { MarkerManager } from '../../marker/marker-manager';
import { EquatorNodeMarkerPair } from '../../marker/equator-node-marker-pair';
import type { BaseSaveData } from '../../save/save-data';
import { Plan } from '../../plan/plan';
import type { PlanExecutionMode } from '../../player/player';
import { generateRandomName } from '../../random-name';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import type { MarkerRole } from '../../targeter';
import { fmtDist, fmtMarkerDist } from '../../hud/utils';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../../marker/marker-identity';
import { baseMarkerSvg } from '../../marker/marker-shapes';
import type { RayHit, SphereHit } from '../../../math/triangle-mesh';
import { BaseCollisionGeometry } from './base-collision';
import { PlayerThrottle } from '../../player/player-throttle';
import type { Controllable } from './controllable';
import type { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { ThrustEffects } from '../../player/thrust-effects';
import { RcsEffects } from '../../player/rcs-effects';
import type { CameraSystem } from '../../camera/camera-system';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { RenderStyle } from '../../../render/render-style';
import type { MapVisibility, MapVisibilityPolicy } from '../../map/visibility-policy';
import { currentThemePalette } from '../../../theme';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { MARKER_PRIORITY } from '../../marker/marker-manager';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ObjectCommands } from '../../pickable/object-commands';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../hud/windows/property-window';
import type { MapListSection } from '../../hud/panels/physical-object-list-panel';
import type { ObjectPickerGenre } from '../../hud/object-groups';

export const BASE_MAX_VESSELS = 4; // 基地が保有・格納できる艦艇の最大数
const BASE_THRUST = 4e8;        // 基地の総推力 [N]（1e6 kg で 400 m/s² — 船の全開加速度と同等）
const BASE_TORQUE = 1.4e8;      // 基地のトルク [N·m]（慣性 1e8 で 1.4 rad/s² — 船の角加速度と同等）
const BASE_FUEL_RATE = 0.5;     // 基地の燃料消費レート
const BASE_MAX_FUEL = 50000;    // 基地の最大燃料
const BASE_INERTIA_X = 1e8;     // 基地の慣性モーメント（ほぼ対称の大質量構造物）
const BASE_INERTIA_Y = 1e8;
const BASE_INERTIA_Z = 1.2e8;   // 長軸方向はやや大きい

// 基地のドッキングハッチのローカル位置および外向き法線ベクトル (中腹ドッキングパレット上部, 3倍スケール対応)
const BASE_HATCH_LOCAL_POS: Vec3 = v3(0, 21.0, 0);
const BASE_HATCH_LOCAL_NORMAL: Vec3 = v3(0, 1, 0);

interface BaseDockSlot {
  readonly id: number;
  readonly localPos: Vec3;
  readonly localNormal: Vec3;
}

const BASE_DOCK_SLOTS: readonly BaseDockSlot[] = [
  { id: 0, localPos: v3(-16.5, 21.0, -16.5), localNormal: v3(0, 1, 0) },
  { id: 1, localPos: v3( 16.5, 21.0, -16.5), localNormal: v3(0, 1, 0) },
  { id: 2, localPos: v3(-16.5, 21.0,  16.5), localNormal: v3(0, 1, 0) },
  { id: 3, localPos: v3( 16.5, 21.0,  16.5), localNormal: v3(0, 1, 0) },
];

// 収容中の艦のエントリ。parts は player.parts と同一参照(修理は艦へ直接反映される)。
// hp/maxHp は艦一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedVesselEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly player: Player;
  slotIndex: number;
}

interface BaseState {
  money: number;
  inventory: AnyPart[];
  dockedVessels: DockedVesselEntry[];
}

const idAllocator = new EntityIdAllocator('base-');

// 新規配置は state/name/att をそのまま使い、スナップショットからの再開は saved を
// simTime 付きの状態として展開する。
type BaseInit =
  | { readonly state: KinematicState; readonly name?: string; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: BaseSaveData; readonly simTime: number };

export class Base extends DynamicEntity implements Controllable, ObjectPickable {
  public readonly mapKind: DynamicEntityKind = 'base';

  readonly collisionGeom = new BaseCollisionGeometry();
  protected readonly predictedForGhost = true;
  protected readonly baseHistoryDuration = DEFAULT_HISTORY_DURATION;
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'off';
  fineAttitude = false;
  // 基地は常に赤道交点マーカーを出すので、コンストラクタで必ず組む。
  declare equatorNodes: EquatorNodeMarkerPair;
  public baseState: BaseState = {
    money: 100000,
    inventory: [],
    dockedVessels: []
  };

  // --- Controllable 実装 ---
  readonly throttle: PlayerThrottle;
  readonly thrustEffects: ThrustEffects;
  readonly rcsEffects: RcsEffects;
  private baseFuel: number;
  get totalThrust(): number { return BASE_THRUST; }
  get totalTorque(): number { return BASE_TORQUE; }
  get totalFuelConsumptionRate(): number { return BASE_FUEL_RATE; }
  get totalFuel(): number { return this.baseFuel; }
  get totalMaxFuel(): number { return BASE_MAX_FUEL; }
  // 基地は装甲を持たない。撃たれても削れる耐久値そのものが無い。
  readonly hp = null;
  readonly maxHp = null;

  // 基地は機関砲・太陽電池パドル・放熱板を持たず、大気も受けない。
  readonly fire = null;
  readonly power = null;
  readonly radiator = null;
  readonly aero = null;
  readonly altitudeAlarm = null;

  consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    const actual = Math.min(this.baseFuel, amount);
    this.baseFuel -= actual;
    return actual / amount;
  }

  raycast(rayOrigin: Vec3, rayDir: Vec3, maxDist: number, warpLevel = 1): RayHit | null {
    return this.collisionGeom.raycast(rayOrigin, rayDir, maxDist, this.state.r, this.att.q, warpLevel);
  }

  // 基地は外接球の中が大きく空いているので、メッシュへ当たったかまで見る。
  override hitBodyByRay(ray: Ray, pos: Vec3): boolean {
    const reach = len(sub(pos, ray.origin)) + this.radius;
    return this.collisionGeom.raycast(ray.origin, ray.dir, reach, pos, this.att.q, 1) !== null;
  }

  testSphereCollision(sphereCenter: Vec3, sphereRadius: number, warpLevel = 1): SphereHit | null {
    return this.collisionGeom.testSphereCollision(sphereCenter, sphereRadius, this.state.r, this.att.q, warpLevel);
  }

  // 基地は接触で押されない。mass は推力加速度の分母を兼ねるので、そちらとは別に持つ。
  override get contactMass(): number { return Infinity; }

  // hud/worldSfx/fx/markerManager は格納艦(Player)の組み立てに要る。格納艦は entities.players へ
  // 入らない — それが「格納中」の定義であり、艦自身の状態としては何も倒さない。
  constructor(
    init: BaseInit,
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
    fx: EffectsSystem,
    private readonly markerManager: MarkerManager,
  ) {
    const { state, name, att, id } = 'saved' in init
      ? {
        state: kinematicState<'eci'>(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        name: init.saved.name || '基地',
        att: undefined,
        id: init.saved.id,
      }
      : { state: init.state, name: init.name ?? generateRandomName('base'), att: init.att, id: init.id };
    const savedAtt: Attitude | undefined = 'saved' in init && init.saved.q
      ? {
        q: { ...init.saved.q },
        w: init.saved.w ? v3(init.saved.w.x, init.saved.w.y, init.saved.w.z) : v3(),
        inertia: v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z),
      }
      : undefined;
    super(state, buildBaseModel(), scene, savedAtt ?? att, idAllocator.next(id));
    // 姿勢に慣性モーメントを設定（既定の identityAttitude は inertia=(1,1,1) なので上書きが必要）
    if (!savedAtt && !att) {
      this.att = { ...this.att, inertia: v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z) };
    } else if (att && !att.inertia) {
      this.att = { ...this.att, inertia: v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z) };
    }
    this.mass = 3e6;
    this.radius = 330;
    this.collides = true;
    this.name = name;
    this.baseFuel = 'saved' in init && init.saved.fuel !== undefined ? init.saved.fuel : BASE_MAX_FUEL;
    this.throttle = new PlayerThrottle(hud, 'saved' in init ? init.saved.throttle : undefined);
    this.thrustEffects = new ThrustEffects(scene, worldSfx);
    this.rcsEffects = new RcsEffects(scene, worldSfx);
    this.equatorNodes = new EquatorNodeMarkerPair(this, markerManager);

    if ('saved' in init) {
      this.showTrajectoryLine = init.saved.showTrajectoryLine ?? false;
      this.baseState.money = init.saved.money;
      this.baseState.inventory = (init.saved.inventory ?? []).map(partFromSaveData);
      const savedVessels = init.saved.dockedVessels ?? init.saved.dockedShips ?? [];
      this.baseState.dockedVessels = savedVessels.map((shipData, idx) => {
        const player = new Player(hud, worldSfx, scene, fx, markerManager, { saved: shipData, simTime: init.simTime });
        const slotIndex = idx < BASE_MAX_VESSELS ? idx : 0;
        this.attachDockedVesselMesh(player, slotIndex);
        return {
          id: player.id,
          name: player.name,
          hp: player.hp,
          maxHp: player.maxHp,
          parts: player.parts,
          player,
          slotIndex,
        };
      });
    }
  }

  // 基地のドッキングハッチのワールド座標を取得する
  getHatchWorldPos(): Vec3 {
    return add(this.state.r, qRotate(this.att.q, BASE_HATCH_LOCAL_POS));
  }

  // 基地のドッキングハッチのワールド正面法線ベクトルを取得する
  getHatchWorldNormal(): Vec3 {
    return qRotate(this.att.q, BASE_HATCH_LOCAL_NORMAL);
  }

  // 指定スロットのワールド位置を取得する
  getSlotWorldPos(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return add(this.state.r, qRotate(this.att.q, slot.localPos));
  }

  // 指定スロットの外向き法線ベクトルを取得する
  getSlotWorldNormal(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return qRotate(this.att.q, slot.localNormal);
  }

  // 利用可能な空きスロット番号(0..3)を返す。満杯なら null。
  getAvailableSlotIndex(): number | null {
    const occupied = new Set(this.baseState.dockedVessels.map((s) => s.slotIndex));
    for (let i = 0; i < BASE_MAX_VESSELS; i++) {
      if (!occupied.has(i)) return i;
    }
    return null;
  }

  // 格納艦の 3D メッシュを基地ドックスロットへアタッチ表示する
  attachDockedVesselMesh(ship: Player, slotIndex: number): void {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    const shipObj = ship.renderObject;
    shipObj.visible = true;
    shipObj.position.set(slot.localPos.x, slot.localPos.y, slot.localPos.z);

    const dir = new THREE.Vector3(slot.localNormal.x, slot.localNormal.y, slot.localNormal.z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    shipObj.quaternion.copy(q);

    if (shipObj.parent !== this.renderObject) {
      this.renderObject.add(shipObj);
    }
  }

  // 発進時、格納艦の 3D メッシュを基地ドックスロットから分離し、ワールド Scene へ復帰させる
  detachDockedVesselMesh(ship: Player): void {
    const shipObj = ship.renderObject;
    if (shipObj.parent === this.renderObject) {
      this.renderObject.remove(shipObj);
    }
    if (this.scene && shipObj.parent !== this.scene) {
      this.scene.add(shipObj);
    }
    shipObj.visible = true;
  }

  // --- 操作制御 ---

  // 毎フレーム、操作対象の基地に対して1度だけ呼ぶ。input が null なら操作されない。
  updateBaseControls(input: Input | null, dt: number, simDt: number): void {
    if (input === null) {
      this.clearTransientCommands();
      return;
    }
    this.handleEdgeInput(input);
    this.torque = this.throttle.updateTorque(
      this.att, this.state.r, this.state.v, input, false, dt, simDt, this,
      () => {},  // 基地はプログレードホールド解除のヒントを出さない
    );
    this.throttle.updateThrustLatches(input);
    this.thrust = this.throttle.updateThrustState(input, this.att, simDt, this);
  }

  clearTransientCommands(): void {
    this.thrust = null;
    this.torque = v3();
    this.throttle.clearTransientState();
  }

  // 基地側のキー（RCS減衰・プログレード・スロットル等）を1フレーム分消費する。
  private handleEdgeInput(input: Input): void {
    input.takeKeys((code) => {
      switch (code) {
        case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
        case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
        case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
        case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
        case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
        case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
        case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
        default: return false;
      }
    });
  }

  // 基地のメッシュ・推力プルーム・RCS パフ・音・軌道線を同期する。
  syncBase(
    fo: FloatingOrigin,
    camera: CameraSystem,
    displayTime: number,
    isControlled: boolean,
    style: RenderStyle,
    visibility: MapVisibility | null = null,
  ): void {
    const displayState = this.stateAt(displayTime);
    const mapEntityVisible = camera.view !== 'map' || visibility === null || visibility.category;
    this.renderObject.visible = displayState !== null && mapEntityVisible;
    if (displayState !== null) {
      this.renderObject.position.copy(fo.RtoThreeV3(displayState.r));
      this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    }

    const effectState = displayState ?? this.state;
    const effectVisible = displayState !== null && mapEntityVisible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects.sync(fo, effectState.r, this.thrust, maxAccel, effectVisible, isControlled, camera, style, 6.0);
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isControlled, 6.0);
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `base-${this.id}`; }

  // 基地のマーカー表示項目。pos/vel には構造メッシュと同じ表示時刻の状態を渡すこと。
  markerItem(role: MarkerRole, viewerPos: Vec3, pos: Vec3, vel: Vec3, view: View): GroupedMarkerItem {
    const dist = len(sub(pos, viewerPos));
    const priority = role === 'primary' ? MARKER_PRIORITY.PRIMARY_TARGET : MARKER_PRIORITY.BASE - dist / 1e9;
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: role === 'primary' ? 'mk-base mk-target' : 'mk-base',
      sym: baseMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      detail: view === 'map' ? '' : fmtMarkerDist(dist),
      bearingColor: role === 'primary' ? currentThemePalette().signal : COLOR_MARKER_ALLY,
      bearingSym: ENTITY_GLYPH.base,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: false,
      color: role === 'primary' ? currentThemePalette().signal : COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  dispose(): void {
    super.dispose();
    if (this.scene) {
      this.thrustEffects.dispose(this.scene);
      this.rcsEffects.dispose(this.scene);
    }
    this.markerManager.remove(this.markerKey);
    this.markerManager.remove(`${this.markerKey}-bearing`);
    // 格納艦は entities.players から外れているため、ここでしか回収できない。
    for (const entry of this.baseState.dockedVessels) entry.player.dispose();
    this.baseState.dockedVessels = [];
  }

  // セーブデータへ変換する。格納艦は player.serialize() に委ねる。
  serialize(): BaseSaveData {
    return {
      id: this.id,
      name: this.name,
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      money: this.baseState.money,
      fuel: this.baseFuel,
      inventory: this.baseState.inventory.map(p => ({ ...p })),
      dockedVessels: this.baseState.dockedVessels.map(entry => entry.player.serialize()),
      throttle: this.throttle.serialize(),
      showTrajectoryLine: this.showTrajectoryLine,
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.alive; }
  public get orbitState(): KinematicState { return this.state; }
  public readonly glyph = ENTITY_GLYPH.base;
  public get glyphSvg(): string { return baseMarkerSvg(); }
  public readonly listSection: MapListSection = 'base';
  public readonly pickerGenre: ObjectPickerGenre = '基地';
  public readonly hiddenBehindBodies = true;
  public readonly onlyInFocusedSystem = false;
  public listPriority(): number { return 0; }
  public listCounted(): boolean { return false; }

  // 表示時刻の ECI 位置。予測が届かない時刻では null。
  public posAt(displayTime: number): Vec3 | null {
    return this.stateAt(displayTime)?.r ?? null;
  }

  // 基地カテゴリの表示トグルによる可否。
  public mapVisibility(policy: MapVisibilityPolicy): MapVisibility {
    return policy.entity(this.mapKind);
  }

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 自艦がいれば自艦からの距離、いなければ格納中の艦艇数。
  public listDetail(
    _celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    if (activePlayer === null) return `格納 ${this.baseState.dockedVessels.length} 艇`;
    return fmtDist(len(sub(this.posAt(displayTime) ?? this.state.r, activePlayer.state.r)));
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(
    celestialSystem: CelestialSystem, activePlayer: Player | null, displayTime: number,
  ): string {
    return this.listDetail(celestialSystem, activePlayer, displayTime);
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    commands: ObjectCommands, _celestialSystem: CelestialSystem, simTime: number,
  ): readonly MenuItem<MenuAction>[] {
    const { money, dockedVessels } = this.baseState;
    const subLabel = `基地 / 所持金: ${money.toLocaleString()} Cr / 格納艦艇: ${dockedVessels.length}隻`;
    const controlItem: MenuItem<MenuAction> = commands.controlledBase === this
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };
    const dockItems: readonly MenuItem<MenuAction>[] =
      commands.dockState(this) === 'dockable' ? [MenuCommon.dock()] : [];

    return [
      { type: 'header', label: this.name, subLabel },
      ...MenuCommon.targetItems(commands, this.id, simTime),
      controlItem,
      ...dockItems,
      {
        label: commands.isBasePanelExpanded(this) ? '基地パネルを収納' : '基地パネルを展開',
        act: 'toggleBasePanel', keepOpen: true,
      },
      MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.showTrajectoryLine),
      ...MenuCommon.duplicateItems(commands),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // menuItems が出した操作を実行する。軌道線の表示だけ自分の状態を書き換え、残りは commands を通す。
  public runMenu(act: MenuAction, commands: ObjectCommands): void {
    if (act === 'activate') {
      commands.setControlledBase(this);
    } else if (act === 'deactivate') {
      if (commands.controlledBase === this) commands.setControlledBase(null);
    } else if (act === 'toggleTrajectoryLine') {
      this.showTrajectoryLine = !this.showTrajectoryLine;
    } else if (act === 'toggleBasePanel') {
      commands.toggleBasePanel(this);
    } else if (act === 'dock') {
      commands.dock(this);
    } else if (act === 'delete') {
      commands.removeBase(this);
    } else if (act === 'duplicate') {
      commands.duplicate(this.mapKind, this.state);
    } else if (act === 'focus') {
      commands.focus(this.id, this.name);
    } else if (act === 'target') {
      commands.toggleNavTarget(this.id, this.name);
    }
  }

  // プロパティウィンドウに出す行。所持金・格納艦艇数・自艦からの距離を主要行とし、操作対象かは
  // 詳細トグル、軌道要素は「軌道」グループの下に畳む。自艦がいなければ距離の行は落ちる。
  public propertyRows(
    commands: ObjectCommands, celestialSystem: CelestialSystem, simTime: number,
  ): readonly PropertyRow[] {
    const viewer = commands.activePlayer;
    const rows: PropertyRow[] = [
      {
        key: 'operated', label: '操作対象か',
        value: commands.controlledBase === this ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'money', label: '所持金', value: `${this.baseState.money.toLocaleString()} Cr` },
      { key: 'vessels', label: '格納艦艇数', value: `${this.baseState.dockedVessels.length}` },
    ];
    if (viewer) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(this.state.r, viewer.state.r))) });
    rows.push(...orbitRows(this, celestialSystem, simTime));
    return rows;
  }

  public readonly rename = (name: string): void => { this.name = name; };

  // 単クリックは選択までに留め、基地パネルは展開しない。
  public readonly onMapSelect = (commands: ObjectCommands): void => {
    commands.selectBase(this);
    commands.hint(`${this.name} を選択`);
  };

  // 注視されても操作対象にはならない。
  public readonly onMapFocus = null;
}
