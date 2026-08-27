// 描画パスごとの GPU 実行時間 [ms] を溜める。パスは数値インデックスで指す(`GPU_PASS` の各値)。
//
// `frame-sections.ts` の update 側と同型だが、値が非同期に届く点だけが違う。GPU の時刻印は
// フレーム N のぶんがフレーム N+k に返るので、`enter`/`exit` がその場で確定する `FrameSections`
// とは器を分ける。表示は 500ms 窓の平均なので、この遅れは読みに出ない。
import { InspectorBase, TimestampQuery, type WebGPURenderer } from 'three/webgpu';

// パスの識別子。並びは描画フェーズでの実行順。
export const GPU_PASS = {
  shadow: 0,
  gbuffer: 1,
  occlusion: 2,
  lighting: 3,
  material: 4,
  atmosphere: 5,
  world: 6,
  lens: 7,
  composite: 8,
  overlay: 9,
  antialias: 10,
} as const;

export type GpuPassId = (typeof GPU_PASS)[keyof typeof GPU_PASS];

// 表示名。並びは GPU_PASS の値の順。
export const GPU_PASS_LABELS: readonly string[] = ['影', 'Gバッファ', '遮蔽', 'ライティング', 'マテリアル', '大気', 'ワールド', 'レンズ', '合成', '3D UI', 'アンチエイリアス'];

export const GPU_PASS_COUNT = GPU_PASS_LABELS.length;

export interface GpuTimingSnapshot {
  readonly supported: boolean;
  readonly elapsedMs: readonly number[];
}

// backend.timestampQueryPool[type] の型。@types/three の Backend 型には出てこないが、
// resolveTimestampsAsync の戻り値がフレーム全体の合計だけなのに対し、呼び出しごと(uid ごと)
// の実測値はここにしかない。
interface RenderTimestampPool {
  readonly timestamps: Map<string, number>;
}

// resolve() を跨いで解決されないまま残る uid が際限なく育たないための上限。
// 数フレーム分のパス数だけ許せば十分で、超えたら丸ごと捨てて次のフレームから数え直す。
const PENDING_UID_CAP = GPU_PASS_COUNT * 8;

// renderer.render() 呼び出しの uid を、直前の GpuTimings.beginPass が宣言したパスへ結び付ける
// だけの Inspector。GpuTimings 自身に InspectorBase を継承させず別クラスへ切り出すのは、
// InspectorBase が持つ広いメソッド一式(beginCompute など)を GpuTimings の公開面へ持ち込まないため。
class PassInspector extends InspectorBase {
  constructor(private readonly onUid: (uid: string) => void) {
    super();
  }

  // レンダラーが render() を呼ぶたびに、その呼び出しの uid を添えて呼ばれる。
  beginRender(uid: string): void {
    this.onUid(uid);
  }
}

export class GpuTimings {
  // 集計の可否。偽の間は届いた値を捨てる。
  enabled = false;
  private readonly elapsedMs = new Float64Array(GPU_PASS_COUNT);
  // 解決は非同期なので、前回の解決が返る前に次を積まない。
  private resolving = false;
  private resolvePromise: Promise<void> | null = null;
  private available = false;
  // 次に来る renderer.render() 呼び出しが属するパス。Inspector が uid を受け取るたび null へ戻す。
  private pendingPass: GpuPassId | null = null;
  // render() 呼び出しの uid → その呼び出しが属していたパス。resolve() が該当分を引いて消費する。
  private readonly passByUid = new Map<string, GpuPassId>();

  // 自分専用の Inspector をレンダラーへ据え、以後の render() 呼び出しの uid を
  // beginPass が宣言したパスへ結び付けられるようにする。
  constructor(private readonly renderer: WebGPURenderer) {
    renderer.inspector = new PassInspector((uid) => this.onBeginRender(uid));
  }

  // 時刻印が実際に取れているか。デバイスが timestamp-query を持たない環境では偽のままになる。
  get supported(): boolean { return this.available; }

  // このあと最初に来る renderer.render() 呼び出しが id の描画パスであることを宣言する。
  // パイプラインはそのパスを発行する直前に毎回呼ぶ。
  //
  // 窓が閉じている間は「測定は何もしない」という enabled の規則どおり、フレームごとの
  // 記帳自体を省く。
  beginPass(id: GpuPassId): void {
    if (!this.enabled) return;
    this.pendingPass = id;
  }

  // beginPass を伴わない render() 呼び出し(three が内部で発行するもの)はどのパスにも
  // 属さないので、そのまま無視して他のパスの枠を奪わないようにする。
  private onBeginRender(uid: string): void {
    if (!this.enabled || this.pendingPass === null) return;
    this.passByUid.set(uid, this.pendingPass);
    this.pendingPass = null;
  }

  // 描画フェーズの末尾で呼ぶ。直近フレームのパス所要時間を要求し、届き次第 elapsedMs へ書く。
  //
  // 呼ばない期間があるとレンダラ側の時刻印クエリが溜まって上限に当たるため、`enabled` に
  // かかわらず毎フレーム呼ぶこと。ゲート下にあるのは集計だけで、要求そのものではない。
  resolve(): void {
    if (this.resolving) return;
    this.resolving = true;
    this.resolvePromise = this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER)
      .then((ms) => {
        if (ms === undefined) return;
        this.available = true;
        const pool = this.renderTimestampPool();
        if (pool) {
          const matches: Array<readonly [GpuPassId, number]> = [];
          for (const [uid, duration] of pool.timestamps) {
            const pass = this.passByUid.get(uid);
            if (pass === undefined) continue;
            matches.push([pass, duration]);
            this.passByUid.delete(uid);
          }
          // 1件も一致しなかった(まだクエリが flush されていない)フレームは、前回までの
          // 読みをそのまま残す。0 で塗り潰すのはここで初めて書き込むときだけ。
          if (this.enabled && matches.length > 0) {
            this.elapsedMs.fill(0);
            // 1 つのパスが 1 フレームに何度も render() を呼ぶことがあるので、上書きではなく
            // 足し合わせる。
            for (const [pass, duration] of matches) this.elapsedMs[pass]! += duration;
          }
          // three は resolve のたびにここへ足すだけで自分では空にしないので、消費済みかどうかに
          // 関わらず毎フレームここで空にする(さもないと無限に肥大化する)。
          pool.timestamps.clear();
        }
        // 解決されないまま残った uid が際限なく育たないよう、閾値を超えたら丸ごと捨てる。
        if (this.passByUid.size > PENDING_UID_CAP) this.passByUid.clear();
      })
      .catch(() => {
        // Timestamp queries are optional. A lost query must not turn the render loop into an
        // unhandled rejection; `supported` remains false until a query resolves successfully.
      })
      .finally(() => { this.resolving = false; });
  }

  // Render Lab and other offline profilers need a deterministic point at which the asynchronous
  // timestamp result can be read. The game loop deliberately keeps using fire-and-forget resolve().
  async waitForResolve(): Promise<void> {
    await this.resolvePromise;
  }

  // Discard the current window before a new benchmark case. Callers must waitForResolve() first so
  // a late GPU result cannot repopulate an already-reset case.
  reset(): void {
    this.elapsedMs.fill(0);
    this.available = false;
    this.pendingPass = null;
    this.passByUid.clear();
  }

  snapshot(): GpuTimingSnapshot {
    return { supported: this.available, elapsedMs: Array.from(this.elapsedMs) };
  }

  // パス id の直近の所要時間 [ms]。
  msOf(id: GpuPassId): number { return this.elapsedMs[id]!; }

  // render 用の timestampQueryPool を返す。公開型に無い内部プロパティを読む唯一のキャスト箇所。
  private renderTimestampPool(): RenderTimestampPool | undefined {
    const backend = this.renderer.backend as unknown as { timestampQueryPool: Record<string, RenderTimestampPool> };
    return backend.timestampQueryPool[TimestampQuery.RENDER];
  }
}
