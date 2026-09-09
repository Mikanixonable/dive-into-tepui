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
import type { DebrisKind } from './debris-motion';
import { DynamicView, type DynamicViewFrame } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';

export class DebrisPieceView extends DynamicView {
  private readonly fragmentVariant: number;
  private readonly fragmentColor: THREE.Color | null;

  constructor(private readonly debrisKind: DebrisKind, scene?: THREE.Scene) {
    const root = buildDebrisRenderObject(debrisKind);
    super(root, scene, debrisKind.kind !== 'casing' && debrisKind.kind !== 'fragment');
    if (debrisKind.kind === 'fragment') {
      this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
      const dark = Math.random() < 0.30;
      this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : debrisKind.accent);
    } else {
      this.fragmentVariant = -1;
      this.fragmentColor = null;
    }
  }

  protected override syncModel(
    _motion: DynamicMotion, _displayed: import('../../../physics/kinematic-state').KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (this.debrisKind.kind === 'casing') context.pools.pushCasing(this.object);
    else if (this.debrisKind.kind === 'fragment') {
      context.pools.pushDebrisFragment(this.fragmentVariant, this.object, this.fragmentColor!);
    }
  }
}

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
