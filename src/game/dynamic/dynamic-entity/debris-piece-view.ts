import * as THREE from 'three/webgpu';
import {
  buildBarrelMesh,
  buildCasingMesh,
  buildMagazineFrame,
  DEBRIS_FRAGMENT_VARIANT_COUNT,
} from '../../../render/ships';
import {
  buildBoosterExplosiveBoltMesh,
  buildBoosterInterstageCoverPanelMesh,
} from '../../../render/booster';
import { SHIP_DARK_HULL_COLOR } from '../../../render/vfx-style';
import type { DebrisKind } from './debris-kind';
import { DynamicView, type DynamicViewFrame, type DynamicViewIdentity } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';

export class DebrisPieceView extends DynamicView {
  private readonly fragmentVariant: number;
  private readonly fragmentColor: THREE.Color | null;

  // 残骸種別に対応する THREE 資源と、固定した破片バリエーションを組み立てる。
  constructor(private readonly debrisKind: DebrisKind, scene?: THREE.Scene) {
    // casing/fragment は instance pool へ積むため、個別には scene へ追加しない。
    const root = buildDebrisRenderObject(debrisKind);
    super(root, scene, debrisKind.kind !== 'casing' && debrisKind.kind !== 'fragment');
    // 破片の形と色は生成時に固定し、フレームごとの焼き付き状態にはしない。
    if (debrisKind.kind === 'fragment') {
      this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
      const dark = Math.random() < 0.30;
      this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : debrisKind.accent);
    } else {
      this.fragmentVariant = -1;
      this.fragmentColor = null;
    }
  }

  // instance 描画する残骸だけを、外部フレームの pool へ登録する。
  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion, _displayed: import('../../../physics/kinematic-state').KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (this.debrisKind.kind === 'casing') context.pools.pushCasing(this.object);
    else if (this.debrisKind.kind === 'fragment') {
      context.pools.pushDebrisFragment(this.fragmentVariant, this.object, this.fragmentColor!);
    }
  }
}

// 残骸種別の固定定義から、その個体が所有する THREE ルートを作る。
function buildDebrisRenderObject(debrisKind: DebrisKind): THREE.Object3D {
  // 破片だけは空ルートを作り、生成時に固定した instance variant で描く。
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
