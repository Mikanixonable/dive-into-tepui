// 全球を正距円筒で割る格子と、接平面 footprint のセル被覆を求める。
// 格子は方向から行・列への射影と、緯度帯ごとに球面上で積分した実セル面積を持つ。
// footprint は中心方向の接平面に置いた円・楕円で、覆うセルはセルを副分割した
// 副セル中心方向を接平面へ指数写像で写した点が内部に入るかで分ける。

import { dot, len, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import {
  cloudFootprintQuadraticAt,
  cloudFootprintQuadraticForm,
  type CloudFootprint,
  type CloudFootprintCoverage,
  type CloudFootprintOverlap,
} from './cloud-footprint-overlap';

export interface CloudEquirectGrid {
  // 経度方向のセル数。経度 -π..π をこの数で等分し、列 0 の西端は -π(日付変更線)。
  readonly width: number;
  // 緯度方向のセル数。緯度 -π/2..π/2 をこの数で等分し、行 0 が北極側の帯。
  readonly height: number;
  // 格子が覆う球面の半径。m。
  readonly sphereRadiusM: number;
}

const VECTOR_TOLERANCE = 1e-10;
// anchor が極にある判定と、セル中心方向が anchor・対蹠点へ潰れる判定の下限。
const DEGENERATE_EPSILON = 1e-12;
// footprint とセルの交差を推す副分割数。セル中心だけの判定は footprint が
// セル数個ぶんの面積しかないとき被覆を数割欠くので、セルを副セルへ割って
// 境界の一部被覆を拾う。副セル一辺は格子セルの 1/8 で、細長い楕円 footprint の
// 幅(数十 km 台)も列の隙間へ落ちずに拾える大きさに取る。
const OVERLAP_SUBCELLS_PER_SIDE = 8;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function validateUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(len(vector) - 1) > VECTOR_TOLERANCE) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

function clampValue(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function validateCloudEquirectGrid(grid: CloudEquirectGrid): void {
  if (!Number.isSafeInteger(grid.width) || grid.width <= 0
    || !Number.isSafeInteger(grid.height) || grid.height <= 0
    || !Number.isSafeInteger(grid.width * grid.height)) {
    throw new RangeError('equirect grid dimensions must be positive safe integers');
  }
  requirePositive(grid.sphereRadiusM, 'sphereRadiusM');
}

// 方向の緯度 [rad]。北極(+Y)が π/2。
function latitudeRadOf(direction: Vec3): number {
  return Math.asin(clampValue(direction.y, -1, 1));
}

// 方向の経度 [rad]。+Z が 0 で、東(+X)向きに増える。範囲は -π..π。
function longitudeRadOf(direction: Vec3): number {
  return Math.atan2(direction.x, direction.z);
}

// 行の緯度帯で積分した実セル面積。m²。帯の面積は R²·Δλ·(sin φ_top − sin φ_bottom) で、
// 極へ向かうほど東西の実幅が潰れて小さくなる。
export function cloudEquirectCellAreaM2(grid: CloudEquirectGrid, rowIndex: number): number {
  validateCloudEquirectGrid(grid);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= grid.height) {
    throw new RangeError('rowIndex must refer to a grid row');
  }
  const bandRad = Math.PI / grid.height;
  const latitudeTopRad = Math.PI / 2 - rowIndex * bandRad;
  const longitudeWidthRad = 2 * Math.PI / grid.width;
  return grid.sphereRadiusM * grid.sphereRadiusM * longitudeWidthRad
    * (Math.sin(latitudeTopRad) - Math.sin(latitudeTopRad - bandRad));
}

// セル中心の単位方向。
export function cloudEquirectCellCenter(grid: CloudEquirectGrid, cellIndex: number): Vec3 {
  validateCloudEquirectGrid(grid);
  if (!Number.isInteger(cellIndex) || cellIndex < 0
    || cellIndex >= grid.width * grid.height) {
    throw new RangeError('cellIndex must refer to a grid cell');
  }
  const row = Math.floor(cellIndex / grid.width);
  const column = cellIndex % grid.width;
  const longitudeRad = -Math.PI + (column + 0.5) * (2 * Math.PI / grid.width);
  const latitudeRad = Math.PI / 2 - (row + 0.5) * (Math.PI / grid.height);
  const flat = Math.cos(latitudeRad);
  return v3(flat * Math.sin(longitudeRad), Math.sin(latitudeRad), flat * Math.cos(longitudeRad));
}

// 単位方向が属するセルの行優先 index。経度方向は日付変更線をまたいで折り返す。
export function cloudEquirectCellIndex(grid: CloudEquirectGrid, direction: Vec3): number {
  validateCloudEquirectGrid(grid);
  validateUnitVector(direction, 'direction');
  const longitudeRad = longitudeRadOf(direction);
  const latitudeRad = latitudeRadOf(direction);
  const column = Math.floor((longitudeRad + Math.PI) / (2 * Math.PI) * grid.width);
  const row = Math.floor((Math.PI / 2 - latitudeRad) / Math.PI * grid.height);
  const wrappedColumn = ((column % grid.width) + grid.width) % grid.width;
  return clampValue(row, 0, grid.height - 1) * grid.width + wrappedColumn;
}

// 方向の地点での接平面の東・北右手系。経度から直接基底を組むので極でも東向きが退化しない。
export function cloudEquirectTangentBasisAt(
  direction: Vec3,
): { readonly eastUnitVector: Vec3; readonly northUnitVector: Vec3 } {
  validateUnitVector(direction, 'direction');
  const latitudeRad = latitudeRadOf(direction);
  const longitudeRad = longitudeRadOf(direction);
  const cosLatitude = Math.cos(latitudeRad);
  const sinLatitude = Math.sin(latitudeRad);
  const cosLongitude = Math.cos(longitudeRad);
  const sinLongitude = Math.sin(longitudeRad);
  return {
    eastUnitVector: v3(cosLongitude, 0, -sinLongitude),
    northUnitVector: v3(
      -sinLatitude * sinLongitude, cosLatitude, -sinLatitude * cosLongitude),
  };
}

// 円・楕円 footprint の半軸と面積を取り出し、有限で正の面積を保証する。
function footprintMetricsM(footprint: CloudFootprint): {
  readonly majorRadiusM: number;
  readonly areaM2: number;
} {
  requireFinite(footprint.eastM, 'footprint.eastM');
  requireFinite(footprint.northM, 'footprint.northM');
  let majorRadiusM: number;
  let minorRadiusM: number;
  if ('radiusM' in footprint) {
    majorRadiusM = footprint.radiusM;
    minorRadiusM = footprint.radiusM;
  } else {
    majorRadiusM = footprint.majorRadiusM;
    minorRadiusM = footprint.minorRadiusM;
    requireFinite(footprint.majorAxisAzimuthRad, 'footprint.majorAxisAzimuthRad');
  }
  requireFinite(majorRadiusM, 'footprint major radius');
  requireFinite(minorRadiusM, 'footprint minor radius');
  if (minorRadiusM <= 0) throw new RangeError('footprint minor radius must be positive');
  if (majorRadiusM < minorRadiusM) {
    throw new RangeError('footprint major radius must not be smaller than minor radius');
  }
  const areaM2 = Math.PI * majorRadiusM * minorRadiusM;
  if (!Number.isFinite(areaM2) || areaM2 <= 0) {
    throw new RangeError('footprint area must be finite and positive');
  }
  return { majorRadiusM, areaM2 };
}

// 方向を anchor の接平面へ指数写像する。面内座標は球面距離 R·θ を面内成分の方位へ
// 置いた点で、局所 chart の log map と同じ距離の取り方。
function projectToTangentPlane(
  direction: Vec3,
  anchor: Vec3,
  eastUnitVector: Vec3,
  northUnitVector: Vec3,
  sphereRadiusM: number,
): { readonly x: number; readonly y: number } {
  const angleRad = Math.acos(clampValue(dot(anchor, direction), -1, 1));
  const eastComponent = dot(direction, eastUnitVector);
  const northComponent = dot(direction, northUnitVector);
  const inPlaneM = Math.hypot(eastComponent, northComponent);
  if (inPlaneM < DEGENERATE_EPSILON) {
    // anchor 自身か対蹠点。対蹠点は方位を持たないので、距離 πR の代表点として扱う。
    return angleRad < Math.PI / 2
      ? { x: 0, y: 0 }
      : { x: angleRad * sphereRadiusM, y: 0 };
  }
  const scale = sphereRadiusM * angleRad / inPlaneM;
  return { x: eastComponent * scale, y: northComponent * scale };
}

// 接平面の円・楕円 footprint が全球格子のどのセルを覆うかを求める。
// セルの被覆は副セルへ割って推す: 副セルの中心方向を接平面へ指数写像で写し、
// 楕円の内側に入った副セルだけ実面積を足す。被覆面積が footprint 面積を超えた分は
// 比率で割り戻す。足りない分は overlaps へ入れないので、footprintAreaM2 と被覆面積の
// 差が未分配として残る。
export function cloudEquirectFootprintOverlap(
  centerDirectionUnitVector: Vec3,
  footprint: CloudFootprint,
  grid: CloudEquirectGrid,
): CloudFootprintCoverage {
  validateCloudEquirectGrid(grid);
  validateUnitVector(centerDirectionUnitVector, 'centerDirectionUnitVector');
  const metrics = footprintMetricsM(footprint);
  // 副セル評価は全点で同じ footprint を当たるので、2次形式はここで1度だけ立てる。
  const quadratic = cloudFootprintQuadraticForm(footprint);
  const { eastUnitVector, northUnitVector } = cloudEquirectTangentBasisAt(centerDirectionUnitVector);

  // footprint は接平面上で中心から オフセット+長半径 の内側に収まるので、覆いうる
  // セル中心は同じ距離を角距離にした球面キャップの内側だけ。指数写像は距離 πR
  // (対蹠点)までしか方向を返せない。
  const capAngularRadiusRad = Math.min(Math.PI,
    (Math.hypot(footprint.eastM, footprint.northM) + metrics.majorRadiusM)
      / grid.sphereRadiusM);
  const anchorLatitudeRad = latitudeRadOf(centerDirectionUnitVector);
  const anchorLongitudeRad = longitudeRadOf(centerDirectionUnitVector);
  const cosAnchorLatitude = Math.cos(anchorLatitudeRad);
  const sinAnchorLatitude = Math.sin(anchorLatitudeRad);
  const cosCap = Math.cos(capAngularRadiusRad);

  const bandRad = Math.PI / grid.height;
  const cellWidthRad = 2 * Math.PI / grid.width;
  const latitudeTopRad = Math.min(Math.PI / 2, anchorLatitudeRad + capAngularRadiusRad);
  const latitudeBottomRad = Math.max(-Math.PI / 2, anchorLatitudeRad - capAngularRadiusRad);
  const firstRow = clampValue(
    Math.floor((Math.PI / 2 - latitudeTopRad) / bandRad), 0, grid.height - 1);
  const lastRow = clampValue(
    Math.floor((Math.PI / 2 - latitudeBottomRad) / bandRad), 0, grid.height - 1);

  const overlaps: CloudFootprintOverlap[] = [];
  let coveredAreaM2 = 0;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const rowTopRad = Math.PI / 2 - row * bandRad;
    // 行の緯度帯で anchor に最も近い緯度。キャップの経度半幅はこの緯度で最大になる
    // ので、ここで求める窓は行内の全点を覆う。セル中心ではなく行の端まで含めた
    // 最寄り緯度で見ないと、キャップが行の端だけを掠める配置で行ごと取りこぼす。
    const rowNearestLatitudeRad = clampValue(
      anchorLatitudeRad, rowTopRad - bandRad, rowTopRad);
    let firstColumn = 0;
    let columnCount = grid.width;
    const denominator = cosAnchorLatitude * Math.cos(rowNearestLatitudeRad);
    const numerator = cosCap - sinAnchorLatitude * Math.sin(rowNearestLatitudeRad);
    if (Math.abs(denominator) < DEGENERATE_EPSILON) {
      const poleDistanceRad = Math.acos(clampValue(
        sinAnchorLatitude * Math.sin(rowNearestLatitudeRad), -1, 1));
      if (poleDistanceRad > capAngularRadiusRad) continue;
    } else {
      const cosHalfWidth = numerator / denominator;
      if (cosHalfWidth >= 1) continue;
      if (cosHalfWidth > -1) {
        const halfWidthRad = Math.acos(cosHalfWidth);
        // キャップの経度窓が触れる列をすべて走る — セル幅単位の窓はセル中心ではなく
        // セル区画へ写す。窓が区画の境へ食い込むだけの配置で走査列が空になり、
        // footprint の全質量が未分配になるのを防ぐ。
        firstColumn = Math.floor(
          (anchorLongitudeRad - halfWidthRad + Math.PI) / cellWidthRad);
        columnCount = Math.floor(
          (anchorLongitudeRad + halfWidthRad + Math.PI) / cellWidthRad)
          - firstColumn + 1;
        if (columnCount >= grid.width) {
          firstColumn = 0;
          columnCount = grid.width;
        }
      }
    }
    const cellAreaM2 = cloudEquirectCellAreaM2(grid, row);
    const subBandRad = bandRad / OVERLAP_SUBCELLS_PER_SIDE;
    const subCellWidthRad = cellWidthRad / OVERLAP_SUBCELLS_PER_SIDE;
    for (let offset = 0; offset < columnCount; offset += 1) {
      const column = ((firstColumn + offset) % grid.width + grid.width) % grid.width;
      const cellIndex = row * grid.width + column;
      const longitudeLeftRad = -Math.PI + column * cellWidthRad;
      // 副セルの緯度帯もセル面積と同じ積分で実面積を立てる — 緯度帯内の和が
      // 親セルの実面積へ一致し、極側で潰れたセルでも副セル面積は正しい。
      // 積算の丸めで親セルを数万分の1だけ超えうるので、親セル面積で止める。
      let coveredCellAreaM2 = 0;
      for (let subRow = 0; subRow < OVERLAP_SUBCELLS_PER_SIDE; subRow += 1) {
        const subLatitudeTopRad = rowTopRad - subRow * subBandRad;
        const subCellAreaM2 = grid.sphereRadiusM * grid.sphereRadiusM * subCellWidthRad
          * (Math.sin(subLatitudeTopRad) - Math.sin(subLatitudeTopRad - subBandRad));
        const subLatitudeRad = subLatitudeTopRad - subBandRad / 2;
        const sinSubLatitude = Math.sin(subLatitudeRad);
        const flat = Math.cos(subLatitudeRad);
        for (let subColumn = 0; subColumn < OVERLAP_SUBCELLS_PER_SIDE; subColumn += 1) {
          const longitudeRad = longitudeLeftRad + (subColumn + 0.5) * subCellWidthRad;
          const point = projectToTangentPlane(
            v3(flat * Math.sin(longitudeRad), sinSubLatitude, flat * Math.cos(longitudeRad)),
            centerDirectionUnitVector, eastUnitVector, northUnitVector, grid.sphereRadiusM);
          if (cloudFootprintQuadraticAt(quadratic, point.x, point.y) <= 1) {
            coveredCellAreaM2 += subCellAreaM2;
          }
        }
      }
      if (coveredCellAreaM2 > 0) {
        const overlapAreaM2 = Math.min(coveredCellAreaM2, cellAreaM2);
        overlaps.push({ cellIndex, areaM2: overlapAreaM2 });
        coveredAreaM2 += overlapAreaM2;
      }
    }
  }
  if (coveredAreaM2 > metrics.areaM2) {
    const shrink = metrics.areaM2 / coveredAreaM2;
    for (const [index, overlap] of overlaps.entries()) {
      overlaps[index] = { cellIndex: overlap.cellIndex, areaM2: overlap.areaM2 * shrink };
    }
  }
  return { footprintAreaM2: metrics.areaM2, overlaps };
}
