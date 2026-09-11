// 地球表面。EarthSurfaceContext は配信版と、地表要求の世代・キャンセル信号を配る。EarthSurface は
// 天体表面の球へ、詳細な材質とタイルの常駐を接続する。
import * as THREE from 'three/webgpu';
import type { EarthSurfaceSource } from '../game/celestial/solar-system/earth-surface-source';
import { EarthSurfaceView } from './earth-surface-tiles';
import type {
  EarthSurfaceResidentFrame,
} from './earth-surface-resident';
import type {
  CelestialSurfaceFrame,
  CelestialSurfaceDiagnostics,
  CelestialSurfaceLike,
  CelestialSurfaceMaterialAttachment,
  CelestialSurfaceStatus,
  SurfacePhotometry,
} from './celestial/celestial-surface';

// 地表要求1件ぶんの世代とキャンセル信号。使い終えたら release する(信号は中断される)。
export interface EarthSurfaceRequestLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  release(): void;
}

export type EarthSurfaceStatus = CelestialSurfaceStatus;

const PROJECTION_REBUILD_INTERVAL_MS = 100; // [ms]

// 実GPU実装を直接所有せず、ゲーム側から差し込める地表常駐の最小境界。
// 具象coordinatorはタイル要求とGPU寿命を持つため、EarthSurfaceはこの2操作だけを知る。
export interface EarthSurfaceResidentCoordinatorLike {
  sync(input: EarthSurfaceResidentFrame): unknown;
  readonly residentMaxZ?: number | null;
  readonly failureReason?: string | null;
  reset?(): void;
  dispose(): void;
}

// 天体表面の球へ差し込む詳細な材質。syncFrame はフレームごとに呼ぶ。
export interface EarthSurfaceMaterialAttachment extends CelestialSurfaceMaterialAttachment {
  readonly syncFrame: (frame: CelestialSurfaceFrame) => void;
  readonly failureReason?: () => string | null;
}

// 材質を差し替えられる天体表面。fallback がこれを満たせば詳細な材質を差し込める。
interface CelestialSurfaceMaterialHost {
  replaceMaterial(attachment: CelestialSurfaceMaterialAttachment): void;
  restoreFallbackMaterial?(): void;
}

// 差し込めなかった材質を、持ち物のテクスチャごと解放する。
function disposeMaterialAttachment(attachment: EarthSurfaceMaterialAttachment): void {
  attachment.onDispose?.();
  attachment.material.dispose();
  for (const deferred of attachment.deferred) deferred.dispose();
  for (const texture of attachment.textures ?? []) texture.dispose();
}

// 配信版(source)を持ち、地表要求へ世代とキャンセル信号を配る。世代を進めると、それまでに
// 配った要求は中断される。
export class EarthSurfaceContext {
  private nextGenerationValue = 1;
  private readonly requests = new Set<AbortController>();
  private disposed = false;

  public constructor(private sourceValue: EarthSurfaceSource) {}

  public get source(): EarthSurfaceSource { return this.sourceValue; }

  public get generation(): number { return this.nextGenerationValue; }

  // 1つの地表要求へ、現在の世代とキャンセル信号を割り当てる。dispose 後は例外を投げる。
  public requestLease(): EarthSurfaceRequestLease {
    if (this.disposed) throw new Error('Earth surface context is disposed');
    // 世代を進めたときにまとめて中断できるよう、配った要求を控えておく。
    const controller = new AbortController();
    const generation = this.nextGenerationValue;
    this.requests.add(controller);
    // release は何度呼んでもよく、最初の1回で控えから外して信号を中断する。
    let released = false;
    return {
      generation,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.requests.delete(controller);
        controller.abort();
      },
    };
  }

  // 世代を進め、配った要求をすべて中断する。返り値は新しい世代。
  public invalidateRequests(): number {
    if (this.disposed) return this.nextGenerationValue;
    this.nextGenerationValue++;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    return this.nextGenerationValue;
  }

  // 配信版を差し替え、旧版の要求を中断する(世代も進む)。dispose 後は例外を投げる。
  public replaceSource(source: EarthSurfaceSource): void {
    if (this.disposed) throw new Error('Earth surface context is disposed');
    this.invalidateRequests();
    this.sourceValue = source;
  }

  // 配った要求をすべて中断する。以後 requestLease と replaceSource は例外を投げる。
  public dispose(): void {
    if (this.disposed) return;
    this.invalidateRequests();
    this.disposed = true;
  }
}

// fallback の球面に、attach で詳細な材質とタイルの常駐を重ねる地球の天体表面。
export class EarthSurface implements CelestialSurfaceLike {
  private requestLeaseValue: EarthSurfaceRequestLease | null = null;
  private coordinatorValue: EarthSurfaceResidentCoordinatorLike | null;
  private projectionValue: EarthSurfaceView | null = null;
  private projectionBuiltTimeMs: number | null = null;
  private projectionCameraWorldValue: THREE.Matrix4 | null = null;
  private projectionCameraViewValue: THREE.Matrix4 | null = null;
  private projectionMatrixValue: THREE.Matrix4 | null = null;
  private bodyToViewValue: THREE.Matrix4 | null = null;
  private axesValue: THREE.Vector3 | null = null;
  private projectionViewportValue: { width: number; height: number } | null = null;
  private projectionCameraTypeValue: 'perspective' | 'orthographic' | null = null;
  private projectionCoordinateSystemValue: number | null = null;
  private projectionReversedDepthValue: boolean | null = null;
  private materialSyncValue: ((frame: CelestialSurfaceFrame) => void) | null = null;
  private detailedMaterialValue = false;
  private materialFailureReasonValue: (() => string | null) | null = null;
  private statusValue: EarthSurfaceStatus;
  private reasonValue: string | null;
  private disposed = false;

  // context と fallback の所有を引き継ぎ、dispose で一緒に解放する。status は省くと
  // coordinator の有無から決まる。
  public constructor(
    private readonly context: EarthSurfaceContext,
    private readonly fallback: CelestialSurfaceLike,
    coordinator: EarthSurfaceResidentCoordinatorLike | null = null,
    status: EarthSurfaceStatus = coordinator === null ? 'fallback' : 'ready',
    reason: string | null = null,
  ) {
    this.coordinatorValue = coordinator;
    this.statusValue = status;
    this.reasonValue = reason;
  }

  public get status(): EarthSurfaceStatus { return this.statusValue; }

  public get usesDetailedMaterial(): boolean { return this.detailedMaterialValue; }

  // 現在の状態。reason は明示の理由・常駐の失敗・材質の失敗のうち最初にあるもの。
  public get diagnostics(): CelestialSurfaceDiagnostics {
    return {
      status: this.statusValue,
      reason: this.reasonValue ?? this.coordinatorValue?.failureReason
        ?? this.materialFailureReasonValue?.() ?? null,
      usesDetailedMaterial: this.detailedMaterialValue,
      residentMaxZ: this.coordinatorValue?.residentMaxZ ?? null,
    };
  }

  public get photometry(): SurfacePhotometry | null { return this.fallback.photometry; }

  public get textureUrl(): string | null { return this.fallback.textureUrl; }

  public addTo(parent: THREE.Object3D): void { this.fallback.addTo(parent); }

  public syncLod(apparentDiameterPx: number): void { this.fallback.syncLod(apparentDiameterPx); }

  // フレームの値で球と材質を更新し、タイルの常駐を進める。dispose 後は何もしない。
  public syncFrame(frame: CelestialSurfaceFrame): void {
    if (this.disposed) return;
    this.fallback.syncFrame(frame);
    this.materialSyncValue?.(frame);
    if (this.coordinatorValue === null) return;

    // 中断された要求は借り直す。
    const lease = this.requestLeaseValue?.signal.aborted
      ? this.context.requestLease()
      : this.requestLeaseValue ?? this.context.requestLease();
    this.requestLeaseValue = lease;
    if (!(frame.camera instanceof THREE.PerspectiveCamera)
      && !(frame.camera instanceof THREE.OrthographicCamera)) {
      // EarthSurfaceView が扱えないカメラでは、要求を中断して fallback のまま描く。
      lease.release();
      this.requestLeaseValue = null;
      return;
    }
    const cameraType = frame.camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic';
    const projectionChanged = this.projectionValue === null
      || this.projectionCameraViewValue === null
      || this.projectionCameraWorldValue === null
      || !this.projectionCameraWorldValue.equals(frame.camera.matrixWorld)
      || !this.projectionCameraViewValue.equals(frame.camera.matrixWorldInverse)
      || this.projectionMatrixValue === null
      || !this.projectionMatrixValue.equals(frame.camera.projectionMatrix)
      || this.bodyToViewValue === null
      || !this.bodyToViewValue.equals(frame.bodyToView)
      || this.axesValue === null
      || !this.axesValue.equals(frame.axes)
      || this.projectionViewportValue?.width !== frame.viewport.width
      || this.projectionViewportValue?.height !== frame.viewport.height
      || this.projectionCameraTypeValue !== cameraType
      || this.projectionCoordinateSystemValue !== frame.camera.coordinateSystem
      || this.projectionReversedDepthValue !== frame.camera.reversedDepth;
    const timeRewound = this.projectionBuiltTimeMs !== null && frame.timeMs < this.projectionBuiltTimeMs;
    const rebuildWindowElapsed = this.projectionBuiltTimeMs !== null
      && frame.timeMs - this.projectionBuiltTimeMs >= PROJECTION_REBUILD_INTERVAL_MS;
    const rebuildProjection = this.projectionValue === null
      || timeRewound || (projectionChanged && rebuildWindowElapsed);
    if (rebuildProjection) {
      const bodyToWorld = frame.camera.matrixWorld.clone().multiply(frame.bodyToView);
      this.projectionValue = new EarthSurfaceView(
        frame.camera, bodyToWorld, frame.axes, frame.viewport.width, frame.viewport.height,
      );
      this.projectionCameraWorldValue = frame.camera.matrixWorld.clone();
      this.projectionCameraViewValue = frame.camera.matrixWorldInverse.clone();
      this.projectionMatrixValue = frame.camera.projectionMatrix.clone();
      this.bodyToViewValue = frame.bodyToView.clone();
      this.axesValue = frame.axes.clone();
      this.projectionViewportValue = { width: frame.viewport.width, height: frame.viewport.height };
      this.projectionCameraTypeValue = cameraType;
      this.projectionCoordinateSystemValue = frame.camera.coordinateSystem;
      this.projectionReversedDepthValue = frame.camera.reversedDepth;
      this.projectionBuiltTimeMs = frame.timeMs;
    }
    const projection = this.projectionValue;
    if (projection === null) throw new Error('Earth surface projection is unavailable');
    const residentFrame: EarthSurfaceResidentFrame = {
      projection,
      timeMs: frame.timeMs,
      generation: lease.generation,
      signal: lease.signal,
      frame: frame.frame,
    };
    try {
      this.coordinatorValue.sync(residentFrame);
    } catch (error) {
      lease.release();
      this.requestLeaseValue = null;
      throw error;
    }
  }

  // 要求を中断して常駐を捨て、球を隠す。
  public hide(): void {
    if (this.disposed) return;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.context.invalidateRequests();
    this.coordinatorValue?.reset?.();
    this.clearProjectionCache();
    this.fallback.hide();
  }

  // 実行中の配信版を破棄し、新しい版を base から再開できる状態へ戻す。
  public replaceSource(source: EarthSurfaceSource): void {
    if (this.disposed) return;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.context.replaceSource(source);
    this.coordinatorValue?.reset?.();
    this.clearProjectionCache();
  }

  // source・coordinator・材質を差し替えて接続する。渡したものの所有を引き継ぎ、dispose 後に
  // 渡されたものはその場で解放する。
  public attach(
    source: EarthSurfaceSource,
    coordinator: EarthSurfaceResidentCoordinatorLike | null,
    status: EarthSurfaceStatus,
    material: EarthSurfaceMaterialAttachment | null = null,
    reason: string | null = null,
  ): void {
    if (this.disposed) {
      coordinator?.dispose();
      if (material !== null) disposeMaterialAttachment(material);
      return;
    }
    // 前の要求・常駐・材質の状態を捨てて、渡されたものへ置き換える。
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.coordinatorValue?.dispose();
    this.context.replaceSource(source);
    this.coordinatorValue = coordinator;
    this.statusValue = status;
    this.reasonValue = reason;
    this.materialSyncValue = null;
    this.materialFailureReasonValue = null;
    this.detailedMaterialValue = false;
    this.clearProjectionCache();
    if (material !== null) {
      const host = this.fallback as unknown as CelestialSurfaceMaterialHost;
      if (typeof host.replaceMaterial !== 'function') {
        disposeMaterialAttachment(material);
        this.coordinatorValue?.dispose();
        this.coordinatorValue = null;
        this.statusValue = 'fallback';
        this.reasonValue = 'detailed material connection unavailable';
      } else {
        host.replaceMaterial(material);
        this.materialSyncValue = material.syncFrame;
        this.materialFailureReasonValue = material.failureReason ?? null;
        this.detailedMaterialValue = true;
      }
    } else {
      const host = this.fallback as unknown as CelestialSurfaceMaterialHost;
      host.restoreFallbackMaterial?.();
    }
  }

  // 要求を中断し、所有する coordinator・context・fallback ごと解放する。何度呼んでもよい。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.coordinatorValue?.dispose();
    this.context.dispose();
    this.fallback.dispose();
  }

  // sourceや表示寿命の境界で、次のframeに最新の投影を必ず作らせる。
  private clearProjectionCache(): void {
    this.projectionValue = null;
    this.projectionBuiltTimeMs = null;
    this.projectionCameraWorldValue = null;
    this.projectionCameraViewValue = null;
    this.projectionMatrixValue = null;
    this.bodyToViewValue = null;
    this.axesValue = null;
    this.projectionViewportValue = null;
    this.projectionCameraTypeValue = null;
    this.projectionCoordinateSystemValue = null;
    this.projectionReversedDepthValue = null;
  }
}
