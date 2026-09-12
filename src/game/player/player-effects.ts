import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { FlashEffects } from '../vfx/flash-effects';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { KinematicState } from '../../physics/kinematic-state';
import type { Vec3 } from '../../math/vec3';
import type { BulletType } from '../dynamic/dynamic-entity/bullet-reaction';
import type { RadiatorSide } from './radiator';
import {
  buildDestroyFragments, DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN,
  PLAYER_DESTROY_FRAG_COLOR, playerDestroyFragments,
} from '../dynamic/dynamic-entity/debris-piece';
import { len, sub } from '../../math/vec3';

export interface PlayerEffects {
  impact(type: BulletType, state: KinematicState, impactPoint: Vec3): void;
  contact(state: KinematicState): void;
  destroy(state: KinematicState, registry: EntityRegistry): void;
  radiatorBreak(side: RadiatorSide, state: KinematicState, tip: Vec3, registry: EntityRegistry): void;
}

// 自機固有の音・閃光・破片をまとめる副作用 port の既定実装。
export class DefaultPlayerEffects implements PlayerEffects {
  public constructor(
    private readonly worldSfx: WorldSfx,
    private readonly fx: FlashEffects,
  ) {}

  public impact(type: BulletType, state: KinematicState, impactPoint: Vec3): void {
    this.worldSfx.hit(len(sub(impactPoint, state.r)));
    const impact = { t: state.t, r: impactPoint, v: state.v } as KinematicState<'eci'>;
    if (type === 'plasma') this.fx.spawnPlasmaFlash(impact);
    else this.fx.spawnBulletFlash(impact);
    this.fx.spawnGasPuff(impact);
  }

  public contact(state: KinematicState): void {
    this.worldSfx.clank();
    this.fx.spawnGasPuff(state);
  }

  public destroy(state: KinematicState, registry: EntityRegistry): void {
    this.worldSfx.explosion();
    this.fx.spawnPlayerDestroyFlash(state);
    for (const piece of playerDestroyFragments(state, this.worldSfx, this.fx)) registry.add(piece);
  }

  public radiatorBreak(_side: RadiatorSide, state: KinematicState, tip: Vec3, registry: EntityRegistry): void {
    this.worldSfx.hit(len(sub(tip, state.r)));
    for (const piece of buildDestroyFragments(
      state.t, tip, state.v, 4, PLAYER_DESTROY_FRAG_COLOR,
      DESTROY_FRAG_SIZE_MIN, DESTROY_FRAG_SIZE_MAX, 8.0,
      this.worldSfx, this.fx,
    )) registry.add(piece);
  }
}
