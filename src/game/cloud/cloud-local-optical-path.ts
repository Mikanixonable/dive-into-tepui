// 局所接平面の有限セルと高度層を通る線分の消散を、相別の格子場から厳密に積分する CPU 基準。
// セル・層の内部では消散係数を一定とみなす。散乱、曲がる光路、地球の曲率は含まない。

import type { CloudFootprintGrid } from './cloud-footprint-overlap';
import type { CloudExtinctionLayer } from './cloud-mass-extinction';

export interface CloudLocalPoint {
  readonly eastM: number;
  readonly northM: number;
  readonly altitudeM: number;
}

export interface CloudLocalOpticalPath {
  readonly liquidOpticalDepth: number;
  readonly iceOpticalDepth: number;
  readonly transmittance: number;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

function intersectAxis(
  start: number,
  delta: number,
  lower: number,
  upper: number,
  interval: Interval,
): Interval | null {
  if (delta === 0) return start >= lower && start < upper ? interval : null;
  const a = (lower - start) / delta;
  const b = (upper - start) / delta;
  const clipped = { start: Math.max(interval.start, Math.min(a, b)), end: Math.min(interval.end, Math.max(a, b)) };
  return clipped.end > clipped.start ? clipped : null;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function validate(
  from: CloudLocalPoint,
  to: CloudLocalPoint,
  grid: CloudFootprintGrid,
  layers: readonly CloudExtinctionLayer[],
): void {
  for (const [name, value] of Object.entries({
    fromEastM: from.eastM, fromNorthM: from.northM, fromAltitudeM: from.altitudeM,
    toEastM: to.eastM, toNorthM: to.northM, toAltitudeM: to.altitudeM,
    originEastM: grid.originEastM, originNorthM: grid.originNorthM,
    cellWidthM: grid.cellWidthM, cellHeightM: grid.cellHeightM,
  })) requireFinite(value, name);
  if (!Number.isSafeInteger(grid.width) || grid.width <= 0
    || !Number.isSafeInteger(grid.height) || grid.height <= 0
    || !Number.isSafeInteger(grid.width * grid.height)
    || grid.cellWidthM <= 0 || grid.cellHeightM <= 0) {
    throw new RangeError('grid dimensions must be finite and positive');
  }
  if (!Number.isFinite(grid.originEastM + grid.width * grid.cellWidthM)
    || !Number.isFinite(grid.originNorthM + grid.height * grid.cellHeightM)) {
    throw new RangeError('grid extent must be finite');
  }
  let previousTopM = Number.NEGATIVE_INFINITY;
  for (const layer of layers) {
    requireFinite(layer.lowerAltitudeM, 'lowerAltitudeM');
    requireFinite(layer.upperAltitudeM, 'upperAltitudeM');
    if (layer.upperAltitudeM <= layer.lowerAltitudeM || layer.lowerAltitudeM < previousTopM
      || layer.liquidPerMByCell.length !== grid.width * grid.height
      || layer.icePerMByCell.length !== grid.width * grid.height) {
        throw new RangeError('layer altitude or cell count is invalid');
    }
    previousTopM = layer.upperAltitudeM;
    for (const coefficient of layer.liquidPerMByCell) {
      if (!Number.isFinite(coefficient) || coefficient < 0) {
        throw new RangeError('layer extinction must be finite and non-negative');
      }
    }
    for (const coefficient of layer.icePerMByCell) {
      if (!Number.isFinite(coefficient) || coefficient < 0) {
        throw new RangeError('layer extinction must be finite and non-negative');
      }
    }
  }
}

// 表示・太陽のどちらの線分も同じ積分器へ渡せる。格子外の線分部分は透明。
export function integrateCloudLocalOpticalPath(
  from: CloudLocalPoint,
  to: CloudLocalPoint,
  grid: CloudFootprintGrid,
  layers: readonly CloudExtinctionLayer[],
): CloudLocalOpticalPath {
  validate(from, to, grid, layers);
  const de = to.eastM - from.eastM;
  const dn = to.northM - from.northM;
  const dz = to.altitudeM - from.altitudeM;
  const lengthM = Math.hypot(de, dn, dz);
  if (!Number.isFinite(lengthM)) throw new RangeError('optical path length must be finite');
  if (lengthM === 0 || layers.length === 0) {
    return { liquidOpticalDepth: 0, iceOpticalDepth: 0, transmittance: 1 };
  }
  const firstColumn = Math.max(0, Math.floor(
    (Math.min(from.eastM, to.eastM) - grid.originEastM) / grid.cellWidthM,
  ));
  const lastColumn = Math.min(grid.width - 1, Math.floor(
    (Math.max(from.eastM, to.eastM) - grid.originEastM) / grid.cellWidthM,
  ));
  const firstRow = Math.max(0, Math.floor(
    (Math.min(from.northM, to.northM) - grid.originNorthM) / grid.cellHeightM,
  ));
  const lastRow = Math.min(grid.height - 1, Math.floor(
    (Math.max(from.northM, to.northM) - grid.originNorthM) / grid.cellHeightM,
  ));
  let liquidOpticalDepth = 0;
  let iceOpticalDepth = 0;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const south = grid.originNorthM + row * grid.cellHeightM;
    const north = south + grid.cellHeightM;
    const yInterval = intersectAxis(from.northM, dn, south, north, { start: 0, end: 1 });
    if (yInterval === null) continue;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const west = grid.originEastM + column * grid.cellWidthM;
      const east = west + grid.cellWidthM;
      const xyInterval = intersectAxis(from.eastM, de, west, east, yInterval);
      if (xyInterval === null) continue;
      const cellIndex = row * grid.width + column;
      for (const layer of layers) {
        const xyzInterval = intersectAxis(
          from.altitudeM, dz, layer.lowerAltitudeM, layer.upperAltitudeM, xyInterval,
        );
        if (xyzInterval === null) continue;
        const distanceM = (xyzInterval.end - xyzInterval.start) * lengthM;
        liquidOpticalDepth += distanceM * layer.liquidPerMByCell[cellIndex]!;
        iceOpticalDepth += distanceM * layer.icePerMByCell[cellIndex]!;
      }
    }
  }
  if (!Number.isFinite(liquidOpticalDepth) || !Number.isFinite(iceOpticalDepth)) {
    throw new RangeError('optical depth must be finite');
  }
  return {
    liquidOpticalDepth,
    iceOpticalDepth,
    transmittance: Math.exp(-liquidOpticalDepth - iceOpticalDepth),
  };
}
