// 軌道上を飛ぶ物体は、艦艇も軌道基地も敵艦も、すべてこの1クラスである。何ができるかは
// 積んでいる搭載要素から決まる。
import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qInvert, qRotate } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { MU_EARTH, R_EARTH, earthAltitudeOf } from '../../physics/solar-system';
import { Vec3, len, scale, sub, v3 } from '../../physics/vec3';
import { Attractor, reachedBody } from '../../physics/attractor';
import type { InertiaTensor } from '../../physics/inertia-tensor';
import type { ActuatorSet } from '../../physics/attitude-control';
import { AttitudeControlSystem } from './attitude-control-system';
import { actuatorSetOf } from './actuator-set';
import { airspeed, burnUpBody } from '../../physics/atmosphere';
import { ballisticCoeffInv, radiationPressureCoeff } from '../../physics/aerodynamics';
import { buildVesselWireframe } from '../../render/vessel-wireframe';
import type { GraphicsSettings } from '../../render/graphics-settings';
import type { HullCapsule } from './collision-shape';
import { deriveCapsules } from './collision-shape';
import type { HeatShielding } from './heat-shield';
import { UNSHIELDED, ablate, heatShielding } from './heat-shield';
import { BaseCollisionGeometry, RayHit, SphereHit } from '../../physics/base-collision';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import * as C from '../const';
import { GameEntity } from '../game-entity/game-entity';
import { Bullet } from '../game-entity/bullet';
import { EntityIdAllocator } from '../game-entity/entity-id';
import { partFromSaveData, type AnyPart, type DockPort, type BaseModulePart, type Part } from '../game-entity/parts';
import type { EntityManager } from '../simulation/entity-manager';
import type { Contact } from '../simulation/contact';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { CameraSystem } from '../camera/camera-system';
import { focusTargetId } from '../camera/focus-target';
import type { MapVisibility } from '../celestial/map-visibility';
import type { DisplayWindow } from '../display-window-manager';
import { generateRandomName } from '../random-name';
import { celestialBodyName } from '../hud/frame-labels';
import { fmtMarkerDist } from '../hud/utils';
import type { Stage } from '../stages/stage';
import type { FloatingOrigin } from '../floating-origin';
import type { MarkerManager } from '../marker/marker-manager';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { DIRECTION_GLYPH, ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { MarkerRole } from '../targeter';
import { VesselThrottle } from '../vessel/throttle';
import { Gunnery, type AmmoLoad } from '../vessel/gunnery';
import { Belt } from '../vessel/belt';
import { ThermalSystem } from '../vessel/thermal';
import { RadiatorSide, RadiatorSystem } from '../vessel/radiator';
import { PowerSystem } from '../vessel/power';
import { ThrustEffects } from '../vessel/thrust-effects';
import { RcsEffects } from '../vessel/rcs-effects';
import { ReentryEffects } from '../vessel/reentry-effects';
import { PilotMarkers } from '../vessel/pilot-markers';
import { Plan } from '../plan/plan';
import { PlanExecutor, type PlanExecutionMode } from '../plan/plan-executor';
import {
  BASE_SAVE_FORMAT_VERSION,
  isSupportedBaseSaveFormat,
  resolveDockSlotIndices,
  type AssemblySaveData,
  type BaseSaveData,
  type EnemySaveData,
  type PlanSaveData,
  type PlayerSaveData,
} from '../save-data';
import type { VesselAssembly } from './assembly';
import type { MassProperties } from './mass-properties';
import { hasBaseModule } from './capabilities';
import { ResourceLedger } from '../economy/resource-ledger';
import type { PropellantId } from '../economy/propellant-compatibility';
import {
  BaseState as RawBaseState, baseAssemblyCollisionRadius, deriveBaseDockingPorts,
  DockedVesselEntry as RawDockedVesselEntry,
  portWorldPos, portWorldNormal,
} from './base-module';
import { EnemyAi, type EnemyKind } from './enemy-ai';
import { PartInventory } from './part-inventory';
import { vesselMarkerSvg } from './hp-marker-svg';
import {
  baseAssemblyFromSaveData, blueprintDesign, crewedShipDesign, hostileShipDesign, orbitalBaseDesign,
  type VesselDesign, type VesselFaction,
} from './vessel-designs';
import { createBlueprint, type VesselBlueprint } from './blueprint';

export type { PlanExecutionMode };

const PLAN_EXECUTION_LABELS: Record<PlanExecutionMode, string> = { off: 'OFF', instant: '瞬間移動', powered: '自動操縦' };

// mode の表示ラベル(HUDのメニュー項目・プロパティ行が共有する)。
export function planExecutionLabel(mode: PlanExecutionMode): string {
  return PLAN_EXECUTION_LABELS[mode];
}

const baseIdAllocator = new EntityIdAllocator('base-');

// 有人艦の新規配置。省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の円軌道に機首プログレードで置く。
export interface CrewedShipInit {
  readonly name?: string;
  readonly state?: KinematicState;
  readonly id?: string;
  readonly ammo?: AmmoLoad;
}

// 保存された設計から組む機体の新規配置。
export interface BlueprintShipInit {
  readonly blueprint: VesselBlueprint;
  readonly name?: string;
  readonly state: KinematicState;
  readonly id?: string;
}

export interface OrbitalBaseInit {
  readonly state: KinematicState;
  readonly name?: string;
  readonly att?: Attitude;
  readonly id?: string;
}

export interface HostileShipInit {
  readonly name: string;
  readonly state: KinematicState;
  readonly enemyKind: EnemyKind;
  readonly att: Attitude;
  readonly accent: string | number;
  readonly orbitLineColor: string | number;
  readonly waveId?: number;
  readonly id?: string;
}

// どの既定の設計で組むか。saved* から始まるものはスナップショットの復元。
export type VesselInit =
  | { readonly crewedShip: CrewedShipInit }
  | { readonly blueprintShip: BlueprintShipInit }
  | { readonly orbitalBase: OrbitalBaseInit }
  | { readonly hostileShip: HostileShipInit }
  | { readonly savedShip: PlayerSaveData; readonly simTime: number }
  | { readonly savedBase: BaseSaveData; readonly simTime: number }
  | { readonly savedHostile: EnemySaveData; readonly simTime: number };

// 機体の組み立てに要る、ゲーム側が持っている資源一式。
export interface VesselDeps {
  readonly hud: Hud;
  readonly worldSfx: WorldSfx;
  readonly scene: THREE.Scene;
  readonly fx: EffectsSystem;
  readonly markerManager: MarkerManager;
  readonly graphics: GraphicsSettings;
}

// 高度 INITIAL_ALT、傾斜角 INITIAL_INC_DEG の円軌道状態を返す。
function initialShipState(): KinematicState {
  const r0 = R_EARTH + C.INITIAL_ALT;
  const vCirc = Math.sqrt(MU_EARTH / r0);
  const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
  return kinematicState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
}

// state の速度方向を機首、位置方向を上として姿勢を組む。
function progradeAttitude(state: KinematicState, inertia: InertiaTensor): Attitude {
  return { q: qFromForwardUp(state.v, state.r) ?? { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia };
}

// init が指す既定の設計を返す。
function resolveDesign(init: VesselInit): VesselDesign {
  if ('blueprintShip' in init) return blueprintDesign(init.blueprintShip.blueprint);
  if ('crewedShip' in init) return crewedShipDesign();
  if ('savedShip' in init) {
    if (!init.savedShip.assembly) return crewedShipDesign();
    const saved = init.savedShip;
    const assembly = saved.assembly!;
    return blueprintDesign(createBlueprint({
      id: `${saved.id}-saved`, name: saved.name ?? saved.id,
      tree: assembly.tree, placements: assembly.placements, now: 0,
    }));
  }
  if ('orbitalBase' in init) return orbitalBaseDesign();
  if ('savedBase' in init) {
    const saved = init.savedBase;
    if (!isSupportedBaseSaveFormat(saved.formatVersion)) return orbitalBaseDesign();
    const assembly = baseAssemblyFromSaveData(saved.assembly);
    if (!assembly) return orbitalBaseDesign();
    try {
      return orbitalBaseDesign(assembly);
    } catch {
      // 断面・エッジ・配置の意味的な破損は設計導出時に例外になることがある。セーブ全体を失わず、
      // 既定基地で復元を続ける。
      return orbitalBaseDesign();
    }
  }
  if ('hostileShip' in init) return hostileShipDesign(init.hostileShip.enemyKind, init.hostileShip.accent);
  return hostileShipDesign(init.savedHostile.enemyKind, init.savedHostile.accent);
}

// 機体を名指すもの一式。設計とは別に、init ごとに決まる。
interface VesselIdentity {
  readonly name: string;
  readonly state: KinematicState;
  readonly att: Attitude;
  readonly id: string | undefined;
}

// init から、この機体の位置・姿勢・表示名・識別子を決める。姿勢は与えられていなければ
// 機首プログレードに置き、識別子は省略時に GameEntity 側の採番へ委ねて undefined を返す。
function resolveIdentity(init: VesselInit, design: VesselDesign): VesselIdentity {
  const inertia = design.massProperties.inertia;
  type Xyz = { x: number; y: number; z: number };
  const savedState = (s: { r: Xyz; v: Xyz }, t: number): KinematicState =>
    kinematicState(t, v3(s.r.x, s.r.y, s.r.z), v3(s.v.x, s.v.y, s.v.z));
  const savedAtt = (q: { x: number; y: number; z: number; w: number }, w: Xyz | undefined): Attitude =>
    ({ q: { ...q }, w: w ? v3(w.x, w.y, w.z) : v3(), inertia });

  if ('crewedShip' in init) {
    const { name, state, id } = init.crewedShip;
    const s = state ?? initialShipState();
    const n = name ?? generateRandomName('player');
    return { name: n, state: s, att: progradeAttitude(s, inertia), id: id ?? n };
  }
  if ('savedShip' in init) {
    const d = init.savedShip;
    return {
      name: d.name || d.id, state: savedState(d, init.simTime),
      att: savedAtt(d.q, d.w), id: d.id,
    };
  }
  if ('orbitalBase' in init) {
    const { state, name, att, id } = init.orbitalBase;
    return {
      name: name ?? generateRandomName('base'), state,
      att: att ? { ...att, inertia } : { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia },
      id: baseIdAllocator.next(id),
    };
  }
  if ('savedBase' in init) {
    const d = init.savedBase;
    return {
      name: d.name || '基地', state: savedState(d, init.simTime),
      att: d.q ? savedAtt(d.q, d.w) : { q: { x: 0, y: 0, z: 0, w: 1 }, w: v3(), inertia },
      id: baseIdAllocator.next(d.id),
    };
  }
  if ('hostileShip' in init) {
    const { name, state, att, id } = init.hostileShip;
    return { name, state, att: { ...att, inertia }, id };
  }
  if ('blueprintShip' in init) {
    const { blueprint, name, state, id } = init.blueprintShip;
    return { name: name ?? blueprint.name, state, att: progradeAttitude(state, inertia), id };
  }
  const d = init.savedHostile;
  return {
    name: d.name || '', state: savedState(d, init.simTime),
    att: savedAtt(d.q, d.w), id: d.id || undefined,
  };
}

// assembly は Three.js の Object3D を含まない値だが、保存境界で部品・配列をコピーしておく。これにより
// セーブ後の runtime 部品 HP や作業中の配列変更が、別の保存値を通じて設計へ逆流しない。
function serializeAssembly(assembly: VesselAssembly): AssemblySaveData {
  return {
    tree: assembly.tree,
    placements: assembly.placements.map((placement) => {
      const part = { ...placement.part };
      if (placement.kind === 'internal') return { ...placement, part, edgeIds: [...placement.edgeIds] };
      const mount = placement.mount.kind === 'port'
        ? { ...placement.mount, port: { ...placement.mount.port } }
        : { ...placement.mount };
      return { ...placement, part, mount };
    }),
  };
}

export class Vessel extends GameEntity {
  // 所属勢力。表示種別と、喪失をどう記録するかがここから決まる。
  public readonly faction: VesselFaction;
  // ツリーと、その上に配置された搭載要素。質量特性を直接与えられた機体(§5-3)では null。
  public assembly: VesselAssembly | null;
  // 質量・重心・慣性テンソル・投影面積。assembly から導くか、直接与えられる。
  public massProperties: MassProperties;
  // 狭域の接触形状。ツリーのエッジ1本につき1つで、形状を持たない機体では空になり外接球のままになる。
  public collisionCapsules: readonly HullCapsule[];
  // 搭載要素。HP と性能の唯一の源。
  private readonly inventory: PartInventory;

  // 抗力の断面積は、対気速度の向きから見た投影面積で決まる(§11-2)。細長い機体を横に向ければ
  // 抗力が数倍になり、進行方向へ向ければ最小になる。
  protected override get bcInv(): number {
    const { r, v } = this.state;
    const relative = qRotate(qInvert(this.att.q), airspeed(r, v));
    return ballisticCoeffInv(this.currentAreas, this.mass, relative);
  }

  protected override get srpCoeff(): number {
    return radiationPressureCoeff(this.currentAreas, this.mass);
  }

  // 予測の空力は主軸3方向の投影面積の平均で行う(§X-7)。姿勢を保てば予測より落ちにくく、
  // 回せば予測より速く落ちるという一方向のずれになる。展開度は姿勢と違っていま決まっている
  // 構成なので、平均する対象には入れない。
  protected override get predictionBcInv(): number {
    return ballisticCoeffInv(this.currentAreas, this.mass, v3());
  }

  // いまの構成の主軸3方向の投影面積 [m²]。設計の値は放熱板を完全に展開した状態なので、畳んだ
  // ぶんを差し引く — 展開したまま低軌道に留まれば、その面積ぶんの抗力を払い続けることになる。
  private get currentAreas(): Vec3 {
    const { principalAreas, deployableAreas } = this.massProperties;
    if (!this.radiator) return principalAreas;
    return sub(principalAreas, scale(deployableAreas, 1 - this.radiator.deployedFraction()));
  }

  // 対気速度の向きから見た、いま効いている熱防御(§11-3)。形状を持たない機体は素の閾値を持つ。
  public heatShielding(): HeatShielding {
    if (!this.assembly) return UNSHIELDED;
    const { r, v } = this.state;
    return heatShielding(
      this.assembly.tree, this.assembly.placements, qRotate(qInvert(this.att.q), airspeed(r, v)));
  }

  // 熱シールドが遮蔽した入熱 [J] のぶんアブレータを削る。尽きれば熱防御は失われる。
  public ablateHeatShields(shieldedHeat: number): void {
    if (this.assembly) ablate(this.assembly.placements, shieldedHeat);
  }
  protected readonly baseHistoryDuration = C.SHIP_HISTORY_DURATION;
  protected readonly predictedForGhost = true;

  public readonly throttle: VesselThrottle;
  // 砲と給弾ベルト。積んでいない設計では null。
  public readonly fire: Gunnery | null = null;
  public readonly belt: Belt | null = null;
  // 熱・放熱・電力の収支。持たない設計では null。
  public readonly thermal: ThermalSystem | null = null;
  public readonly radiator: RadiatorSystem | null = null;
  public readonly power: PowerSystem | null = null;
  // 敵対勢力の行動則。持たない機体では null。
  public readonly ai: EnemyAi | null = null;
  // 基地モジュールが与える在庫と収容。モジュールを積まない機体では null。
  public readonly baseState: RawBaseState<Vessel> | null = null;
  public collisionGeom: BaseCollisionGeometry | null = null;

  private readonly thrustEffects: ThrustEffects | null = null;
  private readonly rcsEffects: RcsEffects | null = null;
  private readonly reentryEffects: ReentryEffects | null = null;
  private readonly markers: PilotMarkers | null = null;

  // この機体自身のマニューバ計画。PlanEditor は操作対象のこれを編集する。
  public readonly plan = new Plan();
  public readonly planExecutor: PlanExecutor;
  // 軌道計画の自動実行モード。'powered' の間に手動の並進・回転入力があれば 'off' へ戻る。
  // 書き換えは setPlanExecution だけが行う — 通知を伴う状態変更の所有者を1つに定める(T-7)。
  private _planExecution: PlanExecutionMode = 'off';
  // 姿勢制御系。手動操作も自動操縦も、この機体のトルクを直接書かずここへ要求を出す。
  public readonly attitudeControl = new AttitudeControlSystem();
  // アクチュエータ集合は形状と搭載要素から導く。要素が壊れると顔ぶれが変わるので、HP が
  // 動いたときだけ組み直す。
  private actuators: ActuatorSet | null = null;
  private actuatorsHp = -1;
  private _fineAttitude = false;

  // 個体色・集団識別。敵対勢力の機体だけが持つ。
  private _accent: string | number | null = null;
  private _waveId: number | undefined = undefined;
  private _orbitLineColor: string | number | null = null;
  private _enemyKind: EnemyKind | null = null;

  public get accent(): string | number | null { return this._accent; }
  public get waveId(): number | undefined { return this._waveId; }
  public get orbitLineColor(): string | number | null { return this._orbitLineColor; }
  public get enemyKind(): EnemyKind | null { return this._enemyKind; }
  public get fineAttitude(): boolean { return this._fineAttitude; }
  public get planExecution(): PlanExecutionMode { return this._planExecution; }

  // 軌道計画の自動実行モードを切り替える唯一の入口。reason があれば通知する。
  public setPlanExecution(mode: PlanExecutionMode, reason?: string): void {
    if (this._planExecution === mode) return;
    this._planExecution = mode;
    if (reason) this.hud.hint(reason);
  }

  // 姿勢トルクを要求する。手動操作・自動操縦のどちらもこの口を通る。
  public requestTorque(torque: Vec3): void {
    this.attitudeControl.requestTorque(torque);
  }

  // この機体のアクチュエータ集合。搭載要素が壊れて顔ぶれが変わったときだけ組み直す。
  public actuatorSet(): ActuatorSet {
    if (!this.actuators || this.actuatorsHp !== this.hp) {
      this.actuators = actuatorSetOf(this.assembly, this.parts, this.massProperties.centerOfMass);
      this.actuatorsHp = this.hp;
    }
    return this.actuators;
  }

  // 要求を1刻みぶんアクチュエータへ配分し、機体が実際に受けるトルクを確定する。
  // 姿勢積分の直前に、シミュレーション時間の刻みで呼ぶ。
  public resolveAttitudeControl(simDt: number): void {
    this.torque = this.attitudeControl.resolve(this.actuatorSet(), this.state.r, this.att, simDt);
  }

  private readonly hpRegenRate: number;
  private readonly reentryAltMargin: number;
  private readonly maneuverEffectScale: number;
  private readonly directionMarkers: boolean;

  private readonly hud: Hud;
  private readonly worldSfx: WorldSfx;
  private readonly fx: EffectsSystem;
  private readonly vesselScene: THREE.Scene;
  private readonly graphics: GraphicsSettings;
  // 設計ツリー・当たり判定カプセルのデバッグ用ワイヤーフレーム。表示可否は毎フレーム
  // graphics.current.wireframe から合わせる — 設計を持たない機体では null のまま。
  private wireframe: THREE.Object3D | null = null;
  private disposed = false;

  // 設計と識別を init から解決し、その設計が積むものだけを組み立てる。
  public constructor(init: VesselInit, deps: VesselDeps) {
    // 設計・識別と、そこから決まる物理量。
    const design = resolveDesign(init);
    const identity = resolveIdentity(init, design);
    super(identity.state, design.renderObject, deps.scene, identity.att, identity.id);
    this.name = identity.name;
    this.faction = design.faction;
    this.assembly = design.assembly;
    this.collisionCapsules = design.assembly ? deriveCapsules(design.assembly.tree) : [];
    this.graphics = deps.graphics;
    if (design.assembly) {
      this.wireframe = buildVesselWireframe(design.assembly.tree, this.collisionCapsules);
      this.wireframe.visible = this.graphics.current.wireframe;
      this.renderObject.add(this.wireframe);
    }
    this.massProperties = design.massProperties;
    this.mass = design.massProperties.mass;
    this.radius = design.radius;
    this.collides = true;
    this.hpRegenRate = design.hpRegenRate;
    this.reentryAltMargin = design.reentryAltMargin;
    this.maneuverEffectScale = design.maneuverEffectScale;
    this.directionMarkers = design.directionMarkers;
    this.hud = deps.hud;
    this.worldSfx = deps.worldSfx;
    this.fx = deps.fx;
    this.vesselScene = deps.scene;
    this.inventory = new PartInventory(design.parts);

    // 姿勢・並進の操作は全ての機体が持つ。
    const savedShip = 'savedShip' in init ? init.savedShip : undefined;
    this.throttle = new VesselThrottle(deps.hud, savedShip?.throttle ?? ('savedBase' in init ? init.savedBase.throttle : undefined));
    this.planExecutor = new PlanExecutor(deps.hud);

    // 設計が積むと言った系だけを組む。
    if (design.gunnery) {
      this.fire = new Gunnery(this, deps.hud, deps.worldSfx, deps.scene, deps.fx,
        savedShip ? { saved: savedShip.fire } : { ammo: 'crewedShip' in init ? init.crewedShip.ammo : undefined });
      this.belt = new Belt(this.renderObject, this);
    }
    if (design.lifeSupport) {
      this.thermal = new ThermalSystem(deps.hud, deps.worldSfx, savedShip?.thermal);
      this.radiator = new RadiatorSystem(this.renderObject, this, savedShip?.radiator);
      this.power = new PowerSystem(this.renderObject, savedShip?.power);
      this.reentryEffects = new ReentryEffects(deps.scene);
    }
    if (design.maneuverEffectScale > 0) {
      this.thrustEffects = new ThrustEffects(deps.scene, deps.worldSfx);
      this.rcsEffects = new RcsEffects(deps.scene, deps.worldSfx);
    }
    // 操縦(方向マーカー・ボアサイト)を持たない機体でも、操作対象になれば自機位置マーカーは要る。
    if (design.directionMarkers || hasBaseModule(this)) {
      this.markers = new PilotMarkers(deps.markerManager, this.id, this);
    }
    if (design.faction === 'enemy') {
      this.ai = new EnemyAi(this, deps.worldSfx, deps.scene);
    }
    // 基地モジュールを積んだ機体だけが在庫と収容を持ち、常設の軌道構造物として
    // 赤道交点マーカーを出す。
    if (hasBaseModule(this)) {
      this.baseState = { inventory: [], dockedVessels: [], resources: new ResourceLedger() };
      // assembly付きの基地は、旧render/shipsの固定形状ではなく保存されたassemblyから衝突形状を
      // 導く。assembly無しの旧セーブは従来の固定LOD・半径を使い、旧データの挙動を変えない。
      const savedBaseAssembly = 'savedBase' in init && isSupportedBaseSaveFormat(init.savedBase.formatVersion)
        ? baseAssemblyFromSaveData(init.savedBase.assembly)
        : null;
      if ((savedBaseAssembly || !('savedBase' in init)) && this.assembly) {
        this.radius = baseAssemblyCollisionRadius(this.assembly);
        this.collisionGeom = new BaseCollisionGeometry(this.assembly);
      } else {
        this.collisionGeom = new BaseCollisionGeometry();
      }
      this.equatorNodes = new EquatorNodeMarkerPair(this, deps.markerManager);
    }

    // 敵対勢力の機体だけが持つ個体色と集団識別。
    if ('hostileShip' in init) {
      this._accent = init.hostileShip.accent;
      this._orbitLineColor = init.hostileShip.orbitLineColor;
      this._waveId = init.hostileShip.waveId;
      this._enemyKind = init.hostileShip.enemyKind;
    }

    // スナップショットからの復元は、組み上がった機体へ最後に載せる。
    if (savedShip) this.restoreShip(savedShip, deps.hud);
    if ('savedBase' in init) this.restoreBase(init.savedBase, init.simTime, deps);
    if ('savedHostile' in init) this.restoreHostile(init.savedHostile);
  }

  // --------------------------------------------------------------- 復元
  // 有人艦の保存形から、自動実行モード・姿勢微調整・搭載要素・計画を戻す。
  private restoreShip(saved: PlayerSaveData, hud: Hud): void {
    // planExecution を持たず followPlan: boolean で保存された形も受ける(true→'instant')。
    this._planExecution = saved.planExecution ?? (saved.followPlan ? 'instant' : 'off');
    this._fineAttitude = saved.fineAttitude ?? false;
    const restoredParts = saved.parts.map(partFromSaveData);
    this.inventory.replaceAll(restoredParts);
    if (saved.assembly && this.assembly) {
      const byId = new Map(restoredParts.map((part) => [part.id, part]));
      this.assembly = {
        tree: saved.assembly.tree,
        placements: saved.assembly.placements.map((placement) => ({
          ...placement,
          part: byId.get(placement.part.id) ?? placement.part,
        })),
      };
    }
    this.restorePlan(saved.plan, hud);
  }

  // 敵対勢力の機体の保存形から、個体色・集団識別・残 HP・バースト射撃の途中経過を戻す。
  private restoreHostile(saved: EnemySaveData): void {
    this._accent = saved.accent;
    this._orbitLineColor = saved.accent;
    this._enemyKind = saved.enemyKind;
    this._waveId = saved.waveId;
    this.inventory.setOverallHp(saved.health);
    if (this.ai) {
      this.ai.burstLeft = saved.burstLeft;
      this.ai.burstDelay = saved.burstDelay;
    }
    this.alive = saved.alive;
    if (!this.alive) this.renderObject.visible = false;
  }

  // 基地の保存形から、在庫・燃料・収容中の機体を戻す。収容機は保存形から組み直し、
  // スロットへ取り付けたうえで一覧へ加える。
  private restoreBase(saved: BaseSaveData, simTime: number, deps: VesselDeps): void {
    const state = this.baseState!;
    state.inventory = (saved.inventory ?? []).map(partFromSaveData);
    if (saved.fuel !== undefined) {
      this.inventory.consumeFuel('hydrazine', this.inventory.fuelOf('hydrazine'));
      this.inventory.refuel('hydrazine', saved.fuel);
    }
    const savedVessels = saved.dockedVessels ?? saved.dockedShips ?? [];
    const portIndexById = new Map<string, number>();
    for (let slot = 0; slot < this.dockCapacity; slot++) {
      const portId = this.getDockPortId(slot);
      if (portId) portIndexById.set(portId, slot);
    }
    const slotIndices = resolveDockSlotIndices(saved.dockBindings, savedVessels, this.dockCapacity, portIndexById);
    state.dockedVessels = savedVessels.map((data, idx) => {
      const vessel = new Vessel({ savedShip: data, simTime }, deps);
      const slotIndex = slotIndices[idx] ?? 0;
      this.attachDockedVesselMesh(vessel, slotIndex);
      return { id: vessel.id, name: vessel.name, hp: vessel.hp, maxHp: vessel.maxHp, parts: vessel.parts, vessel, slotIndex };
    });
  }

  // 保存された計画を復元する。起点は addNode の from として与え、最初の1件が通った時点で凍結される。
  private restorePlan(saved: PlanSaveData | null | undefined, hud: Hud): void {
    if (!saved) return;
    const anchor = kinematicState(
      saved.anchor.t,
      v3(saved.anchor.r.x, saved.anchor.r.y, saved.anchor.r.z),
      v3(saved.anchor.v.x, saved.anchor.v.y, saved.anchor.v.z),
    );
    let rejected = 0;
    for (const n of saved.nodes) {
      if (this.plan.addNode(kinematicState(n.t, v3(n.r.x, n.r.y, n.r.z), v3(n.v.x, n.v.y, n.v.z)), anchor) < 0) rejected++;
    }
    if (rejected > 0) hud.hint(`${this.name}: 起点より前のマニューバノード ${rejected} 件を復元できません`);
  }

  // --------------------------------------------------------- 搭載要素と性能
  public get parts(): AnyPart[] { return this.inventory.parts; }
  public get hp(): number { return this.inventory.hp; }
  public get maxHp(): number { return this.inventory.maxHp; }
  public get totalTorque(): number { return this.inventory.totalTorque; }
  public get totalThrust(): number { return this.inventory.totalThrust; }
  public get totalRcsThrust(): number { return this.inventory.totalRcsThrust; }
  public get totalCoolingRate(): number { return this.inventory.totalCoolingRate; }
  public get totalPowerGeneration(): number { return this.inventory.totalPowerGeneration; }
  public get totalFireRate(): number { return this.inventory.totalFireRate; }
  public get weaponDamage(): number { return this.inventory.weaponDamage; }
  public get averageMuzzleVelocity(): number { return this.inventory.averageMuzzleVelocity; }
  public get solarParts(): readonly (Part | undefined)[] { return this.inventory.solarParts; }

  public fuelOf(propellant: PropellantId): number { return this.inventory.fuelOf(propellant); }
  public maxFuelOf(propellant: PropellantId): number { return this.inventory.maxFuelOf(propellant); }
  public propellantSummary(): ReturnType<PartInventory['propellantSummary']> {
    return this.inventory.propellantSummary();
  }
  public consumeFuel(propellant: PropellantId, amount: number): number {
    return this.inventory.consumeFuel(propellant, amount);
  }
  public refuel(propellant: PropellantId, amount: number): void { this.inventory.refuel(propellant, amount); }
  public engineFuelConsumptionRates(): ReadonlyMap<PropellantId, number> {
    return this.inventory.engineFuelConsumptionRates();
  }
  public rcsFuelConsumptionRates(): ReadonlyMap<PropellantId, number> {
    return this.inventory.rcsFuelConsumptionRates();
  }
  public consumeFuelByRates(rates: ReadonlyMap<PropellantId, number>, scale: number): number {
    return this.inventory.consumeFuelByRates(rates, scale);
  }
  public refreshFromParts(): void { this.inventory.refresh(); }
  public applyDamageToParts(amount: number, part?: Part): void { this.inventory.applyDamage(amount, part); }
  public selfRepair(amount: number): void { this.inventory.selfRepair(amount); }

  /**
   * Apply an edited assembly to a live base while keeping its identity and operational state.
   * The workbench calls this only after base-specific validation has succeeded.
   */
  public replaceAssembly(assembly: VesselAssembly): { ok: true } | { ok: false; reason: string } {
    if (!this.baseState) return { ok: false, reason: '基地ではありません' };
    try {
      const design = orbitalBaseDesign(assembly);
      const capsules = deriveCapsules(assembly.tree);
      const collisionGeom = new BaseCollisionGeometry(assembly);
      const wireframe = buildVesselWireframe(assembly.tree, capsules);
      wireframe.visible = this.graphics.current.wireframe;
      const dockedObjects = new Set(this.baseState.dockedVessels.map((entry) => entry.vessel.renderObject));
      const oldChildren = [...this.renderObject.children].filter((child) =>
        !dockedObjects.has(child) && child.userData['workbenchDraft'] !== true);
      for (const child of oldChildren) {
        this.renderObject.remove(child);
        disposeVesselObject(child);
      }
      for (const child of [...design.renderObject.children]) this.renderObject.add(child);
      this.renderObject.add(wireframe);
      this.wireframe = wireframe;

      this.assembly = assembly;
      this.collisionCapsules = capsules;
      this.collisionGeom = collisionGeom;
      this.massProperties = design.massProperties;
      this.mass = design.massProperties.mass;
      this.radius = design.radius;
      this.att = { ...this.att, inertia: design.massProperties.inertia };
      this.inventory.replaceAll(design.parts);
      for (const entry of this.baseState.dockedVessels) this.attachDockedVesselMesh(entry.vessel, entry.slotIndex);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // 自身が受けた速度変化 dv = impulse/mass に応じたダメージをパーツへ適用し、
  // ダメージが発生したかを返す。part を指定すると割り振り先をそのパーツに固定する。
  private applyCollisionDamage(dv: number, part?: Part): boolean {
    const span = C.COLLISION_DAMAGE_FULL_DV - C.COLLISION_DAMAGE_MIN_DV;
    const t = Math.min(1, Math.max(0, (dv - C.COLLISION_DAMAGE_MIN_DV) / span));
    if (t <= 0) return false;
    this.applyDamageToParts(this.maxHp * t, part);
    return true;
  }

  // ------------------------------------------------------------ 基地モジュール
  private get baseModule(): BaseModulePart | null {
    for (const p of this.parts) if (p.type === 'base_module' && p.hp > 0) return p;
    return null;
  }

  private get dockPorts() {
    return deriveBaseDockingPorts(this.assembly, this.baseModule);
  }

  // 収容できる機体数。固定base_module.capacityではなく、assemblyから解決できた安定ポート数を返す。
  public get dockCapacity(): number { return this.dockPorts.slots.length; }

  // 作業台・セーブが参照できる安定したドックポートID。slotIndexは表示順であり、永続参照には使わない。
  public getDockPortId(slotIndex: number): string | null {
    return this.dockPorts.slots[slotIndex]?.id ?? null;
  }

  public getSlotIndexForDockPortId(portId: string): number | null {
    const index = this.dockPorts.slots.findIndex((port) => port.id === portId);
    return index >= 0 ? index : null;
  }

  // 中央ハッチのワールド位置と外向き法線。カスタム基地でhatchが無い場合は最初のドック口を
  // 互換用の主口として返し、口が一つも無ければ機体そのものへ戻す。
  public getHatchWorldPos(): Vec3 {
    const ports = this.dockPorts;
    const port = ports.hatch ?? ports.slots[0];
    return port ? portWorldPos(this, port) : this.state.r;
  }

  public getHatchWorldNormal(): Vec3 {
    const ports = this.dockPorts;
    const port = ports.hatch ?? ports.slots[0];
    return port ? portWorldNormal(this, port) : v3(0, 1, 0);
  }

  private slotPort(slotIndex: number): DockPort | null {
    const slots = this.dockPorts.slots;
    if (slots.length === 0) return null;
    return slots[slotIndex] ?? slots[0]!;
  }

  public getSlotWorldPos(slotIndex: number): Vec3 {
    const port = this.slotPort(slotIndex);
    return port ? portWorldPos(this, port) : this.state.r;
  }

  public getSlotWorldNormal(slotIndex: number): Vec3 {
    const port = this.slotPort(slotIndex);
    return port ? portWorldNormal(this, port) : v3(0, 1, 0);
  }

  // 利用可能な空きスロット番号を返す。満杯なら null。
  public getAvailableSlotIndex(): number | null {
    if (!this.baseState) return null;
    const occupied = new Set(this.baseState.dockedVessels.map((s) => s.slotIndex));
    for (let i = 0; i < this.dockCapacity; i++) if (!occupied.has(i)) return i;
    return null;
  }

  // 収容判定の閾値。基地モジュールを積んでいなければ受け入れない。
  public canCapture(other: Vessel): boolean {
    const module = this.baseModule;
    const ports = this.dockPorts;
    if (!module || !this.baseState || ports.slots.length === 0) return false;
    if (this.baseState.dockedVessels.length >= ports.slots.length) return false;
    if (len(sub(other.state.v, this.state.v)) > ports.captureRelSpeed) return false;
    const accepts = (port: DockPort & { readonly maxVesselSize?: number }, maxDist: number, minAlignment: number): boolean => {
      if (port.maxVesselSize !== undefined && other.radius > port.maxVesselSize) return false;
      const pos = portWorldPos(this, port);
      const d = sub(other.state.r, pos);
      const dist = len(d);
      if (dist > maxDist) return false;
      const normal = portWorldNormal(this, port);
      return (d.x * normal.x + d.y * normal.y + d.z * normal.z) / Math.max(dist, 1e-9) >= minAlignment;
    };
    for (const slot of ports.slots) {
      if (accepts(slot, ports.slotCaptureDist, ports.slotCaptureAlignment)) return true;
    }
    return ports.hatch
      ? accepts(ports.hatch, ports.hatchCaptureDist, ports.hatchCaptureAlignment)
      : false;
  }

  // 収容した機体のメッシュを、指定スロットへ取り付けて表示する。
  public attachDockedVesselMesh(vessel: Vessel, slotIndex: number): void {
    this.placeAtDockSlot(vessel.renderObject, slotIndex);
  }

  // 任意のメッシュをドック口へ据える。口の法線へ +Z を向け、基地の子にする。収容艦も、まだ
  // 実機になっていない下書きも、置かれ方が食い違わないようにここを共有する。
  public placeAtDockSlot(obj: THREE.Object3D, slotIndex: number): void {
    const port = this.slotPort(slotIndex);
    if (!port) return;
    obj.visible = true;
    obj.position.set(port.localPos.x, port.localPos.y, port.localPos.z);
    const dir = new THREE.Vector3(port.localNormal.x, port.localNormal.y, port.localNormal.z);
    obj.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
    if (obj.parent !== this.renderObject) this.renderObject.add(obj);
  }

  // 発進時、収容した機体のメッシュをスロットから分離し、ワールド Scene へ復帰させる。
  public detachDockedVesselMesh(vessel: Vessel): void {
    const obj = vessel.renderObject;
    if (obj.parent === this.renderObject) this.renderObject.remove(obj);
    if (this.scene && obj.parent !== this.scene) this.scene.add(obj);
    obj.visible = true;
  }

  public raycast(rayOrigin: Vec3, rayDir: Vec3, maxDist: number, warpLevel = 1): RayHit | null {
    return this.collisionGeom?.raycast(rayOrigin, rayDir, maxDist, this.state.r, this.att.q, warpLevel) ?? null;
  }

  public testSphereCollision(sphereCenter: Vec3, sphereRadius: number, warpLevel = 1): SphereHit | null {
    return this.collisionGeom?.testSphereCollision(sphereCenter, sphereRadius, this.state.r, this.att.q, warpLevel) ?? null;
  }

  // ----------------------------------------------------------------- 操作
  public get rcsDamp(): boolean { return this.throttle.rcsDamp; }
  public get throttleIdx(): number { return this.throttle.throttleIdx; }
  public get progradeHold(): boolean { return this.throttle.progradeHold; }
  public get roundsInMag(): number { return this.fire?.rounds ?? 0; }
  public get magsLeft(): number { return this.fire?.mags ?? 0; }
  public get magsLeftInBarrel(): number { return this.fire?.barrel ?? 0; }
  public get reloadTimer(): number { return this.fire?.cooldown ?? 0; }
  public get isFiring(): boolean { return this.fire?.isFiring ?? false; }

  // 弾薬ピックアップで得たマグ数を加算する。
  public onPickup(mags: number): void { this.fire?.onPickup(mags); }

  // 毎フレーム、全ての機体に対して1度だけ呼ぶ。input が null の機体はこのフレーム操作されないので、
  // 次フレームへ持ち越してはならない連続指令をここで畳む。受動状態(ベルト物理・HP自然回復)は
  // 操作の可否によらず進める。
  public updateControls(
    input: Input | null,
    dt: number,
    simDt: number,
    entities: EntityManager,
    activeStage: Stage,
    ephemeris: Ephemeris,
  ): void {
    this.updatePassive(dt);
    if (input === null) {
      this.clearTransientCommands();
      return;
    }
    input.takeKeys((code) => this.handleEdgePress(code));
    // 発砲中は姿勢微調整と同じ操作精度になる
    const fine = this._fineAttitude || this.isFiring;
    this.attitudeControl.requestTorque(this.throttle.updateTorque(
      this.att, this.state.r, this.state.v, input, fine, dt, simDt, this,
      () => this.hud.hint('進行方向ホールド解除(手動操作)'),
    ));
    this.fire?.updateFireState(dt, input, activeStage, entities, ephemeris);
    this.throttle.updateThrustLatches(input);
    this.thrust = this.throttle.updateThrustState(input, this.att, simDt, this);
    // 噴射中は毎フレーム破棄する — 次の Predictor がその時点の実状態を種に作り直す。
    if (this.thrust !== null) this.invalidatePrediction();

    // 手動並進・手動回転は 'powered' 自動実行を中断する(進行方向ホールドが手動回転で
    // 解除されるのと同じ作法)。
    if (this._planExecution === 'powered'
      && (this.thrust !== null || this.throttle.hasManualRotationInput(input))) {
      this.setPlanExecution('off', '軌道計画の自動実行を中断(手動操作)');
    }
  }

  // 表示フレーム基準の受動状態。環境(熱・電力・ラジエータ)は stepEnvironment で
  // simulation clock に合わせて進めるため、ここで重複させない。
  private updatePassive(dt: number): void {
    this.belt?.update(dt, this.fire?.mags ?? 0, this.fire?.rounds ?? 0, this.att, this.throttle.thrustAccelVec);
    if (this.hpRegenRate > 0 && this.hp > 0 && this.hp < this.maxHp) {
      this.selfRepair(dt * this.hpRegenRate);
    }
  }

  // 軌道・姿勢と同じ simulation clock で受動環境系を進める。bodies はこの substep の天体窓で、
  // 恒星の取り出しと日照率の遮蔽体に使う。
  public stepEnvironment(dt: number, ephemeris: Ephemeris, simTime: number, bodies: readonly Attractor[]): void {
    if (!this.alive || !this.thermal || !this.radiator || !this.power) return;
    this.radiator.update(dt, this.radiatorWear());
    const sunDir = ephemeris.sunDirFrom(this.state.r, simTime);
    const star = bodies.find((a) => a.id === ephemeris.starId);
    const sunlit = star ? sunlitFactor(this.state.r, star, bodies) : 1;
    this.thermal.setRadiatorLoad(
      this.radiator.radiatingArea(this.totalCoolingRate),
      this.radiator.solarLoad(sunlit, sunDir, this.att, this.totalCoolingRate),
    );
    this.power.update(dt, sunlit, sunDir, this.att, this);
    this.thermal.updateThermal(dt, this.state.r, this.state.v, this);
  }

  // 操作できない間、次のフレームへ持ち越してはならない連続指令を畳む。
  // 角速度によるcoast自体は継続する。
  public clearTransientCommands(): void {
    this.thrust = null;
    this.torque = v3();
    this.attitudeControl.clearRequest();
    this.throttle.clearTransientState();
    this.fire?.stopFiring();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  public toggleFineAttitude(): void {
    this._fineAttitude = !this._fineAttitude;
    this.hud.hint(`姿勢微調整モード: ${this._fineAttitude ? 'ON' : 'OFF'}`);
  }

  // 機体側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.throttleMax.code: this.throttle.setThrottlePreset(3); return true;
      case K.radiatorDeployLeft.code: if (!this.radiator) return false; this.radiator.toggle('up'); return true;
      case K.radiatorDeployRight.code: if (!this.radiator) return false; this.radiator.toggle('down'); return true;
      case K.solarDeployLeft.code: if (!this.power) return false; this.power.toggle('up'); return true;
      case K.solarDeployRight.code: if (!this.power) return false; this.power.toggle('down'); return true;
      // マニュアルリロードに成功した場合だけキーを消費する
      case K.reload.code: return this.fire?.manualReload() ?? false;
      default: return false;
    }
  }

  // side に対応する放熱板パーツ。RadiatorSystem がメッシュから読んだ partId で引くので、
  // 積んだ順ではなく実際にその側へ置かれたパーツを指す。
  private radiatorPartAt(side: RadiatorSide): Part | undefined {
    const partId = this.radiator?.partIdOf(side);
    return partId ? this.parts.find((p) => p.id === partId) : undefined;
  }

  // 放熱板パーツの残 HP から side ごとの損耗率を組む。パーツが欠けている側は全損扱い。
  private radiatorWear(): Record<RadiatorSide, number> {
    const wearOf = (part: Part | undefined): number =>
      part && part.maxHp > 0 ? 1 - part.hp / part.maxHp : 1;
    return { up: wearOf(this.radiatorPartAt('up')), down: wearOf(this.radiatorPartAt('down')) };
  }

  // ------------------------------------------------------------ 損傷と喪失
  // この機体を失ったことをステージへ記録する。敵対勢力なら撃墜、基地モジュールを持たない
  // 自勢力機なら機体の喪失、基地は決着に関わらない。
  private recordLoss(activeStage: Stage, simTime: number, reason: string, cause: 'killed' | 'reentry' | 'despawn'): void {
    if (this.faction === 'enemy') {
      activeStage.recordEnemyDeath(this, simTime, cause);
      return;
    }
    if (!hasBaseModule(this)) activeStage.recordPlayerLost(reason);
  }

  // 被弾によるダメージ・致死判定。side を指定するとその放熱板パーツへ、無指定なら
  // 無作為なパーツへダメージが入る。
  private attackedByBullet(
    bullet: Bullet, impactPoint: Vec3, simTime: number, activeStage: Stage, side: RadiatorSide | null = null,
  ): void {
    if (this.faction === 'enemy') {
      activeStage.scoreCounter.recordHit();
      this.applyDamageToParts(bullet.damage);
    } else {
      this.thermal?.addImpactHeat();
      const damagedPart = side === null ? undefined : this.radiatorPartAt(side);
      this.applyDamageToParts(side === null ? bullet.damage : C.RADIATOR_BULLET_DAMAGE, damagedPart);
      if (side !== null && damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side);
    }
    if (this.hp > 0) {
      this.impactEffect(bullet, impactPoint);
      return;
    }
    this.alive = false;
    const reason = this.faction === 'enemy'
      ? ''
      : (bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した');
    this.recordLoss(activeStage, simTime, reason, 'killed');
    this.destroyEffect();
  }

  // 弾は武装のダメージを、それ以外は接触の速度変化 Δv = impulse/mass を根拠にする
  // (前者はゲームバランス、後者は物理量で、統合すると前者の根拠が消える)。
  public collideWith(other: GameEntity | Attractor, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    const simTime = contact.selfState.t;
    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, simTime, activeStage);
      return;
    }
    if (!this.applyCollisionDamage(contact.impulse / this.mass)) return;
    if (this.hp > 0) {
      this.worldSfx.clank();
      this.fx.spawnGasPuff(this.state);
      return;
    }
    this.alive = false;
    this.recordLoss(activeStage, simTime, '高速接触により機体を喪失した', 'killed');
    this.destroyEffect();
  }

  // 放熱板の接触代理(RadiatorFold)が受けた接触を解決する。ダメージは side の放熱板パーツへ
  // 入り、そのパーツが全損すれば破片エフェクトを出す。
  public collideAtRadiator(side: RadiatorSide, other: GameEntity | Attractor, contact: Contact, activeStage: Stage): void {
    if (!this.alive) return;
    const simTime = contact.selfState.t;
    if (other instanceof Bullet) {
      this.attackedByBullet(other, contact.point, simTime, activeStage, side);
      return;
    }
    const damagedPart = this.radiatorPartAt(side);
    if (!this.applyCollisionDamage(contact.impulse / this.mass, damagedPart)) return;
    if (damagedPart && damagedPart.hp <= 0) this.radiatorBreakEffect(side);
    if (this.hp > 0) {
      this.worldSfx.clank();
      this.fx.spawnGasPuff(this.state);
      return;
    }
    this.alive = false;
    this.recordLoss(activeStage, simTime, '高速接触により機体を喪失した', 'killed');
    this.destroyEffect();
  }

  // この機体の放熱板の、今フレームの接触代理一覧(展開中かつ健在な折りのみ)。
  public collisionFolds(simTime: number): GameEntity[] {
    return this.radiator?.collisionFolds(this.state.r, this.state.v, this.att, simTime) ?? [];
  }

  // 交戦圏外への離脱によるデスポーン。
  public despawn(simTime: number, activeStage: Stage): void {
    if (!this.alive) return;
    this.alive = false;
    this.recordLoss(activeStage, simTime, '', 'despawn');
  }

  // 熱防御の飽和・空力破壊・大気突入・天体の地表到達の判定(自然死)。
  public checkLoss(dt: number, simTime: number, activeStage: Stage, _viewerPos: Vec3, attractors: readonly Attractor[]): void {
    if (!this.alive) return;
    let reason: string | null = null;
    if (this.thermal) {
      const limit = this.thermal.updateAltitudeAlarm(dt, earthAltitudeOf(this.state.r));
      if (limit === 'heat-aero') reason = `${this.name} は断熱圧縮による加熱で熱防御が飽和し、焼失した`;
      else if (limit === 'heat-internal') reason = `${this.name} は排熱が追いつかず、熱で機能不全に陥った`;
      else if (limit === 'dynpressure') reason = `${this.name} は動圧が構造限界を超え、空力的に分解した`;
    }
    if (reason === null) {
      const burnUp = burnUpBody(this.state.r, attractors, this.reentryAltMargin);
      if (burnUp !== null) reason = `${this.name} は ${celestialBodyName(burnUp.id)} の大気圏に突入し、焼失した`;
      else {
        const impact = reachedBody(this.actual.prevState, this.state, attractors, this.reentryAltMargin);
        if (impact !== null) reason = `${this.name} は ${celestialBodyName(impact.body.id)} の地表へ到達し、失われた`;
      }
    }
    if (reason === null) return;
    this.alive = false;
    this.destroyEffect();
    this.recordLoss(activeStage, simTime, reason, 'reentry');
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private impactEffect(bullet: Bullet, impactPoint: Vec3): void {
    if (this.faction === 'enemy') this.worldSfx.enemyHit();
    else this.worldSfx.hit();
    const at = kinematicState(this.state.t, impactPoint, this.state.v);
    if (bullet.type === 'plasma') this.fx.spawnPlasmaFlash(at);
    else this.fx.spawnBulletFlash(at);
    this.fx.spawnGasPuff(at);
  }

  // 機体喪失時の爆発音・爆発エフェクト。演出の大きさは機体の見た目のスケールに揃える。
  private destroyEffect(): void {
    this.worldSfx.explosion();
    const scale = this.faction === 'enemy' ? C.ENEMY_SCALE : 1;
    const color = this.faction === 'enemy' ? C.COLOR_ENEMY_DESTROY_FRAG : C.COLOR_PLAYER_DESTROY_FRAG;
    this.fx.spawnShipDestroyEffect(this.state, scale, color);
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide): void {
    if (!this.radiator) return;
    this.worldSfx.hit();
    const tipR = this.radiator.tipWorldPosition(side, this.state.r, this.att);
    this.fx.scatterFragments(this.state.t, tipR, this.state.v, 4, C.COLOR_PLAYER_DESTROY_FRAG, C.DESTROY_FRAG_SIZE_MIN, C.DESTROY_FRAG_SIZE_MAX, 8.0);
  }

  // ----------------------------------------------------------------- 表示
  // 個体色の CSS 表記。方位マーカー・LEAD マーカーの着色に使う。
  public get accentColor(): string {
    if (this.accent === null) return C.COLOR_MARKER_ALLY;
    if (typeof this.accent === 'string') return this.accent;
    return '#' + this.accent.toString(16).padStart(6, '0');
  }

  // マーカープールのキー。同じ機体が同じ鍵を使い続けるように1箇所で決める。
  public get markerKey(): string {
    if (this.baseState) return `base-${this.id}`;
    return this.faction === 'enemy' ? `enemy-${this.name}` : `player-${this.id}`;
  }

  // 設計ツリーのワイヤーフレームの表示可否を押し込む。syncVessel より後に呼ぶこと —
  // syncVessel も毎フレーム graphics.current.wireframe から同じ値を書くので、後から呼んだ側が勝つ。
  // 呼ぶのをやめただけでは戻らない機体がある(基地へ格納された艦は vessels から外れ、
  // syncVessel 自体が走らなくなる)ので、露出をやめる側が false を明示して戻す。
  public setStructureVisible(visible: boolean): void {
    if (this.wireframe) this.wireframe.visible = visible;
  }

  // メッシュ・エフェクト・ベルト・マーカーを displayTime の状態へ同期する。
  // isActive はこの機体が操作対象かどうか。操作対象だけがガンサイト時に隠れ、方位マーカーを出す。
  public syncVessel(
    fo: FloatingOrigin,
    camera: CameraSystem,
    displayTime: number,
    isActive: boolean,
    ephemeris: Ephemeris,
    attractors: readonly Attractor[],
    visibility: MapVisibility | null = null,
    displayWindow?: DisplayWindow,
  ): void {
    const displayState = this.displayState(displayTime);
    const mapEntityVisible = !camera.overviewMode || visibility === null || visibility.category;
    const hiddenByGunsight = isActive && camera.zoomActive && this.directionMarkers;
    this.renderObject.visible = displayState !== null && mapEntityVisible && !hiddenByGunsight;
    if (this.wireframe) this.wireframe.visible = this.graphics.current.wireframe;
    if (displayState !== null) {
      this.renderObject.position.copy(fo.RtoThreeV3(displayState.r));
      this.renderObject.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    }

    // 推力/RCS エフェクトとベルト。機体メッシュと同じ displayState に載せる —
    // 揃えないと「機体は未来位置、プルームは現在位置」に割れる。表示できる状態が無いときは
    // 各エフェクトが自分で消えられるよう visible を倒して呼ぶ。
    const effectState = displayState ?? this.state;
    const effectVisible = displayState !== null && mapEntityVisible;
    const maxAccel = this.mass > 0 ? this.totalThrust / this.mass : 0;
    this.thrustEffects?.sync(fo, effectState.r, this.thrust, maxAccel, effectVisible, isActive, camera, this.maneuverEffectScale);
    this.rcsEffects?.sync(
      fo, effectState.r, this.attitudeControl.allocation, this.actuatorSet(), this.torque, this.att,
      effectVisible, camera, isActive, this.maneuverEffectScale);
    this.reentryEffects?.sync(fo, effectState.r, effectState.v, this.thermal?.qdyn ?? 0, effectVisible, camera);
    this.belt?.sync();
    this.radiator?.sync();
    this.power?.sync();
    // 方位マーカーは操作対象の軌道座標系を指すものなので操作対象だけが出す。
    this.markers?.sync(
      this.state, displayState, this.att, camera.overviewMode, isActive, camera.activeCameraPos,
      camera.activeCameraProjection, camera.activeCameraScale, this.name, this.roundsInMag, this.reloadTimer,
      this.magsLeft, this.averageMuzzleVelocity, focusTargetId(camera.mapCamera.focus), ephemeris.registry,
      attractors, visibility, displayWindow?.frame, displayTime, ephemeris);
  }

  // 画面マーカー1件ぶんの見た目。pos/vel は機体メッシュと同じ表示時刻の状態を使う。
  public markerItem(role: MarkerRole, viewerPos: Vec3, pos: Vec3, vel: Vec3, overviewMode: boolean): GroupedMarkerItem {
    // 表示の優先度。ターゲットに指定されていればそれが勝ち、そうでなければ種別と距離で決まる。
    const dist = len(sub(pos, viewerPos));
    const isEnemy = this.faction === 'enemy';
    const ownPriority = this.baseState
      ? C.MARKER_PRIORITY.BASE - dist / 1e9
      : isEnemy ? C.MARKER_PRIORITY.ENEMY - dist / 1e9 : C.MARKER_PRIORITY.PLAYER;
    const priority = role === 'primary'
      ? C.MARKER_PRIORITY.PRIMARY_TARGET
      : role === 'secondary' ? C.MARKER_PRIORITY.SECONDARY_TARGET : ownPriority;
    // 図形と着色。基地は専用図形、機体はマップでは進行方向つき、戦闘ビューでは HP 刻み。
    const color = isEnemy ? C.COLOR_MARKER_ENEMY : C.COLOR_MARKER_ALLY;
    const sym = vesselMarkerSvg(!!this.baseState, this.hp, this.maxHp, this.name, overviewMode, isEnemy);
    const ownClass = this.baseState ? 'mk-base' : 'mk-enemy';
    return {
      key: this.markerKey,
      cls: role === 'primary' ? 'mk-target' : ownClass,
      sym,
      pos,
      vel,
      priority,
      name: this.name,
      detail: overviewMode || (!isEnemy && !this.baseState) ? '' : fmtMarkerDist(dist),
      bearingColor: color,
      bearingSym: this.baseState ? ENTITY_GLYPH.base : isEnemy ? ENTITY_GLYPH.enemyShip : DIRECTION_GLYPH.allyBearing,
      bearingClass: isEnemy ? 'mk-dir mk-bearing-triangle' : 'mk-dir mk-ally-dir',
      bearingVisible: this.baseState ? false : isEnemy ? undefined : dist <= C.ALLY_BEARING_MAX_DISTANCE,
      color,
      symMarkup: true,
    };
  }

  // 自身に関するメッシュ・エフェクト・マーカー・収容中の機体を解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    this.markers?.dispose();
    this.thrustEffects?.dispose(this.vesselScene);
    this.rcsEffects?.dispose(this.vesselScene);
    this.reentryEffects?.dispose(this.vesselScene);
    // 収容中の機体は entities.vessels から外れているため、ここでしか回収できない。
    if (this.baseState) {
      for (const entry of this.baseState.dockedVessels) entry.vessel.dispose();
      this.baseState.dockedVessels = [];
    }
    super.dispose();
  }

  // ----------------------------------------------------------------- 保存
  // 有人艦としての保存形。
  public serializeAsShip(): PlayerSaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'player',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      fire: this.fire!.serialize(),
      thermal: this.thermal!.serialize(),
      radiator: this.radiator!.serialize(),
      power: this.power!.serialize(),
      throttle: this.throttle.serialize(),
      parts: this.parts.map((p) => ({ ...p })) as AnyPart[],
      assembly: this.assembly ? serializeAssembly(this.assembly) : undefined,
      planExecution: this._planExecution,
      fineAttitude: this._fineAttitude,
      plan: this.serializePlan(),
    };
  }

  // 敵対勢力の機体としての保存形。
  public serializeAsHostile(): EnemySaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'enemy',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      enemyKind: this._enemyKind!,
      alive: this.alive,
      health: this.hp,
      accent: this._accent!,
      waveId: this._waveId,
      burstLeft: this.ai?.burstLeft,
      burstDelay: this.ai?.burstDelay,
    };
  }

  // 基地モジュールを積んだ機体としての保存形。収容中の機体もここに含む。
  public serializeAsBase(): BaseSaveData {
    const state = this.baseState!;
    return {
      id: this.id,
      name: this.name,
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      fuel: this.fuelOf('hydrazine'),
      formatVersion: BASE_SAVE_FORMAT_VERSION,
      assembly: this.assembly ? serializeAssembly(this.assembly) : undefined,
      inventory: state.inventory.map((p) => ({ ...p })),
      dockedVessels: state.dockedVessels.map((entry) => entry.vessel.serializeAsShip()),
      dockBindings: state.dockedVessels.map((entry) => ({
        vesselId: entry.vessel.id,
        slotIndex: entry.slotIndex,
        dockId: this.getDockPortId(entry.slotIndex) ?? undefined,
      })),
      throttle: this.throttle.serialize(),
    };
  }

  // 計画の保存形。凍結された計画が無ければ null。
  private serializePlan(): PlanSaveData | null {
    const frozen = this.plan.frozenData();
    if (!frozen) return null;
    const { anchor, nodes } = frozen;
    return {
      anchor: { t: anchor.t, r: { ...anchor.r }, v: { ...anchor.v } },
      nodes: nodes.map((n) => ({ t: n.t, r: { ...n.r }, v: { ...n.v } })),
    };
  }
}

function disposeVesselObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

export type DockedVesselEntry = RawDockedVesselEntry<Vessel>;
export type BaseState = RawBaseState<Vessel>;
