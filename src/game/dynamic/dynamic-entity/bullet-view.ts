import * as THREE from 'three/webgpu';
import { orientProjectile } from '../../../render/projectile-orientation';
import { buildBulletMesh, buildPlasmaMesh } from '../../../render/ships';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';

// Bullet-only render state. Simulation code supplies the already-resolved display state.
export class BulletView extends DynamicView {
  private readonly orientation = new THREE.Quaternion();
  private readonly plasma: boolean;

  public constructor(plasma: boolean) {
    super(plasma ? buildPlasmaMesh() : buildBulletMesh(), undefined, false);
    this.plasma = plasma;
  }

  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion, displayed: import('../../../physics/kinematic-state').KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (displayed !== null
      && orientProjectile(this.orientation, context.floatingOrigin.VtoThreeV3(displayed.v))) {
      this.object.quaternion.copy(this.orientation);
    }
    if (!this.object.visible) return;
    if (this.plasma) {
      context.pools.pushPlasma(this.object);
      return;
    }
    this.object.updateMatrixWorld();
    context.pools.pushBulletBody(this.object.children[0]!);
    context.pools.pushBulletHalo(this.object.children[1]!);
  }
}
