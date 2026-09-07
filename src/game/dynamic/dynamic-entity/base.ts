// 軌道上の拠点。自艦と同じく操作でき、資金を持つ。
import * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { OrbitingObject } from './orbiting-object';
import type { View } from '../../view/view';
import { DynamicEntity } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import { EntityIdAllocator } from './entity-id';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { Attitude } from '../../../physics/attitude';
import { qInvert, qRotate } from '../../../math/quat';
import { add, len, sub, v3, Vec3 } from '../../../math/vec3';
import type { Ray } from '../../../math/ray';
import { buildBaseModel } from '../../../render/base-station-model';
import type { Notifier } from '../../../hud/notifier';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { MarkerManager } from '../../marker/marker-manager';
import type { BaseSaveData } from '../../save/save-data';
import { Plan, type PlanExecutionMode } from '../../plan/plan';
import { generateRandomName } from '../../random-name';
import type { GroupedMarkerItem, MarkerRole } from '../../marker/grouped-markers';
import { fmtDist, fmtMarkerDist } from '../../../hud/utils';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../../marker/marker-identity';
import { baseMarkerSvg } from '../../marker/marker-shapes';
import type { SphereHit } from '../../../math/triangle-mesh';
import { BASE_COLLISION_RADIUS, baseRaycast, baseSphereCollide } from './base-collision';
import { Throttle } from '../../player/throttle';
import type { Controllable } from './controllable';
import type { EntityRegistry } from '../entity-registry';
import type { Stage } from '../../stages/stage';
import type { Input } from '../../../input/input';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { ThrustEffects } from '../../player/thrust-effects';
import { RcsEffects } from '../../player/rcs-effects';
import type { CameraSystem } from '../../camera/camera-system';
import type { FloatingOrigin } from '../../camera/floating-origin';
import type { RenderStyle } from '../../../render/render-style';
import type { MapVisibilityPolicy } from '../../map/visibility-policy';
import type { InstancedPools } from '../instanced-pools';
import { currentThemePalette } from '../../../theme';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { MARKER_PRIORITY } from '../../marker/crowding';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';

import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ControlSelection } from '../../control-selection';
import type { ObjectAuthoring } from '../../stages/stage';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../../pickable/pickable-listing';

const BASE_THRUST = 4e8;        // 基地の総推力 [N]（1e6 kg で 400 m/s² — 船の全開加速度と同等）
const BASE_TORQUE = 1.4e8;      // 基地のトルク [N·m]（慣性 1e8 で 1.4 rad/s² — 船の角加速度と同等）
const BASE_FUEL_RATE = 0.5;     // 基地の燃料消費レート
const BASE_MAX_FUEL = 50000;    // 基地の最大燃料
const BASE_INERTIA_X = 1e8;     // 基地の慣性モーメント（ほぼ対称の大質量構造物）
const BASE_INERTIA_Y = 1e8;
const BASE_INERTIA_Z = 1.2e8;   // 長軸方向はやや大きい

interface BaseState {
  money: number;
}

const idAllocator = new EntityIdAllocator('base-');

// 新規配置は state/name/att をそのまま使い、スナップショットからの再開は saved を
// simTime 付きの状態として展開する。
type BaseInit =
  | { readonly state: KinematicState; readonly name?: string; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: BaseSaveData; readonly simTime: number };

export class Base extends DynamicEntity implements Controllable, ObjectPickable {
  public override readonly mapKind: DynamicEntityKind = 'base';
  public override readonly combatTarget = true;
  public override readonly controllable = true;
  public override readonly pickable = true;

  protected readonly predictedForGhost = true;
  protected readonly baseHistoryDuration = DEFAULT_HISTORY_DURATION;
  readonly plan = new Plan();
  planExecution: PlanExecutionMode = 'off';
  fineAttitude = false;
  // 除去の前に注視・操作対象の参照を引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;
  readonly releaseHint = '基地の操作を解除しました';
  // 基地は自機と操作キーの並びが違うので、選んだ時点で案内を出す。
  get controlHint(): string {
    return `基地「${this.name}」の操作モードに入りました (WASDQE: 噴射 / IJKLUO: 姿勢制御 / T: RCS減衰 / C: プログレード)`;
  }
  // 基地は常設の軌道構造物なので、選択の有無に関わらず赤道交点マーカーを出す。
  public override readonly showsEquatorNodesAlways = true;
  public baseState: BaseState = { money: 100000 };

  // --- Controllable 実装 ---
  readonly throttle: Throttle;
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

  // 基地は機関砲・分離式ブースター・太陽電池パドル・放熱板を持たず、大気も受けない。
  readonly fire = null;
  readonly boosters = null;
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

  // 基地は外接球の中が大きく空いているので、メッシュへ当たったかまで見る。
  override hitBodyByRay(ray: Ray, pos: Vec3): boolean {
    const toLocal = qInvert(this.att.q);
    const reach = len(sub(pos, ray.origin)) + this.radius;
    return baseRaycast(qRotate(toLocal, sub(ray.origin, pos)), qRotate(toLocal, ray.dir), reach) !== null;
  }

  // 球が基地の当たり形状へ触れているか。中心はワールド ECI で受け、点と法線も ECI で返す。
  // 触れていなければ null。
  testSphereCollision(sphereCenter: Vec3, sphereRadius: number): SphereHit | null {
    const toLocal = qInvert(this.att.q);
    const hit = baseSphereCollide(qRotate(toLocal, sub(sphereCenter, this.state.r)), sphereRadius);
    return hit === null ? null : {
      point: add(this.state.r, qRotate(this.att.q, hit.point)),
      normal: qRotate(this.att.q, hit.normal),
      depth: hit.depth,
    };
  }

  // 基地は接触で押されない。mass は推力加速度の分母を兼ねるので、そちらとは別に持つ。
  override get contactMass(): number { return Infinity; }

  constructor(
    init: BaseInit,
    scene: THREE.Scene,
    notifier: Notifier,
    worldSfx: WorldSfx,
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
    const savedAtt: Attitude | undefined = 'saved' in init
      ? {
        q: { ...init.saved.q },
        w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z),
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
    this.radius = BASE_COLLISION_RADIUS;
    this.collides = true;
    this.engagementAnchor = true;
    this.setName(name);
    this.baseFuel = 'saved' in init && init.saved.fuel !== undefined ? init.saved.fuel : BASE_MAX_FUEL;
    this.throttle = new Throttle(notifier, 'saved' in init ? init.saved.throttle : undefined);
    this.thrustEffects = new ThrustEffects(scene, worldSfx);
    this.rcsEffects = new RcsEffects(scene, worldSfx);

    if ('saved' in init) {
      this.showTrajectoryLine = init.saved.showTrajectoryLine ?? false;
      this.baseState.money = init.saved.money;
    }
  }

  // --- 操作制御 ---

  // 毎フレーム、全ての基地に対して1度だけ呼ぶ。input が null なら操作されない。
  updateControls(
    input: Input | null, dt: number, simDt: number,
    _registry: EntityRegistry, _activeStage: Stage, _celestialBodies: CelestialBodies,
  ): void {
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

  // 基地のメッシュ・推力プルーム・RCS パフ・音を同期する。プルームと音は操作中だけ変わるので、
  // 操作対象かどうかを active から引く。
  protected override syncModel(
    fo: FloatingOrigin,
    displayTime: number,
    active: Controllable | null,
    visibilityPolicy: MapVisibilityPolicy | null,
    _pools: InstancedPools,
    camera: CameraSystem,
    style: RenderStyle,
  ): void {
    const displayState = this.placeModel(fo, displayTime, active, visibilityPolicy);
    const isControlled = this === active;
    const effectState = displayState ?? this.state;
    const effectVisible = this.renderObject.visible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects.sync(fo, effectState.r, this.thrust, maxAccel, effectVisible, isControlled, camera, style, 6.0);
    this.rcsEffects.sync(fo, effectState.r, this.torque, this.att, effectVisible, camera, isControlled, 6.0);
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `base-${this.id}`; }

  // 基地のマーカー表示項目。pos/vel には構造メッシュと同じ表示時刻の状態を渡すこと。
  markerItem(
    role: MarkerRole, viewerPos: Vec3, pos: Vec3, vel: Vec3, view: View, _isActive: boolean,
  ): GroupedMarkerItem {
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
  }

  // セーブデータへ変換する。
  public override serialize(): BaseSaveData {
    return {
      id: this.id,
      kind: 'base',
      name: this.name,
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      money: this.baseState.money,
      fuel: this.baseFuel,
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

  public shownOnMap(markers: MarkerManager): boolean { return markers.shows(this.markerKey); }

  // 自艦がいれば自艦からの距離。いなければ出さない。
  public listDetail(
    _celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    if (viewer === null) return '';
    return fmtDist(len(sub(this.posAt(displayTime) ?? this.state.r, viewer.state.r)));
  }

  // 検索が照合する文字列。行の補助表示と同じ。
  public listSearchText(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    return this.listDetail(celestialBodies, viewer, displayTime);
  }

  // 右クリックメニュー・プロパティウィンドウに出す操作項目。
  public menuItems(
    _celestialBodies: CelestialBodies, viewer: OrbitingObject | null, navTargetId: string | null,
  ): readonly MenuItem<MenuAction>[] {
    const subLabel = `基地 / 所持金: ${this.baseState.money.toLocaleString()} Cr`;
    const controlItem: MenuItem<MenuAction> = viewer === this
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };

    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.target(navTargetId === this.id),
      controlItem,
      MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.showTrajectoryLine),
      MenuCommon.duplicate(),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // 軌道線の表示だけ自分の状態を書き換える。
  public runMenu(
    act: MenuAction, controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
  ): void {
    if (act === 'activate') {
      controlSelection.select(this);
    } else if (act === 'deactivate') {
      controlSelection.release(this);
    } else if (act === 'toggleTrajectoryLine') {
      this.showTrajectoryLine = !this.showTrajectoryLine;
    } else if (act === 'delete') {
      controlSelection.remove(this);
    } else if (act === 'duplicate') {
      authoring?.openObjectPlacerForDuplicate(this.mapKind, this.state);
    }
  }

  // プロパティウィンドウに出す行。所持金・自艦からの距離を主要行とし、操作対象かは
  // 詳細トグル、軌道要素は「軌道」グループの下に畳む。自艦がいなければ距離の行は落ちる。
  public propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    const rows: PropertyRow[] = [
      {
        key: 'operated', label: '操作対象か',
        value: viewer === this ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'money', label: '所持金', value: `${this.baseState.money.toLocaleString()} Cr` },
    ];
    if (viewer) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(this.state.r, viewer.state.r))) });
    rows.push(...orbitRows(this, celestialBodies, simTime));
    return rows;
  }

  public readonly rename = (name: string): void => { this.setName(name); };

  public readonly onMapSelect = null;

  // 注視されても操作対象にはならない。
  public readonly onMapFocus = null;
}

// この個体が基地か。顔ぶれから基地だけを絞るときに使う。
export function isBase(entity: DynamicEntity): entity is Base {
  return entity instanceof Base;
}
