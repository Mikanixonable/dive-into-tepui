import type { RunEventSink } from '../run-events';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Vec3 } from '../../math/vec3';
import type { BulletType } from '../dynamic/dynamic-entity/bullet-reaction';
import type { RadiatorSide } from './radiator';
import {
  buildDestroyFragments, DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN,
  PLAYER_DESTROY_FRAG_COLOR, playerDestroyFragments,
} from '../dynamic/dynamic-entity/debris-piece';

export interface PlayerEffects {
  impact(type: BulletType, state: KinematicState, impactPoint: Vec3): void;
  contact(state: KinematicState): void;
  destroy(state: KinematicState, registry: EntityRegistry): void;
  radiatorBreak(side: RadiatorSide, state: KinematicState, tip: Vec3, registry: EntityRegistry): void;
}

// 自機固有の出来事と破片をまとめる副作用 port の既定実装。
export class DefaultPlayerEffects implements PlayerEffects {
  public constructor(private readonly events: RunEventSink) {}

  // 撃破に至らない被弾の出来事。impactPoint は着弾点の ECI 位置。
  public impact(type: BulletType, state: KinematicState, impactPoint: Vec3): void {
    this.events.record({ kind: 'shipStruck', impactPoint, shipState: state, bullet: type });
  }

  // 物体どうしがぶつかったときの出来事。
  public contact(state: KinematicState): void {
    this.events.record({ kind: 'shipDamagedByContact', state });
  }

  // 機体喪失の出来事と破片。破片は registry へ足す。
  public destroy(state: KinematicState, registry: EntityRegistry): void {
    this.events.record({ kind: 'shipExploded', state, modelScale: 1 });
    for (const piece of playerDestroyFragments(
      state, registry.idAllocators,
    )) registry.add(piece);
  }

  // 放熱板が全損した瞬間の破片を、そのパネル先端 tip から出す。
  public radiatorBreak(_side: RadiatorSide, state: KinematicState, tip: Vec3, registry: EntityRegistry): void {
    this.events.record({ kind: 'shipStruck', impactPoint: tip, shipState: state, bullet: null });
    for (const piece of buildDestroyFragments(
      state.t, tip, state.v, 4, PLAYER_DESTROY_FRAG_COLOR,
      DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, 8.0,
      registry.idAllocators,
    )) registry.add(piece);
  }
}
