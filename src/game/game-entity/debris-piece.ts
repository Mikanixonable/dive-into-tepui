import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import { buildBarrelMesh, buildCasingMesh, buildDebrisMesh, buildMagazineFrame } from '../../render/ships';
import { GameEntity } from './game-entity';

// DebrisPiece の見た目・振る舞いの種別。
export type DebrisKind =
  | { kind: 'fragment'; accent: number; size: number; }
  | { kind: 'barrel'; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; };

function buildDebrisObj(debrisKind: DebrisKind): THREE.Object3D {
  switch (debrisKind.kind) {
    case 'fragment': return buildDebrisMesh(debrisKind.accent, debrisKind.size);
    case 'barrel': return buildBarrelMesh();
    case 'magazineFrame': return buildMagazineFrame();
    case 'casing': return buildCasingMesh();
  }
}

export class DebrisPiece extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;

  constructor(state: OrbitState, readonly debrisKind: DebrisKind, att: Attitude, collideRadius?: number, scene?: THREE.Scene) {
    super(state, buildDebrisObj(debrisKind), scene, att);
    this.collideRadius = debrisKind.kind === 'fragment' ? undefined : collideRadius;
    switch (debrisKind.kind) {
      case 'barrel': this.mass = C.BARREL_MASS; break;
      case 'magazineFrame': this.mass = C.MAGAZINE_FRAME_MASS; break;
      case 'casing': this.mass = C.CASING_MASS; break;
      case 'fragment': this.mass = 0; break;
    }
  }

  get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }

  checkLoss(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3): void {
    super.checkLoss(dt, simTime, activeStage, playerPos);
    if (!this.alive) return;
    // 薬莢のみ、寿命(CASING_LIFETIME)による消滅がある(他のデブリは大気突入のみ)。
    if (this.debrisKind.kind === 'casing' && simTime - this.debrisKind.bornSim > C.CASING_LIFETIME) {
      this.alive = false;
    }
  }

  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
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
