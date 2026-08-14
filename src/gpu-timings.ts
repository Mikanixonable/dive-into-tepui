// 描画パスごとの GPU 実行時間 [ms] を溜める。パスは数値インデックスで指す(`GPU_PASS` の各値)。
//
// `frame-sections.ts` の update 側と同型だが、値が非同期に届く点だけが違う。GPU の時刻印は
// フレーム N のぶんがフレーム N+k に返るので、`enter`/`exit` がその場で確定する `FrameSections`
// とは器を分ける。表示は 500ms 窓の平均なので、この遅れは読みに出ない。
import { TimestampQuery, type WebGPURenderer } from 'three/webgpu';

// パスの識別子。並びは描画フェーズでの実行順。
export const GPU_PASS = {
  world: 0,
} as const;

export type GpuPassId = (typeof GPU_PASS)[keyof typeof GPU_PASS];

// 表示名。並びは GPU_PASS の値の順。
export const GPU_PASS_LABELS: readonly string[] = ['ワールド'];

export const GPU_PASS_COUNT = GPU_PASS_LABELS.length;

export class GpuTimings {
  // 集計の可否。偽の間は届いた値を捨てる。
  enabled = false;
  private readonly elapsedMs = new Float64Array(GPU_PASS_COUNT);
  // 解決は非同期なので、前回の解決が返る前に次を積まない。
  private resolving = false;
  private available = false;

  constructor(private readonly renderer: WebGPURenderer) {}

  // 時刻印が実際に取れているか。デバイスが timestamp-query を持たない環境では偽のままになる。
  get supported(): boolean { return this.available; }

  // 描画フェーズの末尾で呼ぶ。直近フレームのパス所要時間を要求し、届き次第 elapsedMs へ書く。
  //
  // 呼ばない期間があるとレンダラ側の時刻印クエリが溜まって上限に当たるため、`enabled` に
  // かかわらず毎フレーム呼ぶこと。ゲート下にあるのは集計だけで、要求そのものではない。
  resolve(): void {
    if (this.resolving) return;
    this.resolving = true;
    void this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER)
      .then((ms) => {
        if (ms === undefined) return;
        this.available = true;
        if (this.enabled) this.elapsedMs[GPU_PASS.world] = ms;
      })
      .finally(() => { this.resolving = false; });
  }

  // パス id の直近の所要時間 [ms]。
  msOf(id: GpuPassId): number { return this.elapsedMs[id]!; }
}
