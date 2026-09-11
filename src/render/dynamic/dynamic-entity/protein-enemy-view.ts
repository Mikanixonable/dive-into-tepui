import * as THREE from 'three/webgpu';
import { apparentSizePx } from '../../../math/projection';
import { proteinMotionModeDisplacements } from '../../protein/protein-motion-modes';
import { ProteinRuntime } from '../../protein/protein-runtime';
import { createProteinMotionBinding } from '../../protein/protein-motion-material';
import {
  ProteinMotionController, proteinMotionLodForProjectedSize,
} from '../../protein/protein-motion-controller';
import {
  DynamicView, type DynamicRenderSource, type DynamicViewFrame,
} from '../dynamic-view';
import type { ProteinRenderDefinition } from '../../protein/protein-render-definition';
import type { ProteinDisplaySettings, ProteinMotionLod, ProteinPhase } from '../../protein/protein-display';
import type { KinematicState } from '../../../physics/kinematic-state';
import type { Quat } from '../../../math/quat';
import type { Vec3 } from '../../../math/vec3';

// タンパク質の敵1体ぶんの、そのフレームの表示入力。表示設定と構造フェーズを共通の面へ足す。
export interface ProteinVisualSource extends DynamicRenderSource {
  readonly display: ProteinDisplaySettings;
  readonly phase: ProteinPhase;
}

/** 部位マーカーの、位置以外の表示内容。 */
export interface ProteinSiteStatus {
  readonly id: string;
  readonly abbreviation: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly disabled: boolean;
  readonly attackable: boolean;
}

/** 変形済みアンカーのワールド座標を添えた部位マーカー。 */
export interface ProteinSiteMarker extends ProteinSiteStatus {
  readonly worldPos: Vec3;
}

// タンパク質モデル、構造ゆらぎ、結合線と、ゆらぎの LOD・係数遷移の履歴を所有する。
export class ProteinEnemyView extends DynamicView<ProteinVisualSource> {
  private readonly runtime: ProteinRuntime;
  private renderedDisplay: ProteinDisplaySettings;
  private readonly motionController: ProteinMotionController;
  private lod: ProteinMotionLod = 'near';
  // 直近の同期でモード係数の確定に要した CPU 時間 [ms]。
  private motionControllerCpuMs = 0;

  // 初期表示設定で THREE ツリーと共有 GPU binding を組み立てる。modelScale(表示倍率)と
  // boundingRadius(LOD を選ぶ外接半径 [m])には物理の判定形状と同じ値を渡す。enemyId は
  // ゆらぎの個体差の鍵で、同じ鍵の個体は同じように揺らぐ。
  public constructor(
    private readonly definition: ProteinRenderDefinition,
    display: ProteinDisplaySettings,
    modelScale: number,
    private readonly boundingRadius: number,
    enemyId: string,
    scene?: THREE.Scene,
  ) {
    // モード変位は asset 単位で共有し、個体ごとに係数スロットを確保する。
    const motion = definition.source.motion;
    const motionBinding = createProteinMotionBinding(
      motion.residueCount,
      proteinMotionModeDisplacements(motion),
      motion.modes.length,
    );
    // 表示ツリーと runtime は同じ root/binding を共有し、寿命も View に揃える。
    const root = definition.buildRenderObject(display, motionBinding ?? undefined);
    root.scale.setScalar(modelScale);
    super(root, scene);
    this.runtime = new ProteinRuntime(root, definition.source.semantic, motion, motionBinding);
    this.renderedDisplay = { ...display };
    this.motionController = new ProteinMotionController(motion, enemyId);
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

  // 直近の同期で選んだ LOD と、係数の確定から表示反映までに要した CPU 時間・GPU 転送量を公開する。
  public get motionMetrics(): {
    readonly lod: ProteinMotionLod;
    readonly cpuMs: number;
    readonly uploadBytes: number;
  } {
    return {
      lod: this.lod,
      cpuMs: this.motionControllerCpuMs + this.runtime.cpuMs,
      uploadBytes: this.runtime.uploadBytes,
    };
  }

  // sites に、表示中の変形を掛けたアンカーのワールド座標を添えて返す。displayPos・attitude は
  // 本体を置いた位置と姿勢。
  public siteMarkers(
    displayPos: Vec3, attitude: Quat, sites: readonly ProteinSiteStatus[],
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

  // 表示設定を反映し、投影サイズから LOD を選んで表示時刻のモード係数を確定させ、変形資源へ渡す。
  // 本体を出さないフレームは LOD を保ったまま変形を止める。
  protected override syncModel(
    source: ProteinVisualSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    this.syncDisplay(source.display);
    // 本体と同じ可視条件で表示時刻の状態を使う。
    const shown = source.visible ? displayed : null;
    this.motionControllerCpuMs = 0;
    if (shown !== null) {
      const projectedDiameterPx = apparentSizePx(
        this.boundingRadius * 2,
        viewFrame.camera.radialScale(shown.r),
      );
      this.lod = proteinMotionLodForProjectedSize(projectedDiameterPx, this.lod);
      if (this.lod !== 'marker') {
        const cpuStart = performance.now();
        // 揺らぎの表示が切られている間は、LOD を保ったまま係数だけを静止へ倒す。
        this.motionController.sampleAt(
          viewFrame.displayTime,
          viewFrame.visual.proteinVibration ? this.lod : 'marker',
          source.phase,
        );
        this.motionControllerCpuMs = performance.now() - cpuStart;
      }
    }
    this.runtime.syncVisual({
      active: shown !== null,
      lod: this.lod,
      sampleTime: this.motionController.sampleTime,
      phase: source.phase,
      coefficients: this.motionController.effectiveModeCoefficients,
    });
  }

  // タンパク質固有の GPU・結合線資源を先に破棄する。
  public override dispose(): void {
    this.runtime.dispose();
    super.dispose();
  }
}
