// 全球の質量場を供給する雲場の出どころ。供給側の分割ジョブを prepare のたびに駆動し、
// 届いた正距円筒の層別・相別質量を凝結して DataTexture へ載せ、cap の置き方へ焼き直して
// 供給する。ジョブが未完の間は前回の場を使い続ける。表示時刻が鮮度の間隔を超えて進むか
// 時刻へ戻ると場を引き直し、短い前進では同じ場を使い回す。ロード中などフレーム外の隙間から
// 前倒しでジョブを進める口(drivePendingJobs)と、ジョブの進行を記録した計測口(fieldStats)を持つ。
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { BakedField } from '../baked-field';
import { GPU_PASS } from '../gpu-timings';
import { equirectUvFromDirection, type FieldProjection } from '../field-projection';
import { condenseGlobalMassField } from './cloud-global-condensation';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { CloudFieldSource } from './cloud-presentation';
import type { GlobalMassFieldJob, GlobalMassFieldSupply } from './global-mass-field';
import type { Vec4Node } from '../tsl-types';

// 同じ場を使い回せる表示時刻の前進幅 [s]。全球格子1セルの幅(数百 km)を典型の風が
// 横切る時定数より十分小さいので、これより短い前進で場を引き直しても雲の配置は
// セル未満にしか動かない。
const RESUPPLY_INTERVAL_SECONDS = 600;
// 外部入力(気候画像など)が読めるようになるのを待つ上限 [ms]。小さい画像なので通常は
// 数百 ms で届くが、届かないまま永遠に待たない。超えたら緯度近似へ落ちる入力のまま進める。
const INPUT_WAIT_LIMIT_MS = 1_500;
// 保持する試行記録の上限。計測が読むのは直近だけなので、ランの長さで際限なく育たせない。
const FIELD_ATTEMPT_LIMIT = 16;

// 駆動中の分割ジョブと、それを開始した表示時刻・計測の途中経過。
interface PendingMassFieldJob {
  readonly job: GlobalMassFieldJob;
  readonly displayTimeSeconds: number;
  // ジョブを開始した実時刻 [ms]。開始から採用までの壁時計を読むために記録する。
  readonly startedAtMs: number;
  stepCount: number;
  // step の中で使った CPU の合計 [ms]。
  deriveMs: number;
}

// 供給ジョブ1件ぶんの記録。adopted は結果の場を採用したか(空の結果・途中破棄・
// 途中失敗は偽)。wallMs は開始から完了・破棄までの壁時計、deriveMs は step が使った
// CPU の合計 [ms]。
export interface MeteorologicalFieldAttempt {
  readonly sequence: number;
  readonly displayTimeSeconds: number;
  readonly wallMs: number;
  readonly deriveMs: number;
  readonly stepCount: number;
  readonly adopted: boolean;
}

// 計測の読み出し形。hasField は1度でも場を採用したか — 雲が描けるようになった印。
// pending は駆動中のジョブの途中経過。
export interface MeteorologicalFieldStats {
  readonly hasField: boolean;
  readonly generation: number;
  readonly attempts: readonly MeteorologicalFieldAttempt[];
  readonly pending: {
    readonly displayTimeSeconds: number;
    readonly startedAtMs: number;
    readonly stepCount: number;
    readonly deriveMs: number;
  } | null;
}

export class MeteorologicalCloudField implements CloudFieldSource {
  // 最後に届いた場を載せた正距円筒テクスチャ。届くまでは空の場を読む。
  private map: THREE.DataTexture | null = null;
  private readonly image = texture(EMPTY_CLOUD_FIELD);
  private readonly field: BakedField;
  // 駆動中の分割ジョブ。完成・破棄するまで現行の場を差し替えない。
  private pending: PendingMassFieldJob | null = null;
  // いま読める場を導出した表示時刻。まだ1度も届いていない間は null。
  private fieldTimeSeconds: number | null = null;
  // 最後にジョブを開始した表示時刻。完成・失敗のどちらでも記録され、同じ時刻では
  // 再導出しない — 届かない時刻で毎フレーム燃え続けないようにする。
  private lastJobTimeSeconds: number | null = null;
  // 最後に供給へ向けた表示時刻。prepare と drivePendingJobs のどちらでも記録する。
  private preparedTimeSeconds = 0;
  // 外部入力が読めないことを初めて見た実時刻 [ms]。待つ上限の起算点。
  private inputWaitStartedAtMs: number | null = null;
  // 届いた質量場の版。凝結してテクスチャへ載せるたびに進む。
  private sourceRevision = 0;
  // 焼いたときの場の版と cap の版。どちらかが変わったときだけ焼き直す。
  private bakedSourceRevision = -1;
  private bakedCapRevision = -1;
  private generationValue = 0;
  // 直近の試行記録(古い順)と、その通し番号。
  private readonly attempts: MeteorologicalFieldAttempt[] = [];
  private attemptSequence = 0;

  // supply は全球質量場の導出元、projection は焼き直す先の cap の持ち方、
  // ownedResource は供給が読む外部資源(気候画像など)で所有権はここへ移る。
  // cpuReadable を持つ資源は、CPU から読めるようになるまで最初のジョブの開始を遅らせる。
  // jobStepTimeBudgetMs は分割ジョブを1回の駆動で進めてよい壁時計の上限 [ms]、
  // startupStepTimeBudgetMs は最初の場が届くまでの間だけ使う上限、
  // inputWaitLimitMs は外部入力を待つ上限 [ms]。
  public constructor(
    private readonly supply: GlobalMassFieldSupply,
    private readonly projection: FieldProjection,
    private readonly ownedResource: { dispose(): void; cpuReadable?(): boolean } | null = null,
    private readonly jobStepTimeBudgetMs = 6,
    private readonly startupStepTimeBudgetMs = 16,
    private readonly inputWaitLimitMs = INPUT_WAIT_LIMIT_MS,
  ) {
    if (!Number.isFinite(jobStepTimeBudgetMs) || jobStepTimeBudgetMs < 0) {
      throw new RangeError('jobStepTimeBudgetMs must be non-negative');
    }
    if (!Number.isFinite(startupStepTimeBudgetMs) || startupStepTimeBudgetMs < 0) {
      throw new RangeError('startupStepTimeBudgetMs must be non-negative');
    }
    if (!Number.isFinite(inputWaitLimitMs) || inputWaitLimitMs < 0) {
      throw new RangeError('inputWaitLimitMs must be non-negative');
    }
    this.field = new BakedField(
      'meteorologicalCloud', THREE.RGBAFormat, projection,
      (direction) => this.image.sample(equirectUvFromDirection(direction)) as Vec4Node,
      GPU_PASS.cloudBake,
    );
  }

  public get texture(): THREE.Texture { return this.field.texture; }
  public get generation(): number { return this.generationValue; }
  // 最後に供給へ向けた表示時刻 [s]。一度も駆動されていない間は 0。
  public get displayTimeSeconds(): number { return this.preparedTimeSeconds; }

  // 供給ジョブの計測口。直近の試行記録と、駆動中ならその途中経過を返す。
  // 読み出しは状態を変えない。
  public get fieldStats(): MeteorologicalFieldStats {
    return {
      hasField: this.fieldTimeSeconds !== null,
      generation: this.generationValue,
      attempts: [...this.attempts],
      pending: this.pending === null ? null : {
        displayTimeSeconds: this.pending.displayTimeSeconds,
        startedAtMs: this.pending.startedAtMs,
        stepCount: this.pending.stepCount,
        deriveMs: this.pending.deriveMs,
      },
    };
  }

  // 供給ジョブを進め、届いた場か cap の置き方が変わっていれば写しを焼き直す。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    this.advance(renderer, displayTime, this.stepTimeBudgetMs, gpu);
  }

  // フレーム外の隙間から、供給ジョブを timeBudgetMs [ms] ぶん前倒しで進める。
  // ジョブが無くて再供給の条件も無ければ何もしない。届いた場はその場で焼き直す。
  public drivePendingJobs(
    renderer: WebGPURenderer, displayTime: number, timeBudgetMs: number, gpu?: GpuTimingSink,
  ): void {
    this.advance(renderer, displayTime, timeBudgetMs, gpu);
  }

  // 供給ジョブ・正距円筒テクスチャ・cap の写し・供給の外部資源を解放する。
  public dispose(): void {
    this.pending?.job.cancel?.();
    this.pending = null;
    this.map?.dispose();
    this.field.dispose();
    this.ownedResource?.dispose();
  }

  // 表示時刻へ供給を stepBudgetMs ぶん駆動し、届いた場か cap の置き方が変わっていれば焼き直す。
  private advance(
    renderer: WebGPURenderer, displayTimeSeconds: number, stepBudgetMs: number, gpu?: GpuTimingSink,
  ): void {
    this.preparedTimeSeconds = displayTimeSeconds;
    this.driveSupply(displayTimeSeconds, stepBudgetMs);
    const capRevision = this.projection.revision;
    if (this.sourceRevision === this.bakedSourceRevision && capRevision === this.bakedCapRevision) {
      return;
    }
    this.bakedSourceRevision = this.sourceRevision;
    this.bakedCapRevision = capRevision;
    this.field.render(renderer, gpu);
    this.generationValue += 1;
  }

  // 1回の駆動でジョブを進めてよい予算 [ms]。最初の場が届くまでは起動のバースト予算で
  // 大きく進め、届いたら既定へ戻す。
  private get stepTimeBudgetMs(): number {
    return this.fieldTimeSeconds === null
      ? this.startupStepTimeBudgetMs
      : this.jobStepTimeBudgetMs;
  }

  // 外部入力が CPU から読めるか。読み口を持たない資源は常に真。読めない間は
  // 緯度近似と実気候の混在する場を採らないよう開始を遅らせるが、上限を超えたら
  // 未着のまま進める。
  private inputsReady(): boolean {
    const readiness = this.ownedResource;
    if (readiness?.cpuReadable === undefined || readiness.cpuReadable()) return true;
    if (this.inputWaitStartedAtMs === null) this.inputWaitStartedAtMs = performance.now();
    return performance.now() - this.inputWaitStartedAtMs >= this.inputWaitLimitMs;
  }

  // 表示時刻の場を出すジョブを stepBudgetMs ぶん駆動する。時刻がジョブの時刻を下回って
  // 戻ったら、未来の天気を描かないよう走っているジョブは破棄して新しい時刻のジョブを始める。
  // 前進は走っているジョブをそのまま完成まで駆動し、場の鮮度が RESUPPLY_INTERVAL_SECONDS を
  // 超えたときだけ引き直す — 毎フレームの微細な前進で破棄し続けるとジョブが一生
  // 完成しない。同じ時刻では開始したジョブを使い回し、完了したら凝結して版を進める。
  private driveSupply(displayTimeSeconds: number, stepBudgetMs: number): void {
    const pending = this.pending;
    if (pending !== null && displayTimeSeconds < pending.displayTimeSeconds) {
      pending.job.cancel?.();
      this.recordAttempt(pending, false);
      this.pending = null;
    }
    if (this.pending === null) {
      const fresh = this.fieldTimeSeconds !== null
        && this.fieldTimeSeconds <= displayTimeSeconds
        && displayTimeSeconds - this.fieldTimeSeconds < RESUPPLY_INTERVAL_SECONDS;
      if (fresh || displayTimeSeconds === this.lastJobTimeSeconds) return;
      // 最初の場を採るまでは、外部入力が読めるようになるまで開始を遅らせる。
      if (this.fieldTimeSeconds === null && !this.inputsReady()) return;
      this.lastJobTimeSeconds = displayTimeSeconds;
      this.pending = {
        job: this.supply.startJob(displayTimeSeconds),
        displayTimeSeconds,
        startedAtMs: performance.now(),
        stepCount: 0,
        deriveMs: 0,
      };
    }
    const running = this.pending;
    const stepStartedAt = performance.now();
    let done: boolean;
    try {
      done = running.job.step(stepBudgetMs).done;
    } catch (error) {
      // 投げたジョブは中途状態なので畳む。lastJobTimeSeconds は記録済みなので、
      // 同じ時刻では再開始しない。
      running.deriveMs += performance.now() - stepStartedAt;
      running.stepCount += 1;
      running.job.cancel?.();
      this.recordAttempt(running, false);
      this.pending = null;
      throw error;
    }
    const elapsed = performance.now() - stepStartedAt;
    running.deriveMs += elapsed;
    running.stepCount += 1;
    if (!done) return;
    this.pending = null;
    this.adoptResult(running);
  }

  // 完了したジョブの結果を凝結してテクスチャへ載せ、場の版を進める。届かなかった
  // (null)ときは現行の場とその時刻を保つ。契約を外れた場はそのまま投げる — 同じ時刻
  // では再導出しないので失敗は1回きりである。
  private adoptResult(pending: PendingMassFieldJob): void {
    const result = pending.job.result;
    if (result === null) {
      this.recordAttempt(pending, false);
      return;
    }
    const field = result.field;
    const texels = condenseGlobalMassField(field);
    const bytes = Uint8ClampedArray.from(texels, (v) => v * 255);
    const current = this.map;
    if (current !== null
      && current.image.width === field.width && current.image.height === field.height) {
      (current.image.data as Uint8ClampedArray).set(bytes);
      current.needsUpdate = true;
    } else {
      const map = new THREE.DataTexture(
        bytes, field.width, field.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      map.name = 'meteorologicalCloudGlobal';
      // 経度は周期的なので、画像は経度方向へ巻く。
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.ClampToEdgeWrapping;
      map.minFilter = THREE.LinearFilter;
      map.magFilter = THREE.LinearFilter;
      map.needsUpdate = true;
      current?.dispose();
      this.map = map;
      this.image.value = map;
    }
    this.fieldTimeSeconds = pending.displayTimeSeconds;
    this.sourceRevision += 1;
    this.recordAttempt(pending, true);
  }

  // 1件ぶんの試行記録を積む。
  private recordAttempt(pending: PendingMassFieldJob, adopted: boolean): void {
    this.attempts.push({
      sequence: this.attemptSequence,
      displayTimeSeconds: pending.displayTimeSeconds,
      wallMs: performance.now() - pending.startedAtMs,
      deriveMs: pending.deriveMs,
      stepCount: pending.stepCount,
      adopted,
    });
    this.attemptSequence += 1;
    if (this.attempts.length > FIELD_ATTEMPT_LIMIT) this.attempts.shift();
  }
}
