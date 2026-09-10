import * as THREE from 'three/webgpu';
import { proteinMotionModeDisplacements } from '../../../game/protein/protein-motion-modes';
import { ProteinRuntime } from '../../../game/protein/protein-runtime';
import { createProteinMotionBinding } from '../../protein-motion-material';
import type { ProteinEnemyDefinition } from '../../../game/protein/protein-enemy-registry';
import type { ProteinDisplaySettings } from '../../../game/protein/protein-display';
import type { KinematicState } from '../../../physics/kinematic-state';
import {
  DynamicView, type DynamicRenderSource, type DynamicViewFrame,
} from '../dynamic-view';
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';
import type { ProteinMotionDisplay } from '../../../game/protein/protein-motion-controller';
import type { ProteinHudSnapshot } from '../../../game/protein/protein-schema';

// タンパク質の敵1体ぶんの、そのフレームの表示入力。表示設定と変形係数を共通の面へ足す。
export interface ProteinVisualSource extends DynamicRenderSource {
  readonly display: ProteinDisplaySettings;
  readonly motionDisplay: ProteinMotionDisplay;
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
export class ProteinEnemyView extends DynamicView<ProteinVisualSource> {
  private readonly runtime: ProteinRuntime;
  private renderedDisplay: ProteinDisplaySettings;

  // 初期表示設定で THREE ツリーと共有 GPU binding を組み立てる。
  // modelScale は機体モデルへ掛ける表示倍率。物理の判定半径と同じ値を組み立て側が配る。
  public constructor(
    private readonly definition: ProteinEnemyDefinition,
    display: ProteinDisplaySettings,
    modelScale: number,
    scene?: THREE.Scene,
  ) {
    // モード変位は asset 単位のキャッシュを使い、個体ごとには係数スロットだけを確保する。
    const motionBinding = createProteinMotionBinding(
      definition.motion.residueCount,
      proteinMotionModeDisplacements(definition.motion),
      definition.motion.modes.length,
    );
    // 表示ツリーと runtime は同じ root/binding を共有し、寿命も View に揃える。
    const root = definition.buildRenderObject(display, motionBinding ?? undefined);
    root.scale.setScalar(modelScale);
    super(root, scene);
    this.runtime = new ProteinRuntime(root, definition.asset, definition.motion, motionBinding);
    this.renderedDisplay = { ...display };
  }

  // 表現種別か着色が変わったときだけ THREE 子要素を再構築する。
  private syncDisplay(display: ProteinDisplaySettings): void {
    if (display.representation === this.renderedDisplay.representation
      && display.colorMode === this.renderedDisplay.colorMode) return;
    this.runtime.clearVisuals();
    this.definition.recolorRenderObject(this.object, display, this.runtime.motionBinding ?? undefined);
    this.runtime.rebuildVisuals();
    this.renderedDisplay = { ...display };
  }

  // 直近の表示反映に要した CPU 時間と GPU 転送量を公開する。
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

  // 表示設定と外部で確定した変形係数を、タンパク質の THREE 資源へ反映する。
  protected override syncModel(
    source: ProteinVisualSource,
    _displayed: KinematicState | null,
    _context: DynamicViewFrame,
  ): void {
    this.syncDisplay(source.display);
    this.runtime.syncVisual(source.motionDisplay);
  }

  // タンパク質固有の GPU・結合線資源を先に破棄する。
  public override dispose(): void {
    this.runtime.dispose();
    super.dispose();
  }
}
