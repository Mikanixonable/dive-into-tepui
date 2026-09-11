import type * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { randomQuat } from '../../../math/quat';
import { randSym } from '../../../math/random';
import { add, randVec, type Vec3, v3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { CapKind } from './entity-kind';
import {
  BoosterExplosiveBoltView, BoosterInterstageCoverPanelView,
} from '../../../render/dynamic/dynamic-entity/booster-interstage-part-view';
import { CasingView } from '../../../render/dynamic/dynamic-entity/casing-view';
import { DebrisFragmentView } from '../../../render/dynamic/dynamic-entity/debris-fragment-view';
import {
  BarrelView, MagazineFrameView,
} from '../../../render/dynamic/dynamic-entity/ejected-gun-part-view';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import { DynamicEntity } from './dynamic-entity';
import type { DebrisKind } from './debris-kind';
import { DebrisMotion } from './debris-motion';
import { DebrisReaction } from './debris-reaction';
import {
  DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, ENEMY_DESTROY_FRAG_COLOR,
  PLAYER_DESTROY_FRAG_COLOR,
} from '../../../render/vfx-style';

// 論理種別から、その破片を描く View を組み立てる。
function debrisPieceView(debrisKind: DebrisKind, scene?: THREE.Scene): DynamicView {
  switch (debrisKind.kind) {
    case 'fragment': return new DebrisFragmentView(debrisKind.accent, debrisKind.size, scene);
    case 'barrel': return new BarrelView(scene);
    case 'magazineFrame': return new MagazineFrameView(scene);
    case 'casing': return new CasingView(scene);
    case 'boosterCover': return new BoosterInterstageCoverPanelView(debrisKind.segment, scene);
    case 'boosterBolt': return new BoosterExplosiveBoltView(debrisKind.segment, scene);
  }
}

export class DebrisPiece extends DynamicEntity {
  public override readonly capKind: CapKind;

  // 破片1個を、種別 debrisKind に応じた View と Motion で組み立てる。
  public constructor(
    state: KinematicState,
    debrisKind: DebrisKind,
    attitude: Attitude,
    worldSfx: WorldSfx,
    effects: FlashEffects,
    radius?: number,
    scene?: THREE.Scene,
  ) {
    super(
      () => new DebrisMotion(state, attitude, {
        kind: debrisKind.kind,
        behavior: new DebrisReaction(
          debrisKind.kind,
          'bornSim' in debrisKind ? debrisKind.bornSim : null,
          worldSfx,
          effects,
        ),
        radius,
        temperature: debrisKind.kind === 'barrel' ? debrisKind.bornTemperature : undefined,
        thermalDeviation: debrisKind.kind === 'barrel'
          ? debrisKind.bornThermalDeviation
          : undefined,
      }),
      debrisPieceView(debrisKind, scene),
    );
    this.capKind = debrisKind.kind === 'casing' ? 'casing' : 'debris';
  }
}

export function buildDestroyFragments(
  t: number,
  origin: Vec3,
  baseVel: Vec3,
  count: number,
  accent: string | number,
  sizeMin: number,
  sizeMax: number,
  spread: number,
  worldSfx: WorldSfx,
  effects: FlashEffects,
): DebrisPiece[] {
  const pieces: DebrisPiece[] = [];
  for (let i = 0; i < count; i++) {
    const size = sizeMin + Math.random() * (sizeMax - sizeMin);
    const state = kinematicState<'eci'>(t, add(origin, randVec(2.5)), add(baseVel, randVec(spread)));
    const attitude = {
      q: randomQuat(),
      w: v3(
        randSym(0.25),
        (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1),
        randSym(0.25),
      ),
      inertia: v3(1, 2.05, 3.0),
    };
    pieces.push(new DebrisPiece(
      state, { kind: 'fragment', accent, size }, attitude, worldSfx, effects));
  }
  return pieces;
}

// 自機の撃破で飛び散る破片。
export function playerDestroyFragments(
  state: KinematicState, worldSfx: WorldSfx, effects: FlashEffects,
): DebrisPiece[] {
  return buildDestroyFragments(
    state.t, state.r, state.v, 11, PLAYER_DESTROY_FRAG_COLOR,
    DESTROY_FRAG_SIZE_MIN / 3, DESTROY_FRAG_SIZE_MAX / 3, 20.0, worldSfx, effects,
  );
}

// 敵機の撃破で飛び散る破片。機体メッシュのスケール meshScale へ見合った大きさにする。
export function enemyDestroyFragments(
  state: KinematicState, meshScale: number, worldSfx: WorldSfx, effects: FlashEffects,
): DebrisPiece[] {
  return buildDestroyFragments(
    state.t, state.r, state.v, 11, ENEMY_DESTROY_FRAG_COLOR,
    (DESTROY_FRAG_SIZE_MIN * meshScale) / 3, (DESTROY_FRAG_SIZE_MAX * meshScale) / 3, 20.0,
    worldSfx, effects,
  );
}
