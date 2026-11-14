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
  // 機体が浸っている外気の密度 [kg/m^3]。大気天体が無いとき 0。
  readonly ambientDensity: number;
  readonly belt: BeltNodes;
  readonly magsLeft: number;
  // 機関砲の射撃レート [rounds/s]。全砲口の合計で、トリガーを離していれば 0。
  readonly gunFireRate: number;
  // 砲口ごとの直近発射時刻。表示時刻に基づく後座アニメーションに使う。
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

  // モジュール表示と RCS・再突入・給弾・武装の駆動を ship root の下へ組む。
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

  // そのフレームの source へモジュール表示と各エフェクト・駆動を同期する。
  protected override syncModel(
    source: ModularShipRenderSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    this.modules.sync(
      source.assembly.modules,
      source.centerOffset,
      viewFrame.shipModuleEmphasis?.get(source.id) ?? null,
    );
    const origin = viewFrame.camera.floatingOrigin;
    const effectVisible = this.object.visible;
    const cameraQuat = viewFrame.camera.camera.quaternion;
    const zoomActive = viewFrame.camera.zoomed;
    const rcsAnchors = this.rcsAnchors(source.assembly.modules);

    // プルーム・RCS は module の anchor の world 座標を読むので、先に ship root の行列を確定させる。
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
    // 照準ズームは操作している実体の視点なので、active な実体の本体だけを隠す。
    if (source.active && zoomActive) this.object.visible = false;
  }

  // 健全(hp > 0)な rcs module が持つ 'rcs:' 名前付き anchor を集める。
  private rcsAnchors(modules: readonly ShipModuleRenderInput[]): readonly THREE.Object3D[] {
    const anchors: THREE.Object3D[] = [];
    for (const module of modules) {
      if (module.kind !== 'rcs' || module.hp <= 0) continue;
      anchors.push(...this.modules.semanticAnchors(module.id, 'rcs:'));
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
      const effects = this.thrustEffects[index] ?? new ThrustEffects(
        this.effectScene, this.ownerId, index, viewFrame.sunLight, viewFrame.bodyShadow,
      );
      this.thrustEffects[index] = effects;
      index++;
      const ratio = module.kind === 'booster'
        ? (module.burning === true ? 1 : 0)
        : mainThrustRatio(anchor, source.mainThrustAcceleration, source.maximumAcceleration);
      // 体積描画は主推進器の hydrolox 排気のモデル。ブースター(固体)は簡易表示に留める。
      const plumeMode = module.kind === 'thruster' ? viewFrame.visual.thrustPlume : 'simple';
      effects.syncFromAnchor(
        anchor, ratio, visible, cameraQuat, zoomActive, viewFrame.style, viewFrame.displayTime,
        source.ambientDensity, plumeMode,
      );
    }
    for (let i = index; i < this.thrustEffects.length; i++) this.thrustEffects[i]!.hide();
  }

  // 各エフェクトとモジュール表示の資源を解放し、基底の破棄へ回す。
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
