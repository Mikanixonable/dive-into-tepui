// 対流イベントから局所光学場を導出する供給源。中心方向のまわりへ決定論的に置いたイベント
// セルへ、セル位置の環境プロファイルから導いた供給率・期間・氷放出高を与え、
// 出生 → 輸送 → 堆積 → 消散のチェーンで CloudOpticalVolumeData とそれを張る frame を組む。
// 環境はセル位置ごとに environmentAt から引くので、場の中で湿った対流域と乾いた領域が
// 混在する。下流への地形応答はここでは扱わない。

import { mulberry32 } from '../../math/random';
import { v3 } from '../../math/vec3';
import { AtmosphericWindField } from '../../render/cloud/atmospheric-wind';
import {
  cloudLocalDirectionAt, validateCloudLocalFieldFrame,
} from '../../render/cloud/cloud-local-field';
import { sampleConvectiveCloudEvents } from './cloud-events';
import { deriveCloudEventAreas } from './cloud-event-area-closure';
import { reconstructCloudEventMaterialCohorts } from './cloud-event-transport';
import { depositCloudEventMaterialCohorts } from './cloud-event-local-deposition';
import { extinctionFromCloudMass } from './cloud-mass-extinction';
import { cloudOpticalVolumeFrameFromExtinction } from './cloud-optical-volume-frame';
import type { Vec3 } from '../../math/vec3';
import type {
  CloudLocalFieldFrame, CloudLocalFieldSupply, CloudLocalFieldSupplyResult,
} from '../../render/cloud/cloud-local-field';
import type { CloudOpticalVolumeData } from '../../render/cloud/cloud-optical-volume';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { ConvectiveCloudCell } from './cloud-events';
import type { CloudEventWindAt } from './cloud-event-transport';
import type { CloudFootprintGrid } from './cloud-footprint-overlap';
import type {
  CloudMassDeposition, CloudMassGrid, CloudMassLayerColumns,
} from './cloud-mass-deposition';
import type { CloudLayerMicrophysics } from './cloud-mass-extinction';

// 場の一辺 [texel] と、中心のまわりに東西・南北へ張る幅 [m]。
export const CONVECTIVE_LOCAL_FIELD_SPAN_M = 500e3;
const GRID_SIZE = 256;
const CELL_SIZE_M = CONVECTIVE_LOCAL_FIELD_SPAN_M / GRID_SIZE;
// 中心のまわりへ置くイベントセルの数と間隔。間隔の半対角は格子の半対角より小さく保つ。
const EVENT_CELL_COUNT = 9;
const EVENT_CELL_SPACING_M = 50e3;
const LAYER_EDGES_M = [0, 1_500, 4_000, 7_000, 10_000] as const;
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
// 0°C の水の蒸発潜熱 [J/kg]。地表の潜熱フラックスをそのまま対流の水供給率へ換算する近似。
const LATENT_HEAT_VAPORIZATION_J_PER_KG = 2.501e6;
const MIN_CONVECTIVE_DURATION_SECONDS = 900;
const MAX_CONVECTIVE_DURATION_SECONDS = 7_200;
// セルの対流ポテンシャルの幅。均一格子にしないため seed とセル番号から散らす。
const CONVECTIVE_POTENTIAL_MIN = 0.05;
const CONVECTIVE_POTENTIAL_RANGE = 0.8;

// 高度層の微物理。液水・氷の有効粒径と氷の消散効率は層で分けず一定 — 粒径の高度依存は
// 質量収支とは独立に後から層別へ変えられる。
const LAYER_MICROPHYSICS: readonly CloudLayerMicrophysics[] =
  LAYER_EDGES_M.slice(0, -1).map(() => ({
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

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 天体固定の中心方向から、接平面の東・北の右手系を組む。経度から直接基底を作るので、
// 中心が極でも東向きが退化しない(正距円筒の取り決め: 経度 0 が +Z、東が +X、北極が +Y)。
function tangentBasis(centerDirection: Vec3): { readonly east: Vec3; readonly north: Vec3 } {
  const latitudeRad = Math.asin(clamp(centerDirection.y, -1, 1));
  const longitudeRad = Math.atan2(centerDirection.x, centerDirection.z);
  const cosLatitude = Math.cos(latitudeRad);
  const sinLatitude = Math.sin(latitudeRad);
  const cosLongitude = Math.cos(longitudeRad);
  const sinLongitude = Math.sin(longitudeRad);
  return {
    east: v3(cosLongitude, 0, -sinLongitude),
    north: v3(-sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude),
  };
}

// 単位方向からその地点の環境プロファイルを引く口。供給側はセル・イベントの位置ごとに
// 呼ぶので、実装側は方向から決定的にプロファイルを返す純関数であること。
export type CloudEnvironmentAt = (direction: Vec3) => CloudEnvironmentProfile;

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

// 輸送に使う風。大気風モデルをイベント位置の緯度と高さで評価し、位置の接平面基底で
// 東・北成分から接線速度へ戻す。鉛直流は surrogate では扱わない。
function makeWindAt(windField: AtmosphericWindField): CloudEventWindAt {
  return (directionUnitVector, geometricHeightM) => {
    const latitudeRad = Math.asin(clamp(directionUnitVector.y, -1, 1));
    const { east, north } = tangentBasis(directionUnitVector);
    const wind = windField.sample(latitudeRad, geometricHeightM);
    return {
      tangentVelocityMPerS: v3(
        east.x * wind.east + north.x * wind.north,
        east.y * wind.east + north.y * wind.north,
        east.z * wind.east + north.z * wind.north,
      ),
      verticalVelocityMPerS: 0,
    };
  };
}

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

  public derive(
    displayTimeSeconds: number, centerDirection: Vec3,
  ): CloudLocalFieldSupplyResult | null {
    requireFinite(displayTimeSeconds, 'displayTimeSeconds');
    requireUnitVector(centerDirection, 'centerDirection');
    const frame = this.frame(centerDirection);
    validateCloudLocalFieldFrame(frame);

    const cells = this.cells(frame);
    const sample = sampleConvectiveCloudEvents({
      seed: this.seed,
      birthIntervalSeconds: BIRTH_INTERVAL_SECONDS,
      historyHorizonSeconds: HISTORY_HORIZON_SECONDS,
      maximumOmittedMassKgM2: MAX_OMITTED_MASS_KG_M2,
      maxEventCount: MAX_EVENT_COUNT,
      timeSeconds: displayTimeSeconds,
      cells,
    });
    return { frame, data: this.depositEvents(sample.events, frame) };
  }

  // 場を張る frame。格子は中心のまわりに正方形で、有効角距離は格子の半対角まで届く。
  private frame(centerDirection: Vec3): CloudLocalFieldFrame {
    const { east, north } = tangentBasis(centerDirection);
    return {
      centerDirection,
      eastDirection: east,
      northDirection: north,
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
      layerEdgesM: LAYER_EDGES_M,
    };
  }

  // 中心のまわりに等間隔で置くイベントセル。位置は frame の接平面座標から log-map で引き、
  // 供給系の値はそのセル位置の環境プロファイルから導く。
  private cells(frame: CloudLocalFieldFrame): ConvectiveCloudCell[] {
    const cells: ConvectiveCloudCell[] = [];
    const half = (EVENT_CELL_COUNT - 1) / 2;
    for (let i = 0; i < EVENT_CELL_COUNT; i += 1) {
      for (let j = 0; j < EVENT_CELL_COUNT; j += 1) {
        const direction = cloudLocalDirectionAt(
          (i - half) * EVENT_CELL_SPACING_M, (j - half) * EVENT_CELL_SPACING_M, frame);
        const values = environmentCellValues(this.environmentAt(direction));
        cells.push({
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
      }
    }
    return cells;
  }

  // イベント群を輸送・堆積・消散へ通し、テクスチャへ焼く形へ並べ替える。
  private depositEvents(
    events: ReturnType<typeof sampleConvectiveCloudEvents>['events'],
    frame: CloudLocalFieldFrame,
  ): CloudOpticalVolumeData {
    const cellCount = GRID_SIZE * GRID_SIZE;
    const footprintGrid: CloudFootprintGrid = {
      originEastM: frame.gridOriginEastM,
      originNorthM: frame.gridOriginNorthM,
      cellWidthM: frame.cellWidthM,
      cellHeightM: frame.cellHeightM,
      width: GRID_SIZE,
      height: GRID_SIZE,
    };
    const massGrid: CloudMassGrid = {
      cells: Array.from({ length: cellCount }, () => ({ areaM2: CELL_SIZE_M * CELL_SIZE_M })),
      layerEdgesM: LAYER_EDGES_M,
    };
    const chart = {
      centerDirectionUnitVector: frame.centerDirection,
      eastUnitVector: frame.eastDirection,
      northUnitVector: frame.northDirection,
      sphereRadiusM: this.sphereRadiusM,
      maxAngularDistanceRad: DEPOSITION_MAX_ANGULAR_RAD,
    };
    const windAt = makeWindAt(this.windField);
    const liquidKgM2ByLayer = LAYER_EDGES_M.slice(0, -1).map(() => new Array<number>(cellCount).fill(0));
    const iceKgM2ByLayer = LAYER_EDGES_M.slice(0, -1).map(() => new Array<number>(cellCount).fill(0));
    const unassignedMassKgByPhase = { liquid: 0, ice: 0 };
    for (const event of events) {
      const material = reconstructCloudEventMaterialCohorts(
        event, this.sphereRadiusM, TRANSPORT_STEP_SECONDS, windAt, ICE_COHORT_COUNT);
      // 面積は環境・輸送から導く閉包。環境はイベントの源位置のものを引く — セルは必ず
      // 源位置を持って建てている。
      const areas = deriveCloudEventAreas(
        event, material, this.environmentAt(event.sourcePosition!.directionUnitVector), windAt,
        CELL_SIZE_M * CELL_SIZE_M,
        CONVECTIVE_LOCAL_FIELD_SPAN_M * CONVECTIVE_LOCAL_FIELD_SPAN_M);
      const deposition = depositCloudEventMaterialCohorts(
        material, areas.sourceAreaM2, areas.footprints, chart, footprintGrid, massGrid);
      accumulateDeposition(
        deposition, liquidKgM2ByLayer, iceKgM2ByLayer, unassignedMassKgByPhase);
    }
    const columnsByLayer: CloudMassLayerColumns[] = LAYER_EDGES_M.slice(0, -1).map(
      (lowerAltitudeM, layerIndex) => ({
        lowerAltitudeM,
        upperAltitudeM: LAYER_EDGES_M[layerIndex + 1]!,
        liquidKgM2ByCell: liquidKgM2ByLayer[layerIndex]!,
        iceKgM2ByCell: iceKgM2ByLayer[layerIndex]!,
      }),
    );
    const merged: CloudMassDeposition = { columnsByLayer, unassignedMassKgByPhase };
    const extinction = extinctionFromCloudMass(merged, LAYER_MICROPHYSICS);
    return cloudOpticalVolumeFrameFromExtinction(
      GRID_SIZE, GRID_SIZE, frame.layerEdgesM, extinction);
  }
}
