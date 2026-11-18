// 接舷・分離・修理に伴う assembly と運動状態の遷移を所有する。
// ModularShip は entity としての公開口を残し、このクラスが接続 identity と衝突猶予を保持する。
import type * as THREE from 'three/webgpu';
import { LOCAL_FORWARD, qInvert, qMul, qRotate, type Quat } from '../../math/quat';
import { add, cross, len, norm, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { randSym } from '../../math/random';
import { kinematicState } from '../../physics/kinematic-state';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import type { ControlSelection } from '../control-selection';
import type { ModularShip, ModularShipInit } from './modular-ship';
import type { ModularShipMotion } from './modular-ship-motion';
import type { ShipAssembly, ShipConnection } from './ship-assembly';
import { shipPhysicsShape } from './ship-physics-shape';
import {
  SHIP_DECOUPLING_COLLISION_GRACE, decoupledMasses, separationImpulseVelocities, splitAtDecoupler,
} from './ship-decoupling';
import { dockingEligibility } from './ship-docking';
import { repairDockedAssembly } from './ship-repair';
import type { ShipCapabilities } from './ship-capabilities';
import {
  deserializeDockedVessels,
  type SerializedCollisionGrace,
  type SerializedDockedVessel,
} from './ship-assembly-serialization';

interface DockedVesselRecord {
  readonly id: string;
  readonly name: string;
}

interface ModularShipConnectionHost {
  readonly ship: ModularShip;
  readonly id: string;
  readonly name: string;
  readonly scene: THREE.Scene;
  readonly assembly: ShipAssembly;
  readonly capabilities: ShipCapabilities;
  readonly motion: ModularShipMotion;
  createShip(init: ModularShipInit, registry: EntityRegistry): ModularShip;
  clearTransientCommands(): void;
  syncAssemblyDerivedState(): void;
}

export class ModularShipConnectionOperations {
  private readonly dockedVessels = new Map<string, DockedVesselRecord>();
  private readonly collisionGrace = new Map<string, number>();

  public constructor(private readonly host: ModularShipConnectionHost) {}

  // 両船を接舷して一体化し、統合を受けた側(質量の大きい方)の船を返す。接舷できなければ失敗にする。
  public dock(
    other: ModularShip, localPortId: string, otherPortId: string,
    selection: ControlSelection,
  ): ModularShip {
    // 接舷可否の判定と、一体化の受け皿となる anchor の選定。
    const eligibility = dockingEligibility(this.host.ship, localPortId, other, otherPortId);
    if (!eligibility.eligible) throw new Error(eligibility.reasons[0] ?? '接舷できません');
    const anchor = other.motion.mass > this.host.motion.mass ? other : this.host.ship;
    const moving = anchor === this.host.ship ? other : this.host.ship;
    const anchorPortId = anchor === this.host.ship ? localPortId : otherPortId;
    const movingPortId = anchor === this.host.ship ? otherPortId : localPortId;
    const anchorCockpitId = anchor.capabilities.operatingCockpitId;
    const movingCockpitId = moving.capabilities.operatingCockpitId;
    // assembly の統合と、合体後の運動状態(質量重心・運動量保存)の計算。
    const merged = anchor.assembly.mergedAtDock(
      moving.assembly, anchorPortId, movingPortId, moving.id,
    );
    const shape = shipPhysicsShape(merged.assembly);
    if (shape === null) throw new Error('docking produced an empty ship');
    const position = anchor.motion.assemblyToEci(shape.centerOffset);
    const totalMass = anchor.motion.mass + moving.motion.mass;
    const velocity = totalMass > 0
      ? scale(add(scale(anchor.motion.state.v, anchor.motion.mass), scale(moving.motion.state.v, moving.motion.mass)), 1 / totalMass)
      : anchor.motion.state.v;
    const t = anchor.motion.state.t;
    anchor.assembly.replaceWith(merged.assembly);
    anchor.motion.synchronizeAssembly();
    anchor.motion.reset(kinematicState<'eci'>(t, position, velocity));
    // 統合後も健全なコックピットが残っていれば、それを操作コックピットへ再選する。
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
    anchor.connections.mergeDockedVesselsFrom(moving.connections, merged.connectionIds, merged.connectionId, moving);
    anchor.clearTransientCommands();
    moving.clearTransientCommands();
    // 消えた moving を選択から外し、どちらかが選ばれていれば anchor へ選び直す。
    const selectedParticipant = selection.current === this.host.ship || selection.current === other;
    selection.remove(moving);
    if (selectedParticipant) selection.select(anchor);
    anchor.connections.syncAssemblyDerivedState();
    return anchor;
  }

  // portId が関わる接舷接続を切り離し、外側の部分を新しい船として返す。
  public undock(portId: string, registry: EntityRegistry): ModularShip {
    const connection = this.host.assembly.detachableConnections().find(
      edge => edge.parentId === portId || edge.childId === portId,
    );
    if (connection === undefined) throw new Error(`docking module is not connected: ${portId}`);
    return this.separateConnection(connection, registry);
  }

  // connection を切断して船を2つへ分け、子側を新しい船として registry へ加えて返す。
  // identity は直前の接舷相手の記録で、分離船の id・name に使う。
  private separateConnection(
    connection: ShipConnection, registry: EntityRegistry,
    identity?: { readonly id?: string; readonly name: string },
  ): ModularShip {
    // 切断前に両側のワールド変換を取り、切り離し後の位置・速度の基準にする。
    const parentRoot = this.host.assembly.worldTransformOf(connection.parentId);
    const detachedRoot = this.host.assembly.worldTransformOf(connection.childId);
    if (parentRoot === null || detachedRoot === null) throw new Error('missing separated branch transform');
    const operatingCockpitId = this.host.capabilities.operatingCockpitId;
    const working = this.host.assembly.clone();
    const [retainedAssembly, detachedAssembly] = working.splitAt(connection.id);
    const retainedShape = shipPhysicsShape(retainedAssembly);
    const detachedShape = shipPhysicsShape(detachedAssembly);
    if (retainedShape === null || detachedShape === null) throw new Error('undocking produced an empty ship');
    // 分離両側の運動状態。回転する船からの分離なので、各重心の位置まわりの速度成分を加える。
    const q = this.host.motion.att.q;
    const w = this.host.motion.att.w;
    const t = this.host.motion.state.t;
    const retainedPosition = this.host.motion.assemblyToEci(retainedShape.centerOffset);
    const detachedQ = qMul(q, detachedRoot.rotation);
    const detachedRootPosition = this.host.motion.assemblyToEci(detachedRoot.position);
    const detachedPosition = add(detachedRootPosition, qRotate(detachedQ, detachedShape.centerOffset));
    const omegaWorld = qRotate(q, w);
    const retainedVelocity = add(this.host.motion.state.v, cross(omegaWorld, sub(retainedPosition, this.host.motion.state.r)));
    const detachedBaseVelocity = add(this.host.motion.state.v, cross(omegaWorld, sub(detachedPosition, this.host.motion.state.r)));
    const separationAxisLocal = norm(sub(detachedRoot.position, parentRoot.position));
    const separationAxisWorld = len(separationAxisLocal) > 1e-12
      ? qRotate(q, separationAxisLocal)
      : qRotate(qMul(q, parentRoot.rotation), LOCAL_FORWARD);
    const velocities = separationImpulseVelocities(
      retainedVelocity, detachedBaseVelocity, separationAxisWorld,
      retainedShape.mass.totalMass, detachedShape.mass.totalMass,
    );
    // 分離船の構築。identity か接舷記録があれば id・name を引き継ぐ。
    const record = identity ?? this.dockedVessels.get(connection.id);
    const detached = this.host.createShip({
      id: record?.id,
      name: record?.name ?? `${this.host.name} 分離船`,
      state: kinematicState<'eci'>(t, detachedPosition, velocities.detached),
      att: {
        q: detachedQ,
        w: qRotate(qInvert(detachedRoot.rotation), w),
        inertia: detachedShape.mass.inertia,
      },
      assembly: detachedAssembly,
      operatingCockpitId: operatingCockpitId !== null && detachedAssembly.module(operatingCockpitId) !== null
        ? operatingCockpitId : null,
    }, registry);
    // 分離船へ出て行った接舷の記録は分離船側へ移す。
    const detachedDockingIds = new Set(
      detachedAssembly.dockingConnections().map(edge => edge.id),
    );
    for (const [connectionId, vessel] of [...this.dockedVessels]) {
      if (!detachedDockingIds.has(connectionId)) continue;
      detached.connections.setDockedVessel(connectionId, vessel);
      this.dockedVessels.delete(connectionId);
    }
    // 残る側の assembly・運動状態の差し替えと、直後の衝突猶予。
    this.host.clearTransientCommands();
    this.host.assembly.replaceWith(retainedAssembly);
    this.host.motion.synchronizeAssembly();
    this.host.motion.reset(kinematicState<'eci'>(t, retainedPosition, velocities.retained));
    this.host.syncAssemblyDerivedState();
    this.dockedVessels.delete(connection.id);
    const collisionEnableAt = t + SHIP_DECOUPLING_COLLISION_GRACE;
    this.ignoreCollisionsWith(detached, collisionEnableAt);
    registry.add(detached);
    return detached;
  }

  // portId の接舷接続で繋がる両側を修理し、実際に回復した HP を返す。
  public repairAtDock(portId: string): number {
    const repaired = repairDockedAssembly(this.host.assembly, portId);
    this.host.syncAssemblyDerivedState();
    return repaired;
  }

  // decouplerId のデカプラーで船を切り離し、先端部を新しい船として返す。
  public decouple(decouplerId: string, registry: EntityRegistry): ModularShip {
    const operatingCockpitId = this.host.capabilities.operatingCockpitId;
    const split = splitAtDecoupler(this.host.assembly, decouplerId);
    const masses = decoupledMasses(split);
    const retainedShape = shipPhysicsShape(split.retained);
    const detachedShape = shipPhysicsShape(split.detached);
    if (retainedShape === null || detachedShape === null) throw new Error('decoupling produced an empty ship');

    const q = { ...this.host.motion.att.q };
    const w = { ...this.host.motion.att.w };
    const retainedPosition = this.host.motion.assemblyToEci(retainedShape.centerOffset);
    const detachedQ = qMul(q, split.detachedRoot.rotation);
    const detachedRootPosition = this.host.motion.assemblyToEci(split.detachedRoot.position);
    const decouplerPosition = this.host.motion.assemblyToEci(split.decouplerTransform.position);
    const detachedPosition = add(detachedRootPosition, qRotate(detachedQ, detachedShape.centerOffset));
    const angularVelocityWorld = qRotate(q, w);
    const retainedBaseVelocity = add(
      this.host.motion.state.v, cross(angularVelocityWorld, sub(retainedPosition, this.host.motion.state.r)),
    );
    const detachedBaseVelocity = add(
      this.host.motion.state.v, cross(angularVelocityWorld, sub(detachedPosition, this.host.motion.state.r)),
    );
    const separationAxisWorld = qRotate(q, split.separationAxis);
    const velocities = separationImpulseVelocities(
      retainedBaseVelocity, detachedBaseVelocity, separationAxisWorld, masses.retained, masses.detached,
    );
    const t = this.host.motion.state.t;
    const detachedW = qRotate(qInvert(split.detachedRoot.rotation), w);
    const detached = this.host.createShip({
      name: `${this.host.name} 分離体`,
      id: `${this.host.id}-${decouplerId}`,
      state: kinematicState<'eci'>(t, detachedPosition, velocities.detached),
      att: { q: detachedQ, w: detachedW, inertia: detachedShape.mass.inertia },
      assembly: split.detached,
      operatingCockpitId: operatingCockpitId !== null && split.detached.module(operatingCockpitId) !== null
        ? operatingCockpitId : null,
    }, registry);
    // 分離船の構築成功後に live assembly を差し替え、途中失敗を原船へ反映させない。
    this.host.clearTransientCommands();
    this.host.assembly.replaceWith(split.retained);
    this.host.motion.synchronizeAssembly();
    this.host.motion.resetRigidState(
      kinematicState<'eci'>(t, retainedPosition, velocities.retained),
      { ...this.host.motion.att, q, w },
    );
    this.host.syncAssemblyDerivedState();
    const collisionEnableAt = t + SHIP_DECOUPLING_COLLISION_GRACE;
    this.ignoreCollisionsWith(detached, collisionEnableAt);
    registry.add(detached);
    this.scatterDecouplerPanels(t, decouplerPosition, q, this.host.motion.state.v, registry);
    registry.events.record({
      kind: 'boosterDecoupled', stages: this.host.capabilities.modules('booster').length,
      jointState: kinematicState<'eci'>(t, detachedRootPosition, this.host.motion.state.v),
    });
    return detached;
  }

  // 切断面を囲む8枚のデカプラーパネルを、外向きの初速を持つデブリとしてばら撒く。
  private scatterDecouplerPanels(
    t: number, center: Vec3, attitude: Quat, baseVelocity: Vec3, registry: EntityRegistry,
  ): void {
    for (let segment = 0; segment < 8; segment++) {
      // 各方向へ1枚ずつ、切断面から 3m 外・外向き 5m/s の初速で落とす。
      const angle = segment * Math.PI * 2 / 8;
      const radial = qRotate(attitude, v3(Math.cos(angle), Math.sin(angle), 0));
      registry.add(DebrisPiece.create(
        kinematicState<'eci'>(t, add(center, scale(radial, 3)), add(baseVelocity, scale(radial, 5))),
        { kind: 'decouplerPanel', segment, bornSim: t },
        {
          q: attitude,
          w: v3(randSym(1.4), randSym(1.4), randSym(1.4)),
          inertia: v3(1, 1.7, 2.4),
        },
        registry.idAllocators, 0.8, this.host.scene,
      ));
    }
  }

  // 両船どうしの衝突を until(simTime)まで無視させ、その期限を両側へ記録する。
  private ignoreCollisionsWith(other: ModularShip, until: number): void {
    this.host.motion.ignoreCollisionWith(other.motion, until);
    other.motion.ignoreCollisionWith(this.host.motion, until);
    this.collisionGrace.set(other.id, until);
    other.connections.setCollisionGrace(this.host.id, until);
  }

  // 復元した衝突猶予を現在の船一覧へ再適用する。期限切れ・相手不明の分は捨てる。
  public restoreCollisionGrace(ships: readonly ModularShip[]): void {
    for (const [otherId, until] of [...this.collisionGrace]) {
      const other = ships.find(ship => ship.id === otherId);
      if (other === undefined || until <= this.host.motion.state.t) {
        this.collisionGrace.delete(otherId);
        continue;
      }
      this.host.motion.ignoreCollisionWith(other.motion, until);
    }
  }

  // moving が持っていた接舷記録を統合後の接続 ID へ移し、moving 自身の記録を新しい接続へ載せる。
  public mergeDockedVesselsFrom(
    moving: ModularShipConnectionOperations,
    connectionIds: ReadonlyMap<string, string>, connectionId: string, movingShip: ModularShip,
  ): void {
    for (const [oldConnectionId, vessel] of moving.dockedRecords()) {
      this.dockedVessels.set(connectionIds.get(oldConnectionId) ?? oldConnectionId, vessel);
    }
    this.dockedVessels.set(connectionId, { id: movingShip.id, name: movingShip.name });
  }

  private dockedRecords(): readonly (readonly [string, DockedVesselRecord])[] {
    return [...this.dockedVessels];
  }

  // connectionId の接続へ接舷船の記録を対応付ける。
  public setDockedVessel(connectionId: string, record: DockedVesselRecord): void {
    this.dockedVessels.set(connectionId, record);
  }

  // otherId の船との衝突猶予の期限を記録する。
  public setCollisionGrace(otherId: string, until: number): void {
    this.collisionGrace.set(otherId, until);
  }

  // assembly 変更後の派生状態(HP・操作コックピット・役割)を host へ再計算させる。
  public syncAssemblyDerivedState(): void {
    this.host.syncAssemblyDerivedState();
  }

  // 直列化された接舷記録と衝突猶予を復元する。simTime までに切れる猶予は捨てる。
  public deserializeConnectionState(
    dockedVessels: readonly SerializedDockedVessel[],
    collisionGrace: readonly SerializedCollisionGrace[],
    simTime: number,
  ): void {
    for (const record of deserializeDockedVessels(dockedVessels, this.host.assembly)) {
      this.dockedVessels.set(record.connectionId, { id: record.id, name: record.name });
    }
    for (const grace of collisionGrace) {
      if (typeof grace.otherId === 'string' && Number.isFinite(grace.until) && grace.until > simTime) {
        this.collisionGrace.set(grace.otherId, grace.until);
      }
    }
  }

  // 接舷中の船の記録を直列化した形で返す。
  public serializeDockedVessels(): readonly SerializedDockedVessel[] {
    return [...this.dockedVessels].map(([connectionId, vessel]) => ({ connectionId, ...vessel }));
  }

  // simTime の時点でもまだ残る衝突猶予を直列化した形で返す。
  public serializeCollisionGrace(simTime: number): readonly SerializedCollisionGrace[] {
    return [...this.collisionGrace]
      .filter(([, until]) => until > simTime)
      .map(([otherId, until]) => ({ otherId, until }));
  }
}
