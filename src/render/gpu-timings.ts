// 描画パスごとの GPU 実行時間 [ms] を溜める。パスは数値インデックスで指す(`GPU_PASS` の各値)。
// GPU の時刻印はフレーム N のぶんがフレーム N+k に返るので、値は数フレーム遅れて非同期に届く。
import { InspectorBase, TimestampQuery, type WebGPURenderer } from 'three/webgpu';

// パスの識別子。並びは描画フェーズでの実行順。
export const GPU_PASS = {
  shadowMap: 0,
  gbuffer: 1,
  shadow: 2,
  lighting: 3,
  material: 4,
  atmosphere: 5,
  world: 6,
  lens: 7,
  composite: 8,
  overlay: 9,
  antialias: 10,
  cloudBake: 11,
  cloudSurface: 12,
  cloudAtmosphere: 13,
  cloudShadow: 14,
} as const;

export type GpuPassId = (typeof GPU_PASS)[keyof typeof GPU_PASS];

export interface GpuTimingSink {
  beginPass(id: GpuPassId): void;
}

// 表示名。並びは GPU_PASS の値の順。
export const GPU_PASS_LABELS: readonly string[] = [
  '影マップ', 'Gバッファ', '影', 'ライティング', 'マテリアル', '大気', 'ワールド', 'レンズ', '合成',
  '3D UI', 'アンチエイリアス', '雲の生成', '表面雲', '大気(雲あり)', '雲影',
];

export const GPU_PASS_COUNT = GPU_PASS_LABELS.length;

// 雲の計測対象と、単独のGPU時刻として読める範囲。表面雲は雲殻だけを描く2回目のGバッファ
// render() として分けてあるので、単独の時刻印で読める。**大気だけは分けられない** — 積分器が
// 雲を同一シェーダ内で評価して描画するため、雲のぶんだけを切り出した時刻は取れず、行の名前も
// 「大気(雲あり)」にしてある。WebGPUのtimestamp-queryが無い場合は、既存のGpuTimingsが
// すべて「未対応」へフォールバックする。
export const CLOUD_GPU_MEASUREMENTS = {
  bake: { pass: GPU_PASS.cloudBake, scope: 'exact' },
  atmosphere: { pass: GPU_PASS.cloudAtmosphere, scope: 'cloud-enabled composite' },
  shadow: { pass: GPU_PASS.cloudShadow, scope: 'exact' },
  surface: { pass: GPU_PASS.cloudSurface, scope: 'exact' },
} as const;

interface GpuTimingSnapshot {
  readonly supported: boolean;
  readonly elapsedMs: readonly number[];
  readonly observedRenderTotalMs: number | null;
  readonly observedRenderExpectedQueryCount: number;
  readonly observedRenderQueryCount: number;
  readonly observedRenderComplete: boolean;
  readonly observedComputeTotalMs: number | null;
  readonly observedComputeExpectedQueryCount: number;
  readonly observedComputeQueryCount: number;
  readonly observedComputeComplete: boolean;
}

// backend.timestampQueryPool[type] の型。@types/three の Backend 型には出てこない。
interface RenderTimestampPool {
  readonly timestamps: Map<string, number>;
}

interface ObservedFrameTimings {
  renderExpected: number;
  renderResolved: number;
  renderMs: number;
  computeExpected: number;
  computeResolved: number;
  computeMs: number;
  ended: boolean;
}

// resolve() を跨いで解決されないまま残る uid が際限なく育たないための上限。
// 数フレーム分のパス数だけ許容すれば十分で、上限を超えたら一括破棄して次のフレームから計測し直す。
const PENDING_UID_CAP = GPU_PASS_COUNT * 8;
const OBSERVED_FRAME_CAP = 64;

// renderer.render() 呼び出しの uid を、直前の GpuTimings.beginPass が宣言したパスへ結び付ける
// Inspector。InspectorBase の広いメソッド一式(beginCompute など)を GpuTimings の公開面へ持ち込まない
// よう、GpuTimings とは別のクラスにする。
class PassInspector extends InspectorBase {
  // onBegin は render() の呼び出しごとにその uid を、onFinish はその終わりを受け取る。
  public constructor(
    private readonly onBegin: (uid: string) => void,
    private readonly onFinish: () => void,
    private readonly onComputeBegin: (uid: string) => void,
  ) {
    super();
  }

  // レンダラーが render() を呼ぶたびに、その呼び出しの uid を添えて呼ばれる。
  public beginRender(uid: string): void {
    this.onBegin(uid);
  }

  // その render() が終わるたびに呼ばれる。入れ子の呼び出しでは内側が先に閉じる。
  public finishRender(): void {
    this.onFinish();
  }

  // compute() ごとにレンダラーから届く UID を計測器へ渡す。
  public beginCompute(uid: string): void {
    this.onComputeBegin(uid);
  }
}

export class GpuTimings {
  // 集計の可否。偽の間は届いた値を捨てる。
  public enabled = false;
  private readonly elapsedMs = new Float64Array(GPU_PASS_COUNT);
  // 解決は非同期なので、前回の解決が返る前に次を積まない。
  private resolving = false;
  private resolvePromise: Promise<void> | null = null;
  private available = false;
  // 次に来る renderer.render() 呼び出しが属するパス。Inspector が uid を受け取るたび null へ戻す。
  private pendingPass: GpuPassId | null = null;
  // 実行中の render() の入れ子の深さと、いちばん外側が属するパス。ノードが自前の中間パスを
  // 内側で発行することがあるので、そのぶんも外側のパスへ計上する。
  private renderDepth = 0;
  private outerPass: GpuPassId | null = null;
  // render() 呼び出しの uid → その呼び出しが属していたパス。resolve() が該当分を引いて消費する。
  private readonly passByUid = new Map<string, GpuPassId>();
  private readonly renderFrameByUid = new Map<string, number>();
  private readonly computeFrameByUid = new Map<string, number>();
  private readonly observedFrames = new Map<number, ObservedFrameTimings>();
  private nextFrameId = 0;
  private activeFrameId: number | null = null;
  private latestObservedFrameId: number | null = null;

  // 自分専用の Inspector をレンダラーへ据え、以後の render() 呼び出しの uid を
  // beginPass が宣言したパスへ結び付けられるようにする。
  public constructor(private readonly renderer: WebGPURenderer) {
    renderer.inspector = new PassInspector(
      (uid) => this.onBeginRender(uid),
      () => this.onFinishRender(),
      (uid) => this.onBeginCompute(uid),
    );
  }

  // 時刻印が実際に取れているか。デバイスが timestamp-query を持たない環境では偽のままになる。
  public get supported(): boolean { return this.available; }

  // このあと最初に来る renderer.render() 呼び出しが id の描画パスであることを宣言する。パスを
  // 発行する直前に毎回呼ぶ。enabled が偽の間は宣言を捨てる。
  public beginPass(id: GpuPassId): void {
    if (!this.enabled) return;
    this.pendingPass = id;
  }

  // render-lab marks one synchronous scene/pipeline render as a measurement frame. Query UIDs are
  // attributed to this boundary even when no named beginPass() was set.
  // render-lab の1回の同期描画を計測窓として開き、非同期の query 解決に備える。
  public beginObservedFrame(): void {
    if (this.activeFrameId !== null) throw new Error('An observed GPU frame is already active');
    const id = this.nextFrameId++;
    this.observedFrames.set(id, {
      renderExpected: 0, renderResolved: 0, renderMs: 0,
      computeExpected: 0, computeResolved: 0, computeMs: 0, ended: false,
    });
    this.activeFrameId = id;
    this.latestObservedFrameId = id;
    // 解決待ちの窓は上限内で保持し、最古の UID 紐付けから破棄する。
    if (this.observedFrames.size > OBSERVED_FRAME_CAP) {
      const oldestId = this.observedFrames.keys().next().value;
      if (oldestId !== undefined && oldestId !== id) {
        this.observedFrames.delete(oldestId);
        for (const [uid, frameId] of this.renderFrameByUid) if (frameId === oldestId) this.renderFrameByUid.delete(uid);
        for (const [uid, frameId] of this.computeFrameByUid) if (frameId === oldestId) this.computeFrameByUid.delete(uid);
      }
    }
  }

  // 計測窓を閉じる。開始中の窓がなければ呼び出し順の誤りとして例外にする。
  public endObservedFrame(): void {
    const id = this.activeFrameId;
    if (id === null) throw new Error('No observed GPU frame is active');
    const frame = this.observedFrames.get(id);
    if (frame) frame.ended = true;
    this.activeFrameId = null;
  }

  // いちばん外側の render() が beginPass の宣言を消費し、その内側で発行される render()
  // (ノードが自前の中間パスを持つとき)も同じパスへ計上する。宣言のないまま始まった外側の
  // 呼び出しは、どのパスにも属さない扱いで流れる。
  private onBeginRender(uid: string): void {
    if (this.renderDepth === 0) this.outerPass = this.pendingPass;
    this.renderDepth++;
    this.pendingPass = null;
    if (this.enabled && this.outerPass !== null) this.passByUid.set(uid, this.outerPass);
    if (this.enabled && this.activeFrameId !== null) {
      this.renderFrameByUid.set(uid, this.activeFrameId);
      const frame = this.observedFrames.get(this.activeFrameId);
      if (frame) frame.renderExpected++;
    }
  }

  // compute query の UID を実行中の観測窓へ帰属させ、完了数を数える。
  private onBeginCompute(uid: string): void {
    if (!this.enabled || this.activeFrameId === null) return;
    this.computeFrameByUid.set(uid, this.activeFrameId);
    const frame = this.observedFrames.get(this.activeFrameId);
    if (frame) frame.computeExpected++;
  }

  // render() の終わりで入れ子の深さを戻し、いちばん外側が閉じたらパスの帰属を解除する。
  private onFinishRender(): void {
    // 深さは enabled によらず戻す — 窓の開閉が描画の途中に挟まると、深さが釣り合わなくなる。
    if (this.renderDepth > 0) this.renderDepth--;
    if (this.renderDepth === 0) this.outerPass = null;
  }

  // 描画フェーズの末尾で呼ぶ。render / compute の時刻印を要求し、届き次第対応する集計へ書く。
  //
  // 呼ばない期間があるとレンダラ側の時刻印クエリが溜まって上限に当たるため、`enabled` に
  // かかわらず毎フレーム呼ぶこと。ゲート下にあるのは集計だけで、要求そのものではない。
  public resolve(): void {
    if (this.resolving) return;
    this.resolving = true;
    this.resolvePromise = Promise.all([
      this.renderer.resolveTimestampsAsync(TimestampQuery.RENDER),
      this.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE),
    ])
      .then(([renderMs]) => {
        if (renderMs !== undefined) this.available = true;
        this.collectTimestamps(TimestampQuery.RENDER);
        this.collectTimestamps(TimestampQuery.COMPUTE);
        // 解決されないまま残った uid が肥大化しないよう、閾値を超えたら一括破棄する。
        if (this.passByUid.size > PENDING_UID_CAP) this.passByUid.clear();
      })
      .catch(() => {
        // 時刻印は取れないことがある。落ちたクエリで描画ループを未処理の rejection にしない —
        // 一度も解決しない環境では supported が偽のままになるだけで済む。
      })
      .finally(() => { this.resolving = false; });
  }

  // 直近の resolve() が完了するまで待機する。非同期の結果を特定のタイミングで取得したい計測用のインターフェース。
  public async waitForResolve(): Promise<void> {
    await this.resolvePromise;
  }

  // 溜めた読みを捨てて数え直す。**先に waitForResolve() を待つこと** —
  // 待たずに呼ぶと、遅れて届いた前の窓の値が捨てたはずの器へ入る。
  public reset(): void {
    this.elapsedMs.fill(0);
    this.available = false;
    this.pendingPass = null;
    this.passByUid.clear();
    this.renderFrameByUid.clear();
    this.computeFrameByUid.clear();
    this.observedFrames.clear();
    this.latestObservedFrameId = null;
  }

  // 全パスの直近の所要時間 [ms] を、パス id の並びのまま写して返す。
  public snapshot(): GpuTimingSnapshot {
    // 未解決 query が残る窓の部分和は total として公開しない。
    const frame = this.latestObservedFrameId === null
      ? undefined : this.observedFrames.get(this.latestObservedFrameId);
    const renderComplete = frame !== undefined && frame.ended
      && frame.renderResolved === frame.renderExpected;
    const computeComplete = frame !== undefined && frame.ended
      && frame.computeResolved === frame.computeExpected;
    return {
      supported: this.available,
      elapsedMs: Array.from(this.elapsedMs),
      observedRenderTotalMs: renderComplete ? frame.renderMs : null,
      observedRenderExpectedQueryCount: frame?.renderExpected ?? 0,
      observedRenderQueryCount: frame?.renderResolved ?? 0,
      observedRenderComplete: renderComplete,
      observedComputeTotalMs: computeComplete ? frame.computeMs : null,
      observedComputeExpectedQueryCount: frame?.computeExpected ?? 0,
      observedComputeQueryCount: frame?.computeResolved ?? 0,
      observedComputeComplete: computeComplete,
    };
  }

  // パス id の直近の所要時間 [ms]。
  public msOf(id: GpuPassId): number { return this.elapsedMs[id]!; }

  // WebGPU timestampQueryPool を読む唯一のキャスト箇所。Three の公開型にはこの内部プールが出てこない。
  private collectTimestamps(type: typeof TimestampQuery.RENDER | typeof TimestampQuery.COMPUTE): void {
    const backend = this.renderer.backend as unknown as { timestampQueryPool: Record<string, RenderTimestampPool> };
    const pool = backend.timestampQueryPool[type];
    if (!pool) return;
    // Render は名前付き pass と窓全体へ、compute は窓全体へ振り分ける。
    if (type === TimestampQuery.RENDER) {
      const matches: (readonly [GpuPassId, number])[] = [];
      for (const [uid, duration] of pool.timestamps) {
        const frameId = this.renderFrameByUid.get(uid);
        const frame = frameId === undefined ? undefined : this.observedFrames.get(frameId);
        if (frame) {
          frame.renderMs += duration;
          frame.renderResolved++;
          this.renderFrameByUid.delete(uid);
        }
        const pass = this.passByUid.get(uid);
        if (pass !== undefined) {
          matches.push([pass, duration]);
          this.passByUid.delete(uid);
        }
      }
      if (this.enabled && matches.length > 0) {
        this.elapsedMs.fill(0);
        for (const [pass, duration] of matches) this.elapsedMs[pass]! += duration;
      }
    } else {
      for (const [uid, duration] of pool.timestamps) {
        const frameId = this.computeFrameByUid.get(uid);
        const frame = frameId === undefined ? undefined : this.observedFrames.get(frameId);
        if (frame) {
          frame.computeMs += duration;
          frame.computeResolved++;
          this.computeFrameByUid.delete(uid);
        }
      }
    }
    pool.timestamps.clear();
  }
}
