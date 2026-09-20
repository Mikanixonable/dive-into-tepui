// モジュール船 entity の船体・操縦・戦闘・接舷・分離・保存ライフサイクルを所有する。
import type * as THREE from 'three/webgpu';
import type { ViewMode } from '../view/view-mode';
import { deserializeAttitude, type Attitude } from '../../physics/attitude';
import { LOCAL_FORWARD, qFromBasis, qInvert, qMul, qRotate } from '../../math/quat';
import { deserializeKinematicState, kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { add, cross, norm, scale, v3, len, sub, type Vec3 } from '../../math/vec3';
import { randSym } from '../../math/random';
import { Ship } from '../dynamic/dynamic-entity/ship';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import type { DynamicEntity, SerializedDynamicEntityFields } from '../dynamic/dynamic-entity/dynamic-entity';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
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
import type { ShipAssembly, ShipConnection } from './ship-assembly';
import { shipRenderAssembly } from './ship-render-adapter';
import { ShipCapabilities } from './ship-capabilities';
import { shipPhysicsShape } from './ship-physics-shape';
import {
  SHIP_DECOUPLING_COLLISION_GRACE, decoupledMasses, separationImpulseVelocities, splitAtDecoupler,
} from './ship-decoupling';
import { dockingEligibility } from './ship-docking';
import { repairDockedAssembly } from './ship-repair';
import type { ControlSelection } from '../control-selection';
import { ShipDockState } from './ship-dock-state';
import {
  restoreConstructionDrafts, restoreDockedVessels, restoreShipAssembly, serializeShipAssembly,
  type SerializedCollisionGrace, type SerializedDockedVessel, type SerializedShipAssembly,
  type SerializedShipConstructionDraft,
} from './ship-save';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { StageOutcome } from '../stages/stage-outcome';
import type { StageRules } from '../stages/stage-rules';

const HULL_START_TEMP = 273; // 初期機体温度 [K]

// 展開中の放熱板に当たった1発が放熱板パーツへ与えるダメージ [HP]。薄く大きい構造物なので
// 船体への直撃(PLASMA_BULLET_DAMAGE)より軽い。
const ALLY_BEARING_MAX_DISTANCE = 20e3; // 味方機の画面外方位マーカーを表示する上限距離 [m]

// 給弾ベルトの節点数。たわみ物理の鎖の長さと、表示するリンクメッシュの本数を揃える。
const BELT_MAX_VISIBLE = 18;

// 軌道計画の実行モードの巡回順。ボタン1つで次のモードへ進める。
// 新規配置は name/state/id/ammo を任意指定し、省略時は高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の
// 円軌道に機首プログレードで初期配置する。スナップショットからの再開は saved を simTime 付きの
// 状態として展開する。
export interface ModularShipInit {
  readonly name?: string;
  readonly state?: KinematicState;
  readonly id?: string;
  readonly ammo?: AmmoLoad;
  readonly assembly?: ShipAssembly;
  readonly att?: Attitude;
  readonly dockState?: readonly SerializedShipConstructionDraft[];
  readonly operatingCockpitId?: string | null;
}

export interface SerializedModularShip extends SerializedDynamicEntityFields {
  readonly kind: 'ship';
  readonly name: string;
  readonly assembly: SerializedShipAssembly;
  readonly dockState: readonly SerializedShipConstructionDraft[];
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
  readonly fineAttitude: boolean;
}

// モジュール船の操縦・射撃・ブースター・接触帰結・保存を合成する entity。
export class ModularShip extends Ship implements Controllable {
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
  public readonly docks: ShipDockState;
  public readonly throttle: Throttle;
  public readonly fire: FireControl;
  public readonly altitudeAlarm: AltitudeAlarm;
  private readonly effects: PlayerEffects;
  private readonly reactions: ModularShipReactions;
  private readonly scene: THREE.Scene;
  private readonly registry: EntityRegistry;
  private readonly dockedVessels = new Map<string, { readonly id: string; readonly name: string }>();
  private readonly collisionGrace = new Map<string, number>();
  // この艦自身のマニューバ計画。
  public readonly plan: Plan;
  private _planExecution: PlanExecutionMode;

  private _fineAttitude: boolean;
  // 自機の操作方法は HUD とヘルプが常設で示しているので、選び直しても案内は出さない。
  public readonly controlHint = null;
  public readonly releaseHint = null;
  public readonly toggleSolarPanel = (side: 'up' | 'down'): void => this.motion.power.toggle(side);
  public readonly toggleRadiator = (side: 'up' | 'down'): void => this.motion.radiator.toggle(side);

  public override get totalTorque(): number { return this.capabilities.totalTorque; }
  public override get totalThrust(): number { return this.capabilities.totalThrust; }
  public override get totalFuelConsumptionRate(): number {
    return this.capabilities.modules('thruster', true).reduce(
      (sum, module) => sum + (this.assembly.definition(module.id)?.abilities.fuelConsumptionRate ?? 0), 0,
    );
  }
  public get rcsFuelConsumptionRate(): number {
    return this.capabilities.modules('rcs', true).reduce(
      (sum, module) => sum + (this.assembly.definition(module.id)?.abilities.fuelConsumptionRate ?? 0), 0,
    );
  }
  public override get totalFuel(): number { return this.capabilities.fuel('main'); }
  public override get totalMaxFuel(): number { return this.capabilities.maxFuel('main'); }
  public get totalRcsFuel(): number { return this.capabilities.fuel('rcs'); }
  public get totalMaxRcsFuel(): number { return this.capabilities.maxFuel('rcs'); }
  public override consumeFuel(amount: number): number {
    if (amount <= 0) return 1;
    const consumed = this.capabilities.consumeFuel('main', amount);
    if (consumed > 0) this.motion.synchronizeAssembly();
    return consumed / amount;
  }
  public override refuelFuel(amount: number): number {
    const added = this.capabilities.refuel('main', amount);
    if (added > 0) this.motion.synchronizeAssembly();
    return added;
  }
  public consumeRcsFuel(amount: number): number {
    if (amount <= 0) return 1;
    const consumed = this.capabilities.consumeFuel('rcs', amount);
    if (consumed > 0) this.motion.synchronizeAssembly();
    return consumed / amount;
  }
  public refuelRcsFuel(amount: number): number {
    const added = this.capabilities.refuel('rcs', amount);
    if (added > 0) this.motion.synchronizeAssembly();
    return added;
  }
  public override get totalCoolingRate(): number { return this.capabilities.totalCoolingRate; }
  public override get totalPowerGeneration(): number { return this.capabilities.totalPowerGeneration; }
  public override get weaponDamage(): number { return this.capabilities.weaponDamage; }
  public override get totalFireRate(): number { return this.capabilities.totalFireRate; }
  public override get averageMuzzleVelocity(): number { return this.capabilities.averageMuzzleVelocity; }

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

  private constructor(
    registry: EntityRegistry,
    scene: THREE.Scene,
    init: { readonly placement: ModularShipInit } | { readonly serialized: SerializedModularShip },
  ) {
    const saved = 'serialized' in init ? init.serialized : undefined;
    const placement = 'placement' in init ? init.placement : undefined;
    const assembly = saved ? restoreShipAssembly(saved.assembly) : (placement?.assembly ?? createDefaultCombatPreset());
    const physics = shipPhysicsShape(assembly);
    if (physics === null) throw new Error('default modular ship preset is empty');
    const name = saved ? (saved.name || saved.id) : (placement?.name ?? generateRandomName('player'));
    const state = saved
      ? deserializeKinematicState(saved)
      : (placement?.state ?? kinematicState<'eci'>(0, v3(1, 0, 0), v3(0, 1, 0)));
    const id = registry.idAllocators.entity.next(saved?.id ?? placement?.id ?? name);
    const att: Attitude = saved
      ? deserializeAttitude(saved, physics.mass.inertia)
      : (placement?.att === undefined
        ? ModularShip.progradeAttitude(state, physics.mass.inertia)
        : { ...placement.att, inertia: physics.mass.inertia });

    let reactionHandler: ModularShipReactions | null = null;
    const requiredReactions = (): ModularShipReactions => {
      if (reactionHandler === null) throw new Error('modular ship reactions are not initialized');
      return reactionHandler;
    };
    const reactions = (owner: ModularShip): ModularShipMotionReactions => ({
      roundsInMagazine: () => owner.fire.rounds,
      stepBarrelThermal: dt => owner.fire.stepBarrelThermal(dt),
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
    });
    super(
      name,
      assembly.maxHp,
      owner => new ModularShipMotion(
        assembly,
        state,
        att,
        reactions(owner as ModularShip),
        {
          temperature: saved?.thermal.temperature ?? HULL_START_TEMP,
          beltLinkCount: BELT_MAX_VISIBLE,
          beltSave: saved?.belt,
          radiatorSave: saved?.radiator,
          powerSave: saved?.power,
        },
      ),
      new ModularShipDynamicView(scene, id, BELT_MAX_VISIBLE),
      id,
    );
    this.assembly = assembly;
    this.docks = new ShipDockState(saved
      ? restoreConstructionDrafts(saved.dockState, assembly)
      : placement?.dockState ? restoreConstructionDrafts(placement.dockState, assembly) : []);
    this.capabilities = new ShipCapabilities(
      assembly, saved?.operatingCockpitId ?? placement?.operatingCockpitId ?? null,
    );
    this.mapKind = assembly.role === 'base' ? 'base' : 'player';
    this.showsEquatorNodesAlways = assembly.role === 'base';
    this.hp = assembly.totalHp;
    this.maxHp = assembly.maxHp;
    this.registry = registry;
    this.scene = scene;
    this.throttle = saved?.throttle ? Throttle.deserialize(saved.throttle) : new Throttle();
    this.effects = new PlayerEffects(registry);
    this.reactions = new ModularShipReactions({
      motion: this.motion,
      assembly: this.assembly,
      effects: this.effects,
      syncAfterDamage: () => {
        this.hp = this.assembly.totalHp;
        this.maxHp = this.assembly.maxHp;
        this.capabilities.reconcileOperatingCockpit();
        this.syncDerivedRole();
      },
    });
    reactionHandler = this.reactions;
    this.plan = saved?.plan ? Plan.deserialize(saved.plan) : Plan.create();
    this._planExecution = saved?.planExecution ?? 'instant';
    this._fineAttitude = saved?.fineAttitude ?? false;
    if (saved) {
      for (const record of restoreDockedVessels(saved.dockedVessels, assembly)) {
        this.dockedVessels.set(record.connectionId, { id: record.id, name: record.name });
      }
      for (const grace of saved.collisionGrace) {
        if (typeof grace.otherId === 'string' && Number.isFinite(grace.until) && grace.until > state.t) {
          this.collisionGrace.set(grace.otherId, grace.until);
        }
      }
    }
    this.fire = new FireControl(
      this, registry, scene,
      saved?.fire ? WeaponState.deserialize(saved.fire) : placement?.ammo ? WeaponState.create(placement.ammo) : undefined,
    );
    this.altitudeAlarm = saved?.altitudeAlarm
      ? AltitudeAlarm.deserialize(saved.altitudeAlarm, registry.events)
      : new AltitudeAlarm(registry.events);
    if (saved?.plan) {
      const dropped = Plan.droppedNodeCount(saved.plan);
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

  public setPlanExecution(mode: PlanExecutionMode): void { this._planExecution = mode; }

  public get instantNodeTime(): number | null {
    return this._planExecution === 'instant' ? this.plan.firstNode()?.t ?? null : null;
  }

  public executeInstantNodesUpTo(simTime: number): void {
    if (this._planExecution !== 'instant') return;
    const due = this.plan.nodes.filter(node => node.t <= simTime);
    const reached = due[due.length - 1];
    if (reached === undefined) return;
    this.plan.consumeNodesUpTo(simTime, reached);
    this.motion.reset(reached);
  }

  private hpRegen(dt: number): void {
    let remaining = Math.max(0, dt);
    for (const module of this.assembly.modules) {
      if (remaining <= 0 || module.hp <= 0) continue;
      const maxHp = this.assembly.definition(module.id)?.maxHp ?? module.hp;
      const repaired = Math.min(remaining, Math.max(0, maxHp - module.hp));
      if (repaired > 0) this.assembly.setHp(module.id, module.hp + repaired);
      remaining -= repaired;
    }
    this.hp = this.assembly.totalHp;
  }

  // -------------------------------------------------------- 移動/射撃 状態
  public get roundsInMag(): number { return this.fire.rounds; }
  public get magsLeft(): number { return this.fire.mags; }
  public get reloadTimer(): number { return this.fire.cooldown; }

  // 展開操作の状態を module ID へ戻す。配列順は旧セーブの移行にだけ使い、継続状態の対応付けには使わない。
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
    const massAfter = this.motion.mass;
    const meanMass = Math.abs(massBefore - massAfter) < 1e-12
      ? massAfter
      : (massBefore - massAfter) / Math.log(massBefore / massAfter);
    const acceleration = meanMass > 0 ? averageThrust / meanMass : 0;
    return acceleration > 0
      ? scale(qRotate(this.motion.att.q, LOCAL_FORWARD), acceleration)
      : null;
  }

  public toggleBoosterIgnition(moduleId: string): boolean {
    const booster = this.assembly.module(moduleId);
    if (booster?.kind !== 'booster') throw new Error(`not a booster module: ${moduleId}`);
    const ignited = !(booster.ignited && booster.fuel > 0 && booster.hp > 0);
    this.assembly.setIgnited(moduleId, ignited);
    this.motion.invalidatePrediction();
    const updated = this.assembly.module(moduleId);
    return updated?.kind === 'booster' && updated.ignited;
  }

  // 条件を満たす二船を質量の大きい側へ統合し、軽い側の entity を選択系から除去する。
  public dock(
    other: ModularShip, localPortId: string, otherPortId: string,
    selection: ControlSelection,
  ): ModularShip {
    const eligibility = dockingEligibility(this, localPortId, other, otherPortId);
    if (!eligibility.eligible) throw new Error(eligibility.reasons[0] ?? '接舷できません');
    const anchor = other.motion.mass > this.motion.mass ? other : this;
    const moving = anchor === this ? other : this;
    const anchorPortId = anchor === this ? localPortId : otherPortId;
    const movingPortId = anchor === this ? otherPortId : localPortId;
    const anchorCockpitId = anchor.capabilities.operatingCockpitId;
    const movingCockpitId = moving.capabilities.operatingCockpitId;
    const merged = anchor.assembly.mergedAtDock(
      moving.assembly, anchorPortId, movingPortId, moving.id,
    );
    const shape = shipPhysicsShape(merged.assembly);
    if (shape === null) throw new Error('docking produced an empty ship');
    const rootPosition = sub(anchor.motion.state.r, qRotate(anchor.motion.att.q, anchor.motion.centerOffset));
    const position = add(rootPosition, qRotate(anchor.motion.att.q, shape.centerOffset));
    const totalMass = anchor.motion.mass + moving.motion.mass;
    const velocity = totalMass > 0
      ? scale(add(scale(anchor.motion.state.v, anchor.motion.mass), scale(moving.motion.state.v, moving.motion.mass)), 1 / totalMass)
      : anchor.motion.state.v;
    const t = anchor.motion.state.t;
    anchor.assembly.replaceWith(merged.assembly);
    anchor.docks.mergeFrom(moving.docks, merged.moduleIds, merged.connectionIds);
    anchor.motion.synchronizeAssembly();
    anchor.motion.reset(kinematicState<'eci'>(t, position, velocity));
    const anchorCockpit = anchorCockpitId === null ? null : anchor.assembly.module(anchorCockpitId);
    const movingCockpit = movingCockpitId === null ? null : merged.moduleIds.get(movingCockpitId);
    if (anchorCockpit?.kind === 'cockpit' && anchorCockpit.hp > 0) {
      anchor.capabilities.selectOperatingCockpit(anchorCockpit.id);
    } else if (movingCockpit !== null && movingCockpit !== undefined
      && anchor.assembly.module(movingCockpit)?.kind === 'cockpit'
      && (anchor.assembly.module(movingCockpit)?.hp ?? 0) > 0) {
      anchor.capabilities.selectOperatingCockpit(movingCockpit);
    } else {
      anchor.capabilities.reconcileOperatingCockpit();
    }
    for (const [connectionId, vessel] of moving.dockedVessels) {
      anchor.dockedVessels.set(merged.connectionIds.get(connectionId) ?? connectionId, vessel);
    }
    anchor.dockedVessels.set(merged.connectionId, { id: moving.id, name: moving.name });
    anchor.clearTransientCommands();
    moving.clearTransientCommands();
    const selectedParticipant = selection.current === this || selection.current === other;
    selection.remove(moving);
    if (selectedParticipant) selection.select(anchor);
    anchor.hp = anchor.assembly.totalHp;
    anchor.maxHp = anchor.assembly.maxHp;
    anchor.syncDerivedRole();
    return anchor;
  }

  // 指定ポートの docking/construction edge を切り、記録された identity で船を再登録する。
  public undock(portId: string, registry: EntityRegistry): ModularShip {
    const connection = this.assembly.detachableConnections().find(
      edge => edge.parentId === portId || edge.childId === portId,
    );
    if (connection === undefined) throw new Error(`docking module is not connected: ${portId}`);
    return this.separateConnection(connection, registry);
  }

  // 指定 edge の両側へ assembly と運動状態を分け、分離船を登録する。
  private separateConnection(
    connection: ShipConnection, registry: EntityRegistry,
    identity?: { readonly id?: string; readonly name: string },
  ): ModularShip {
    const parentRoot = this.assembly.worldTransformOf(connection.parentId);
    const detachedRoot = this.assembly.worldTransformOf(connection.childId);
    if (parentRoot === null || detachedRoot === null) throw new Error('missing separated branch transform');
    const operatingCockpitId = this.capabilities.operatingCockpitId;
    const working = this.assembly.clone();
    const [retainedAssembly, detachedAssembly] = working.splitAt(connection.id);
    const retainedShape = shipPhysicsShape(retainedAssembly);
    const detachedShape = shipPhysicsShape(detachedAssembly);
    if (retainedShape === null || detachedShape === null) throw new Error('undocking produced an empty ship');
    const q = this.motion.att.q;
    const w = this.motion.att.w;
    const t = this.motion.state.t;
    const rootPosition = sub(this.motion.state.r, qRotate(q, this.motion.centerOffset));
    const retainedPosition = add(rootPosition, qRotate(q, retainedShape.centerOffset));
    const detachedQ = qMul(q, detachedRoot.rotation);
    const detachedRootPosition = add(rootPosition, qRotate(q, detachedRoot.position));
    const detachedPosition = add(detachedRootPosition, qRotate(detachedQ, detachedShape.centerOffset));
    const omegaWorld = qRotate(q, w);
    const retainedVelocity = add(this.motion.state.v, cross(omegaWorld, sub(retainedPosition, this.motion.state.r)));
    const detachedBaseVelocity = add(this.motion.state.v, cross(omegaWorld, sub(detachedPosition, this.motion.state.r)));
    const separationAxisLocal = norm(sub(detachedRoot.position, parentRoot.position));
    const separationAxisWorld = len(separationAxisLocal) > 1e-12
      ? qRotate(q, separationAxisLocal)
      : qRotate(qMul(q, parentRoot.rotation), LOCAL_FORWARD);
    const velocities = separationImpulseVelocities(
      retainedVelocity, detachedBaseVelocity, separationAxisWorld,
      retainedShape.mass.totalMass, detachedShape.mass.totalMass,
    );
    const record = identity ?? this.dockedVessels.get(connection.id);
    const detached = ModularShip.create(
      {
        id: record?.id,
        name: record?.name ?? `${this.name} 分離船`,
        state: kinematicState<'eci'>(t, detachedPosition, velocities.detached),
        att: {
          q: detachedQ,
          w: qRotate(qInvert(detachedRoot.rotation), w),
          inertia: detachedShape.mass.inertia,
        },
        assembly: detachedAssembly,
        dockState: this.docks.copyForAssembly(detachedAssembly).serialize(),
        operatingCockpitId: operatingCockpitId !== null && detachedAssembly.module(operatingCockpitId) !== null
          ? operatingCockpitId : null,
      }, registry, this.scene,
    );
    const detachedDockingIds = new Set(
      detachedAssembly.dockingConnections().map(edge => edge.id),
    );
    for (const [connectionId, vessel] of [...this.dockedVessels]) {
      if (!detachedDockingIds.has(connectionId)) continue;
      detached.dockedVessels.set(connectionId, vessel);
      this.dockedVessels.delete(connectionId);
    }
    this.clearTransientCommands();
    this.assembly.replaceWith(retainedAssembly);
    this.docks.restrictToAssembly(retainedAssembly);
    this.motion.synchronizeAssembly();
    this.motion.reset(kinematicState<'eci'>(t, retainedPosition, velocities.retained));
    this.hp = this.assembly.totalHp;
    this.maxHp = this.assembly.maxHp;
    this.capabilities.reconcileOperatingCockpit();
    this.syncDerivedRole();
    this.dockedVessels.delete(connection.id);
    const collisionEnableAt = t + SHIP_DECOUPLING_COLLISION_GRACE;
    this.ignoreCollisionsWith(detached, collisionEnableAt);
    registry.add(detached);
    return detached;
  }

  // 接舷済みの統合船体を指定接舷部から一括修理し、導出状態を同期する。
  public repairAtDock(portId: string): number {
    const repaired = repairDockedAssembly(this.assembly, portId);
    this.hp = this.assembly.totalHp;
    this.maxHp = this.assembly.maxHp;
    this.capabilities.reconcileOperatingCockpit();
    this.syncDerivedRole();
    return repaired;
  }

  // assembly を直接編集する建造系の操作後に、質量特性・耐久値・能力・表示上の役割を一括更新する。
  public synchronizeAssemblyState(): void {
    if (this.assembly.size === 0) {
      this.motion.kill();
      return;
    }
    this.motion.synchronizeAssembly();
    this.hp = this.assembly.totalHp;
    this.maxHp = this.assembly.maxHp;
    this.capabilities.reconcileOperatingCockpit();
    this.syncDerivedRole();
  }

  private syncDerivedRole(): void {
    this.mapKind = this.capabilities.role === 'base' ? 'base' : 'player';
    this.showsEquatorNodesAlways = this.capabilities.role === 'base';
  }

  // 健全なデカプラーで船体と運動量を二分し、分離船と火工品 debris を登録する。
  public decouple(decouplerId: string, registry: EntityRegistry): ModularShip {
    const operatingCockpitId = this.capabilities.operatingCockpitId;
    const before = this.motion.physicsShape;
    const split = splitAtDecoupler(this.assembly, decouplerId);
    const masses = decoupledMasses(split);
    const retainedShape = shipPhysicsShape(split.retained);
    const detachedShape = shipPhysicsShape(split.detached);
    if (retainedShape === null || detachedShape === null) throw new Error('decoupling produced an empty ship');

    const q = { ...this.motion.att.q };
    const w = { ...this.motion.att.w };
    const rootPosition = sub(this.motion.state.r, qRotate(q, before.centerOffset));
    const retainedPosition = add(rootPosition, qRotate(q, retainedShape.centerOffset));
    const detachedQ = qMul(q, split.detachedRoot.rotation);
    const detachedRootPosition = add(rootPosition, qRotate(q, split.detachedRoot.position));
    const decouplerPosition = add(rootPosition, qRotate(q, split.decouplerTransform.position));
    const detachedPosition = add(detachedRootPosition, qRotate(detachedQ, detachedShape.centerOffset));
    const angularVelocityWorld = qRotate(q, w);
    const retainedBaseVelocity = add(
      this.motion.state.v, cross(angularVelocityWorld, sub(retainedPosition, this.motion.state.r)),
    );
    const detachedBaseVelocity = add(
      this.motion.state.v, cross(angularVelocityWorld, sub(detachedPosition, this.motion.state.r)),
    );
    const separationAxisWorld = qRotate(q, split.separationAxis);
    const velocities = separationImpulseVelocities(
      retainedBaseVelocity, detachedBaseVelocity, separationAxisWorld, masses.retained, masses.detached,
    );
    const t = this.motion.state.t;

    const detachedW = qRotate(qInvert(split.detachedRoot.rotation), w);
    const detached = ModularShip.create(
      {
        name: `${this.name} 分離体`,
        id: `${this.id}-${decouplerId}`,
        state: kinematicState<'eci'>(t, detachedPosition, velocities.detached),
        att: { q: detachedQ, w: detachedW, inertia: detachedShape.mass.inertia },
        assembly: split.detached,
        dockState: this.docks.copyForAssembly(split.detached).serialize(),
        operatingCockpitId: operatingCockpitId !== null && split.detached.module(operatingCockpitId) !== null
          ? operatingCockpitId : null,
      }, registry, this.scene,
    );
    // 分離船の構築成功後に live assembly を差し替え、途中失敗を原船へ反映させない。
    this.clearTransientCommands();
    this.assembly.replaceWith(split.retained);
    this.docks.restrictToAssembly(split.retained);
    this.motion.synchronizeAssembly();
    this.motion.resetRigidState(
      kinematicState<'eci'>(t, retainedPosition, velocities.retained),
      { ...this.motion.att, q, w },
    );
    this.hp = this.assembly.totalHp;
    this.maxHp = this.assembly.maxHp;
    this.capabilities.reconcileOperatingCockpit();
    this.syncDerivedRole();
    const collisionEnableAt = t + SHIP_DECOUPLING_COLLISION_GRACE;
    this.ignoreCollisionsWith(detached, collisionEnableAt);
    registry.add(detached);
    this.scatterDecouplerPanels(t, decouplerPosition, q, this.motion.state.v, registry);
    registry.events.record({
      kind: 'boosterDecoupled', stages: this.capabilities.modules('booster').length,
      jointState: kinematicState<'eci'>(t, detachedRootPosition, this.motion.state.v),
    });
    return detached;
  }

  // 消費したリングを周方向8枚の物理 debris として散らす。通常 snapshot には残さない。
  private scatterDecouplerPanels(
    t: number, center: Vec3, attitude: Attitude['q'], baseVelocity: Vec3, registry: EntityRegistry,
  ): void {
    const segments = 8;
    for (let segment = 0; segment < segments; segment++) {
      const angle = segment * Math.PI * 2 / segments;
      const radial = qRotate(attitude, v3(Math.cos(angle), Math.sin(angle), 0));
      registry.add(DebrisPiece.create(
        kinematicState<'eci'>(t, add(center, scale(radial, 3)), add(baseVelocity, scale(radial, 5))),
        { kind: 'decouplerPanel', segment, bornSim: t },
        {
          q: attitude,
          w: v3(randSym(1.4), randSym(1.4), randSym(1.4)),
          inertia: v3(1, 1.7, 2.4),
        },
        registry.idAllocators, 0.8, this.scene,
      ));
    }
  }

  private ignoreCollisionsWith(other: ModularShip, until: number): void {
    this.motion.ignoreCollisionWith(other.motion, until);
    other.motion.ignoreCollisionWith(this.motion, until);
    this.collisionGrace.set(other.id, until);
    other.collisionGrace.set(this.id, until);
  }

  // 復元した ID 参照を motion 参照へ結び、期限切れ・欠損記録を取り除く。
  public restoreCollisionGrace(ships: readonly ModularShip[]): void {
    for (const [otherId, until] of [...this.collisionGrace]) {
      const other = ships.find(ship => ship.id === otherId);
      if (other === undefined || until <= this.motion.state.t) {
        this.collisionGrace.delete(otherId);
        continue;
      }
      this.motion.ignoreCollisionWith(other.motion, until);
    }
  }

  // ブースターとデカプラーがある艦の燃焼管理表示を組み立てる。
  public burnManagementViewModel(): BurnManagementViewModel | null {
    const boosters = this.capabilities.modules('booster');
    const decouplers = this.capabilities.modules('decoupler');
    if (boosters.length === 0 && decouplers.length === 0) return null;
    const activeFuel = boosters.reduce((total, module) => total + module.fuel, 0);
    const activeFuelMax = boosters.reduce(
      (total, module) => total + (this.assembly.definition(module.id)?.abilities.fuelCapacity ?? 0), 0,
    );
    const anyIgnited = boosters.some(module => module.ignited && module.fuel > 0 && module.hp > 0);
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

  public handleCommand(command: PilotCommand): void {
    const events = this.registry.events;
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
    // eslint-disable-next-line no-restricted-syntax
    orbitReference: OrbitReference | undefined,
  ): ModularShipRenderSource {
    const motion = this.motion;
    const { belt } = motion;
    // 指令の有無は加速度の大きさで決まるので、噴射していないフレームは null として渡す。
    const thrustAcceleration = motion.thrust;
    return {
      ...super.renderSource(viewFrame, active, orbitReference),
      assembly: shipRenderAssembly(this.assembly),
      centerOffset: motion.centerOffset,
      state: motion.state,
      active,
      thrustAcceleration: thrustAcceleration !== null && len(thrustAcceleration) > 0
        ? thrustAcceleration
        : null,
      maximumAcceleration: motion.mass > 0 ? this.totalThrust / motion.mass : 0,
      torque: motion.torque,
      dynamicPressure: motion.aero.qdyn,
      belt: { anchor: belt.anchor, positions: belt.positions, twists: belt.twists },
      magsLeft: this.magsLeft,
    };
  }

  // 自身に関するメッシュやエフェクトを解放する。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTransientCommands();
    super.dispose();
  }

  // 現在の艦状態を保存用データへ変換する。
  public override serialize(): SerializedModularShip {
    return {
      ...this.serializeEntityFields(ModularShip.kind),
      name: this.name,
      assembly: serializeShipAssembly(this.assembly),
      dockState: this.docks.serialize(),
      dockedVessels: [...this.dockedVessels].map(([connectionId, vessel]) => ({ connectionId, ...vessel })),
      collisionGrace: [...this.collisionGrace]
        .filter(([, until]) => until > this.motion.state.t)
        .map(([otherId, until]) => ({ otherId, until })),
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
