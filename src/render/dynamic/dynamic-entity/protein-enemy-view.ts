import * as THREE from 'three/webgpu';
import { apparentSizePx } from '../../../math/projection';
import { ProteinRuntime } from '../../protein/protein-runtime';
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

// タンパク質の敵1体ぶんの、そのフレームの表示入力。構造フェーズを共通の面へ足す。
export interface ProteinVisualSource extends DynamicRenderSource {
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

// 直近の同期で選んだゆらぎの LOD と、その反映に要した CPU 時間 [ms]・GPU 転送量 [byte]。
export interface ProteinMotionMetrics {
  readonly lod: ProteinMotionLod;
  readonly cpuMs: number;
  readonly uploadBytes: number;
}

// タンパク質モデル、構造ゆらぎ、結合線と、ゆらぎの LOD・係数遷移の履歴を所有する。
export class ProteinEnemyView extends DynamicView<ProteinVisualSource> {
  private readonly runtime: ProteinRuntime;
  // 構造メッシュを組んだ表示設定。まだ組んでいなければ null。
  private renderedDisplay: ProteinDisplaySettings | null = null;
  private readonly motionController: ProteinMotionController;
  private lod: ProteinMotionLod = 'near';
  // 直近の同期でモード係数の確定に要した CPU 時間 [ms]。
  private motionControllerCpuMs = 0;

  // THREE ツリーの根と、残基変形を持つ runtime を用意する。構造メッシュは最初の同期で、そのフレームの
  // 表示設定から組む。modelScale(表示倍率)と boundingRadius(LOD を選ぶ外接半径 [m])には
  // 物理の判定形状と同じ値を渡す。enemyId はゆらぎの個体差の鍵で、同じ鍵の個体は同じように揺らぐ。
  public constructor(
    private readonly definition: ProteinRenderDefinition,
    modelScale: number,
    private readonly boundingRadius: number,
    enemyId: string,
    scene?: THREE.Scene,
  ) {
    const motion = definition.source.motion;
    // 表示ツリーと runtime は同じ root を共有し、寿命も View に揃える。
    const root = new THREE.Group();
    root.scale.setScalar(modelScale);
    super(root, scene);
    this.runtime = new ProteinRuntime(root, definition.source.semantic, motion);
    this.motionController = new ProteinMotionController(motion, enemyId);
  }

  // まだ組んでいないか、表現種別か着色が変わったときだけ THREE 子要素を組み直す。
  private syncDisplay(display: ProteinDisplaySettings): void {
    if (this.renderedDisplay !== null
      && display.representation === this.renderedDisplay.representation
      && display.colorMode === this.renderedDisplay.colorMode) return;
    this.runtime.clearVisuals();
    this.definition.buildRenderObjectInto(this.object, display, this.runtime.motionBinding ?? undefined);
    this.runtime.rebuildVisuals();
    this.renderedDisplay = { ...display };
  }

  // 直近の同期で選んだ LOD と、係数の確定から表示反映までに要した CPU 時間・GPU 転送量を公開する。
  public get motionMetrics(): ProteinMotionMetrics {
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
  // 表示時刻の状態を引けないフレームは LOD を保ったまま変形を止める。
  protected override syncModel(
    source: ProteinVisualSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    this.syncDisplay(viewFrame.proteinDisplay);
    this.motionControllerCpuMs = 0;
    if (displayed !== null) {
      const projectedDiameterPx = apparentSizePx(
        this.boundingRadius * 2,
        viewFrame.camera.radialScale(displayed.r),
      );
      this.lod = proteinMotionLodForProjectedSize(projectedDiameterPx, this.lod);
      if (this.lod !== 'marker') {
        const cpuStart = performance.now();
        // 揺らぎの表示が無効化されている間は、LOD を保ったまま係数のみを静止状態（0）へ設定する。
        this.motionController.sampleAt(
          viewFrame.displayTime,
          viewFrame.visual.proteinVibration ? this.lod : 'marker',
          source.phase,
        );
        this.motionControllerCpuMs = performance.now() - cpuStart;
      }
    }
    this.runtime.syncVisual({
      active: displayed !== null,
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
