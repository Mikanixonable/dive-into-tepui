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
import { WeaponDrives, type WeaponRecoilInput } from './weapon-drives';
import { buildShipModuleModel } from './ship-module-models';
import { ModularShipView } from './modular-ship-view';
import type { ShipModuleRenderInput, ShipRenderAssembly } from './ship-render-contract';

export interface ModularShipRenderSource extends DynamicRenderSource {
  readonly assembly: ShipRenderAssembly;
  readonly centerOffset: Vec3;
  readonly state: KinematicState;
  readonly active: boolean;
  // 主推進器の推力による ECI 加速度 [m/s^2]。噴射していなければ null。
  readonly mainThrustAcceleration: Vec3 | null;
  // 全開時の加速度 [m/s^2]。
  readonly maximumAcceleration: number;
  readonly torque: Vec3;
  readonly dynamicPressure: number;
  readonly belt: BeltNodes;
  readonly magsLeft: number;
  // 機関砲の射撃レート [rounds/s]。全砲口の合計で、トリガーを離していれば 0。
  readonly gunFireRate: number;
  // 直近に成功した発射の砲口ごとの記録。反動部の後座はここから表示時刻へ同期する。
  readonly recentShotRecords: readonly WeaponRecoilInput[];
}

// DynamicView の時刻配置と、assembly から再構築する module 表示を一体にした実体用 View。
export class ModularShipDynamicView extends DynamicView<ModularShipRenderSource> {
  private readonly modules: ModularShipView;
  private readonly thrustEffects: ThrustEffects[] = [];
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly belt: BeltView;
  private readonly weaponDrives = new WeaponDrives();

  public constructor(
    private readonly effectScene: THREE.Scene,
    private readonly ownerId: string,
    beltLinkCount: number,
  ) {
    const modules = new ModularShipView(buildShipModuleModel, undefined, false);
    const root = new THREE.Group();
    root.name = 'modular-ship-dynamic';
    root.add(modules.object);
    super(root, effectScene);
    this.modules = modules;
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
    const rcsAnchors = this.anchors(source.assembly.modules, 'rcs', 'rcs:');

    this.object.updateWorldMatrix(true, true);
    this.syncEnginePlumes(source, effectVisible, cameraQuat, zoomActive, viewFrame);
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
    this.weaponDrives.sync(
      this.modules, source.assembly.modules, source.gunFireRate, viewFrame.displayTime,
      source.recentShotRecords,
    );
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

  // 健全な推進器・ブースターの噴射口ごとにプルームを出す。主推進器の出力比は主推力の噴射軸成分と
  // 全開加速度の比、ブースターは燃焼中なら全開。ship root の world matrix 更新後に呼ぶ。
  private syncEnginePlumes(
    source: ModularShipRenderSource, visible: boolean, cameraQuat: THREE.Quaternion, zoomActive: boolean,
    viewFrame: DynamicViewFrame,
  ): void {
    let index = 0;
    for (const module of source.assembly.modules) {
      if ((module.kind !== 'thruster' && module.kind !== 'booster') || module.hp <= 0) continue;
      const anchor = this.modules.semanticAnchor(module.id, 'thrust');
      if (anchor === null) continue;
      const effects = this.thrustEffects[index] ?? new ThrustEffects(this.effectScene, this.ownerId, index);
      this.thrustEffects[index] = effects;
      index++;
      const ratio = module.kind === 'booster'
        ? (module.burning === true ? 1 : 0)
        : mainThrustRatio(anchor, source.mainThrustAcceleration, source.maximumAcceleration);
      effects.syncFromAnchor(anchor, ratio, visible, cameraQuat, zoomActive, viewFrame.style, viewFrame.displayTime);
    }
    for (let i = index; i < this.thrustEffects.length; i++) this.thrustEffects[i]!.hide();
  }

  public override dispose(): void {
    for (const effects of this.thrustEffects) effects.dispose(this.effectScene);
    this.rcsEffects.dispose(this.effectScene);
    this.reentryEffects.dispose(this.effectScene);
    this.modules.dispose();
    super.dispose();
  }
}

// 噴射口 anchor(+Z が排気方向)の推力軸へ主推力 thrust を射影した、全開加速度 maxAccel に対する出力比 0..1。
function mainThrustRatio(anchor: THREE.Object3D, thrust: Vec3 | null, maxAccel: number): number {
  if (thrust === null || !(maxAccel > 0)) return 0;
  const exhaust = new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()));
  const along = -(exhaust.x * thrust.x + exhaust.y * thrust.y + exhaust.z * thrust.z);
  return Math.max(0, Math.min(1, along / maxAccel));
}
