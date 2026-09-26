// 対流イベントから局所光学場を導出する供給源。中心方向のまわりへ決定論的に置いたイベント
// セルへ、セル位置の環境プロファイルから導いた供給率・期間・氷放出高を与え、
// 出生 → 輸送 → 堆積 → 消散のチェーンで CloudOpticalVolumeData とそれを張る frame を組む。
// 環境はセル位置ごとに environmentAt から引くので、場の中で湿った対流域と乾いた領域が
// 混在する。下流への地形応答はここでは扱わない。導出は一括の同期 derive と、
// step で分割して進めるジョブの両方を出す。

import { mulberry32 } from '../../math/random';
import { AtmosphericWindField } from '../../render/cloud/atmospheric-wind';
import {
  cloudLocalDirectionAt, validateCloudLocalFieldFrame,
} from '../../render/cloud/cloud-local-field';
import { sampleConvectiveCloudEvents } from './cloud-events';
import { deriveCloudEventAreas } from './cloud-event-area-closure';
import {
  cloudEventWindAt, reconstructCloudEventMaterialCohorts,
} from './cloud-event-transport';
import { depositCloudEventMaterialCohorts } from './cloud-event-local-deposition';
import { cloudEquirectTangentBasisAt } from './cloud-equirect-grid';
import {
  CLOUD_MASS_LAYER_EDGES_M, CONVECTIVE_POTENTIAL_MIN, CONVECTIVE_POTENTIAL_RANGE,
  convectiveCellSupplyValues,
} from './convective-cell-supply';
import { extinctionFromCloudMass } from './cloud-mass-extinction';
import {
  cloudGravityWaveFieldFromEnvironment, displaceCloudMassByWave,
} from './cloud-wave-displacement';
import { cloudOpticalVolumeFrameFromExtinction } from './cloud-optical-volume-frame';
import type { Vec3 } from '../../math/vec3';
import type {
  CloudLocalFieldFrame, CloudLocalFieldJob, CloudLocalFieldSupply,
  CloudLocalFieldSupplyResult,
} from '../../render/cloud/cloud-local-field';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { ConvectiveCloudCell, ConvectiveCloudEvent } from './cloud-events';
import type { CloudEventWindAt, CloudEventMaterialCohorts } from './cloud-event-transport';
import type { CloudEventAreas } from './cloud-event-area-closure';
import type { CloudEventTangentChart } from './cloud-event-local-deposition';
import type { CloudFootprintGrid } from './cloud-footprint-overlap';
import type {
  CloudMassDeposition, CloudMassGrid, CloudMassLayerColumns,
} from './cloud-mass-deposition';
import type { CloudExtinctionLayer, CloudLayerMicrophysics } from './cloud-mass-extinction';

// 場の一辺 [texel] と、中心のまわりに東西・南北へ張る幅 [m]。
export const CONVECTIVE_LOCAL_FIELD_SPAN_M = 500e3;
const GRID_SIZE = 256;
const CELL_SIZE_M = CONVECTIVE_LOCAL_FIELD_SPAN_M / GRID_SIZE;
// 中心のまわりへ置くイベントセルの数と間隔。間隔の半対角は格子の半対角より小さく保つ。
const EVENT_CELL_COUNT = 9;
const EVENT_CELL_SPACING_M = 50e3;
// 堆積 chart の有効角距離 [rad]。輸送された材料が格子の外へ出ても、はみ出た質量は
// unassigned へ積まれて保存されるよう、格子よりはるかに広く取る。frame 側の有効角距離は
// 格子の半対角だけなので、読み手には格子域だけが見える。
const DEPOSITION_MAX_ANGULAR_RAD = 1.0;
const BIRTH_INTERVAL_SECONDS = 86_400;
const HISTORY_HORIZON_SECONDS = 86_400;
const MAX_EVENT_COUNT = 256;
const MAX_OMITTED_MASS_KG_M2 = 0.01;
const TRANSPORT_STEP_SECONDS = 300;
const ICE_COHORT_COUNT = 8;

// 高度層の微物理。液水・氷の有効粒径と氷の消散効率は層で分けず一定 — 粒径の高度依存は
// 質量収支とは独立に後から層別へ変えられる。
const LAYER_MICROPHYSICS: readonly CloudLayerMicrophysics[] =
  CLOUD_MASS_LAYER_EDGES_M.slice(0, -1).map(() => ({
    liquidEffectiveRadiusM: 10e-6,
    iceEffectiveRadiusM: 30e-6,
    iceExtinctionEfficiency: 2,
  }));

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requireUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(Math.hypot(vector.x, vector.y, vector.z) - 1) > 1e-10) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

// 単位方向からその地点の環境プロファイルを引く口。供給側はセル・イベントの位置ごとに
// 呼ぶので、実装側は方向から決定的にプロファイルを返す純関数であること。
export type CloudEnvironmentAt = (direction: Vec3) => CloudEnvironmentProfile;

// イベント1件分の堆積結果を、格子へ加算する形で畳み込む。個々の堆積は格子域の外の質量を
// unassigned として保存するので、畳み込み側もそれを累計して返す。
function accumulateDeposition(
  deposition: CloudMassDeposition,
  liquidKgM2ByLayer: number[][],
  iceKgM2ByLayer: number[][],
  unassignedMassKgByPhase: { liquid: number; ice: number },
): void {
  for (const [layerIndex, layer] of deposition.columnsByLayer.entries()) {
    const liquidCells = liquidKgM2ByLayer[layerIndex]!;
    const iceCells = iceKgM2ByLayer[layerIndex]!;
    for (let cellIndex = 0; cellIndex < layer.liquidKgM2ByCell.length; cellIndex += 1) {
      liquidCells[cellIndex]! += layer.liquidKgM2ByCell[cellIndex]!;
      iceCells[cellIndex]! += layer.iceKgM2ByCell[cellIndex]!;
    }
  }
  unassignedMassKgByPhase.liquid += deposition.unassignedMassKgByPhase.liquid;
  unassignedMassKgByPhase.ice += deposition.unassignedMassKgByPhase.ice;
}

// 表示時刻 displayTimeSeconds [s] の、中心方向のまわりの局所光学場を導出する。セルの
// 対流ポテンシャルに加え、供給系の値もセル位置の環境プロファイルから導く。
export class ConvectiveCloudLocalFieldSupply implements CloudLocalFieldSupply {
  private readonly windField = new AtmosphericWindField();

  // environmentAt はイベントの供給系を決める環境プロファイルを方向から引く口、seed は
  // セルのポテンシャルとイベント出生の決定論を与える種、sphereRadiusM は場を張る球の半径 [m]。
  public constructor(
    private readonly environmentAt: CloudEnvironmentAt,
    private readonly seed: number,
    private readonly sphereRadiusM: number,
  ) {
    requireFinite(seed, 'seed');
    requireFinite(sphereRadiusM, 'sphereRadiusM');
    if (sphereRadiusM <= 0) throw new RangeError('sphereRadiusM must be positive');
    if (typeof environmentAt !== 'function') {
      throw new TypeError('environmentAt must be a function');
    }
  }

  // 同期の一括導出。ジョブを制限なしで駆動したものと同じ結果を返す。
  public derive(
    displayTimeSeconds: number, centerDirection: Vec3,
  ): CloudLocalFieldSupplyResult | null {
    const job = this.startJob(displayTimeSeconds, centerDirection);
    job.step(Number.POSITIVE_INFINITY);
    return job.result;
  }

  // 分割して駆動できる導出ジョブを始める。
  public startJob(
    displayTimeSeconds: number, centerDirection: Vec3,
  ): CloudLocalFieldJob {
    requireFinite(displayTimeSeconds, 'displayTimeSeconds');
    requireUnitVector(centerDirection, 'centerDirection');
    const frame = this.frame(centerDirection);
    validateCloudLocalFieldFrame(frame);
    return new ConvectiveCloudLocalFieldJob(
      frame, displayTimeSeconds, this.environmentAt, this.seed, this.sphereRadiusM,
      this.windField);
  }

  // 場を張る frame。格子は中心のまわりに正方形で、有効角距離は格子の半対角まで届く。
  private frame(centerDirection: Vec3): CloudLocalFieldFrame {
    const { eastUnitVector, northUnitVector } = cloudEquirectTangentBasisAt(centerDirection);
    return {
      centerDirection,
      eastDirection: eastUnitVector,
      northDirection: northUnitVector,
      sphereRadiusM: this.sphereRadiusM,
      gridOriginEastM: -CONVECTIVE_LOCAL_FIELD_SPAN_M / 2,
      gridOriginNorthM: -CONVECTIVE_LOCAL_FIELD_SPAN_M / 2,
      cellWidthM: CELL_SIZE_M,
      cellHeightM: CELL_SIZE_M,
      gridWidth: GRID_SIZE,
      gridHeight: GRID_SIZE,
      maxAngularDistanceRad: Math.hypot(
        CONVECTIVE_LOCAL_FIELD_SPAN_M / 2, CONVECTIVE_LOCAL_FIELD_SPAN_M / 2)
        / this.sphereRadiusM,
      layerEdgesM: CLOUD_MASS_LAYER_EDGES_M,
    };
  }
}

// 導出ジョブの段階。cells / deposit は反復を1要素ずつ、残りは段階全体を1単位で進める。
type ConvectiveLocalFieldStage =
  | 'cells' | 'events' | 'deposit' | 'merge' | 'wave' | 'extinction' | 'volume' | 'done';

// 堆積段階の進行状態。格子・chart・風は段階のあいだ変わらない固定入力、層別の質量配列と
// unassigned はイベントごとに累積される。
interface LocalFieldDepositionState {
  readonly footprintGrid: CloudFootprintGrid;
  readonly massGrid: CloudMassGrid;
  readonly chart: CloudEventTangentChart;
  readonly windAt: CloudEventWindAt;
  readonly liquidKgM2ByLayer: number[][];
  readonly iceKgM2ByLayer: number[][];
  readonly unassignedMassKgByPhase: { liquid: number; ice: number };
}

// 対流イベントから局所光学場を組む分割導出。段階の境界と反復の1要素で壁時計の予算を
// 見て中断し、呼ばれるたびに続きを進める。done が立つまで result は null。
class ConvectiveCloudLocalFieldJob implements CloudLocalFieldJob {
  private stage: ConvectiveLocalFieldStage = 'cells';
  private resultValue: CloudLocalFieldSupplyResult | null = null;
  private readonly cells: ConvectiveCloudCell[] = [];
  private cellIndex = 0;
  private events: readonly ConvectiveCloudEvent[] = [];
  private eventIndex = 0;
  // 進行中イベントの中間結果。堆積の1イベントを「輸送の復元」「面積の導出」「堆積と累積」の
  // 3単位に分ける — まとめて1単位にすると1イベントの費用がそのまま1駆動の床になる。
  private eventMaterial: CloudEventMaterialCohorts | null = null;
  private eventAreas: CloudEventAreas | null = null;
  private deposition: LocalFieldDepositionState | null = null;
  private merged: CloudMassDeposition | null = null;
  private displaced: CloudMassDeposition | null = null;
  private extinction: readonly CloudExtinctionLayer[] | null = null;

  public constructor(
    private readonly frame: CloudLocalFieldFrame,
    private readonly displayTimeSeconds: number,
    private readonly environmentAt: CloudEnvironmentAt,
    private readonly seed: number,
    private readonly sphereRadiusM: number,
    private readonly windField: AtmosphericWindField,
  ) {}

  public get result(): CloudLocalFieldSupplyResult | null {
    return this.resultValue;
  }

  // 予算には Infinity を渡せる — 締切が無限大になり完了まで一度に進む。
  public step(timeBudgetMs: number): { readonly done: boolean } {
    if (typeof timeBudgetMs !== 'number' || Number.isNaN(timeBudgetMs)) {
      throw new RangeError('timeBudgetMs must be a number');
    }
    const deadline = performance.now() + Math.max(0, timeBudgetMs);
    while (this.stage !== 'done') {
      switch (this.stage) {
        case 'cells': this.stepCell(); break;
        case 'events': this.stepEventSampling(); break;
        case 'deposit': this.stepDeposit(); break;
        case 'merge': this.stepMerge(); break;
        case 'wave': this.stepWave(); break;
        case 'extinction': this.stepExtinction(); break;
        case 'volume': this.stepVolume(); break;
      }
      if (performance.now() >= deadline) break;
    }
    return { done: this.stage === 'done' };
  }

  // イベントセルを1件導く。位置は frame の接平面座標から log-map で引き、
  // 供給系の値はそのセル位置の環境プロファイルから導く。
  private stepCell(): void {
    const index = this.cellIndex;
    const i = Math.floor(index / EVENT_CELL_COUNT);
    const j = index % EVENT_CELL_COUNT;
    const half = (EVENT_CELL_COUNT - 1) / 2;
    const direction = cloudLocalDirectionAt(
      (i - half) * EVENT_CELL_SPACING_M, (j - half) * EVENT_CELL_SPACING_M, this.frame);
    const values = convectiveCellSupplyValues(this.environmentAt(direction));
    this.cells.push({
      id: `local-${i}-${j}`,
      supplySourceId: `local-source-${i}-${j}`,
      convectivePotential: CONVECTIVE_POTENTIAL_MIN
        + CONVECTIVE_POTENTIAL_RANGE
          * mulberry32((this.seed ^ Math.imul(i + 1, 0x9e3779b1)
            ^ Math.imul(j + 1, 0x85ebca6b)) >>> 0)(),
      upperRelativeHumidity: values.upperRelativeHumidity,
      liquidSupplyRateKgM2S: values.liquidSupplyRateKgM2S,
      convectiveDurationSeconds: values.convectiveDurationSeconds,
      sourcePosition: {
        directionUnitVector: direction,
        geometricHeightM: values.sourceHeightM,
      },
      iceReleaseHeightM: values.iceReleaseHeightM,
    });
    this.cellIndex = index + 1;
    if (this.cellIndex >= EVENT_CELL_COUNT * EVENT_CELL_COUNT) this.stage = 'events';
  }

  // セル群から表示時刻のイベント履歴を復元する。
  private stepEventSampling(): void {
    this.events = sampleConvectiveCloudEvents({
      seed: this.seed,
      birthIntervalSeconds: BIRTH_INTERVAL_SECONDS,
      historyHorizonSeconds: HISTORY_HORIZON_SECONDS,
      maximumOmittedMassKgM2: MAX_OMITTED_MASS_KG_M2,
      maxEventCount: MAX_EVENT_COUNT,
      timeSeconds: this.displayTimeSeconds,
      cells: this.cells,
    }).events;
    this.stage = 'deposit';
  }

  // イベントの堆積を1単位ずつ進める。輸送の復元 → 面積の導出 → 堆積と累積の3単位で
  // 1イベントぶん。呼ばれるたびに進捗の続きから始める。
  private stepDeposit(): void {
    const work = this.deposition ??= this.startDeposition();
    if (this.eventIndex >= this.events.length) {
      this.stage = 'merge';
      return;
    }
    const event = this.events[this.eventIndex]!;
    if (this.eventMaterial === null) {
      this.eventMaterial = reconstructCloudEventMaterialCohorts(
        event, this.sphereRadiusM, TRANSPORT_STEP_SECONDS, work.windAt, ICE_COHORT_COUNT);
      return;
    }
    if (this.eventAreas === null) {
      // 面積は環境・輸送から導く閉包。環境はイベントの源位置のものを引く — セルは必ず
      // 源位置を持って建てている。
      this.eventAreas = deriveCloudEventAreas(
        event, this.eventMaterial,
        this.environmentAt(event.sourcePosition!.directionUnitVector), work.windAt,
        CELL_SIZE_M * CELL_SIZE_M,
        CONVECTIVE_LOCAL_FIELD_SPAN_M * CONVECTIVE_LOCAL_FIELD_SPAN_M);
      return;
    }
    const deposition = depositCloudEventMaterialCohorts(
      this.eventMaterial, this.eventAreas.sourceAreaM2, this.eventAreas.footprints,
      work.chart, work.footprintGrid, work.massGrid);
    accumulateDeposition(
      deposition, work.liquidKgM2ByLayer, work.iceKgM2ByLayer, work.unassignedMassKgByPhase);
    this.eventMaterial = null;
    this.eventAreas = null;
    this.eventIndex += 1;
    if (this.eventIndex >= this.events.length) this.stage = 'merge';
  }

  // 堆積段階の固定入力と累積器を組む。
  private startDeposition(): LocalFieldDepositionState {
    const cellCount = GRID_SIZE * GRID_SIZE;
    return {
      footprintGrid: {
        originEastM: this.frame.gridOriginEastM,
        originNorthM: this.frame.gridOriginNorthM,
        cellWidthM: this.frame.cellWidthM,
        cellHeightM: this.frame.cellHeightM,
        width: GRID_SIZE,
        height: GRID_SIZE,
      },
      massGrid: {
        cells: Array.from({ length: cellCount }, () => ({ areaM2: CELL_SIZE_M * CELL_SIZE_M })),
        layerEdgesM: CLOUD_MASS_LAYER_EDGES_M,
      },
      chart: {
        centerDirectionUnitVector: this.frame.centerDirection,
        eastUnitVector: this.frame.eastDirection,
        northUnitVector: this.frame.northDirection,
        sphereRadiusM: this.sphereRadiusM,
        maxAngularDistanceRad: DEPOSITION_MAX_ANGULAR_RAD,
      },
      windAt: cloudEventWindAt(this.windField),
      liquidKgM2ByLayer:
        CLOUD_MASS_LAYER_EDGES_M.slice(0, -1).map(() => new Array<number>(cellCount).fill(0)),
      iceKgM2ByLayer:
        CLOUD_MASS_LAYER_EDGES_M.slice(0, -1).map(() => new Array<number>(cellCount).fill(0)),
      unassignedMassKgByPhase: { liquid: 0, ice: 0 },
    };
  }

  // 累積した層別質量を堆積の形へ束ねる。
  private stepMerge(): void {
    const work = this.deposition!;
    const columnsByLayer: CloudMassLayerColumns[] = CLOUD_MASS_LAYER_EDGES_M.slice(0, -1).map(
      (lowerAltitudeM, layerIndex) => ({
        lowerAltitudeM,
        upperAltitudeM: CLOUD_MASS_LAYER_EDGES_M[layerIndex + 1]!,
        liquidKgM2ByCell: work.liquidKgM2ByLayer[layerIndex]!,
        iceKgM2ByCell: work.iceKgM2ByLayer[layerIndex]!,
      }),
    );
    this.merged = { columnsByLayer, unassignedMassKgByPhase: work.unassignedMassKgByPhase };
    this.stage = 'wave';
  }

  // 場中心の環境が波源を持ち凝結まで届くときだけ、堆積済みの層別質量を波の位相で
  // 鉛直に畳み直す。波の伝播は環境が導いた位相速度だけで決まり、輸送に使った物質風
  // とは独立 — 波状雲で雲の流れと波の伝播が一致しないことを、この変位が風の情報を
  // 持たないことで保つ。場の幅で環境は緩やかに変わるとして、波場は中心の環境で代表する。
  private stepWave(): void {
    const merged = this.merged!;
    const waveField = cloudGravityWaveFieldFromEnvironment(
      this.environmentAt(this.frame.centerDirection));
    this.displaced = waveField === null
      ? merged
      : displaceCloudMassByWave(
        merged, waveField, this.deposition!.footprintGrid, this.displayTimeSeconds);
    this.stage = 'extinction';
  }

  // 層別質量を微物理から消散係数へ換算する。
  private stepExtinction(): void {
    this.extinction = extinctionFromCloudMass(this.displaced!, LAYER_MICROPHYSICS);
    this.stage = 'volume';
  }

  // 消散をテクスチャへ焼く形へ並べ替えて結果を確定する。
  private stepVolume(): void {
    this.resultValue = {
      frame: this.frame,
      data: cloudOpticalVolumeFrameFromExtinction(
        GRID_SIZE, GRID_SIZE, this.frame.layerEdgesM, this.extinction!),
    };
    this.stage = 'done';
  }
}
