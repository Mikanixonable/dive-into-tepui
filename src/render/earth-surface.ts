// 地球表面の寿命境界。実データの取得・GPU公開・気候入力が同じdatasetIdと世代を共有する。
import * as THREE from 'three/webgpu';
import type { EarthSurfaceSource } from '../game/celestial/solar-system/earth-surface-source';
import { EarthSurfaceView } from './earth-surface-tiles';
import type {
  EarthSurfaceResidentFrame,
} from './earth-surface-resident';
import type {
  CelestialSurfaceFrame,
  CelestialSurfaceLike,
  SurfacePhotometry,
} from './celestial-surface';

export interface EarthSurfaceRequestLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  release(): void;
}

// 実GPU実装を直接所有せず、ゲーム側から差し込める地表常駐の最小境界。
// 具象coordinatorはタイル要求とGPU寿命を持つため、EarthSurfaceはこの2操作だけを知る。
export interface EarthSurfaceResidentCoordinatorLike {
  sync(input: EarthSurfaceResidentFrame): unknown;
  reset?(): void;
  dispose(): void;
}

export class EarthSurfaceContext {
  private nextGenerationValue = 1;
  private readonly requests = new Set<AbortController>();
  private disposed = false;

  public constructor(private sourceValue: EarthSurfaceSource) {}

  public get source(): EarthSurfaceSource { return this.sourceValue; }

  public get generation(): number { return this.nextGenerationValue; }

  // 1つの地表要求へ世代とキャンセル信号を割り当てる。
  public requestLease(): EarthSurfaceRequestLease {
    if (this.disposed) throw new Error('Earth surface context is disposed');
    const controller = new AbortController();
    const generation = this.nextGenerationValue;
    this.requests.add(controller);
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

  // 視点変更などで旧要求を無効化する。既に届いた結果もgeneration比較で公開側が拒否する。
  public invalidateRequests(): number {
    if (this.disposed) return this.nextGenerationValue;
    this.nextGenerationValue++;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    return this.nextGenerationValue;
  }

  // 配信版を切り替えると、旧版の要求と結果を同じ地表へ公開してはならない。
  public replaceSource(source: EarthSurfaceSource): void {
    if (this.disposed) throw new Error('Earth surface context is disposed');
    this.invalidateRequests();
    this.sourceValue = source;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.invalidateRequests();
    this.disposed = true;
  }
}

// 地球固有の寿命境界を共有しながら、天体表面の描画契約は既存の球面へ委譲する。
export class EarthSurface implements CelestialSurfaceLike {
  private requestLeaseValue: EarthSurfaceRequestLease | null = null;
  private disposed = false;

  public constructor(
    private readonly context: EarthSurfaceContext,
    private readonly fallback: CelestialSurfaceLike,
    private readonly coordinator: EarthSurfaceResidentCoordinatorLike | null = null,
  ) {}

  public get photometry(): SurfacePhotometry | null { return this.fallback.photometry; }

  public get textureUrl(): string | null { return this.fallback.textureUrl; }

  public addTo(parent: THREE.Object3D): void { this.fallback.addTo(parent); }

  public syncLod(apparentDiameterPx: number): void { this.fallback.syncLod(apparentDiameterPx); }

  public syncFrame(frame: CelestialSurfaceFrame): void {
    if (this.disposed) return;
    this.fallback.syncFrame(frame);
    if (this.coordinator === null) return;

    const lease = this.requestLeaseValue?.signal.aborted
      ? this.context.requestLease()
      : this.requestLeaseValue ?? this.context.requestLease();
    this.requestLeaseValue = lease;
    if (!(frame.camera instanceof THREE.PerspectiveCamera)
      && !(frame.camera instanceof THREE.OrthographicCamera)) {
      // EarthSurfaceViewは投影行列を持つ2種類のゲームカメラだけを受ける。
      // 未知のカメラではfallbackを維持し、要求だけは直ちにキャンセルする。
      lease.release();
      this.requestLeaseValue = null;
      return;
    }
    const bodyToWorld = frame.camera.matrixWorld.clone().multiply(frame.bodyToView);
    const projection = new EarthSurfaceView(
      frame.camera, bodyToWorld, frame.axes, frame.viewport.width, frame.viewport.height,
    );
    const residentFrame: EarthSurfaceResidentFrame = {
      projection,
      timeMs: frame.timeMs,
      generation: lease.generation,
      signal: lease.signal,
      frame: frame.frame,
    };
    try {
      this.coordinator.sync(residentFrame);
    } catch (error) {
      lease.release();
      this.requestLeaseValue = null;
      throw error;
    }
  }

  public hide(): void {
    if (this.disposed) return;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.context.invalidateRequests();
    this.coordinator?.reset?.();
    this.fallback.hide();
  }

  // 実行中の配信版を破棄し、新しい版をbaseから再開できる状態へ戻す。
  public replaceSource(source: EarthSurfaceSource): void {
    if (this.disposed) return;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.context.replaceSource(source);
    this.coordinator?.reset?.();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requestLeaseValue?.release();
    this.requestLeaseValue = null;
    this.coordinator?.dispose();
    this.context.dispose();
    this.fallback.dispose();
  }
}
