// モジュール船 entity の船体・操縦・戦闘・接舷・分離・直列化のライフサイクルを所有する。
import type * as THREE from 'three/webgpu';
import type { ViewMode } from '../view/view-mode';
import { deserializeAttitude, type Attitude } from '../../physics/attitude';
import { LOCAL_FORWARD, qFromBasis, qRotate } from '../../math/quat';
import { deserializeKinematicState, kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { add, scale, v3, len, sub, type Vec3 } from '../../math/vec3';
import { CombatShipEntity } from '../dynamic/dynamic-entity/combat-ship-entity';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity, SerializedDynamicEntityFields } from '../dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { generateRandomName } from '../random-name';
import { Throttle, type SerializedThrottle } from '../player/throttle';
import { FireControl, type SerializedFireControl } from '../player/fire-control';
import { WeaponState, type AmmoLoad } from '../player/weapon-state';
import { AltitudeAlarm, type SerializedAltitudeAlarm } from '../player/altitude-alarm';
import {
  ModularShipDynamicView, type ModularShipRenderSource,
} from '../../render/dynamic/ship/modular-ship-dynamic-view';
import type { DynamicViewFrame } from '../../render/dynamic/dynamic-view';
import type { OrbitReference } from '../orbit-reference';
import type { SerializedRadiatorSystem } from '../player/radiator';
import type { SerializedPowerSystem } from '../player/power';
import type { SerializedBeltController } from '../player/belt';

import { Plan, type PlanExecutionMode } from '../plan/plan';
import type { SerializedPlan } from '../plan/plan';
import { ShipAutopilot, type SerializedShipAutopilot } from './ship-autopilot';
import { DIRECTION_GLYPH, COLOR_MARKER_ALLY } from '../marker/marker-identity';
import type { GroupedMarkerItem } from '../marker/grouped-markers';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { baseMarkerSvg } from '../marker/marker-shapes';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { PilotCommand, PilotControls } from '../dynamic/dynamic-entity/pilot-controls';
import { ModularShipMotion, type ModularShipMotionReactions } from './modular-ship-motion';
import type { DynamicMotionThermal } from '../dynamic/dynamic-motion';
import type { BurnManagementViewModel } from '../hud/panels/burn-management-panel';
import { ShipInspection } from '../pickable/ship-inspection';
import { PlayerEffects } from '../player/player-effects';
import { ModularShipReactions } from './modular-ship-reactions';
import { createDefaultCombatPreset } from './ship-presets';
import type { ShipAssembly } from './ship-assembly';
import { shipRenderAssembly } from './ship-render-adapter';
import { ShipCapabilities } from './ship-capabilities';
import { shipPhysicsShape } from './ship-physics-shape';
import type { ControlSelection } from '../control-selection';
import {
  deserializeShipAssembly, serializeShipAssembly,
  type SerializedCollisionGrace, type SerializedDockedVessel, type SerializedShipAssembly,
} from './ship-assembly-serialization';
import { ModularShipConnectionOperations } from './modular-ship-connection-operations';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageRules } from '../stages/stage-rules';

const HULL_START_TEMP = 273; // 初期機体温度 [K]

const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

// 給弾ベルトの節点数。たわみ物理の鎖の長さと、表示するリンクメッシュの本数を揃える。
const BELT_MAX_VISIBLE = 18;

// 新規配置するモジュール船の初期値。省略した項目は既定値で組み、
// assembly 未指定なら既定戦闘船、state 未指定なら原点近傍の静止状態で配置する。
export interface ModularShipInit {
  readonly name?: string;
  readonly state?: KinematicState;
  readonly id?: string;
  readonly ammo?: AmmoLoad;
  readonly assembly?: ShipAssembly;
  readonly att?: Attitude;
  readonly operatingCockpitId?: string | null;
}

export interface SerializedModularShip extends SerializedDynamicEntityFields {
  readonly kind: 'ship';
  readonly name: string;
  readonly assembly: SerializedShipAssembly;
  readonly dockedVessels: readonly SerializedDockedVessel[];
  readonly collisionGrace: readonly SerializedCollisionGrace[];
  readonly operatingCockpitId: string | null;
  readonly fire: SerializedFireControl;
  readonly thermal: DynamicMotionThermal;
  readonly radiator: SerializedRadiatorSystem;
  readonly power: SerializedPowerSystem;
  readonly belt: SerializedBeltController;
  readonly throttle: SerializedThrottle;
  readonly altitudeAlarm: SerializedAltitudeAlarm;
  readonly plan: SerializedPlan | null;
  readonly planExecution: PlanExecutionMode;
  readonly autopilot?: SerializedShipAutopilot;
  readonly fineAttitude: boolean;
}

// モジュール船の操縦・射撃・ブースター・接触帰結・保存を合成する entity。
export class ModularShip extends CombatShipEntity implements Controllable {
  public static readonly kind = 'ship';
  public static spawnGate(): null { return null; }
  public override mapKind: DynamicEntityKind;
  public override showsEquatorNodesAlways: boolean;
  public override readonly controllable = true;
  public override readonly pickable = true;
  // 軌道線の表示切替は表示 adapter から直接読む軽量な個体設定。
  public trajectoryLineVisible = true;
  public readonly inspection = new ShipInspection(this);
  public readonly objectPickable = this.inspection;
  // 除去の前に注視・操作対象の参照を次の艦へ引き継ぐ必要があるので、所有者側に回収させる。
  public override readonly reclaimedByOwner = true;

  public declare readonly motion: ModularShipMotion;
  public readonly assembly: ShipAssembly;
  public readonly capabilities: ShipCapabilities;
  public readonly connections: ModularShipConnectionOperations;
  public readonly throttle: Throttle;
  public readonly fire: FireControl;
  public readonly altitudeAlarm: AltitudeAlarm;
  private readonly effects: PlayerEffects;
  private readonly reactions: ModularShipReactions;
  private readonly registry: EntityRegistry;
  // この艦自身のマニューバ計画。
  public readonly plan: Plan;
  private _planExecution: PlanExecutionMode;
  // 計画ノードを有限燃焼で実行する自動操縦。planExecution==='autopilot' のときだけ動く。
  public readonly autopilot: ShipAutopilot;

  private _fineAttitude: boolean;
  // 自機の操作方法は HUD とヘルプが常設で示しているので、選び直しても案内は出さない。
  public readonly controlHint = null;
  public readonly releaseHint = null;
  public readonly toggleSolarPanel = (side: 'up' | 'down'): void => this.motion.power.toggle(side);
  public readonly toggleRadiator = (side: 'up' | 'down'): void => this.motion.radiator.toggle(side);

  public get totalTorque(): number { return this.capabilities.totalTorque; }
  public get totalThrust(): number { return this.capabilities.totalThrust; }
  // 健全な主推進器の燃料消費率の合計 [unit/s]。
  public get totalFuelConsumptionRate(): number {
    return this.capabilities.totals.mainFuelConsumptionRate;
  }
  // 健全な RCS モジュールの燃料消費率の合計 [unit/s]。
  public get rcsFuelConsumptionRate(): number {
    return this.capabilities.modules('rcs', true).reduce(
      (sum, module) => sum + (this.assembly.definition(module.id)?.abilities.fuelConsumptionRate ?? 0), 0,
    );
  }
  public get totalFuel(): number { return this.capabilities.fuel('main'); }
  public get totalMaxFuel(): number { return this.capabilities.maxFuel('main'); }
  public get totalRcsFuel(): number { return this.capabilities.fuel('rcs'); }
  public get totalMaxRcsFuel(): number { return this.capabilities.maxFuel('rcs'); }
  // 主推進燃料を amount だけ消費し、消費できた割合(0..1)を返す。amount <= 0 なら 1。
  public consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    const consumed = this.capabilities.consumeFuel('main', amount);
    if (consumed > 0) this.motion.synchronizeAssembly();
    return consumed / amount;
  }
  // 主推進燃料を amount だけ補給し、実際に入った量を返す。
  public refuelFuel(amount: number): number {
    const added = this.capabilities.refuel('main', amount);
    if (added > 0) this.motion.synchronizeAssembly();
    return added;
  }
  // RCS 燃料を amount だけ消費し、消費できた割合(0..1)を返す。amount <= 0 なら 1。
  public consumeRcsFuel(amount: number): number {
    if (amount <= 0) return 1;
    const consumed = this.capabilities.consumeFuel('rcs', amount);
    if (consumed > 0) this.motion.synchronizeAssembly();
    return consumed / amount;
  }
  // RCS 燃料を amount だけ補給し、実際に入った量を返す。
  public refuelRcsFuel(amount: number): number {
    const added = this.capabilities.refuel('rcs', amount);
    if (added > 0) this.motion.synchronizeAssembly();
    return added;
  }
  public get totalCoolingRate(): number { return this.capabilities.totalCoolingRate; }
  public get totalPowerGeneration(): number { return this.capabilities.totalPowerGeneration; }
  public get weaponDamage(): number { return this.capabilities.weaponDamage; }
  public get totalFireRate(): number { return this.capabilities.totalFireRate; }
  public get averageMuzzleVelocity(): number { return this.capabilities.averageMuzzleVelocity; }

  // placement に新しいモジュール船を置く。
  public static create(
    placement: ModularShipInit, registry: EntityRegistry, scene: THREE.Scene,
  ): ModularShip {
    return new ModularShip(registry, scene, { placement });
  }

  // 直列化したモジュール船を復元する。
  public static deserialize(
    serialized: SerializedModularShip, registry: EntityRegistry, scene: THREE.Scene,
  ): ModularShip {
    return new ModularShip(registry, scene, { serialized });
  }

  // placement なら新規配置、serialized なら直列化された記録からの復元として組む。
  private constructor(
    registry: EntityRegistry,
    scene: THREE.Scene,
    init: { readonly placement: ModularShipInit } | { readonly serialized: SerializedModularShip },
  ) {
    // 記録と配置どちらの入力かで、assembly・名前・運動状態・姿勢を解決する。
    const serialized = 'serialized' in init ? init.serialized : undefined;
    const placement = 'placement' in init ? init.placement : undefined;
    const assembly = serialized ? deserializeShipAssembly(serialized.assembly) : (placement?.assembly ?? createDefaultCombatPreset());
    const physics = shipPhysicsShape(assembly);
    if (physics === null) throw new Error('default modular ship preset is empty');
    const name = serialized ? (serialized.name || serialized.id) : (placement?.name ?? generateRandomName('player'));
    const state = serialized
      ? deserializeKinematicState(serialized)
      : (placement?.state ?? kinematicState<'eci'>(0, v3(1, 0, 0), v3(0, 1, 0)));
    const id = registry.idAllocators.entity.next(serialized?.id ?? placement?.id ?? name);
    const att: Attitude = serialized
      ? deserializeAttitude(serialized, physics.mass.inertia)
      : (placement?.att === undefined
        ? ModularShip.progradeAttitude(state, physics.mass.inertia)
        : { ...placement.att, inertia: physics.mass.inertia });

    // 接触帰結は motion が持つ反応契約経由で届くが、reactions 本体は motion より後に組めるので、
    // 呼ばれた時点で解決する遅延参照にする。
    let reactionHandler: ModularShipReactions | null = null;
    // 遅延参照を解決する。まだ組めていなければ失敗にする。
    const requiredReactions = (): ModularShipReactions => {
      if (reactionHandler === null) throw new Error('modular ship reactions are not initialized');
      return reactionHandler;
    };
    const reactions = (owner: ModularShip): ModularShipMotionReactions => ({
      roundsInMagazine: () => owner.fire.rounds,
      magsLeft: () => owner.fire.mags,
      thrustAcceleration: () => owner.motion.thrust ?? v3(),
      radiatorWear: () => owner.radiatorWear(),
      totalCoolingRate: () => owner.totalCoolingRate,
      totalPowerGeneration: () => owner.totalPowerGeneration,
      updateAltitudeAlarm: (dt, position, body, pivot) => (
        owner.altitudeAlarm.update(dt, position, body, pivot)
      ),
      receiveEntityContact: (other, contact, services) => requiredReactions().receiveEntityContact(other, contact, services),
      receiveRadiatorContact: (side, other, contact, services) => (
        requiredReactions().receiveRadiatorContact(side, other, contact, services)
      ),
      receiveSurfaceContact: (body, contact, services) => (
        requiredReactions().receiveSurfaceContact(body, contact, services)
      ),
      receiveStructuralLoss: services => requiredReactions().receiveStructuralLoss(services),
      receiveBurnUp: services => requiredReactions().receiveBurnUp(services),
      nextAutopilotEventTime: (_self, simTime) => owner.autopilot.nextEventTime(simTime),
      stepAutopilot: (_self, dt, attractors, pivot) => owner.autopilot.step(dt, attractors, pivot),
      autopilotMaxStep: () => owner.autopilot.maxStepDuration(),
    });
    // entity の基底へ、assembly を物理形状として運ぶ motion と表示資源を渡す。
    super(
      name,
      assembly.maxHp,
      owner => new ModularShipMotion(
        assembly,
        state,
        att,
        reactions(owner as ModularShip),
        {
          temperature: serialized?.thermal.temperature ?? HULL_START_TEMP,
          beltLinkCount: BELT_MAX_VISIBLE,
          serializedBelt: serialized?.belt,
          serializedRadiator: serialized?.radiator,
          serializedPower: serialized?.power,
        },
      ),
      new ModularShipDynamicView(scene, id, BELT_MAX_VISIBLE),
      id,
    );
    // assembly と、その周りに組む能力・接触帰結・接続系の協力者。
    this.assembly = assembly;
    this.capabilities = new ShipCapabilities(
      assembly, serialized?.operatingCockpitId ?? placement?.operatingCockpitId ?? null,
    );
    this.mapKind = assembly.role === 'base' ? 'base' : 'player';
    this.showsEquatorNodesAlways = assembly.role === 'base';
    this.setHealth(assembly.totalHp, assembly.maxHp);
    this.registry = registry;
    this.throttle = serialized?.throttle ? Throttle.deserialize(serialized.throttle) : new Throttle();
    this.effects = new PlayerEffects(registry);
    this.reactions = new ModularShipReactions({
      motion: this.motion,
      assembly: this.assembly,
      effects: this.effects,
      syncAfterDamage: () => this.syncAssemblyIntegrity(),
    });
    reactionHandler = this.reactions;
    const thisShipName = (): string => this.name;
    this.connections = new ModularShipConnectionOperations({
      ship: this,
      id: this.id,
      get name(): string { return thisShipName(); },
      scene,
      assembly: this.assembly,
      capabilities: this.capabilities,
      motion: this.motion,
      createShip: (next, nextRegistry) => ModularShip.create(next, nextRegistry, scene),
      clearTransientCommands: () => this.clearTransientCommands(),
      syncAssemblyDerivedState: () => this.syncAssemblyIntegrity(),
    });
    // 計画・操縦・射撃系の部品と、記録があれば接舷 identity の復元。
    this.plan = serialized?.plan ? Plan.deserialize(serialized.plan) : Plan.create();
    this._planExecution = serialized?.planExecution ?? 'instant';
    this.autopilot = new ShipAutopilot(this, serialized?.autopilot);
    this._fineAttitude = serialized?.fineAttitude ?? false;
    if (serialized) {
      this.connections.deserializeConnectionState(serialized.dockedVessels, serialized.collisionGrace, state.t);
    }
    this.fire = new FireControl(
      this, registry, scene,
      serialized?.fire ? WeaponState.deserialize(serialized.fire) : placement?.ammo ? WeaponState.create(placement.ammo) : undefined,
    );
    this.altitudeAlarm = serialized?.altitudeAlarm
      ? AltitudeAlarm.deserialize(serialized.altitudeAlarm, registry.events)
      : new AltitudeAlarm(registry.events);
    if (serialized?.plan) {
      const dropped = Plan.droppedNodeCount(serialized.plan);
      if (dropped > 0) registry.events.record({ kind: 'planNodesDropped', ship: this.name, count: dropped });
    }
  }

  // state の速度方向を機首、位置方向を上として姿勢を組む。
  private static progradeAttitude(state: KinematicState, inertia: Vec3): Attitude {
    return {
      q: qFromBasis(state.v, state.r),
      w: v3(),
      inertia,
    };
  }

  public get planExecution(): PlanExecutionMode { return this._planExecution; }
  public get fineAttitude(): boolean { return this._fineAttitude; }

  // 健全なコックピットを持ち操縦できるか(自動操縦の許可条件)。
  public get healthyCockpit(): boolean { return this.capabilities.controllable; }

  // 主推進燃料 1 unit あたりの質量 [kg/unit](自動操縦が燃焼時間へ換算する)。
  public mainFuelMassPerUnit(): number { return this.capabilities.fuelMassPerUnit('main'); }

  // 計画ノードの実行方式(instant か autopilot か)を切り替える。
  public setPlanExecution(mode: PlanExecutionMode): void { this._planExecution = mode; }

  // instant モードのときだけ、次に実行される計画ノードの時刻 [s]。それ以外は null。
  public get instantNodeTime(): number | null {
    return this._planExecution === 'instant' ? this.plan.firstNode()?.t ?? null : null;
  }

  // instant モードで simTime までに来た計画ノードを消費し、最後のノードの状態へ運動を飛ばす。
  public executeInstantNodesUpTo(simTime: number): void {
    if (this._planExecution !== 'instant') return;
    const due = this.plan.nodes.filter(node => node.t <= simTime);
    const reached = due[due.length - 1];
    if (reached === undefined) return;
    this.plan.consumeNodesUpTo(simTime, reached);
    this.motion.reset(reached);
  }

  // dt 秒ぶんの回復量(HP = dt)を、健全な module の欠けた分へ先頭から順に配る。
  private hpRegen(dt: number): void {
    let remaining = Math.max(0, dt);
    for (const module of this.assembly.modules) {
      if (remaining <= 0 || module.hp <= 0) continue;
      const maxHp = this.assembly.definition(module.id)?.maxHp ?? module.hp;
      const repaired = Math.min(remaining, Math.max(0, maxHp - module.hp));
      if (repaired > 0) this.assembly.setHp(module.id, module.hp + repaired);
      remaining -= repaired;
    }
    this.setHealth(this.assembly.totalHp);
  }

  // -------------------------------------------------------- 移動/射撃 状態
  public get roundsInMag(): number { return this.fire.rounds; }
  public get magsLeft(): number { return this.fire.mags; }
  public get reloadTimer(): number { return this.fire.cooldown; }

  // 展開操作状態を module ID に反映する。配列順ではなくモジュールIDに基づいて継続状態を対応付ける。
  private syncModuleDeployments(): void {
    this.motion.power.syncAssembly(this.assembly);
    this.motion.radiator.syncAssembly(this.assembly);
    for (const module of this.assembly.modules) {
      if (module.kind === 'solar_panel') this.assembly.setDeployment(module.id, this.motion.power.deployOf(module.id));
      if (module.kind === 'radiator') this.assembly.setDeployment(module.id, this.motion.radiator.deployOf(module.id));
    }
  }

  // 点火済み booster module を同時に進め、区間平均推力を現在質量の対数平均で加速度へ直す。
  private stepBoosters(simDt: number): Vec3 | null {
    if (!(simDt > 0)) return null;
    // 区間で燃やせた割合だけ各 booster の推力を足す。
    const massBefore = this.motion.mass;
    let averageThrust = 0;
    let consumedAny = false;
    for (const booster of this.capabilities.modules('booster', true)) {
      if (!booster.ignited || booster.fuel <= 0) continue;
      const definition = this.assembly.definition(booster.id);
      if (definition === null) continue;
      const rate = definition.abilities.fuelConsumptionRate ?? 0;
      const requested = rate * simDt;
      const consumed = rate > 0 ? this.assembly.consumeBoosterFuel(booster.id, requested) : 0;
      const burnRatio = rate > 0 ? Math.min(1, consumed / requested) : 1;
      averageThrust += (definition.abilities.thrust ?? 0) * burnRatio;
      consumedAny ||= consumed > 0;
    }
    if (consumedAny) this.motion.synchronizeAssembly();
    if (!(averageThrust > 0)) return null;
    // 燃料消費で質量が動いたので、区間の対数平均質量で加速度へ直す。
    const massAfter = this.motion.mass;
    const meanMass = Math.abs(massBefore - massAfter) < 1e-12
      ? massAfter
      : (massBefore - massAfter) / Math.log(massBefore / massAfter);
    const acceleration = meanMass > 0 ? averageThrust / meanMass : 0;
    return acceleration > 0
      ? scale(qRotate(this.motion.att.q, LOCAL_FORWARD), acceleration)
      : null;
  }

  // booster module の点火状態を切り替え、切替後の状態を返す。booster でなければ失敗にする。
  public toggleBoosterIgnition(moduleId: string): boolean {
    const booster = this.assembly.module(moduleId);
    if (booster?.kind !== 'booster') throw new Error(`not a booster module: ${moduleId}`);
    const ignited = !(booster.ignited && booster.fuel > 0 && booster.hp > 0);
    this.assembly.setIgnited(moduleId, ignited);
    this.motion.invalidatePrediction();
    const updated = this.assembly.module(moduleId);
    return updated?.kind === 'booster' && updated.ignited;
  }

  // 接舷・分離・修理は接続 identity と衝突猶予を持つ専用所有者へ渡す。
  public dock(
    other: ModularShip, localPortId: string, otherPortId: string,
    selection: ControlSelection,
  ): ModularShip {
    return this.connections.dock(other, localPortId, otherPortId, selection);
  }

  public undock(portId: string, registry: EntityRegistry): ModularShip {
    return this.connections.undock(portId, registry);
  }

  public repairAtDock(portId: string): number {
    return this.connections.repairAtDock(portId);
  }

  // 展開目標とモジュールの展開状態を、同じ操作で更新する。
  public setModuleDeployment(moduleId: string, deployed: boolean): void {
    const module = this.assembly.module(moduleId);
    if (module === null || (module.kind !== 'radiator' && module.kind !== 'solar_panel')) return;
    const sameKind = this.assembly.modules.filter(candidate => candidate.kind === module.kind);
    const side = sameKind.findIndex(candidate => candidate.id === moduleId) === 0 ? 'up' : 'down';
    if (module.kind === 'radiator') this.motion.radiator.setDeployed(side, deployed);
    else this.motion.power.setDeployed(side, deployed);
    this.assembly.setDeployment(moduleId, deployed ? 1 : 0);
  }

  // assembly を直接編集する建造系の操作後に、質量特性・耐久値・能力・表示上の役割を一括更新する。
  public synchronizeAssemblyState(): void {
    if (this.assembly.size === 0) {
      this.motion.kill();
      return;
    }
    this.motion.synchronizeAssembly();
    this.connections.syncAssemblyDerivedState();
  }

  // 耐久値の合計・操縦基準・表示上の役割を、assembly の現在値へ揃え直す。
  private syncAssemblyIntegrity(): void {
    this.setHealth(this.assembly.totalHp, this.assembly.maxHp);
    this.capabilities.reconcileOperatingCockpit();
    this.syncDerivedRole();
  }

  // assembly の役割(ship/base/material)から mapKind と表示設定を導き直す。
  private syncDerivedRole(): void {
    this.mapKind = this.capabilities.role === 'base' ? 'base' : 'player';
    this.showsEquatorNodesAlways = this.capabilities.role === 'base';
  }

  // デカプラーの切断も同じ接続所有者へ渡す。
  public decouple(decouplerId: string, registry: EntityRegistry): ModularShip {
    return this.connections.decouple(decouplerId, registry);
  }

  // 衝突猶予の再適用も同じ接続所有者へ渡す。
  public restoreCollisionGrace(ships: readonly ModularShip[]): void {
    this.connections.restoreCollisionGrace(ships);
  }

  // ブースターとデカプラーがある艦の燃焼管理表示を組み立てる。
  public burnManagementViewModel(): BurnManagementViewModel | null {
    // booster・decoupler がどちらも無ければ表示するものは無い。
    const boosters = this.capabilities.modules('booster');
    const decouplers = this.capabilities.modules('decoupler');
    if (boosters.length === 0 && decouplers.length === 0) return null;
    const activeFuel = boosters.reduce((total, module) => total + module.fuel, 0);
    const activeFuelMax = boosters.reduce(
      (total, module) => total + (this.assembly.definition(module.id)?.abilities.fuelCapacity ?? 0), 0,
    );
    const anyIgnited = boosters.some(module => module.ignited && module.fuel > 0 && module.hp > 0);
    // 残量と点火状態から燃焼段の状態を決め、モジュール1つ1行の項目へ並べる。
    return {
      stageCount: boosters.length,
      totalMass: this.motion.mass,
      activeFuel,
      activeFuelMax,
      burnState: boosters.length === 0 ? 'idle'
        : activeFuel <= 0 ? 'empty' : anyIgnited ? 'burning' : 'ready',
      modules: [
        ...decouplers.map(module => ({ id: module.id, kind: 'decoupler' as const, state: module.hp > 0 ? '接続中' : '全損' })),
        ...boosters.map(module => ({
          id: module.id,
          kind: 'booster' as const,
          state: module.fuel <= 0 ? '燃料切れ' : module.ignited ? '燃焼中' : '停止',
        })),
      ],
    };
  }

  // 弾薬ピックアップで得たマグ数を加算する。
  public onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 1フレーム分の操縦入力と booster 燃焼を処理し、非操作艦の連続指令を畳む。
  public updateControls(
    requestedControls: PilotControls | null, dt: number, simDt: number,
    activeStage: StageOutcome, stageRules: StageRules, celestialBodies: CelestialBodies,
  ): void {
    const controls = this.capabilities.controllable ? requestedControls : null;
    if (stageRules.selfRepair) this.hpRegen(dt);
    this.syncModuleDeployments();
    const boosterThrust = this.stepBoosters(simDt);
    // 自動操縦は操作艦・非操作艦とも毎フレーム進める。手動の噴射・回転入力は中断として扱う。
    if (controls !== null && (controls.thrust.size > 0 || controls.rotation.size > 0)) {
      this.autopilot.interrupt();
    }
    this.autopilot.updateFrame(this.motion.state.t, celestialBodies, true, boosterThrust);
    if (controls === null) {
      this.clearTransientCommands();
      this.motion.setThrust(boosterThrust);
      return;
    }
    this.updateTorque(controls, dt, simDt);

    this.fire.updateFireState(dt, controls, activeStage, celestialBodies);

    this.throttle.updateThrustLatches(controls);
    this.throttle.updateThrustState(controls, this.motion.att, simDt, this);
    const rcsThrust = this.throttle.thrust;
    this.motion.setThrust(rcsThrust && boosterThrust
      ? add(rcsThrust, boosterThrust)
      : rcsThrust ?? boosterThrust);
  }

  // 次のフレームへ持ち越してはならない連続指令(推力・トルク・射撃)を畳む。角速度による
  // coast はそのまま続く。
  public clearTransientCommands(): void {
    this.motion.setThrust(null);
    this.motion.setTorque(v3());
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  private toggleFineAttitude(): void {
    this._fineAttitude = !this._fineAttitude;
    this.registry.events.record({ kind: 'fineAttitudeToggled', on: this._fineAttitude });
  }

  // 1回きりの操縦命令を受け付け、命令ごとに担当の装備へ振り分ける。
  public handleCommand(command: PilotCommand): void {
    const events = this.registry.events;
    // 命令種別ごとに担当の装備へ振り分ける網羅的な分岐。
    switch (command.kind) {
      case 'thrustLatchToggle': this.throttle.toggleThrustLatch(command.direction); return;
      case 'rcsDampToggle': this.throttle.toggleRcsDamp(events); return;
      case 'progradeReset': this.throttle.enableProgradeReset(events); return;
      case 'fineAttitudeToggle': this.toggleFineAttitude(); return;
      case 'progradeHoldToggle': this.throttle.toggleProgradeHold(events); return;
      case 'throttleLow': this.throttle.setThrottlePreset(0, events); return;
      case 'throttleMid': this.throttle.setThrottlePreset(1, events); return;
      case 'throttleHigh': this.throttle.setThrottlePreset(2, events); return;
      case 'throttleMax': this.throttle.setThrottlePreset(3, events); return;
      case 'radiatorDeployLeft': this.motion.radiator.toggle('up'); return;
      case 'radiatorDeployRight': this.motion.radiator.toggle('down'); return;
      case 'solarDeployLeft': this.motion.power.toggle('up'); return;
      case 'solarDeployRight': this.motion.power.toggle('down'); return;
      case 'reload': this.fire.manualReload(); return;
    }
  }

  // 放熱板 module の残 HP から module ID ごとの損耗率を組む。パーツが欠けている module は全損扱い。
  private radiatorWear(): Readonly<Record<string, number>> {
    const wear: Record<string, number> = {};
    for (const module of this.capabilities.modules('radiator')) {
      const maxHp = this.assembly.definition(module.id)?.maxHp ?? 0;
      wear[module.id] = maxHp > 0 ? 1 - module.hp / maxHp : 1;
    }
    return wear;
  }

  // 入力から機体座標系トルクを求めて Motion へ反映し、角速度をクランプする。
  private updateTorque(controls: PilotControls, dt: number, simDt: number): void {
    // 発砲中は姿勢微調整と同じ操作精度になる
    const fine = this.fineAttitude || this.fire.isFiring;
    this.throttle.updateTorque(
      this.motion.att,
      this.motion.state.r,
      this.motion.state.v,
      controls,
      fine,
      dt,
      simDt,
      this,
      this.registry.events,
    );
    this.motion.setTorque(this.throttle.torque);
  }

  // dispose の多重実行を防ぐ状態。
  private disposed: boolean = false;

  // 画面マーカーと被選択判定が同じ艦を指すためのキー。
  public get markerKey(): string { return `${this.mapKind}-${this.id}`; }

  // 画面マーカー・一覧に出すこの艦の項目。isActive はマップ上で自艦と僚艦を塗り分ける
  // ための操作対象フラグ。
  public markerItem(viewerPos: Vec3 | null, pos: Vec3, vel: Vec3, view: ViewMode, isActive: boolean): GroupedMarkerItem {
    const distance = viewerPos === null ? null : len(sub(pos, viewerPos));
    const isBaseRole = this.capabilities.role === 'base';
    return {
      key: this.markerKey,
      kind: isBaseRole ? 'base' : this.mapKind,
      cls: isBaseRole ? 'mk-base' : (isActive ? 'mk-self' : 'mk-ally'),
      sym: isBaseRole ? baseMarkerSvg() : (view === 'map' ? this.headingHpMarkerSvg() : this.hpMarkerSvg()),
      pos,
      vel,
      // 視点が無いフレームは距離を順位へ持ち込まず、全対象を同じ遠さとして扱う。
      priority: isBaseRole
        ? MARKER_PRIORITY.BASE - (distance ?? 0) / 1e9
        : MARKER_PRIORITY.PLAYER,
      name: this.name,
      // 遠距離では画面外方位マーカーを畳み、密集を抑える。
      bearing: {
        color: COLOR_MARKER_ALLY,
        sym: DIRECTION_GLYPH.allyBearing,
        cls: 'mk-dir mk-ally-dir',
        visible: distance !== null && distance <= ALLY_BEARING_MAX_DISTANCE,
        clustered: true,
      },
      color: isActive ? 'var(--color-primary)' : COLOR_MARKER_ALLY,
      symMarkup: true,
    };
  }

  // 船体 View が読む値を、共通の表示入力へ足す。可動部と噴射は Motion の現在値、
  // マーカーの弾数と初速は装備の現在値から、このフレームぶんだけを組む。
  protected override renderSource(
    viewFrame: DynamicViewFrame, active: boolean,
    orbitReference: OrbitReference | null,
  ): ModularShipRenderSource {
    const motion = this.motion;
    const { belt } = motion;
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      assembly: shipRenderAssembly(this.assembly),
      centerOffset: motion.centerOffset,
      state: motion.state,
      active,
      mainThrustAcceleration: this.throttle.thrust,
      maximumAcceleration: motion.mass > 0 ? this.totalThrust / motion.mass : 0,
      torque: motion.torque,
      dynamicPressure: motion.aero.qdyn,
      ambientDensity: motion.aero.density,
      belt: { anchor: belt.anchor, positions: belt.positions, twists: belt.twists },
      magsLeft: this.magsLeft,
      gunFireRate: this.fire.isFiring ? this.totalFireRate : 0,
      recentShotRecords: this.fire.recentShotRecords,
    };
  }

  // 自身のメッシュやエフェクト等の表示資源を解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    super.dispose();
  }

  // 現在の艦状態を直列化された形へ写す。
  public override serialize(): SerializedModularShip {
    return {
      ...this.serializeEntityFields(ModularShip.kind),
      name: this.name,
      assembly: serializeShipAssembly(this.assembly),
      dockedVessels: this.connections.serializeDockedVessels(),
      collisionGrace: this.connections.serializeCollisionGrace(this.motion.state.t),
      operatingCockpitId: this.capabilities.operatingCockpitId,
      // 下位系の状態
      fire: this.fire.serialize(),
      thermal: this.motion.thermal,
      radiator: this.motion.radiator.serialize(),
      power: this.motion.power.serialize(),
      belt: this.motion.belt.serialize(),
      throttle: this.throttle.serialize(),
      altitudeAlarm: this.altitudeAlarm.serialize(),
      // 操作・表示の設定と計画
      planExecution: this.planExecution,
      autopilot: this.autopilot.serialize(),
      fineAttitude: this.fineAttitude,
      plan: this.plan.serialize(),
    };
  }

  public rename(name: string): void { this.setName(name); }
}

// entity がモジュール船なら型を絞り込む。
export function isModularShip(entity: DynamicEntity): entity is ModularShip {
  return entity instanceof ModularShip;
}
