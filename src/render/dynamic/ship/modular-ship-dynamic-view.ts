// モジュール船の本体、推進・RCS・再突入・給弾・姿勢マーカーを1体分の表示へ同期する。
import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { BeltNodes } from '../player/belt-view';
import { BeltView } from '../player/belt-view';
import { RcsEffects } from '../player/rcs-effects';
import { ReentryEffects } from '../player/reentry-effects';
import { ThrustEffects } from '../player/thrust-effects';
import {
  DynamicView, type DynamicRenderSource, type DynamicViewFrame,
} from '../dynamic-view';
import { buildShipModuleModel } from './ship-module-models';
import { ModularShipView } from './modular-ship-view';
import type { ShipModuleRenderInput, ShipRenderAssembly } from './ship-render-contract';

export interface ModularShipRenderSource extends DynamicRenderSource {
  readonly assembly: ShipRenderAssembly;
  readonly centerOffset: Vec3;
  readonly state: KinematicState;
  readonly active: boolean;
  readonly thrustAcceleration: Vec3 | null;
  readonly maximumAcceleration: number;
  readonly torque: Vec3;
  readonly dynamicPressure: number;
  readonly belt: BeltNodes;
  readonly magsLeft: number;
}

// DynamicView の時刻配置と、assembly から再構築する module 表示を一体にした実体用 View。
export class ModularShipDynamicView extends DynamicView<ModularShipRenderSource> {
  private readonly modules: ModularShipView;
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly belt: BeltView;

  public constructor(
    private readonly effectScene: THREE.Scene,
    ownerId: string,
    beltLinkCount: number,
  ) {
    const modules = new ModularShipView(buildShipModuleModel, undefined, false);
    const root = new THREE.Group();
    root.name = 'modular-ship-dynamic';
    root.add(modules.object);
    super(root, effectScene);
    this.modules = modules;
    this.thrustEffects = new ThrustEffects(effectScene, ownerId);
    this.rcsEffects = new RcsEffects(effectScene, ownerId);
    this.reentryEffects = new ReentryEffects(effectScene);
    this.belt = new BeltView(this.object, beltLinkCount);
  }

  protected override syncModel(
    source: ModularShipRenderSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    this.modules.sync(source.assembly.modules, source.centerOffset);
    const origin = viewFrame.camera.floatingOrigin;
    const effectVisible = this.object.visible;
    const cameraQuat = viewFrame.camera.camera.quaternion;
    const zoomActive = viewFrame.camera.zoomed;
    const thrustAnchor = this.firstAnchor(source.assembly.modules, ['thruster', 'booster'], 'thrust');
    const rcsAnchors = this.anchors(source.assembly.modules, 'rcs', 'rcs:');

    this.object.updateWorldMatrix(true, true);
    this.thrustEffects.syncFromAnchor(
      thrustAnchor,
      source.thrustAcceleration,
      source.maximumAcceleration,
      effectVisible,
      cameraQuat,
      zoomActive,
      viewFrame.style,
      viewFrame.displayTime,
    );
    this.rcsEffects.syncFromAnchors(
      this.object,
      rcsAnchors,
      source.torque,
      effectVisible,
      cameraQuat,
      zoomActive,
      viewFrame.displayTime,
    );
    this.reentryEffects.sync(origin, displayed, source.dynamicPressure, effectVisible, cameraQuat);
    this.belt.sync(source.magsLeft, source.belt);
    if (source.active && zoomActive) this.object.visible = false;
  }

  private anchors(
    modules: readonly ShipModuleRenderInput[],
    kind: 'rcs',
    prefix: string,
  ): readonly THREE.Object3D[] {
    const anchors: THREE.Object3D[] = [];
    for (const module of modules) {
      if (module.kind !== kind || module.hp <= 0) continue;
      anchors.push(...this.modules.semanticAnchors(module.id, prefix));
    }
    return anchors;
  }

  private firstAnchor(
    modules: readonly ShipModuleRenderInput[],
    kinds: readonly ('thruster' | 'booster')[],
    name: string,
  ): THREE.Object3D | null {
    for (const module of modules) {
      if (!kinds.includes(module.kind as 'thruster' | 'booster') || module.hp <= 0) continue;
      const anchor = this.modules.semanticAnchor(module.id, name);
      if (anchor !== null) return anchor;
    }
    return null;
  }

  public override dispose(): void {
    this.thrustEffects.dispose(this.effectScene);
    this.rcsEffects.dispose(this.effectScene);
    this.reentryEffects.dispose(this.effectScene);
    this.modules.dispose();
    super.dispose();
  }
}
