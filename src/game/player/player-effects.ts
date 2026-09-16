// 自機が被弾・接触・喪失したときに起きたことの記録と、そのとき出る破片を組み立てる。
import type { RunEventSink } from '../run-events';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Vec3 } from '../../math/vec3';
import type { BulletType } from '../dynamic/dynamic-entity/bullet-reaction';
import {
  buildDestroyFragments, DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN,
  PLAYER_DESTROY_FRAG_COLOR, playerDestroyFragments,
} from '../dynamic/dynamic-entity/debris-piece';

// 放熱板が全損したとき、その先端から出す破片の数。
const RADIATOR_BREAK_FRAGMENTS = 4;
// 放熱板の破片へ乗せる速度のばらつき [m/s]。
const RADIATOR_BREAK_VELOCITY_SPREAD = 8.0;

export class PlayerEffects {
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

  // 放熱板が全損した瞬間の出来事と破片を、そのパネル先端 tip から出す。
  public radiatorBreak(state: KinematicState, tip: Vec3, registry: EntityRegistry): void {
    this.events.record({ kind: 'shipStruck', impactPoint: tip, shipState: state, bullet: null });
    for (const piece of buildDestroyFragments(
      state.t, tip, state.v, RADIATOR_BREAK_FRAGMENTS, PLAYER_DESTROY_FRAG_COLOR,
      DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, RADIATOR_BREAK_VELOCITY_SPREAD,
      registry.idAllocators,
    )) registry.add(piece);
  }
}
