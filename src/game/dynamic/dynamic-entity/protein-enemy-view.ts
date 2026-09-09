import * as THREE from 'three/webgpu';
import { ENEMY_MODEL_SCALE } from './enemy-motion';
import { proteinMotionModeDisplacements } from '../../protein/protein-motion-modes';
import { ProteinRuntime } from '../../protein/protein-runtime';
import { createProteinMotionBinding } from '../../../render/protein-motion-material';
import type { ProteinEnemyDefinition } from '../../protein/protein-enemy-registry';
import type { ProteinDisplaySettings } from '../../protein/protein-display';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  DynamicView, type DynamicViewFrame, type DynamicViewIdentity,
} from '../dynamic-view';
import type { DynamicMotion } from '../dynamic-motion';
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import type { ProteinMotionDisplay } from '../../protein/protein-motion-controller';
import type { ProteinHudSnapshot } from '../../protein/protein-schema';

interface ProteinVisualSource extends DynamicViewIdentity {
  readonly display: ProteinDisplaySettings;
  readonly motionDisplay: ProteinMotionDisplay;
}

function isProteinVisualSource(identity: DynamicViewIdentity): identity is ProteinVisualSource {
  return identity.mapKind === 'enemy' && 'display' in identity && 'motionDisplay' in identity;
}

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
  private readonly runtime: ProteinRuntime;
  private renderedDisplay: ProteinDisplaySettings;

  public constructor(
    private readonly definition: ProteinEnemyDefinition,
    display: ProteinDisplaySettings,
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
    this.runtime = new ProteinRuntime(root, definition.asset, definition.motion, motionBinding);
    this.renderedDisplay = { ...display };
  }

  private syncDisplay(display: ProteinDisplaySettings): void {
    if (display.representation === this.renderedDisplay.representation
      && display.colorMode === this.renderedDisplay.colorMode) return;
    this.runtime.clearVisuals();
    this.definition.recolorRenderObject(this.object, display, this.runtime.motionBinding ?? undefined);
    this.runtime.rebuildVisuals();
    this.renderedDisplay = { ...display };
  }

  public get motionMetrics(): {
    readonly cpuMs: number;
    readonly uploadBytes: number;
  } {
    return {
      cpuMs: this.runtime.cpuMs,
      uploadBytes: this.runtime.uploadBytes,
    };
  }

  // 部位マーカーは表示中のタンパク質変形と同じアンカー位置を使う。
  public siteMarkers(
    displayPos: Vec3, attitude: Quat, sites: ProteinHudSnapshot['sites'],
  ): readonly ProteinSiteMarker[] {
    return sites.map((site) => ({
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
    identity: DynamicViewIdentity,
    _motion: DynamicMotion,
    _displayed: KinematicState | null,
    _context: DynamicViewFrame,
  ): void {
    if (!isProteinVisualSource(identity)) {
      throw new TypeError('ProteinEnemyView requires ProteinEnemy');
    }
    this.syncDisplay(identity.display);
    this.runtime.syncVisual(identity.motionDisplay);
  }

  public override dispose(): void {
    this.runtime.dispose();
    super.dispose();
  }
}
