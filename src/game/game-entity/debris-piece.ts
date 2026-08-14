import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Attractor } from '../../physics/attractor';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Contact } from '../simulation/contact';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import { buildBarrelMesh, buildCasingMesh, buildMagazineFrame, DEBRIS_FRAGMENT_VARIANT_COUNT } from '../../render/ships';
import { GameEntity } from './game-entity';
import { Player } from '../player/player';
import { Bullet } from './bullet';

// DebrisPiece の見た目・振る舞いの種別。
export type DebrisKind =
  | { kind: 'fragment'; accent: string | number; size: number; }
  | { kind: 'barrel'; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; };

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
  }
}

export class DebrisPiece extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;

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
    private readonly _sfx: Sfx,
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
    this.collides = debrisKind.kind !== 'fragment';
    if (debrisKind.kind === 'fragment') {
      this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
      const dark = Math.random() < 0.30;
      this.fragmentColor = new THREE.Color(dark ? C.COLOR_SHIP_DARK_HULL : debrisKind.accent);
    } else {
      this.fragmentVariant = -1;
      this.fragmentColor = null;
    }
    switch (debrisKind.kind) {
      case 'barrel': this.mass = C.BARREL_MASS; break;
      case 'magazineFrame': this.mass = C.MAGAZINE_FRAME_MASS; break;
      case 'casing': this.mass = C.CASING_MASS; break;
      case 'fragment': this.mass = 0; break;
    }
  }

  get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }

  // 弾が当たったらガスパフを噴いて消える(弾自身の消滅は Bullet.collideWith が書く)。
  // 薬莢が艦(操作対象に限らず Player 全般)に触れたときは、からんと音を鳴らす。
  collideWith(other: GameEntity | Attractor, contact: Contact): void {
    if (other instanceof Bullet) {
      this._fx.spawnGasPuff(kinematicState(contact.selfState.t, contact.point, contact.selfState.v));
      return;
    }
    if (this.debrisKind.kind === 'casing' && other instanceof Player) this._sfx.clank();
  }

  // 薬莢の寿命切れ絶対時刻を返す。薬莢以外、またはすでに過ぎていれば null。
  nextSimulationEventTime(simTime: number): number | null {
    if (this.debrisKind.kind !== 'casing') return null;
    const expiresAt = this.debrisKind.bornSim + C.CASING_LIFETIME;
    return expiresAt >= simTime ? expiresAt : null;
  }

  // 再突入判定に加え、薬莢は寿命超過でも alive を落とす。
  checkLoss(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3, attractors: readonly Attractor[]): void {
    super.checkLoss(dt, simTime, activeStage, playerPos, attractors);
    if (!this.alive) return;
    // 薬莢のみ、寿命(CASING_LIFETIME)による消滅がある(他のデブリは大気突入のみ)。
    if (this.debrisKind.kind === 'casing' && simTime - this.debrisKind.bornSim >= C.CASING_LIFETIME) {
      this.alive = false;
    }
  }

  // シーンからの除去に加え、自身が所有するジオメトリ・マテリアルを解放する。
  dispose(): void {
    super.dispose();
    this.renderObject.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 共有ジオメトリを解放しないよう、所有権フラグが立つものだけ処理する。
      if (mesh.userData.ownsGeometry && mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.userData.ownsMaterial && mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
        else mesh.material.dispose();
      }
    });
  }
}
