// 軌道上の拠点。自艦と同じく操作でき、資金を持つ。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { OrbitingObject } from './orbiting-object';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import type { EntityIdAllocators } from './entity-id';
import { deserializeKinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import type { Vec3 } from '../../../math/vec3';
import { len, sub, v3 } from '../../../math/vec3';
import type { MarkerVisibility } from '../../../marker/marker-visibility';
import { Plan, type PlanExecutionMode, type SerializedPlan } from '../../plan/plan';
import { generateRandomName } from '../../random-name';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import { fmtDist } from '../../../hud/utils';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../../marker/marker-identity';
import { baseMarkerSvg } from '../../marker/marker-shapes';
import { Throttle, type SerializedThrottle } from '../../player/throttle';
import { PLAYER_RCS_ANGULAR_ACCEL } from '../../player/player-loadout';
import type { Controllable } from './controllable';
import type { PilotCommand, PilotControls } from './pilot-controls';
import type { EntityRegistry } from '../entity-registry';
import { BaseView, type BaseRenderSource } from '../../../render/dynamic/dynamic-entity/base-view';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../../orbit-reference';
import { MARKER_PRIORITY } from '../../marker/marker-priority';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';

import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ControlSelection } from '../../control-selection';
import type { ObjectAuthoring } from '../../pickable/inspected-object';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../../pickable/pickable-listing';
import { BASE_THRUST, BaseMotion } from './base-motion';

const BASE_FUEL_RATE = 0.5;     // 基地の燃料消費レート
const BASE_INERTIA_X = 1e8;     // 基地の慣性モーメント（ほぼ対称の大質量構造物）
const BASE_INERTIA_Y = 1e8;
const BASE_INERTIA_Z = 1.2e8;   // 長軸方向はやや大きい
// 基地のトルク [N·m]。短軸まわりに自機の RCS と同じ角加速度を出す。
const BASE_TORQUE = BASE_INERTIA_X * PLAYER_RCS_ANGULAR_ACCEL;
const BASE_INITIAL_MONEY = 100000; // 新規配置の基地の所持金 [Cr]

export interface SerializedBase extends SerializedDynamicEntityFields {
  readonly kind: 'base';
  readonly name: string;
  readonly money: number;
  // 基地の燃料 [kg]。
  readonly fuel: number;
  readonly throttle: SerializedThrottle;
  readonly plan: SerializedPlan | null;
}

// 基地を新しく置く運動状態と表示名。id を省くと採番器が発番する。
export interface BasePlacement {
  readonly state: KinematicState;
  readonly name?: string;
  readonly att?: Attitude;
  readonly id?: string;
}

export class Base extends DynamicEntity implements Controllable, ObjectPickable {
  public static readonly kind = 'base';
  public static spawnGate(): null { return null; }

  public override readonly mapKind: DynamicEntityKind = 'base';
  public override readonly combatTarget = true;
  public override readonly controllable = true;
  public override readonly pickable = true;

  // 基地の計画の実行方法と姿勢操作の微調整は、既定のまま固定する。
  public readonly planExecution: PlanExecutionMode = 'off';
  public readonly fineAttitude = false;
  // 除去の前に注視・操作対象の参照を引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;
  // 基地は常設の軌道構造物なので、選択の有無に関わらず赤道交点マーカーを出す。
  public override readonly showsEquatorNodesAlways = true;
  // 所持金 [Cr]。
  public get money(): number { return this._money; }

  public declare readonly motion: BaseMotion;

  // --- Controllable 実装 ---
  public get totalThrust(): number { return BASE_THRUST; }
  public get totalTorque(): number { return BASE_TORQUE; }
  public get totalFuelConsumptionRate(): number { return BASE_FUEL_RATE; }
  public get totalFuel(): number { return this.motion.fuel; }
  public get totalMaxFuel(): number { return this.motion.maxFuel; }
  public readonly hp = null;
  public readonly maxHp = null;

  // 燃料を amount [kg] だけ、残量の範囲で使う。
  public consumeFuel(amount: number): void {
    this.motion.consumeFuel(amount);
  }

  // 基地 name を state・attitude に置く。id は採番器が配った識別子。_money から後ろは所持金 [Cr]・
  // 燃料・生死・操作状態・マニューバ計画で、省いたものは新しく置いたときの状態で始める。
  private constructor(
    scene: THREE.Scene,
    id: string,
    name: string,
    state: KinematicState,
    attitude: Attitude,
    private readonly _money = BASE_INITIAL_MONEY,
    fuel?: number,
    alive?: boolean,
    public readonly throttle = new Throttle(),
    public readonly plan = Plan.create(),
  ) {
    super(() => new BaseMotion(state, attitude, fuel, alive), new BaseView(scene, id), id);
    this.setName(name);
  }

  // placement に新しく置く。name を省くと無作為な名前、att を省くと静止した姿勢で置く。
  public static create(placement: BasePlacement, scene: THREE.Scene, idAllocators: EntityIdAllocators): Base {
    const name = placement.name ?? generateRandomName('base');
    return new Base(
      scene, idAllocators.base.next(placement.id), name, placement.state,
      placement.att ?? { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia: Base.INERTIA },
    );
  }

  // 直列化した基地を復元する。計画のうち起点より前のノードは戻せないので、その数を registry の出来事へ
  // 記録する。
  public static deserialize(
    serialized: SerializedBase, registry: EntityRegistry, scene: THREE.Scene,
  ): Base {
    const { plan } = serialized;
    const base = new Base(
      scene,
      registry.idAllocators.base.next(serialized.id),
      // 記録に無い名前は、新しく置いたときと違って無作為に選ばず「基地」と名乗る。
      serialized.name || '基地',
      deserializeKinematicState(serialized),
      deserializeAttitude(serialized, Base.INERTIA),
      // null の所持金も欠けと同じく既定へ落とす(既定引数は undefined でしか働かない)。
      serialized.money ?? undefined,
      serialized.fuel,
      serialized.alive,
      serialized.throttle ? Throttle.deserialize(serialized.throttle) : undefined,
      plan ? Plan.deserialize(plan) : undefined,
    );
    const dropped = plan ? Plan.droppedNodeCount(plan) : 0;
    if (dropped > 0) registry.events.record({ kind: 'planNodesDropped', ship: base.name, count: dropped });
    return base;
  }

  // 主慣性モーメント。
  private static readonly INERTIA = v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z);

  // 噴射表現に要る推力・トルクを、共通の表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean, orbitReference: OrbitReference | undefined,
  ): BaseRenderSource {
    const motion = this.motion;
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      thrust: motion.thrust,
      maximumAcceleration: motion.maximumAcceleration,
      torque: motion.torque,
    };
  }

  // --- 操作制御 ---

  // 毎フレーム、全ての基地に対して1度だけ呼ぶ。controls はこのフレームの操作量で、null なら
  // 操作されない。dt [s] は実時間、simDt [sim s] はシミュレーション時間の刻み。
  public updateControls(controls: PilotControls | null, dt: number, simDt: number): void {
    if (controls === null) {
      this.clearTransientCommands();
      return;
    }
    // 操作量から姿勢のトルクと推力を決める
    this.motion.setTorque(this.throttle.updateTorque(
      this.motion.att, this.motion.state.r, this.motion.state.v, controls, false, dt, simDt, this,
      null,
    ));
    this.throttle.updateThrustLatches(controls);
    this.motion.setThrust(this.throttle.updateThrustState(controls, this.motion.att, simDt, this));
  }

  // 推力・トルクの指令とスロットルの一時状態を解く。
  public clearTransientCommands(): void {
    this.motion.setThrust(null);
    this.motion.setTorque(v3());
    this.throttle.clearTransientState();
  }

  // 受け付けた単発の命令のうち、基地が備える操作を状態へ適用する。
  public handleCommand(command: PilotCommand, registry: EntityRegistry): void {
    const events = registry.events;
    // 命令の種類ごとにスロットルの操作へ写す
    switch (command.kind) {
      case 'thrustLatchToggle': this.throttle.toggleThrustLatch(command.direction); return;
      case 'rcsDampToggle': this.throttle.toggleRcsDamp(events); return;
      case 'progradeReset': this.throttle.enableProgradeReset(events); return;
      case 'progradeHoldToggle': this.throttle.toggleProgradeHold(events); return;
      case 'throttleLow': this.throttle.setThrottlePreset(0, events); return;
      case 'throttleMid': this.throttle.setThrottlePreset(1, events); return;
      case 'throttleHigh': this.throttle.setThrottlePreset(2, events); return;
      case 'throttleMax': this.throttle.setThrottlePreset(3, events); return;
    }
  }

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `base-${this.id}`; }

  // 基地のマーカー表示項目。pos/vel には構造メッシュと同じ表示時刻の状態を渡すこと。
  public markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3): GroupedMarkerItem {
    // 代表選出の優先度は、同じ種別の中では視点に近い個体ほど高くする
    const priority = viewerPos ? MARKER_PRIORITY.BASE - len(sub(pos, viewerPos)) / 1e9 : MARKER_PRIORITY.BASE;
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: 'mk-base',
      sym: baseMarkerSvg(),
      pos,
      vel,
      priority,
      name: this.name,
      bearing: {
        cls: 'mk-dir mk-ally-dir', sym: ENTITY_GLYPH.base, color: COLOR_MARKER_ALLY,
        visible: true, clustered: true,
      },
      color: COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 直列化した形へ変換する。
  public override serialize(): SerializedBase {
    return {
      ...this.serializeEntityFields(Base.kind),
      name: this.name,
      // 基地の資源と、操作の設定と計画
      money: this._money,
      fuel: this.motion.fuel,
      throttle: this.throttle.serialize(),
      plan: this.plan.serialize(),
    };
  }

  // 被選択物(ObjectPickable)としての振る舞い。
  public get gone(): boolean { return !this.motion.alive; }
  public get orbitState(): KinematicState { return this.motion.state; }
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
    return this.motion.stateAt(displayTime)?.r ?? null;
  }

  public shownOnMap(markers: MarkerVisibility): boolean { return markers.shows(this.markerKey); }

  // 自艦からの距離。自艦がいなければ空文字。
  public listDetail(
    _celestialBodies: CelestialBodies, viewer: OrbitingObject | null, displayTime: number,
  ): string {
    if (viewer === null) return '';
    return fmtDist(len(sub(this.posAt(displayTime) ?? this.motion.state.r, viewer.motion.state.r)));
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
    trajectoryLineShown: boolean,
  ): readonly MenuItem<MenuAction>[] {
    const subLabel = `基地 / 所持金: ${this._money.toLocaleString()} Cr`;
    const controlItem: MenuItem<MenuAction> = viewer === this
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };

    // 見出しに所持金を添え、共通の操作項目を並べる
    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.target(navTargetId === this.id),
      controlItem,
      MenuCommon.focus(),
      MenuCommon.trajectoryLine(trajectoryLineShown),
      MenuCommon.duplicate(),
      { label: '削除', act: 'delete' },
      MenuCommon.cancel(),
    ];
  }

  // menuItems が出した操作 act を実行する。
  public runMenu(
    act: MenuAction, controlSelection: ControlSelection, authoring: ObjectAuthoring | null,
  ): void {
    if (act === 'activate') {
      controlSelection.select(this);
    } else if (act === 'deactivate') {
      controlSelection.release(this);
    } else if (act === 'delete') {
      controlSelection.remove(this);
    } else if (act === 'duplicate') {
      authoring?.openObjectPlacerForDuplicate(this.mapKind, this.motion.state);
    }
  }

  // プロパティウィンドウに出す行。自艦がいなければ距離の行を省く。
  public propertyRows(
    celestialBodies: CelestialBodies, viewer: OrbitingObject | null, simTime: number,
  ): readonly PropertyRow[] {
    // 詳細トグルで畳む行と、所持金
    const rows: PropertyRow[] = [
      {
        key: 'operated', label: '操作対象か',
        value: viewer === this ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'money', label: '所持金', value: `${this._money.toLocaleString()} Cr` },
    ];
    // 自艦からの距離と軌道要素
    if (viewer) rows.push({
      key: 'dist', label: '距離',
      value: fmtDist(len(sub(this.motion.state.r, viewer.motion.state.r))),
    });
    rows.push(...orbitRows(this, celestialBodies, simTime));
    return rows;
  }

  public readonly rename = (name: string): void => { this.setName(name); };

  public readonly onMapSelect = null;
  public readonly onMapFocus = null;
}

// entity を基地へ絞り込む型ガード。
export function isBase(entity: DynamicEntity): entity is Base {
  return entity instanceof Base;
}
