import * as THREE from 'three/webgpu';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  buildBarrelMesh,
  buildBoosterExplosiveBoltMesh,
  buildBoosterInterstageCoverPanelMesh,
  buildCasingMesh,
  buildMagazineFrame,
  DEBRIS_FRAGMENT_VARIANT_COUNT,
} from '../ships';
import { SHIP_DARK_HULL_COLOR } from '../../vfx-style';
import { DynamicView, type DynamicRenderSource, type DynamicViewFrame } from '../dynamic-view';

// 破片1個をどのメッシュで描くか。accent / size / segment は、その見た目を決めるための値。
export type DebrisPieceVariant =
  | { readonly kind: 'fragment'; readonly accent: string | number; readonly size: number }
  | { readonly kind: 'barrel' }
  | { readonly kind: 'magazineFrame' }
  | { readonly kind: 'casing' }
  | { readonly kind: 'boosterCover'; readonly segment: number }
  | { readonly kind: 'boosterBolt'; readonly segment: number };

class DebrisFragmentView extends DynamicView {
  private readonly fragmentVariant: number;
  private readonly fragmentColor: THREE.Color;

  // どのバリアントジオメトリで、どの色で描くかを生成時に1度だけ抽選する。
  public constructor(accent: string | number, size: number, scene?: THREE.Scene) {
    const root = new THREE.Object3D();
    root.scale.setScalar(size);
    super(root, scene, false);
    this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
    const dark = Math.random() < 0.30;
    this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : accent);
  }

  // 破片はバリアントごとの共有ジオメトリへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
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

  // 薬莢は全個体で共有する1本のプールへ積む。
  protected override syncModel(
    _source: DynamicRenderSource,
    _displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    context.pools.pushCasing(this.object);
  }
}

// 見た目ごとの表示。差が生成するメッシュだけのものは DynamicView をそのまま使う。
export function buildDebrisPieceView(variant: DebrisPieceVariant, scene?: THREE.Scene): DynamicView {
  switch (variant.kind) {
    case 'fragment': return new DebrisFragmentView(variant.accent, variant.size, scene);
    case 'barrel': return new DynamicView(buildBarrelMesh(), scene);
    case 'magazineFrame': return new DynamicView(buildMagazineFrame(), scene);
    case 'casing': return new CasingDebrisView(scene);
    case 'boosterCover':
      return new DynamicView(buildBoosterInterstageCoverPanelMesh(variant.segment), scene);
    case 'boosterBolt':
      return new DynamicView(buildBoosterExplosiveBoltMesh(variant.segment), scene);
  }
}
