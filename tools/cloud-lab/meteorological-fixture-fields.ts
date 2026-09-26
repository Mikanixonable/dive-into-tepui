// 制御実験が測る格子場を組み立てる fixture。生成側の形態実装に依存しない、
// 幾何・調和関数から直接定義された場なので、参照値は実装の出力ではなく
// fixture の定義から読める。
import { cloudFootprintOverlap } from '../../src/game/cloud/cloud-footprint-overlap';
import type { CloudFootprintCircle, CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';
import { v3 } from '../../src/math/vec3';
import type { CloudLocalFieldFrame } from '../../src/render/cloud/cloud-local-field';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';
import type { CloudFieldPlane } from './meteorological-field-measures';

// C9 の二円盤 fixture の寸法。液水層 1–3 km・氷層 6–8 km・空隙 3–6 km の三層で、
// 半径 10 km の円盤を同心に置く。層中央の高さは 2 km/7 km。
export const C9_DISC_RADIUS_M = 10_000;
export const C9_CELL_SIZE_M = 500;
export const C9_GRID_CELL_COUNT = 120;
export const C9_GRID_ORIGIN_M = -12_000;
export const C9_LAYER_EDGES_M = [1_000, 3_000, 6_000, 8_000] as const;
export const C9_LIQUID_EXTINCTION_PER_M = 2e-4;
export const C9_ICE_EXTINCTION_PER_M = 1e-4;
export const C9_LIQUID_LAYER_CENTER_M = 2_000;
export const C9_ICE_LAYER_CENTER_M = 7_000;

const C9_SPHERE_RADIUS_M = 6_371_000;
// 輸送対照で円盤中心が 36 km 離れても場が有効なままの角距離。
const C9_MAX_ANGULAR_DISTANCE_RAD = 0.012;

export interface TangentPlanePoint {
  readonly eastM: number;
  readonly northM: number;
}

export interface C9TwoDiscField {
  readonly frame: CloudLocalFieldFrame;
  readonly data: CloudOpticalVolumeData;
}

// 円盤のセル被覆を解析的な円-矩形交差から積み、被覆率で消散係数を薄めた格子場を返す。
// null の相はその層の消散を丸ごと零とする(片層だけ残す対照用)。
export function buildC9TwoDiscField(
  liquidCenter: TangentPlanePoint | null,
  iceCenter: TangentPlanePoint | null,
): C9TwoDiscField {
  const cellCount = C9_GRID_CELL_COUNT * C9_GRID_CELL_COUNT;
  const layerCount = C9_LAYER_EDGES_M.length - 1;
  const liquid = new Float32Array(cellCount * layerCount);
  const ice = new Float32Array(cellCount * layerCount);
  const cellAreaM2 = C9_CELL_SIZE_M * C9_CELL_SIZE_M;
  const grid: CloudFootprintGrid = {
    originEastM: C9_GRID_ORIGIN_M,
    originNorthM: C9_GRID_ORIGIN_M,
    cellWidthM: C9_CELL_SIZE_M,
    cellHeightM: C9_CELL_SIZE_M,
    width: C9_GRID_CELL_COUNT,
    height: C9_GRID_CELL_COUNT,
  };
  const deposit = (
    center: TangentPlanePoint, layerIndex: number, extinctionPerM: number,
    target: Float32Array,
  ): void => {
    const circle: CloudFootprintCircle = {
      eastM: center.eastM, northM: center.northM, radiusM: C9_DISC_RADIUS_M,
    };
    for (const overlap of cloudFootprintOverlap(circle, grid).overlaps) {
      target[layerIndex * cellCount + overlap.cellIndex] = extinctionPerM
        * overlap.areaM2 / cellAreaM2;
    }
  };
  if (liquidCenter !== null) deposit(liquidCenter, 0, C9_LIQUID_EXTINCTION_PER_M, liquid);
  if (iceCenter !== null) deposit(iceCenter, 2, C9_ICE_EXTINCTION_PER_M, ice);
  const frame: CloudLocalFieldFrame = {
    centerDirection: v3(0, 0, 1),
    eastDirection: v3(1, 0, 0),
    northDirection: v3(0, 1, 0),
    sphereRadiusM: C9_SPHERE_RADIUS_M,
    gridOriginEastM: C9_GRID_ORIGIN_M,
    gridOriginNorthM: C9_GRID_ORIGIN_M,
    cellWidthM: C9_CELL_SIZE_M,
    cellHeightM: C9_CELL_SIZE_M,
    gridWidth: C9_GRID_CELL_COUNT,
    gridHeight: C9_GRID_CELL_COUNT,
    maxAngularDistanceRad: C9_MAX_ANGULAR_DISTANCE_RAD,
    layerEdgesM: [...C9_LAYER_EDGES_M],
  };
  return {
    frame,
    data: {
      width: C9_GRID_CELL_COUNT,
      height: C9_GRID_CELL_COUNT,
      layerEdgesM: Float32Array.from(C9_LAYER_EDGES_M),
      liquidExtinctionPerM: liquid,
      iceExtinctionPerM: ice,
    },
  };
}

// C7 の波状場 fixture。波源の水平波長と伝播方位に沿う一成分の調和関数を、
// 非負の消散として一層分の平面へ敷く。spanM が波長の整数倍なら端で繋がる。
export function buildWaveFieldPlane(input: {
  readonly cellCount: number;
  readonly spanM: number;
  readonly wavelengthM: number;
  readonly propagationAzimuthRad: number;
  readonly extinctionPerM: number;
}): CloudFieldPlane {
  if (!Number.isSafeInteger(input.cellCount) || input.cellCount <= 0
    || !(input.spanM > 0) || !(input.wavelengthM > 0) || !(input.extinctionPerM > 0)) {
    throw new RangeError('wave field parameters must be positive');
  }
  const cellSizeM = input.spanM / input.cellCount;
  const originM = -input.spanM / 2;
  const values = new Float32Array(input.cellCount * input.cellCount);
  for (let row = 0; row < input.cellCount; row += 1) {
    const northM = originM + (row + 0.5) * cellSizeM;
    for (let column = 0; column < input.cellCount; column += 1) {
      const eastM = originM + (column + 0.5) * cellSizeM;
      const alongWaveM = eastM * Math.cos(input.propagationAzimuthRad)
        + northM * Math.sin(input.propagationAzimuthRad);
      values[row * input.cellCount + column] = input.extinctionPerM
        * (1 + Math.cos(2 * Math.PI * alongWaveM / input.wavelengthM)) / 2;
    }
  }
  return {
    width: input.cellCount,
    height: input.cellCount,
    cellWidthM: cellSizeM,
    cellHeightM: cellSizeM,
    originEastM: originM,
    originNorthM: originM,
    values,
  };
}

// C8 の海洋セル fixture の寸法。cos の二項和が作る開いたセル網で、
// 縁に触れない穴が格子内に複数残る。
export const C8_CELL_FIELD_CELL_COUNT = 64;
export const C8_CELL_FIELD_CELL_SIZE_M = 1_000;
export const C8_CELL_FIELD_PERIOD_M = 20_000;
export const C8_CELL_FIELD_THRESHOLD = -0.5;
export const C8_CELL_FIELD_EXTINCTION_PER_M = 5e-5;
// 西端の帯を雲なしにして、格子縁へ触れる非セル性の空隙を混ぜる。
export const C8_BOUNDARY_CLEAR_EAST_M = -24_000;

// C8 の海洋セル fixture。雲は f > -0.5 の連結した網、穴は各極小まわりの閉じた領域。
// filledHoleAt を与えると、その位置の穴を雲で埋める(寿命系列用)。
export function buildCellFieldPlane(input: {
  readonly filledHoleCenterEastM?: number;
  readonly filledHoleCenterNorthM?: number;
  readonly filledHoleRadiusM?: number;
} = {}): CloudFieldPlane {
  const count = C8_CELL_FIELD_CELL_COUNT;
  const cellSizeM = C8_CELL_FIELD_CELL_SIZE_M;
  const spanM = count * cellSizeM;
  const originM = -spanM / 2;
  const values = new Float32Array(count * count);
  // 穴の半径(約 0.28·周期)を覆う埋め込み半径にする。
  const fillRadiusM = input.filledHoleRadiusM ?? 8_000;
  for (let row = 0; row < count; row += 1) {
    const northM = originM + (row + 0.5) * cellSizeM;
    for (let column = 0; column < count; column += 1) {
      const eastM = originM + (column + 0.5) * cellSizeM;
      const field = Math.cos(2 * Math.PI * eastM / C8_CELL_FIELD_PERIOD_M)
        + Math.cos(2 * Math.PI * northM / C8_CELL_FIELD_PERIOD_M);
      let cloudy = field > C8_CELL_FIELD_THRESHOLD && eastM >= C8_BOUNDARY_CLEAR_EAST_M;
      if (input.filledHoleCenterEastM !== undefined
        && input.filledHoleCenterNorthM !== undefined) {
        const distanceToFillM = Math.hypot(
          eastM - input.filledHoleCenterEastM, northM - input.filledHoleCenterNorthM);
        if (distanceToFillM <= fillRadiusM) cloudy = true;
      }
      values[row * count + column] = cloudy ? C8_CELL_FIELD_EXTINCTION_PER_M : 0;
    }
  }
  return {
    width: count,
    height: count,
    cellWidthM: cellSizeM,
    cellHeightM: cellSizeM,
    originEastM: originM,
    originNorthM: originM,
    values,
  };
}

// C8 の寿命系列 fixture。30 分以降は中央の一つの穴が雲で埋まる。
export function buildCellFieldSeries(): readonly {
  readonly timeMinutes: number;
  readonly plane: CloudFieldPlane;
}[] {
  const filledEastM = C8_CELL_FIELD_PERIOD_M / 2;
  const filledNorthM = C8_CELL_FIELD_PERIOD_M / 2;
  return [0, 10, 20, 30, 40, 50, 60].map((timeMinutes) => ({
    timeMinutes,
    plane: buildCellFieldPlane(timeMinutes >= 30
      ? { filledHoleCenterEastM: filledEastM, filledHoleCenterNorthM: filledNorthM }
      : {}),
  }));
}
