// 全球の対流イベント履歴から、正距円筒格子の層別・相別質量場を導出する供給源。
// 緯度帯ごとに経度分割数を変えた準等面積のイベントセルを全球へ張り、セル位置の環境
// プロファイルから供給系の値を導いてイベントを標本し、輸送 → 面積導出 → equirect
// 堆積のチェーンで列質量を積算する。導出は表示時刻と seed だけで決まる決定的な
// surrogate で、一括の同期 derive と step で分割して進めるジョブの両方を出す。

import { mulberry32 } from '../../math/random';
import { v3 } from '../../math/vec3';
import {
  cloudEquirectCellAreaM2, validateCloudEquirectGrid, type CloudEquirectGrid,
} from './cloud-equirect-grid';
import { sampleConvectiveCloudEvents } from './cloud-events';
import { deriveCloudEventAreas } from './cloud-event-area-closure';
import { reconstructCloudEventMaterialCohorts } from './cloud-event-transport';
import {
  accumulateCloudEventMaterialCohortsEquirect,
  prepareCloudEquirectDepositionTarget,
  type CloudEquirectDepositionTarget,
} from './cloud-event-equirect-deposition';
import { createCloudMassAccumulation } from './cloud-mass-deposition';
import type { Vec3 } from '../../math/vec3';
import type {
  CloudMassAccumulation, CloudMassGrid, CloudMassPhase,
} from './cloud-mass-deposition';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { ConvectiveCloudCell, ConvectiveCloudEvent } from './cloud-events';
import type {
  CloudEventMaterialCohorts, CloudEventWindAt,
} from './cloud-event-transport';
import type { CloudEventAreas } from './cloud-event-area-closure';

// 高度層の境界 [m]。局所場と同じ層分けで、全球の質量場も同じ高さへ載せる。
const LAYER_EDGES_M = [0, 1_500, 4_000, 7_000, 10_000] as const;
// イベントセルの目標間隔 [m]。低気圧・前線・ITCZ のスケールより細かく、全球で
// 数千イベントに収まる間隔として取る。
const EVENT_CELL_SPACING_M = 450e3;
const BIRTH_INTERVAL_SECONDS = 21_600;
const HISTORY_HORIZON_SECONDS = 86_400;
// 1セルが履歴窓に置きうる出生枠の数。セル数を掛ければその供給が生じうるイベント数の
// 上界になるので、イベント件数の上限はセル数に連動させる。
const BIRTH_SLOTS_PER_CELL = Math.ceil(HISTORY_HORIZON_SECONDS / BIRTH_INTERVAL_SECONDS) + 1;
// horizon 切り捨て質量上界の許容値 [kg/m²] はセルごとの上界和になるので、許容値も
// セル数に連動させる。1セルあたりの上限で、既定のセル間隔で従来の全球許容値と同桁。
const MAX_OMITTED_MASS_PER_CELL_KG_M2 = 4e-4;
// footprint 面積の上限 [m²]。1イベントが広がりすぎて堆積コストが跳ぶのを止める
// コスト抑止で、物理閉包が形を決めるのでイベントセルの間隔とは独立した固定値。
const MAX_FOOTPRINT_AREA_M2 = 600e3 * 600e3;
const TRANSPORT_STEP_SECONDS = 900;
const ICE_COHORT_COUNT = 8;
// 0°C の水の蒸発潜熱 [J/kg]。地表の潜熱フラックスをそのまま対流の水供給率へ換算する近似。
const LATENT_HEAT_VAPORIZATION_J_PER_KG = 2.501e6;
const MIN_CONVECTIVE_DURATION_SECONDS = 900;
const MAX_CONVECTIVE_DURATION_SECONDS = 7_200;
// セルの対流ポテンシャルの幅。均一格子にしないため seed とセル番号から散らす。
const CONVECTIVE_POTENTIAL_MIN = 0.05;
const CONVECTIVE_POTENTIAL_RANGE = 0.8;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 全球の層別・相別の列質量場。セル (row, column) は正距円筒の行優先で、層 l の値は
// 配列の l·width·height + row·width + column 番目にある [kg/m²]。
export interface CloudGlobalMassField {
  readonly width: number;
  readonly height: number;
  readonly sphereRadiusM: number;
  readonly layerEdgesM: readonly number[];
  readonly liquidKgM2: Float64Array;
  readonly iceKgM2: Float64Array;
}

// derive が返す質量場と、質量収支の診断値。イベントが供給した質量(相別)は、
// 場の堆積質量と unassignedMassKgByPhase の和と一致する。
export interface CloudGlobalFieldSupplyResult {
  readonly field: CloudGlobalMassField;
  // 標本したイベントが供給した質量の相別合計 [kg]。
  readonly eventMassKgByPhase: Readonly<Record<CloudMassPhase, number>>;
  // 全球格子のどのセルにも割り当たらなかった質量 [kg](相別)。
  readonly unassignedMassKgByPhase: Readonly<Record<CloudMassPhase, number>>;
  // 堆積へ流したイベント数と、件数上限で切り捨てたイベント数。
  readonly eventCount: number;
  readonly truncatedEventCount: number;
  // horizon より古いイベントが残しうる質量の上界 [kg/m²](全セル和)。
  readonly omittedMassUpperBoundKgM2: number;
}

// 分割して進められる全球場の導出。step へ1回の駆動で使ってよい壁時計の上限 [ms] を
// 渡すと、その範囲で内部を進める。done が立つまで result は null を返し、途中経過を
// 外へ出さない。
export interface CloudGlobalFieldJob {
  step(timeBudgetMs: number): { readonly done: boolean };
  readonly result: CloudGlobalFieldSupplyResult | null;
  // 途中で放棄するときの後始末。done 以後は呼ばない。
  cancel?(): void;
}

// 表示時刻から全球の質量場を導出する口。
export interface CloudGlobalFieldSupply {
  derive(displayTimeSeconds: number): CloudGlobalFieldSupplyResult;
  startJob(displayTimeSeconds: number): CloudGlobalFieldJob;
}

// 単位方向と時刻からその地点の環境プロファイルを引く口。供給側はセル・イベントの
// 位置ごとに呼ぶので、実装側は方向と時刻から決定的にプロファイルを返す純関数であること。
export type CloudGlobalEnvironmentAt = (
  direction: Vec3,
  timeSeconds: number,
) => CloudEnvironmentProfile;

// 環境プロファイルから、セルへ与える供給系の値を導く。雲底はパーセルの LCL(無ければ境界層
// の深さ)、氷放出高は平衡高度(無ければプロファイル上端)、供給率は潜熱フラックスの蒸発量換算、
// 対流の継続時間は雲の深さを CAPE 由来の上昇速度で渡る時間の数倍で近似する。
function environmentCellValues(environment: CloudEnvironmentProfile): {
  readonly upperRelativeHumidity: number;
  readonly liquidSupplyRateKgM2S: number;
  readonly convectiveDurationSeconds: number;
  readonly sourceHeightM: number;
  readonly iceReleaseHeightM: number;
} {
  const topEdgeM = LAYER_EDGES_M[LAYER_EDGES_M.length - 1]!;
  const parcel = environment.parcel;
  const cloudBaseM = clamp(
    parcel.lclHeightM ?? environment.boundaryLayer.depthM, LAYER_EDGES_M[0]!, topEdgeM - 1);
  const releaseM = clamp(
    parcel.equilibriumHeightM ?? environment.levels[environment.levels.length - 1]!.heightM,
    LAYER_EDGES_M[0]!, topEdgeM - 1);
  const updraftMPerS = Math.sqrt(2 * Math.max(0, parcel.capeJPerKg));
  // 上昇流で雲の深さを渡る時間の約4倍を対流の一生とみなす。CAPE が小さい環境では
  // 供給の細い短命なイベントだけが残る。
  const convectiveDurationSeconds = updraftMPerS >= 0.5 && releaseM > cloudBaseM
    ? clamp(4 * (releaseM - cloudBaseM) / updraftMPerS,
      MIN_CONVECTIVE_DURATION_SECONDS, MAX_CONVECTIVE_DURATION_SECONDS)
    : MIN_CONVECTIVE_DURATION_SECONDS;
  return {
    upperRelativeHumidity: clamp(environment.upperIceMoistureFactor, 0, 1),
    liquidSupplyRateKgM2S: environment.surfaceLatentHeatFluxWPerM2
      / LATENT_HEAT_VAPORIZATION_J_PER_KG,
    convectiveDurationSeconds,
    sourceHeightM: cloudBaseM,
    iceReleaseHeightM: releaseM,
  };
}

// 緯度帯1本のイベントセル配置。帯の中心緯度と、その周へ等間隔に置くセル数を持つ。
interface GlobalEventCellBand {
  readonly latitudeRad: number;
  readonly cellCount: number;
}

// 帯中心の緯度と列番号からセル中心の単位方向を返す。経度 0 が +Z、東が +X、北極が +Y。
function cellDirectionAt(latitudeRad: number, columnIndex: number, cellCount: number): Vec3 {
  const longitudeRad = -Math.PI + (columnIndex + 0.5) * (2 * Math.PI / cellCount);
  const flat = Math.cos(latitudeRad);
  return v3(flat * Math.sin(longitudeRad), Math.sin(latitudeRad), flat * Math.cos(longitudeRad));
}

// 堆積段階の固定入力と累積器。格子と堆積宛先は段階のあいだ変わらない固定入力、
// 層別の質量配列・unassigned・供給質量はイベントごとに累積される。
interface GlobalFieldDepositionState {
  readonly massGrid: CloudMassGrid;
  // 格子と質量格子の面積整合を供給全体で1回照合した堆積先。
  readonly target: CloudEquirectDepositionTarget;
  // 層×セルの質量場と格子外質量をイベント間で継ぎ越す永続累積器。
  readonly accumulation: CloudMassAccumulation;
  readonly eventMassKgByPhase: Record<CloudMassPhase, number>;
}

// 表示時刻 displayTimeSeconds [s] の全球質量場を導出する供給源。イベントセルの対流
// ポテンシャルに加え、供給系の値もセル位置・表示時刻の環境プロファイルから導く。
export class ConvectiveCloudGlobalFieldSupply implements CloudGlobalFieldSupply {
  // environmentAt はイベントの供給系を決める環境プロファイルを方向と時刻から引く口、
  // seed はセルのポテンシャルとイベント出生の決定論を与える種、sphereRadiusM は場を張る
  // 球の半径 [m]、gridWidth/gridHeight は equirect 質量格子の寸法 [texel]、windAt は
  // 輸送と面積導出に使う風場。eventCellSpacingM はイベントセルの目標間隔 [m] で、
  // 細格化した供給はここへ小さい間隔を渡す — 上限類はセル数に連動する。
  public constructor(
    private readonly environmentAt: CloudGlobalEnvironmentAt,
    private readonly seed: number,
    private readonly sphereRadiusM: number,
    private readonly gridWidth: number,
    private readonly gridHeight: number,
    private readonly windAt: CloudEventWindAt,
    private readonly eventCellSpacingM = EVENT_CELL_SPACING_M,
  ) {
    if (typeof environmentAt !== 'function') {
      throw new TypeError('environmentAt must be a function');
    }
    if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
    requireFinite(seed, 'seed');
    requirePositive(sphereRadiusM, 'sphereRadiusM');
    requirePositive(eventCellSpacingM, 'eventCellSpacingM');
    validateCloudEquirectGrid({
      width: gridWidth, height: gridHeight, sphereRadiusM,
    });
  }

  // 同期の一括導出。ジョブを制限なしで駆動したものと同じ結果を返す。
  public derive(displayTimeSeconds: number): CloudGlobalFieldSupplyResult {
    const job = this.startJob(displayTimeSeconds);
    job.step(Number.POSITIVE_INFINITY);
    return job.result!;
  }

  // 分割して駆動できる導出ジョブを始める。
  public startJob(displayTimeSeconds: number): CloudGlobalFieldJob {
    requireFinite(displayTimeSeconds, 'displayTimeSeconds');
    return new ConvectiveCloudGlobalFieldJob(
      displayTimeSeconds, this.environmentAt, this.seed, this.sphereRadiusM,
      this.gridWidth, this.gridHeight, this.windAt, this.eventCellSpacingM);
  }
}

// 導出ジョブの段階。cells は1セルずつ、deposit はイベント1件を3単位で、残りは段階全体を
// 1単位で進める。
type GlobalFieldStage = 'cells' | 'events' | 'deposit' | 'merge' | 'done';

// 対流イベントから全球質量場を組む分割導出。段階の境界と反復の1要素で壁時計の予算を
// 見て中断し、呼ばれるたびに続きを進める。done が立つまで result は null。
class ConvectiveCloudGlobalFieldJob implements CloudGlobalFieldJob {
  private stage: GlobalFieldStage = 'cells';
  private resultValue: CloudGlobalFieldSupplyResult | null = null;
  private readonly bands: readonly GlobalEventCellBand[];
  private bandIndex = 0;
  private columnIndex = 0;
  private readonly cells: ConvectiveCloudCell[] = [];
  private events: readonly ConvectiveCloudEvent[] = [];
  private eventIndex = 0;
  private truncatedEventCount = 0;
  private omittedMassUpperBoundKgM2 = 0;
  // セル位置の環境プロファイルのメモ。セル段階と堆積段階は同じ方向・表示時刻へ
  // 来るので、2度目以降はここから供給して環境プロファイルの二重評価を省く。
  private readonly environmentsByDirection = new Map<string, CloudEnvironmentProfile>();
  // 進行中イベントの中間結果。堆積の1イベントを「輸送の復元」「面積の導出」「堆積と累積」の
  // 3単位に分ける — まとめて1単位にすると1イベントの費用がそのまま1駆動の床になる。
  private eventMaterial: CloudEventMaterialCohorts | null = null;
  private eventAreas: CloudEventAreas | null = null;
  private deposition: GlobalFieldDepositionState | null = null;

  public constructor(
    private readonly displayTimeSeconds: number,
    private readonly environmentAt: CloudGlobalEnvironmentAt,
    private readonly seed: number,
    private readonly sphereRadiusM: number,
    private readonly gridWidth: number,
    private readonly gridHeight: number,
    private readonly windAt: CloudEventWindAt,
    private readonly eventCellSpacingM: number,
  ) {
    this.bands = this.buildBands();
  }

  public get result(): CloudGlobalFieldSupplyResult | null {
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
      }
      if (performance.now() >= deadline) break;
    }
    return { done: this.stage === 'done' };
  }

  // 緯度帯の分割。帯数は子午線長を目標間隔で割った数、各帯のセル数はその緯度の
  // 周長を目標間隔で割った数(最小1)で、全球でほぼ等面積のセル格子を組む。
  private buildBands(): readonly GlobalEventCellBand[] {
    const bandCount = Math.max(
      1, Math.round(Math.PI * this.sphereRadiusM / this.eventCellSpacingM));
    const bands: GlobalEventCellBand[] = [];
    for (let band = 0; band < bandCount; band += 1) {
      const latitudeRad = -Math.PI / 2 + (band + 0.5) * (Math.PI / bandCount);
      const circumferenceM = 2 * Math.PI * this.sphereRadiusM * Math.cos(latitudeRad);
      bands.push({
        latitudeRad,
        cellCount: Math.max(1, Math.round(circumferenceM / this.eventCellSpacingM)),
      });
    }
    return bands;
  }

  // セル位置の環境プロファイルを返す。イベントの源位置はセルの方向と一致するので、
  // 堆積段階で同じ方向・表示時刻へ来た再評価はこのメモから供給する。メモはジョブの
  // 寿命で閉じ、方向の成分をそのまま鍵にする。
  private environmentAtCell(direction: Vec3): CloudEnvironmentProfile {
    const key = `${direction.x},${direction.y},${direction.z}`;
    let profile = this.environmentsByDirection.get(key);
    if (profile === undefined) {
      profile = this.environmentAt(direction, this.displayTimeSeconds);
      this.environmentsByDirection.set(key, profile);
    }
    return profile;
  }

  // イベントセルを1件導く。位置は帯の中心緯度と列の経度から、供給系の値はそのセル位置の
  // 表示時刻の環境プロファイルから導く。
  private stepCell(): void {
    const band = this.bands[this.bandIndex]!;
    const direction = cellDirectionAt(band.latitudeRad, this.columnIndex, band.cellCount);
    const values = environmentCellValues(this.environmentAtCell(direction));
    // セルの乱数列。対流ポテンシャルと出生位相を別の引きで取る — 出生位相を置かないと
    // 全セルが同じ epoch で生まれ、寿命が間隔より短いイベントは全球で同時に消える。
    const cellRand = mulberry32(
      (this.seed ^ Math.imul(this.bandIndex + 1, 0x9e3779b1)
        ^ Math.imul(this.columnIndex + 1, 0x85ebca6b)) >>> 0);
    this.cells.push({
      id: `global-${this.bandIndex}-${this.columnIndex}`,
      supplySourceId: `global-source-${this.bandIndex}-${this.columnIndex}`,
      convectivePotential: CONVECTIVE_POTENTIAL_MIN
        + CONVECTIVE_POTENTIAL_RANGE * cellRand(),
      birthPhaseSeconds: BIRTH_INTERVAL_SECONDS * cellRand(),
      upperRelativeHumidity: values.upperRelativeHumidity,
      liquidSupplyRateKgM2S: values.liquidSupplyRateKgM2S,
      convectiveDurationSeconds: values.convectiveDurationSeconds,
      sourcePosition: {
        directionUnitVector: direction,
        geometricHeightM: values.sourceHeightM,
      },
      iceReleaseHeightM: values.iceReleaseHeightM,
    });
    this.columnIndex += 1;
    if (this.columnIndex >= band.cellCount) {
      this.bandIndex += 1;
      this.columnIndex = 0;
    }
    if (this.bandIndex >= this.bands.length) this.stage = 'events';
  }

  // セル群から表示時刻のイベント履歴を復元する。
  private stepEventSampling(): void {
    const sample = sampleConvectiveCloudEvents({
      seed: this.seed,
      birthIntervalSeconds: BIRTH_INTERVAL_SECONDS,
      historyHorizonSeconds: HISTORY_HORIZON_SECONDS,
      // 切り捨て質量の許容値とイベント件数の上限はセル数に連動させる — 細格化しても
      // 絶対値の上限へは抵触しない。
      maximumOmittedMassKgM2: MAX_OMITTED_MASS_PER_CELL_KG_M2 * this.cells.length,
      maxEventCount: BIRTH_SLOTS_PER_CELL * this.cells.length,
      timeSeconds: this.displayTimeSeconds,
      cells: this.cells,
    });
    this.events = sample.events;
    this.truncatedEventCount = sample.truncatedEventCount;
    this.omittedMassUpperBoundKgM2 = sample.omittedMassUpperBoundKgM2;
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
        event, this.sphereRadiusM, TRANSPORT_STEP_SECONDS, this.windAt, ICE_COHORT_COUNT);
      return;
    }
    if (this.eventAreas === null) {
      // 面積は環境・輸送から導く閉包。環境はイベントの源位置のものを引く — セル段階で
      // 同じ方向・表示時刻のプロファイルを引いているので、ここではメモから供給される。
      this.eventAreas = deriveCloudEventAreas(
        event, this.eventMaterial,
        this.environmentAtCell(event.sourcePosition!.directionUnitVector),
        this.windAt, this.minimumFootprintAreaM2(), MAX_FOOTPRINT_AREA_M2);
      return;
    }
    const sourceAreaM2 = this.eventAreas.sourceAreaM2;
    this.accumulateExpectedMass(this.eventMaterial, sourceAreaM2);
    accumulateCloudEventMaterialCohortsEquirect(
      this.eventMaterial, sourceAreaM2, this.eventAreas.footprints,
      work.target, work.accumulation);
    this.eventMaterial = null;
    this.eventAreas = null;
    this.eventIndex += 1;
    if (this.eventIndex >= this.events.length) this.stage = 'merge';
  }

  // 堆積段階の固定入力と累積器を組む。質量格子のセル面積は帯の実面積から正確に立てる。
  private startDeposition(): GlobalFieldDepositionState {
    const grid: CloudEquirectGrid = {
      width: this.gridWidth, height: this.gridHeight, sphereRadiusM: this.sphereRadiusM,
    };
    const cellCount = this.gridWidth * this.gridHeight;
    const cells = new Array<{ areaM2: number }>(cellCount);
    for (let row = 0; row < this.gridHeight; row += 1) {
      const areaM2 = cloudEquirectCellAreaM2(grid, row);
      for (let column = 0; column < this.gridWidth; column += 1) {
        cells[row * this.gridWidth + column] = { areaM2 };
      }
    }
    const massGrid: CloudMassGrid = { cells, layerEdgesM: LAYER_EDGES_M };
    return {
      massGrid,
      target: prepareCloudEquirectDepositionTarget(grid, massGrid),
      accumulation: createCloudMassAccumulation(massGrid),
      eventMassKgByPhase: { liquid: 0, ice: 0 },
    };
  }

  // 面積の下限。質量格子1セルの対蹠距離(赤道帯のセル対角の半分を半径とする円)で、
  // どんな向きの footprint でも必ずどこかのセルへ載る大きさ。
  private minimumFootprintAreaM2(): number {
    const diagonalRad = Math.hypot(
      2 * Math.PI / this.gridWidth, Math.PI / this.gridHeight);
    const radiusM = this.sphereRadiusM * diagonalRad / 2;
    return Math.PI * radiusM * radiusM;
  }

  // イベントの供給質量を相別へ累積する。質量収支を確かめるための期待値で、
  // 場の堆積質量と unassigned の和と一致する。
  private accumulateExpectedMass(
    material: CloudEventMaterialCohorts, sourceAreaM2: number,
  ): void {
    const totals = this.deposition!.eventMassKgByPhase;
    totals.liquid += (material.parent?.massKgM2 ?? 0) * sourceAreaM2;
    let iceKgM2 = 0;
    for (const cohort of material.releasedIceCohorts) iceKgM2 += cohort.massKgM2;
    totals.ice += iceKgM2 * sourceAreaM2;
  }

  // 場の堆積質量と unassigned の和が、イベントが供給した質量と一致するかを供給全体の
  // 末尾で1回照合する。累積がセルを取りこぼすとここで検出する。
  private verifyMassBalance(work: GlobalFieldDepositionState): void {
    const cellCount = this.gridWidth * this.gridHeight;
    const layerCount = LAYER_EDGES_M.length - 1;
    const deposited: Record<CloudMassPhase, number> = { liquid: 0, ice: 0 };
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex += 1) {
      const base = layerIndex * cellCount;
      for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
        const areaM2 = work.massGrid.cells[cellIndex]!.areaM2;
        deposited.liquid += work.accumulation.liquidKgM2[base + cellIndex]! * areaM2;
        deposited.ice += work.accumulation.iceKgM2[base + cellIndex]! * areaM2;
      }
    }
    for (const phase of ['liquid', 'ice'] as const) {
      const expectedKg = work.eventMassKgByPhase[phase];
      const balanceKg = deposited[phase] + work.accumulation.unassignedMassKgByPhase[phase];
      const toleranceKg = Math.max(1e-6, Math.abs(expectedKg) * 1e-9);
      if (!Number.isFinite(balanceKg) || Math.abs(balanceKg - expectedKg) > toleranceKg) {
        throw new RangeError(`${phase} mass is not conserved by the global field accumulation`);
      }
    }
  }

  // 累積した層別質量を質量場へ束ねて結果を確定する。
  private stepMerge(): void {
    const work = this.deposition!;
    this.verifyMassBalance(work);
    this.resultValue = {
      field: {
        width: this.gridWidth,
        height: this.gridHeight,
        sphereRadiusM: this.sphereRadiusM,
        layerEdgesM: LAYER_EDGES_M,
        liquidKgM2: work.accumulation.liquidKgM2,
        iceKgM2: work.accumulation.iceKgM2,
      },
      eventMassKgByPhase: work.eventMassKgByPhase,
      unassignedMassKgByPhase: work.accumulation.unassignedMassKgByPhase,
      eventCount: this.events.length,
      truncatedEventCount: this.truncatedEventCount,
      omittedMassUpperBoundKgM2: this.omittedMassUpperBoundKgM2,
    };
    this.stage = 'done';
  }
}
