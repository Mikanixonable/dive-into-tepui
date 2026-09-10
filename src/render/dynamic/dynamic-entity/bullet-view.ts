import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import { orientProjectile } from '../../projectile-orientation';
import { buildBulletMesh, buildPlasmaMesh } from '../ships';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';

abstract class ProjectileView extends DynamicView {
  private readonly orientation = new THREE.Quaternion();

  protected constructor(object: THREE.Object3D) {
    super(object, undefined, false);
  }

  // 表示時刻の速度へ機首を向け、画面に出るフレームだけプールへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (displayed !== null
      && orientProjectile(this.orientation, context.camera.floatingOrigin.VtoThreeV3(displayed.v))) {
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
