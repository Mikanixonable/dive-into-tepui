import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import { orientProjectile } from '../../projectile-orientation';
import { buildBulletMesh, buildPlasmaMesh } from '../ships';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../../../game/dynamic/dynamic-motion';

abstract class ProjectileView extends DynamicView {
  private readonly orientation = new THREE.Quaternion();

  protected constructor(object: THREE.Object3D) {
    super(object, undefined, false);
  }

  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (displayed !== null
      && orientProjectile(this.orientation, context.floatingOrigin.VtoThreeV3(displayed.v))) {
      this.object.quaternion.copy(this.orientation);
    }
    if (!this.object.visible) return;
    this.pushToPool(context);
  }

  protected abstract pushToPool(context: DynamicViewFrame): void;
}

export class NormalBulletView extends ProjectileView {
  public constructor() {
    super(buildBulletMesh());
  }

  protected override pushToPool(context: DynamicViewFrame): void {
    this.object.updateMatrixWorld();
    context.pools.pushBulletBody(this.object.children[0]!);
    context.pools.pushBulletHalo(this.object.children[1]!);
  }
}

export class PlasmaBulletView extends ProjectileView {
  public constructor() {
    super(buildPlasmaMesh());
  }

  protected override pushToPool(context: DynamicViewFrame): void {
    context.pools.pushPlasma(this.object);
  }
}
