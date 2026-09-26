// 全球雲場の供給導出を Web Worker の帯分割並列へ振る供給源。GlobalMassFieldSupply を
// 実装し、1回の導出を帯 range へ切った ConvectiveCloudGlobalFieldJob を worker プールへ
// 投げ、全応答を帯順で加算 merge して結果へ置く。帯境界を跨ぐ footprint は各 worker の
// 全球格子へ載るので、merge は配列の要素ごとの加算だけで質量を落とさない。
// Worker を組めない・生成に失敗した環境では、内側の同期供給
// ConvectiveCloudGlobalFieldSupply へそのまま落ちる。

import {
  globalEventCellBands,
  mergeCloudGlobalFieldSupplyResults,
} from './cloud-global-field-supply';
import type {
  CloudGlobalFieldSupplyResult, ConvectiveCloudGlobalFieldSupply,
} from './cloud-global-field-supply';
import type {
  CloudGlobalFieldWorkerReply, CloudGlobalFieldWorkerResult,
} from './cloud-global-field-worker';
import type { ClimatePixels } from '../../render/cloud/climate-pixels';
import type {
  GlobalMassFieldJob, GlobalMassFieldSupply,
} from '../../render/cloud/global-mass-field';

// worker のうちこの client が使う面。本物は webpack が出す
// cloud-global-field-worker.js の Worker で、供給経路を検査する組立てでは
// この形を満たす限り差し替えてよい。
export interface CloudGlobalFieldWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  // 受け手は応答の data だけを読むので、面は DOM の MessageEvent ではなく
  // それを満たす最小の形に絞る — 模造 worker は DOM なしで組める。
  onmessage: ((event: { readonly data: CloudGlobalFieldWorkerReply }) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

// 気候画素の遅延供給口。画像は非同期に届くので、画素を取り出すのはジョブを始める
// ときであって供給の構築時ではない。
export interface CloudGlobalFieldClimateSource {
  climatePixels(): ClimatePixels | null;
}

// 並列度の既定の下限・上限。導出は CPU 束縛なので、メインスレッドへ1コア残すところから
// 上は worker ごとのメモリ(気候画素と全球格子)で止める。
const MIN_WORKER_COUNT = 2;
const MAX_WORKER_COUNT = 8;

// worker 数の既定。ハードウェアの論理コア数が読めない環境では控え目に振る。
function defaultWorkerCount(): number {
  const hardware = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.min(MAX_WORKER_COUNT, Math.max(MIN_WORKER_COUNT, hardware - 1));
}

// 本物の worker を CloudGlobalFieldWorkerPort の面へ合わせる。webpack の出力名と
// 対になる固定 URL から組み、DOM の MessageEvent は data へ絞って受け手へ渡す。
class DomWorkerPort implements CloudGlobalFieldWorkerPort {
  private readonly worker = new Worker(
    new URL('cloud-global-field-worker.js', document.baseURI), { type: 'module' });
  public onmessage:
    ((event: { readonly data: CloudGlobalFieldWorkerReply }) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;

  public constructor() {
    this.worker.onmessage = (event) => {
      this.onmessage?.({ data: event.data as CloudGlobalFieldWorkerReply });
    };
    this.worker.onerror = (event) => this.onerror?.(event);
  }

  public postMessage(message: unknown, transfer?: Transferable[]): void {
    if (transfer === undefined) this.worker.postMessage(message);
    else this.worker.postMessage(message, transfer);
  }

  public terminate(): void {
    this.worker.terminate();
  }
}

// 本物の worker を組む既定口。
function defaultWorkerFactory(): CloudGlobalFieldWorkerPort {
  return new DomWorkerPort();
}

// 要求識別子から帯 range の位置と受け手のジョブへ仕分けるための登録。
interface PendingWorkerRequest {
  readonly job: WorkerGlobalFieldJob;
  readonly rangeIndex: number;
}

// 帯分割ジョブ。step は応答の到着を見るだけで、導出本体は worker が進める。
// 全帯の部分結果が揃った時点で帯順に merge して結果を確定する。
class WorkerGlobalFieldJob implements GlobalMassFieldJob {
  private readonly parts: (CloudGlobalFieldSupplyResult | null)[];
  private remainingCount: number;
  private failure: Error | null = null;
  private cancelled = false;
  private resultValue: CloudGlobalFieldSupplyResult | null = null;

  public constructor(
    rangeCount: number,
    private readonly release: (job: WorkerGlobalFieldJob) => void,
  ) {
    this.parts = new Array<CloudGlobalFieldSupplyResult | null>(rangeCount).fill(null);
    this.remainingCount = rangeCount;
  }

  // 予算は使わない — 導出は worker スレッドが進めており、ここは完了判定だけを返す。
  // 帯のいずれかが失敗を返したときは、その失敗をジョブの失敗として投げる。
  public step(_timeBudgetMs: number): { readonly done: boolean } {
    if (this.failure !== null) throw this.failure;
    return { done: this.resultValue !== null || this.cancelled };
  }

  public get result(): CloudGlobalFieldSupplyResult | null {
    return this.resultValue;
  }

  // 途中で放棄する。走っている worker は止めず、遅着する応答は登録を外して捨てる。
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.release(this);
  }

  // 帯 range の1件ぶんの応答を仕分ける。失敗は最初の1件だけを記録する。
  public receive(rangeIndex: number, reply: CloudGlobalFieldWorkerReply): void {
    if (this.cancelled) return;
    if (reply.kind === 'error') {
      this.failure ??= new Error(reply.error);
      this.release(this);
      return;
    }
    if (rangeIndex < 0 || rangeIndex >= this.parts.length) return;
    if (this.parts[rangeIndex] !== null) return;
    this.parts[rangeIndex] = resultFromReply(reply);
    this.remainingCount -= 1;
    if (this.remainingCount === 0) {
      this.resultValue = mergeCloudGlobalFieldSupplyResults(
        this.parts.map((part) => part!));
      this.release(this);
    }
  }
}

// worker の応答を供給結果の形へ戻す。場の寸法は応答が運んだ値をそのまま使う。
function resultFromReply(reply: CloudGlobalFieldWorkerResult): CloudGlobalFieldSupplyResult {
  return {
    field: {
      width: reply.width,
      height: reply.height,
      sphereRadiusM: reply.sphereRadiusM,
      layerEdgesM: reply.layerEdgesM,
      liquidKgM2: reply.liquidKgM2,
      iceKgM2: reply.iceKgM2,
    },
    eventMassKgByPhase: reply.eventMassKgByPhase,
    unassignedMassKgByPhase: reply.unassignedMassKgByPhase,
    eventCount: reply.eventCount,
    truncatedEventCount: reply.truncatedEventCount,
    omittedMassUpperBoundKgM2: reply.omittedMassUpperBoundKgM2,
  };
}

// 表示時刻から全球の質量場を導出する口の、worker 並列版。内側の同期供給は、
// Worker を組めない環境での fallback と、要求へ載せる構築値の持ち主を兼ねる。
export class ConvectiveCloudGlobalFieldWorkerSupply implements GlobalMassFieldSupply {
  private workers: CloudGlobalFieldWorkerPort[] | null = null;
  // worker をこの先も使えないと確かめた記録。生成失敗・実行時の破棄で立て、以後の
  // ジョブは全て同期供給へ落ちる。
  private workersUnavailable = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingWorkerRequest>();
  // 最後に worker へ送った気候画素。供給が読む画像が差し替わると次のジョブで送り直す。
  private sentClimatePixels: ClimatePixels | null = null;
  private climatePixelsSent = false;

  // supply は worker を組めないときの fallback で、要求へ載せる seed・格子・間隔は
  // そこから読む。climateSource は気候画素の遅延供給口、surfaceRadiusM・
  // rotationPeriodSeconds は worker 側で環境源を組む天体の半径 [m] と自転周期 [s]、
  // workerCount は並列度、workerFactory は worker の生成口 — 省略時は本物を組み、
  // Worker の無い環境では常に同期供給へ落ちる。
  public constructor(
    private readonly supply: ConvectiveCloudGlobalFieldSupply,
    private readonly climateSource: CloudGlobalFieldClimateSource,
    private readonly surfaceRadiusM: number,
    private readonly rotationPeriodSeconds: number,
    private readonly workerCount = defaultWorkerCount(),
    private readonly workerFactory: (() => CloudGlobalFieldWorkerPort) | null
      = typeof Worker === 'undefined' ? null : defaultWorkerFactory,
  ) {
    if (!Number.isFinite(surfaceRadiusM) || surfaceRadiusM <= 0) {
      throw new RangeError('surfaceRadiusM must be positive');
    }
    if (!Number.isFinite(rotationPeriodSeconds) || rotationPeriodSeconds <= 0) {
      throw new RangeError('rotationPeriodSeconds must be positive');
    }
    if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
      throw new RangeError('workerCount must be a positive safe integer');
    }
  }

  // 分割して駆動できる導出ジョブを始める。worker 経路が使えない間は同期供給のジョブを返す。
  public startJob(displayTimeSeconds: number): GlobalMassFieldJob {
    if (!Number.isFinite(displayTimeSeconds)) {
      throw new RangeError('displayTimeSeconds must be finite');
    }
    if (this.workerFactory === null || this.workersUnavailable) {
      return this.supply.startJob(displayTimeSeconds);
    }
    return this.startWorkerJob(displayTimeSeconds);
  }

  // worker プールへ帯 range を投げるジョブを始める。帯は globalEventCellBands の
  // 添字で worker 数ぶんの連続 range に切り、帯ごとのセル数が揃うよう累積セル数の
  // 等分点で割る — 赤道帯は極帯よりセルが密なので、帯数の等分では仕事量が偏る。
  private startWorkerJob(displayTimeSeconds: number): GlobalMassFieldJob {
    const workers = this.ensureWorkers();
    if (workers === null) return this.supply.startJob(displayTimeSeconds);
    this.refreshClimatePixels();
    const bands = globalEventCellBands(this.supply.sphereRadiusM, this.supply.eventCellSpacingM);
    const ranges = bandRanges(bands, workers.length);
    const job = new WorkerGlobalFieldJob(ranges.length, (finished) => this.releaseJob(finished));
    for (const [index, worker] of workers.entries()) {
      const id = this.nextRequestId;
      this.nextRequestId += 1;
      this.pendingRequests.set(id, { job, rangeIndex: index });
      const [bandIndexStart, bandIndexEnd] = ranges[index]!;
      worker.postMessage({
        kind: 'derive',
        id,
        displayTimeSeconds,
        bandIndexStart,
        bandIndexEnd,
        seed: this.supply.seed,
        sphereRadiusM: this.supply.sphereRadiusM,
        gridWidth: this.supply.gridWidth,
        gridHeight: this.supply.gridHeight,
        eventCellSpacingM: this.supply.eventCellSpacingM,
      });
    }
    return job;
  }

  // worker プールを初回要求時に組み、各 worker へ気候画素と環境の定数を渡す。
  // 生成に失敗したら使えないと記録して null を返す — 呼び出し側は同期供給へ落ちる。
  private ensureWorkers(): readonly CloudGlobalFieldWorkerPort[] | null {
    if (this.workers !== null) return this.workers;
    if (this.workerFactory === null) return null;
    try {
      const workers: CloudGlobalFieldWorkerPort[] = [];
      for (let index = 0; index < this.workerCount; index += 1) {
        const worker = this.workerFactory();
        worker.onmessage = (event) => this.dispatchReply(event.data);
        worker.onerror = () => this.failAllWorkers();
        workers.push(worker);
      }
      this.workers = workers;
      this.sendClimateInit();
      return workers;
    } catch {
      this.discardWorkers();
      return null;
    }
  }

  // 気候画素を worker 群へ送る。画素がまだ読めないときは null を送り、環境は
  // 緯度近似へ落ちる — 読めるようになったあとのジョブでは取り直して送り直す。
  private sendClimateInit(): void {
    if (this.workers === null) return;
    const pixels = this.climateSource.climatePixels();
    if (this.climatePixelsSent && pixels === this.sentClimatePixels) return;
    this.climatePixelsSent = true;
    this.sentClimatePixels = pixels;
    for (const worker of this.workers) {
      // 画素列は供給が読む画像のバッファと共有しない — 独立した配列へ写してから渡す。
      // 転送はバッファの所有権を移すので、写しは worker ごとに1枚ずつ取る — 同じ
      // バッファを2度転送すると detach 済みとして postMessage が投げる。
      const payload = pixels === null ? null : {
        width: pixels.width,
        height: pixels.height,
        data: new Uint8Array(pixels.data),
      };
      worker.postMessage({
        kind: 'init',
        climatePixels: payload,
        surfaceRadiusM: this.surfaceRadiusM,
        rotationPeriodSeconds: this.rotationPeriodSeconds,
      }, payload === null ? undefined : [payload.data.buffer]);
    }
  }

  // 各ジョブの開始時に気候画素の鮮度を確かめ、差し替わっていれば送り直す。
  private refreshClimatePixels(): void {
    if (this.climateSource.climatePixels() !== this.sentClimatePixels) this.sendClimateInit();
  }

  // worker の応答を要求識別子で仕分ける。登録の無い識別子は破棄済みジョブの遅着応答。
  private dispatchReply(reply: CloudGlobalFieldWorkerReply): void {
    const pending = this.pendingRequests.get(reply.id);
    if (pending === undefined) return;
    pending.job.receive(pending.rangeIndex, reply);
  }

  // 完了・失敗・破棄で受けを終えたジョブの要求を登録から外す。
  private releaseJob(job: WorkerGlobalFieldJob): void {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.job === job) this.pendingRequests.delete(id);
    }
  }

  // worker の実行時失敗で応答不能になったすべての要求へ失敗を届け、プールを畳む。
  private failAllWorkers(): void {
    const jobs = new Set([...this.pendingRequests.values()].map((pending) => pending.job));
    for (const job of jobs) {
      job.receive(-1, { kind: 'error', id: -1, error: 'cloud global field worker crashed' });
    }
    this.pendingRequests.clear();
    this.discardWorkers();
  }

  // worker プールを破棄し、以後のジョブを同期供給へ落とす。
  private discardWorkers(): void {
    for (const worker of this.workers ?? []) worker.terminate();
    this.workers = null;
    this.workersUnavailable = true;
  }
}

// 帯を連続 range(半開区間)へ切る。境界は累積セル数がほぼ等分になる位置へ置く。
function bandRanges(
  bands: readonly { readonly cellCount: number }[], rangeCount: number,
): readonly (readonly [number, number])[] {
  const totalCells = bands.reduce((sum, band) => sum + band.cellCount, 0);
  const ranges: [number, number][] = [];
  let start = 0;
  let cellsBefore = 0;
  for (let index = 0; index < rangeCount; index += 1) {
    // この range が受け持つ累積セル数の上界。最後の range は残り全帯を取る。
    const cellLimit = index === rangeCount - 1
      ? totalCells : Math.round(totalCells * (index + 1) / rangeCount);
    let end = start;
    let cells = cellsBefore;
    while (end < bands.length && cells < cellLimit) {
      cells += bands[end]!.cellCount;
      end += 1;
    }
    ranges.push([start, end]);
    start = end;
    cellsBefore = cells;
  }
  return ranges;
}
