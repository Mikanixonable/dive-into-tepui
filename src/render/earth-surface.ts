// 地球表面の寿命境界。実データの取得・GPU公開・気候入力が同じdatasetIdと世代を共有する。
import type { EarthSurfaceSource } from '../game/celestial/solar-system/earth-surface-source';

export interface EarthSurfaceRequestLease {
  readonly generation: number;
  readonly signal: AbortSignal;
  release(): void;
}

export class EarthSurfaceContext {
  private nextGenerationValue = 1;
  private readonly requests = new Set<AbortController>();
  private disposed = false;

  public constructor(public readonly source: EarthSurfaceSource) {}

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

  public dispose(): void {
    if (this.disposed) return;
    this.invalidateRequests();
    this.disposed = true;
  }
}
