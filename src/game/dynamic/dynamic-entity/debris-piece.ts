import type * as THREE from 'three/webgpu';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import { randomQuat } from '../../../math/quat';
import { randSym } from '../../../math/random';
import { add, randVec, type Vec3, v3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { FlashEffects } from '../../vfx/flash-effects';
import type { CapKind } from './entity-kind';
import { DebrisPieceView } from './debris-piece-view';
import { DynamicEntity } from './dynamic-entity';
import { DebrisMotion, type DebrisKind } from './debris-motion';

export type { DebrisKind } from './debris-motion';

export class DebrisPiece extends DynamicEntity {
  public override readonly capKind: CapKind;

  public constructor(
    state: KinematicState,
    public readonly debrisKind: DebrisKind,
    attitude: Attitude,
    worldSfx: WorldSfx,
    effects: FlashEffects,
    radius?: number,
    scene?: THREE.Scene,
  ) {
    super(
      state,
      new DebrisPieceView(debrisKind, scene),
      attitude,
      undefined,
      () => new DebrisMotion(state, attitude, debrisKind, worldSfx, effects, radius),
    );
    this.capKind = debrisKind.kind === 'casing' ? 'casing' : 'debris';
  }

  public get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }
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
  scene?: THREE.Scene,
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
      state, { kind: 'fragment', accent, size }, attitude, worldSfx, effects, undefined, scene));
  }
  return pieces;
}
