import * as THREE from 'three/webgpu';
import { orientProjectile } from '../../../render/projectile-orientation';
import { buildBulletMesh, buildPlasmaMesh } from '../../../render/ships';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';

// Bullet-only render state. Simulation code supplies the already-resolved display state.
export class BulletView extends DynamicView {
  private readonly orientation = new THREE.Quaternion();
  private readonly plasma: boolean;

  // 弾種に対応する表示資源を選ぶ。instanced 描画なので scene へは直接追加しない。
  public constructor(plasma: boolean) {
    super(plasma ? buildPlasmaMesh() : buildBulletMesh(), undefined, false);
    this.plasma = plasma;
  }

  // 表示時刻の速度へ姿勢を合わせ、可視な弾だけを対応する instance pool へ積む。
  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion, displayed: import('../../../physics/kinematic-state').KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    // 速度が有効なフレームだけ姿勢を上書きし、ゼロ速度では直前の向きを保つ。
    if (displayed !== null
      && orientProjectile(this.orientation, context.floatingOrigin.VtoThreeV3(displayed.v))) {
      this.object.quaternion.copy(this.orientation);
    }
    if (!this.object.visible) return;
    // プラズマ弾と実体弾では pool の構成が異なる。
    if (this.plasma) {
      context.pools.pushPlasma(this.object);
      return;
    }
    this.object.updateMatrixWorld();
    context.pools.pushBulletBody(this.object.children[0]!);
    context.pools.pushBulletHalo(this.object.children[1]!);
  }
}
