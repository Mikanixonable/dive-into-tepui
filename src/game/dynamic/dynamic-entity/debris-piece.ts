import type * as THREE from 'three/webgpu';
import { randomQuat } from '../../../math/quat';
import { randSym } from '../../../math/random';
import { add, randVec, type SerializedVec3, type Vec3, v3 } from '../../../math/vec3';
import { deserializeAttitude, type Attitude } from '../../../physics/attitude';
import { deserializeKinematicState, kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import type { CapKind } from './entity-kind';
import { CasingView } from '../../../render/dynamic/dynamic-entity/casing-view';
import { DebrisFragmentView } from '../../../render/dynamic/dynamic-entity/debris-fragment-view';
import { MagazineFrameView } from '../../../render/dynamic/dynamic-entity/ejected-gun-part-view';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import { DynamicEntity, type SerializedDynamicEntityFields } from './dynamic-entity';
import type { DebrisKind } from './debris-kind';
import type { EntityIdAllocators } from './entity-id';
import type { EntityRegistry } from '../entity-registry';
import type { DynamicMotionThermal } from '../dynamic-motion';
import { DebrisMotion } from './debris-motion';
import { DebrisReaction } from './debris-reaction';

// 撃破で飛び散る破片の大きさの範囲。敵機では機体サイズに合わせて拡大する。
export const DESTROY_FRAG_SIZE_MIN = 1.5;
export const DESTROY_FRAG_SIZE_MAX = 6.0;
// 撃破で飛び散る破片の色。
export const PLAYER_DESTROY_FRAG_COLOR = '#9fd8e8';
const ENEMY_DESTROY_FRAG_COLOR = '#ff6a4a';

// 論理種別から、その破片を描く View を組み立てる。
function debrisPieceView(debrisKind: DebrisKind, scene?: THREE.Scene): DynamicView {
  switch (debrisKind.kind) {
    case 'fragment': return new DebrisFragmentView(debrisKind.accent, debrisKind.size, scene);
    case 'barrel': return new DebrisFragmentView('#9aa6ad', 0.8, scene);
    case 'magazineFrame': return new MagazineFrameView(scene);
    case 'casing': return new CasingView(scene);
    case 'decouplerPanel': return new DebrisFragmentView('#a9c8d6', 0.8, scene);
  }
}

// 破片1個の直列化した形。慣性と接触半径は出す場所ごとに違い、種別からは決まらないので記録に持つ。
export interface SerializedDebrisPiece extends SerializedDynamicEntityFields {
  readonly kind: 'debris';
  readonly debrisKind: DebrisKind;
  readonly inertia: SerializedVec3;
  readonly radius: number;
  readonly thermal: DynamicMotionThermal;
}

export class DebrisPiece extends DynamicEntity {
  public static readonly kind = 'debris';
  public static spawnGate(): null { return null; }

  public override readonly capKind: CapKind;

  // 復元済みの状態・姿勢と種別から、破片の運動と表示を組み立てる。
  private constructor(
    state: KinematicState,
    private readonly debrisKind: DebrisKind,
    attitude: Attitude,
    id: string,
    radius?: number,
    scene?: THREE.Scene,
    thermal: Partial<DynamicMotionThermal> = {},
    alive?: boolean,
  ) {
    super(
      () => new DebrisMotion(state, attitude, {
        kind: debrisKind.kind,
        // 発生時刻を持つ種別だけが、寿命の起点を反応へ渡す
        behavior: new DebrisReaction(
          debrisKind.kind,
          'bornSim' in debrisKind ? debrisKind.bornSim : null,
          'slide' in debrisKind ? debrisKind.slide ?? null : null,
        ),
        radius,
        thermal,
        alive,
      }),
      debrisPieceView(debrisKind, scene),
      id,
    );
    this.capKind = debrisKind.kind === 'casing' ? 'casing' : 'debris';
  }

  // 破片を指定した位置・姿勢で生成する。radius を省くと接触半径 0 m で始める。
  public static create(
    state: KinematicState, debrisKind: DebrisKind, attitude: Attitude, idAllocators: EntityIdAllocators,
    radius?: number, scene?: THREE.Scene,
  ): DebrisPiece {
    return new DebrisPiece(state, debrisKind, attitude, idAllocators.entity.next(), radius, scene);
  }

  // 直列化した破片を、記録した時刻の状態として復元する。
  public static deserialize(
    serialized: SerializedDebrisPiece, registry: EntityRegistry, scene: THREE.Scene,
  ): DebrisPiece {
    const { inertia } = serialized;
    // 慣性・接触半径・熱の状態も記録した値から始める
    return new DebrisPiece(
      deserializeKinematicState(serialized),
      serialized.debrisKind,
      deserializeAttitude(serialized, v3(inertia.x, inertia.y, inertia.z)),
      registry.idAllocators.entity.next(serialized.id),
      serialized.radius,
      scene,
      serialized.thermal,
      serialized.alive,
    );
  }

  // 運動状態と種別・慣性・接触半径・熱を直列化した形へ変換する。
  public override serialize(): SerializedDebrisPiece {
    const { inertia } = this.motion.att;
    return {
      ...this.serializeEntityFields(DebrisPiece.kind),
      debrisKind: this.debrisKind,
      inertia: { x: inertia.x, y: inertia.y, z: inertia.z },
      radius: this.motion.radius,
      thermal: this.motion.thermal,
    };
  }
}

// origin のまわりへ count 個を作り、速度・大きさ・姿勢に指定範囲のばらつきを与える。
export function buildDestroyFragments(
  t: number,
  origin: Vec3,
  baseVel: Vec3,
  count: number,
  accent: string | number,
  sizeMin: number,
  sizeMax: number,
  spread: number,
  idAllocators: EntityIdAllocators,
): DebrisPiece[] {
  const pieces: DebrisPiece[] = [];
  for (let i = 0; i < count; i++) {
    const size = sizeMin + Math.random() * (sizeMax - sizeMin);
    const state = kinematicState<'eci'>(t, add(origin, randVec(2.5)), add(baseVel, randVec(spread)));
    // 姿勢はばらばらに、回転は y 軸まわりを主にどちらかの向きへ振る。
    const attitude = {
      q: randomQuat(),
      w: v3(
        randSym(0.25),
        (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1),
        randSym(0.25),
      ),
      inertia: v3(1, 2.05, 3.0),
    };
    pieces.push(DebrisPiece.create(
      state, { kind: 'fragment', accent, size }, attitude, idAllocators));
  }
  return pieces;
}

// 自機の撃破で飛び散る破片。
export function playerDestroyFragments(
  state: KinematicState, idAllocators: EntityIdAllocators,
): DebrisPiece[] {
  return buildDestroyFragments(
    state.t, state.r, state.v, 11, PLAYER_DESTROY_FRAG_COLOR,
    DESTROY_FRAG_SIZE_MIN / 3, DESTROY_FRAG_SIZE_MAX / 3, 20.0, idAllocators,
  );
}

// 敵機の撃破で飛び散る破片。機体メッシュのスケール meshScale へ見合った大きさにする。
export function enemyDestroyFragments(
  state: KinematicState, meshScale: number, idAllocators: EntityIdAllocators,
): DebrisPiece[] {
  return buildDestroyFragments(
    state.t, state.r, state.v, 11, ENEMY_DESTROY_FRAG_COLOR,
    (DESTROY_FRAG_SIZE_MIN * meshScale) / 3, (DESTROY_FRAG_SIZE_MAX * meshScale) / 3, 20.0,
    idAllocators,
  );
}
