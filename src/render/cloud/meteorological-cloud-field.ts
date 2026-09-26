// 全球の質量場を供給する雲場の出どころ。供給側の分割ジョブを prepare のたびに駆動し、
// 届いた正距円筒の層別・相別質量を凝結して DataTexture へ載せ、cap の置き方へ焼き直して
// 供給する。ジョブが未完の間は前回の場を使い続ける。表示時刻が鮮度の間隔を超えて進むか
// 時刻へ戻ると場を引き直し、短い前進では同じ場を使い回す。
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

// 駆動中の分割ジョブと、それを開始した表示時刻。
interface PendingMassFieldJob {
  readonly job: GlobalMassFieldJob;
  readonly displayTimeSeconds: number;
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
  // 最後に prepare へ渡された表示時刻。
  private preparedTimeSeconds = 0;
  // 届いた質量場の版。凝結してテクスチャへ載せるたびに進む。
  private sourceRevision = 0;
  // 焼いたときの場の版と cap の版。どちらかが変わったときだけ焼き直す。
  private bakedSourceRevision = -1;
  private bakedCapRevision = -1;
  private generationValue = 0;

  // supply は全球質量場の導出元、projection は焼き直す先の cap の持ち方、
  // ownedResource は供給が読む外部資源(気候画像など)で所有権はここへ移る、
  // jobStepTimeBudgetMs は分割ジョブを1回の prepare で進めてよい壁時計の上限 [ms]。
  public constructor(
    private readonly supply: GlobalMassFieldSupply,
    private readonly projection: FieldProjection,
    private readonly ownedResource: { dispose(): void } | null = null,
    private readonly jobStepTimeBudgetMs = 6,
  ) {
    if (!Number.isFinite(jobStepTimeBudgetMs) || jobStepTimeBudgetMs < 0) {
      throw new RangeError('jobStepTimeBudgetMs must be non-negative');
    }
    this.field = new BakedField(
      'meteorologicalCloud', THREE.RGBAFormat, projection,
      (direction) => this.image.sample(equirectUvFromDirection(direction)) as Vec4Node,
      GPU_PASS.cloudBake,
    );
  }

  public get texture(): THREE.Texture { return this.field.texture; }
  public get generation(): number { return this.generationValue; }
  // 最後に prepare へ渡された表示時刻 [s]。一度も呼ばれていない間は 0。
  public get displayTimeSeconds(): number { return this.preparedTimeSeconds; }

  // 供給ジョブを進め、届いた場か cap の置き方が変わっていれば写しを焼き直す。
  public prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink): void {
    this.preparedTimeSeconds = displayTime;
    this.driveSupply(displayTime);
    const capRevision = this.projection.revision;
    if (this.sourceRevision === this.bakedSourceRevision && capRevision === this.bakedCapRevision) {
      return;
    }
    this.bakedSourceRevision = this.sourceRevision;
    this.bakedCapRevision = capRevision;
    this.field.render(renderer, gpu);
    this.generationValue += 1;
  }

  // 供給ジョブ・正距円筒テクスチャ・cap の写し・供給の外部資源を解放する。
  public dispose(): void {
    this.pending?.job.cancel?.();
    this.pending = null;
    this.map?.dispose();
    this.field.dispose();
    this.ownedResource?.dispose();
  }

  // 表示時刻の場を出すジョブを駆動する。時刻がジョブの時刻を下回って戻ったら、未来の
  // 天気を描かないよう走っているジョブは破棄して新しい時刻のジョブを始める。前進は
  // 走っているジョブをそのまま完成まで駆動し、場の鮮度が RESUPPLY_INTERVAL_SECONDS を
  // 超えたときだけ引き直す — 毎フレームの微細な前進で破棄し続けるとジョブが一生
  // 完成しない。同じ時刻では開始したジョブを使い回し、完了したら凝結して版を進める。
  private driveSupply(displayTimeSeconds: number): void {
    const pending = this.pending;
    if (pending !== null && displayTimeSeconds < pending.displayTimeSeconds) {
      pending.job.cancel?.();
      this.pending = null;
    }
    if (this.pending === null) {
      const fresh = this.fieldTimeSeconds !== null
        && this.fieldTimeSeconds <= displayTimeSeconds
        && displayTimeSeconds - this.fieldTimeSeconds < RESUPPLY_INTERVAL_SECONDS;
      if (fresh || displayTimeSeconds === this.lastJobTimeSeconds) return;
      this.lastJobTimeSeconds = displayTimeSeconds;
      this.pending = {
        job: this.supply.startJob(displayTimeSeconds),
        displayTimeSeconds,
      };
    }
    const running = this.pending;
    let done: boolean;
    try {
      done = running.job.step(this.jobStepTimeBudgetMs).done;
    } catch (error) {
      // 投げたジョブは中途状態なので畳む。lastJobTimeSeconds は記録済みなので、
      // 同じ時刻では再開始しない。
      running.job.cancel?.();
      this.pending = null;
      throw error;
    }
    if (!done) return;
    this.pending = null;
    this.adoptResult(running);
  }

  // 完了したジョブの結果を凝結してテクスチャへ載せ、場の版を進める。届かなかった
  // (null)ときは現行の場とその時刻を保つ。契約を外れた場はそのまま投げる — 同じ時刻
  // では再導出しないので失敗は1回きりである。
  private adoptResult(pending: PendingMassFieldJob): void {
    const result = pending.job.result;
    if (result === null) return;
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
  }
}
