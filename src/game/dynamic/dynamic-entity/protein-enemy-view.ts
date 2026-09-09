import * as THREE from 'three/webgpu';
import { apparentSizePx, metersPerPixel } from '../../../math/projection';
import { ENEMY_MODEL_SCALE } from './enemy-motion';
import { proteinMotionModeDisplacements } from '../../protein/protein-motion-modes';
import { ProteinRuntime } from '../../protein/protein-runtime';
import { createProteinMotionBinding } from '../../../render/protein-motion-material';
import type { ProteinEnemyDefinition } from '../../protein/protein-enemy-registry';
import type { ProteinDisplaySettings } from '../../protein/protein-display';
import type { ProteinCombatState } from '../../protein/protein-combat-state';
import type { KinematicState } from '../../../physics/kinematic-state';
import { DynamicView, type DynamicViewFrame } from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import type { ProteinMotionLod } from '../../protein/protein-motion-controller';

export interface ProteinSiteMarker {
  readonly id: string;
  readonly worldPos: Vec3;
  readonly abbreviation: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly disabled: boolean;
  readonly attackable: boolean;
}

// タンパク質モデル、構造ゆらぎ、結合線を所有する。
export class ProteinEnemyView extends DynamicView {
  public readonly runtime: ProteinRuntime;

  public constructor(
    private readonly definition: ProteinEnemyDefinition,
    display: ProteinDisplaySettings,
    private readonly combat: ProteinCombatState,
    id: string,
    scene?: THREE.Scene,
  ) {
    const motionBinding = createProteinMotionBinding(
      definition.motion.residueCount,
      proteinMotionModeDisplacements(definition.motion),
      definition.motion.modes.length,
    );
    const root = definition.buildRenderObject(display, motionBinding ?? undefined);
    root.scale.setScalar(ENEMY_MODEL_SCALE);
    super(root, scene);
    this.runtime = new ProteinRuntime(root, combat, definition.motion, id, motionBinding);
  }

  public setDisplay(display: ProteinDisplaySettings): void {
    this.runtime.clearVisuals();
    this.definition.recolorRenderObject(this.object, display, this.runtime.motionBinding ?? undefined);
    this.runtime.rebuildVisuals();
  }

  public get motionMetrics(): {
    readonly cpuMs: number;
    readonly uploadBytes: number;
    readonly lod: ProteinMotionLod;
  } {
    return {
      cpuMs: this.runtime.cpuMs,
      uploadBytes: this.runtime.uploadBytes,
      lod: this.runtime.lod,
    };
  }

  // 部位マーカーは表示中のタンパク質変形と同じアンカー位置を使う。
  public siteMarkers(displayPos: Vec3, attitude: Quat): readonly ProteinSiteMarker[] {
    return this.combat.hudSnapshot().sites.map((site) => ({
      id: site.id,
      worldPos: this.runtime.siteWorldPositionById(site.id, displayPos, attitude),
      abbreviation: site.abbreviation,
      hp: site.hp,
      maxHp: site.maxHp,
      disabled: site.disabled,
      attackable: site.attackable,
    }));
  }

  protected override syncModel(
    _identity: import('../dynamic-view').DynamicViewIdentity,
    motion: DynamicMotion,
    displayed: KinematicState | null,
    context: DynamicViewFrame,
  ): void {
    if (displayed === null || !this.object.visible) return;
    const projectedDiameterPx = apparentSizePx(
      motion.radius * 2,
      metersPerPixel(context.cameraSystem.activeViewpoint, displayed.r, window.innerHeight),
    );
    if (this.runtime.updateLod(projectedDiameterPx) !== 'marker') {
      this.runtime.updateVisual(context.displayTime, context.graphics.proteinVibration);
    }
  }

  public override dispose(): void {
    this.runtime.dispose();
    super.dispose();
  }
}
