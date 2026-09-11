// 軌道上の拠点。自艦と同じく操作でき、資金を持つ。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { OrbitingObject } from './orbiting-object';
import { DynamicEntity } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import { EntityIdAllocator } from './entity-id';
import type { KinematicState } from '../../../physics/kinematic-state';
import { Attitude } from '../../../physics/attitude';
import { len, sub, v3, Vec3 } from '../../../math/vec3';
import type { Notifier } from '../../../hud/notifier';
import type { MarkerSlots } from '../../marker/marker-slots';
import type { MarkerVisibility } from '../../marker/marker-visibility';
import { savedAttitude, savedKinematicState, type BaseSaveData } from '../../save/save-data';
import { Plan, type PlanExecutionMode } from '../../plan/plan';
import { generateRandomName } from '../../random-name';
import type { GroupedMarkerItem } from '../../marker/grouped-markers';
import { fmtDist } from '../../../hud/utils';
import { ENTITY_GLYPH, COLOR_MARKER_ALLY } from '../../marker/marker-identity';
import { baseMarkerSvg } from '../../marker/marker-shapes';
import { Throttle } from '../../player/throttle';
import type { Controllable } from './controllable';
import type { EntityRegistry } from '../entity-registry';
import type { StageOutcome } from '../../stages/stage-outcome';
import type { Input } from '../../../input/input';
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { BaseView, type BaseRenderSource } from '../../../render/dynamic/dynamic-entity/base-view';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../../orbit-reference';
import { MARKER_PRIORITY } from '../../marker/crowding';
import { MenuCommon, type MenuAction } from '../../hud/windows/menu-actions';
import { orbitRows } from '../../pickable/orbit-rows';

import type { ObjectPickable } from '../../pickable/object-pickable';
import type { ControlSelection } from '../../control-selection';
import type { ObjectAuthoring } from '../../pickable/inspected-object';
import type { MenuItem } from '../../hud/windows/context-menu';
import type { PropertyRow } from '../../../hud/windows/property-window-content';
import type { MapListSection, ObjectPickerGenre } from '../../pickable/pickable-listing';
import { BASE_THRUST, BaseMotion } from './base-motion';

const BASE_TORQUE = 1.4e8;      // 基地のトルク [N·m]（慣性 1e8 で 1.4 rad/s² — 船の角加速度と同等）
const BASE_FUEL_RATE = 0.5;     // 基地の燃料消費レート
const BASE_INERTIA_X = 1e8;     // 基地の慣性モーメント（ほぼ対称の大質量構造物）
const BASE_INERTIA_Y = 1e8;
const BASE_INERTIA_Z = 1.2e8;   // 長軸方向はやや大きい
const BASE_INITIAL_MONEY = 100000; // 新規配置の基地の所持金 [Cr]

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

  public readonly plan = new Plan();
  public planExecution: PlanExecutionMode = 'off';
  public fineAttitude = false;
  // 除去の前に注視・操作対象の参照を引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;
  public readonly releaseHint = '基地の操作を解除しました';
  // 基地は自機と操作キーの並びが違うので、選んだ時点で案内を出す。
  public get controlHint(): string {
    return `基地「${this.name}」の操作モードに入りました (WASDQE: 噴射 / IJKLUO: 姿勢制御 / T: RCS減衰 / C: プログレード)`;
  }
  // 基地は常設の軌道構造物なので、選択の有無に関わらず赤道交点マーカーを出す。
  public override readonly showsEquatorNodesAlways = true;
  // 所持金 [Cr]。
  private readonly _money: number;
  public get money(): number { return this._money; }

  public declare readonly motion: BaseMotion;

  // --- Controllable 実装 ---
  public readonly throttle: Throttle;
  public get totalThrust(): number { return BASE_THRUST; }
  public get totalTorque(): number { return BASE_TORQUE; }
  public get totalFuelConsumptionRate(): number { return BASE_FUEL_RATE; }
  public get totalFuel(): number { return this.motion.fuel; }
  public get totalMaxFuel(): number { return this.motion.maxFuel; }
  // 基地は装甲を持たない。撃たれても削れる耐久値そのものが無い。
  public readonly hp = null;
  public readonly maxHp = null;

  // 基地は機関砲・分離式ブースターを持たない。
  public readonly fire = null;
  public readonly boosters = null;
  public readonly altitudeAlarm = null;

  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1.0;
    return this.motion.consumeFuel(amount);
  }

  // 基地を組む。復元時は操作状態・所持金・軌道線の表示も戻す。
  public constructor(
    init: BaseInit,
    scene: THREE.Scene,
    notifier: Notifier,
    markers: MarkerSlots,
  ) {
    // 復元と新規配置を同じ形へ均してから基底へ渡す。
    const { state, name, att, id } = 'saved' in init
      ? {
        state: savedKinematicState(init.saved, init.simTime),
        name: init.saved.name || '基地',
        att: undefined,
        id: init.saved.id,
      }
      : { state: init.state, name: init.name ?? generateRandomName('base'), att: init.att, id: init.id };
    const savedAtt: Attitude | undefined = 'saved' in init
      ? savedAttitude(init.saved, v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z))
      : undefined;
    const attitude = savedAtt ?? att ?? {
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(),
      inertia: v3(BASE_INERTIA_X, BASE_INERTIA_Y, BASE_INERTIA_Z),
    };
    const fuel = 'saved' in init && init.saved.fuel !== undefined ? init.saved.fuel : undefined;
    const entityId = idAllocator.next(id);
    super(
      () => new BaseMotion(state, attitude, fuel),
      new BaseView(scene, entityId, markers),
      entityId,
    );
    this.setName(name);
    this.throttle = new Throttle(notifier, 'saved' in init ? init.saved.throttle : undefined);
    this._money = 'saved' in init ? init.saved.money : BASE_INITIAL_MONEY;

    if ('saved' in init) {
      this.trajectoryLineVisible = init.saved.showTrajectoryLine ?? false;
    }
  }

  // 噴射表現に要る推力・トルクを、共通の表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, visible: boolean, active: boolean,
    orbitReference: OrbitReference | undefined,
  ): BaseRenderSource {
    const motion = this.motion;
    return {
      ...super.renderSource(viewFrame, visible, active, orbitReference),
      thrust: motion.thrust,
      maximumAcceleration: motion.maximumAcceleration,
      torque: motion.torque,
    };
  }

  // --- 操作制御 ---

  // 毎フレーム、全ての基地に対して1度だけ呼ぶ。input が null なら操作されない。
  public updateControls(
    input: Input | null, dt: number, simDt: number,
    _registry: EntityRegistry, _activeStage: StageOutcome, _celestialBodies: CelestialBodies,
  ): void {
    if (input === null) {
      this.clearTransientCommands();
      return;
    }
    this.handleEdgeInput(input);
    this.motion.torque = this.throttle.updateTorque(
      this.motion.att, this.motion.state.r, this.motion.state.v, input, false, dt, simDt, this,
      () => {},  // 基地はプログレードホールド解除のヒントを出さない
    );
    this.throttle.updateThrustLatches(input);
    this.motion.thrust = this.throttle.updateThrustState(input, this.motion.att, simDt, this);
  }

  public clearTransientCommands(): void {
    this.motion.thrust = null;
    this.motion.torque = v3();
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

  // 画面マーカーと被選択判定が同じ個体を指すためのキー。
  private get markerKey(): string { return `base-${this.id}`; }

  // 基地のマーカー表示項目。pos/vel には構造メッシュと同じ表示時刻の状態を渡すこと。
  public markerItem(viewerPos: Vec3, pos: Vec3, vel: Vec3): GroupedMarkerItem {
    // 代表選出の優先度は、近い個体ほど高くする
    const dist = len(sub(pos, viewerPos));
    return {
      key: this.markerKey,
      kind: this.mapKind,
      cls: 'mk-base',
      sym: baseMarkerSvg(),
      pos,
      vel,
      priority: MARKER_PRIORITY.BASE - dist / 1e9,
      name: this.name,
      bearingColor: COLOR_MARKER_ALLY,
      bearingSym: ENTITY_GLYPH.base,
      bearingClass: 'mk-dir mk-ally-dir',
      bearingVisible: false,
      color: COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // セーブデータへ変換する。
  public override serialize(): BaseSaveData {
    return {
      id: this.id,
      kind: 'base',
      name: this.name,
      r: { ...this.motion.state.r },
      v: { ...this.motion.state.v },
      q: { ...this.motion.att.q },
      w: { ...this.motion.att.w },
      money: this._money,
      fuel: this.motion.fuel,
      throttle: this.throttle.serialize(),
      showTrajectoryLine: this.trajectoryLineVisible,
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

  // 自艦がいれば自艦からの距離。いなければ出さない。
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
  ): readonly MenuItem<MenuAction>[] {
    const subLabel = `基地 / 所持金: ${this._money.toLocaleString()} Cr`;
    const controlItem: MenuItem<MenuAction> = viewer === this
      ? { label: '操作対象を解除', act: 'deactivate' }
      : { label: '操作対象にする', act: 'activate' };

    return [
      { type: 'header', label: this.name, subLabel },
      MenuCommon.target(navTargetId === this.id),
      controlItem,
      MenuCommon.focus(),
      MenuCommon.trajectoryLine(this.trajectoryLineVisible),
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
      this.trajectoryLineVisible = !this.trajectoryLineVisible;
    } else if (act === 'delete') {
      controlSelection.remove(this);
    } else if (act === 'duplicate') {
      authoring?.openObjectPlacerForDuplicate(this.mapKind, this.motion.state);
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
      { key: 'money', label: '所持金', value: `${this._money.toLocaleString()} Cr` },
    ];
    if (viewer) rows.push({
      key: 'dist', label: '距離',
      value: fmtDist(len(sub(this.motion.state.r, viewer.motion.state.r))),
    });
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
