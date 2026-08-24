import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { CelestialBody } from '../../physics/celestial-body';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from './contact';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import {
  buildBarrelMesh,
  buildCasingMesh,
  buildMagazineFrame,
  DEBRIS_FRAGMENT_VARIANT_COUNT,
} from '../../render/ships';
import {
  buildBoosterExplosiveBoltMesh,
  buildBoosterInterstageCoverPanelMesh,
} from '../../render/booster';
import { GameEntity } from './game-entity';
import { Player } from '../player/player';
import { Bullet } from './bullet';
import {
  SHIP_DARK_HULL_COLOR,
} from '../../render/vfx-style';

// DebrisPiece の見た目・振る舞いの種別。
export type DebrisKind =
  | { kind: 'fragment'; accent: string | number; size: number; }
  | { kind: 'barrel'; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; }
  | { kind: 'boosterCover'; segment: number; bornSim: number; }
  | { kind: 'boosterBolt'; segment: number; bornSim: number; };

// DebrisKind の種別に応じたメッシュを構築する。fragment は InstancedPool 経由で描くため
// ジオメトリを持たない — size だけを renderObject.scale へ焼き、どのバリアント/色を使うかは
// DebrisPiece 自身が持つ(EntityManager.sync が variant ごとのプールへ push する)。
function buildDebrisRenderObject(debrisKind: DebrisKind): THREE.Object3D {
  switch (debrisKind.kind) {
    case 'fragment': {
      const renderObject = new THREE.Object3D();
      renderObject.scale.setScalar(debrisKind.size);
      return renderObject;
    }
    case 'barrel': return buildBarrelMesh();
    case 'magazineFrame': return buildMagazineFrame();
    case 'casing': return buildCasingMesh();
    case 'boosterCover': return buildBoosterInterstageCoverPanelMesh(debrisKind.segment);
    case 'boosterBolt': return buildBoosterExplosiveBoltMesh(debrisKind.segment);
  }
}

export class DebrisPiece extends GameEntity {
  override readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat = C.SMALL_DEBRIS_SPECIFIC_HEAT;
  protected readonly bulkDensity = C.SMALL_DEBRIS_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number {
    return C.SMALL_DEBRIS_RADIATING_AREA_PER_MASS;
  }
  protected readonly maxTemperature = C.SMALL_DEBRIS_MAX_TEMP;

  // fragment のみ意味を持つ: どのバリアントジオメトリを使うか、InstancedPool の
  // per-instance color へ渡す色。EntityManager.sync が variant ごとのプールへ push する。
  readonly fragmentVariant: number;
  readonly fragmentColor: THREE.Color | null;

  // DebrisKind に応じたメッシュ・質量で初期化する。radius は剛体接触半径。fragment は
  // 剛体接触に参加しない(排莢直後の薬莢を弾いてしまう/破片が跳ね回るのを避ける)。
  constructor(
    state: KinematicState,
    readonly debrisKind: DebrisKind,
    att: Attitude,
    private readonly _worldSfx: WorldSfx,
    private readonly _fx: EffectsSystem,
    radius?: number,
    scene?: THREE.Scene,
  ) {
    // 薬莢・破片の renderObject は InstancedPool へ渡す変換を保持する。
    super(
      state,
      buildDebrisRenderObject(debrisKind),
      scene,
      att,
      undefined,
      debrisKind.kind !== 'casing' && debrisKind.kind !== 'fragment',
    );
    this.radius = radius ?? 0;
    this.collides = debrisKind.kind !== 'fragment'
      && debrisKind.kind !== 'boosterCover'
      && debrisKind.kind !== 'boosterBolt';
    this.contactDamageWeight = 0;
    if (debrisKind.kind === 'fragment') {
      this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
      const dark = Math.random() < 0.30;
      this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : debrisKind.accent);
    } else {
      this.fragmentVariant = -1;
      this.fragmentColor = null;
    }
    // 全種別が試験粒子。触れた相手の速度を変えないので、相手の予測弧も捨てられない。
    this.mass = 0;
  }

  get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }

  // 弾が当たったらガスパフを噴いて消える(弾自身の消滅は Bullet.collideWithEntity が書く)。
  // 薬莢が艦(操作対象に限らず Player 全般)に触れたときは、からんと音を鳴らす。
  collideWithEntity(other: GameEntity, contact: Contact): void {
    if (other instanceof Bullet) {
      this._fx.spawnGasPuff(kinematicState(contact.selfState.t, contact.point, contact.selfState.v));
      return;
    }
    if (this.debrisKind.kind === 'casing' && other instanceof Player) this._worldSfx.clank();
  }

  // 寿命を持つ薬莢・段間ハードウェアの次の絶対時刻を返す。
  nextSimulationEventTime(simTime: number): number | null {
    if (this.debrisKind.kind !== 'casing'
      && this.debrisKind.kind !== 'boosterCover'
      && this.debrisKind.kind !== 'boosterBolt') return null;
    const expiresAt = this.debrisKind.bornSim + (this.debrisKind.kind === 'casing'
      ? C.CASING_LIFETIME
      : C.BOOSTER_HARDWARE_LIFETIME);
    return expiresAt >= simTime ? expiresAt : null;
  }

  // 再突入判定に加え、寿命を持つデブリは表示時間の超過でも消す。
  checkLoss(
    dt: number, simTime: number, activeStage: Stage, playerPos: Vec3,
    atmosphereBodies: readonly CelestialBody[],
  ): void {
    super.checkLoss(dt, simTime, activeStage, playerPos, atmosphereBodies);
    if (!this.alive) return;
    const expires = this.debrisKind.kind === 'casing'
      ? C.CASING_LIFETIME
      : this.debrisKind.kind === 'boosterCover' || this.debrisKind.kind === 'boosterBolt'
        ? C.BOOSTER_HARDWARE_LIFETIME
        : null;
    const bornSim = this.debrisKind.kind === 'casing'
      || this.debrisKind.kind === 'boosterCover'
      || this.debrisKind.kind === 'boosterBolt'
      ? this.debrisKind.bornSim
      : null;
    if (expires !== null && bornSim !== null && simTime - bornSim >= expires) {
      this.alive = false;
    }
  }
}
