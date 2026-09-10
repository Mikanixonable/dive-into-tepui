import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  buildBarrelMesh,
  buildCasingMesh,
  buildMagazineFrame,
  DEBRIS_FRAGMENT_VARIANT_COUNT,
} from '../ships';
import {
  buildBoosterExplosiveBoltMesh,
  buildBoosterInterstageCoverPanelMesh,
} from '../booster';
import { SHIP_DARK_HULL_COLOR } from '../../vfx-style';
import {
  DynamicView, type DynamicViewFrame, type DynamicViewIdentity,
} from '../dynamic-view';
import type { DynamicMotion } from '../../../game/dynamic/dynamic-motion';
import type { DebrisKind } from '../../../game/dynamic/dynamic-entity/debris-kind';

class DebrisFragmentView extends DynamicView {
  private readonly fragmentVariant: number;
  private readonly fragmentColor: THREE.Color;

  public constructor(accent: string | number, size: number, scene?: THREE.Scene) {
    const root = new THREE.Object3D();
    root.scale.setScalar(size);
    super(root, scene, false);
    this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
    const dark = Math.random() < 0.30;
    this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : accent);
  }

  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushDebrisFragment(this.fragmentVariant, this.object, this.fragmentColor);
  }
}

class CasingDebrisView extends DynamicView {
  public constructor(scene?: THREE.Scene) {
    super(buildCasingMesh(), scene, false);
  }

  protected override syncModel(
    _identity: DynamicViewIdentity,
    _motion: DynamicMotion,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushCasing(this.object);
  }
}

// 種別ごとの表示。差が生成するメッシュだけのものは DynamicView をそのまま使う。
export function buildDebrisPieceView(debrisKind: DebrisKind, scene?: THREE.Scene): DynamicView {
  switch (debrisKind.kind) {
    case 'fragment': return new DebrisFragmentView(debrisKind.accent, debrisKind.size, scene);
    case 'barrel': return new DynamicView(buildBarrelMesh(), scene);
    case 'magazineFrame': return new DynamicView(buildMagazineFrame(), scene);
    case 'casing': return new CasingDebrisView(scene);
    case 'boosterCover':
      return new DynamicView(buildBoosterInterstageCoverPanelMesh(debrisKind.segment), scene);
    case 'boosterBolt':
      return new DynamicView(buildBoosterExplosiveBoltMesh(debrisKind.segment), scene);
  }
  throw new TypeError('Unknown debris kind');
}
