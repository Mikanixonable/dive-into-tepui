// 円形・楕円形 footprint と局所接平面格子の交差面積・質量分配を検査する。
import * as assert from 'node:assert/strict';
import {
  cloudFootprintOverlap,
  type CloudFootprintCircle,
  type CloudFootprintEllipse,
  type CloudFootprintGrid,
} from '../../src/game/cloud/cloud-footprint-overlap';
import { depositCloudParcelMass } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const UNIT_CIRCLE: CloudFootprintCircle = { eastM: 0, northM: 0, radiusM: 1 };

function grid(
  originEastM: number,
  originNorthM: number,
  width: number,
  height: number,
  cellWidthM = 1,
  cellHeightM = 1,
): CloudFootprintGrid {
  return { originEastM, originNorthM, width, height, cellWidthM, cellHeightM };
}

function overlapAreaM2(overlaps: readonly { readonly areaM2: number }[]): number {
  return overlaps.reduce((total, overlap) => total + overlap.areaM2, 0);
}

function withinRelativeError(actual: number, expected: number, relativeTolerance = 1e-10): void {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relativeTolerance,
    `actual ${actual} should match ${expected} within relative error ${relativeTolerance}`);
}

// 独立基準: 楕円をアフィン変換(主軸座標へ回転→各軸を半軸で割る)で単位円へ
// 縮退させ、変換後の矩形(平行四辺形)と単位円の交差を、辺ごとの扇形・三角形の
// 符号付き面積の和として求める。実装の水平帯積分とは別のアルゴリズム
// (境界周回の解析和)で、精度は機械精度級。
function ellipseRectangleOracleAreaM2(
  ellipse: CloudFootprintEllipse,
  leftM: number,
  bottomM: number,
  rightM: number,
  topM: number,
): number {
  const cosAzimuth = Math.cos(ellipse.majorAxisAzimuthRad);
  const sinAzimuth = Math.sin(ellipse.majorAxisAzimuthRad);
  const toUnitCircle = (eastM: number, northM: number): readonly [number, number] => {
    const eastRelativeM = eastM - ellipse.eastM;
    const northRelativeM = northM - ellipse.northM;
    const alongM = eastRelativeM * cosAzimuth + northRelativeM * sinAzimuth;
    const acrossM = -eastRelativeM * sinAzimuth + northRelativeM * cosAzimuth;
    return [alongM / ellipse.majorRadiusM, acrossM / ellipse.minorRadiusM];
  };
  const corners = [
    toUnitCircle(leftM, bottomM),
    toUnitCircle(rightM, bottomM),
    toUnitCircle(rightM, topM),
    toUnitCircle(leftM, topM),
  ];
  // 辺 a→b について |a + t(b−a)|² = 1 の交点で分割し、内側部分は三角形、
  // 外側部分は扇形の寄与(ともに符号付き面積の2倍)を足す。
  let twiceArea = 0;
  for (const [index, from] of corners.entries()) {
    const to = corners[(index + 1) % corners.length]!;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const quadraticA = dx * dx + dy * dy;
    const quadraticB = 2 * (from[0] * dx + from[1] * dy);
    const quadraticC = from[0] * from[0] + from[1] * from[1] - 1;
    const split: number[] = [0];
    const discriminant = quadraticB * quadraticB - 4 * quadraticA * quadraticC;
    if (quadraticA > 0 && discriminant > 0) {
      const root = Math.sqrt(discriminant);
      for (const t of [(-quadraticB - root) / (2 * quadraticA),
        (-quadraticB + root) / (2 * quadraticA)]) {
        if (t > 0 && t < 1) split.push(t);
      }
    }
    split.push(1);
    split.sort((a, b) => a - b);
    const pointAt = (t: number): readonly [number, number] => [
      from[0] + t * dx, from[1] + t * dy,
    ];
    for (let segment = 0; segment < split.length - 1; segment += 1) {
      const start = pointAt(split[segment]!);
      const end = pointAt(split[segment + 1]!);
      const middle = pointAt((split[segment]! + split[segment + 1]!) / 2);
      const inside = middle[0] * middle[0] + middle[1] * middle[1] <= 1;
      if (inside) {
        // 原点・両端が成す三角形の符号付き面積の2倍。
        twiceArea += start[0] * end[1] - start[1] * end[0];
      } else {
        // 単位円の扇形。面積 θ/2 の2倍で、偏角差そのもの。
        twiceArea += Math.atan2(
          start[0] * end[1] - start[1] * end[0],
          start[0] * end[0] + start[1] * end[1],
        );
      }
    }
  }
  return Math.abs(twiceArea / 2) * ellipse.majorRadiusM * ellipse.minorRadiusM;
}

export function register(): void {
  test('cloud footprint overlap: analytic full, zero, half, and quarter disk oracles', () => {
    const full = cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2, 2));
    assert.equal(full.footprintAreaM2, Math.PI);
    withinRelativeError(overlapAreaM2(full.overlaps), Math.PI);

    assert.deepEqual(cloudFootprintOverlap(UNIT_CIRCLE, grid(2, 2, 1, 1)).overlaps, []);
    withinRelativeError(overlapAreaM2(
      cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, 0, 2, 1)).overlaps,
    ), Math.PI / 2);
    withinRelativeError(overlapAreaM2(
      cloudFootprintOverlap(UNIT_CIRCLE, grid(0, 0, 1, 1)).overlaps,
    ), Math.PI / 4);
  });

  test('cloud footprint overlap: a straight boundary crossing agrees with exact semicircle area', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(0, -1, 1, 2));
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI / 2);
    assert.deepEqual(coverage.overlaps.map(({ cellIndex }) => cellIndex), [0, 1]);
  });

  test('cloud footprint overlap: off-center circular segment agrees with its exact cap formula', () => {
    const offsetM = 0.3;
    const exactCapAreaM2 = Math.acos(offsetM) - offsetM * Math.sqrt(1 - offsetM * offsetM);
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(offsetM, -1, 1, 2));
    withinRelativeError(overlapAreaM2(coverage.overlaps), exactCapAreaM2, 1e-12);
  });

  test('cloud footprint overlap: a thin tangent cap retains its small positive area', () => {
    const leftM = 1 - 1e-8;
    const exactCapAreaM2 = Math.acos(leftM) - leftM * Math.sqrt((1 - leftM) * (1 + leftM));
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(leftM, -1, 1, 2, 1 - leftM));
    assert.equal(coverage.overlaps.length, 2);
    withinRelativeError(overlapAreaM2(coverage.overlaps), exactCapAreaM2, 1e-3);
  });

  test('cloud footprint overlap: complete finite grid conserves circle area across many cells', () => {
    const coverage = cloudFootprintOverlap(
      { eastM: 0.17, northM: -0.23, radiusM: 1.37 },
      grid(-2, -2, 4, 4),
    );
    withinRelativeError(overlapAreaM2(coverage.overlaps), coverage.footprintAreaM2, 1e-11);
    assert.ok(coverage.overlaps.length > 4);
    const massGrid = {
      cells: Array.from({ length: 16 }, () => ({ areaM2: 1 })),
      layerEdgesM: [0, 100],
    };
    const deposition = depositCloudParcelMass([{
      phase: 'ice', massKg: 7, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], massGrid);
    const assignedMassKg = deposition.columnsByLayer[0]!.iceKgM2ByCell.reduce(
      (total, columnKgM2, index) => total + columnKgM2 * massGrid.cells[index]!.areaM2, 0,
    );
    withinRelativeError(assignedMassKg, 7, 1e-14);
    assert.ok(deposition.unassignedMassKgByPhase.ice >= 0);
    assert.ok(deposition.unassignedMassKgByPhase.ice < 1e-14);
  });

  test('cloud footprint overlap: translating nearby geometry to a large origin preserves overlap areas', () => {
    const shiftM = 1e12;
    const local = cloudFootprintOverlap({ eastM: 0.17, northM: -0.23, radiusM: 1.37 }, grid(-2, -2, 4, 4));
    const translated = cloudFootprintOverlap(
      { eastM: shiftM + 0.17, northM: -shiftM - 0.23, radiusM: 1.37 },
      grid(shiftM - 2, -shiftM - 2, 4, 4),
    );
    assert.deepEqual(translated.overlaps.map(({ cellIndex }) => cellIndex),
      local.overlaps.map(({ cellIndex }) => cellIndex));
    for (let index = 0; index < local.overlaps.length; index += 1) {
      withinRelativeError(translated.overlaps[index]!.areaM2, local.overlaps[index]!.areaM2, 1e-3);
    }
  });

  test('cloud footprint overlap: huge grids visit only cells under the circle bounds', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, {
      originEastM: -1e12, originNorthM: -1,
      cellWidthM: 1, cellHeightM: 2,
      width: 2e12, height: 1,
    });
    assert.deepEqual(coverage.overlaps.map(({ cellIndex }) => cellIndex), [999_999_999_999, 1_000_000_000_000]);
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI);
  });

  test('cloud footprint overlap: a rectangle strictly inside the circle does not exceed its exact area', () => {
    const coverage = cloudFootprintOverlap({ eastM: 0, northM: 0, radiusM: 10 }, grid(0.5, -0.5, 1, 1));
    assert.deepEqual(coverage.overlaps, [{ cellIndex: 0, areaM2: 1 }]);
    const result = depositCloudParcelMass([{
      phase: 'liquid', massKg: 1, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], { cells: [{ areaM2: 1 }], layerEdgesM: [0, 100] });
    assert.equal(result.columnsByLayer[0]!.liquidKgM2ByCell[0], 1 / coverage.footprintAreaM2);
  });

  test('cloud footprint overlap: 4 km disk on 250 m cells clamps ULP overshoot and conserves full-grid mass', () => {
    const footprint = { eastM: 0, northM: 0, radiusM: 4_000 };
    const gridGeometry = grid(-8_000, -8_000, 64, 64, 250, 250);
    const coverage = cloudFootprintOverlap(footprint, gridGeometry);
    const cellAreaM2 = 250 ** 2;
    assert.ok(coverage.overlaps.every(({ areaM2 }) => areaM2 <= cellAreaM2));
    withinRelativeError(overlapAreaM2(coverage.overlaps), coverage.footprintAreaM2, 1e-12);

    const massGrid = {
      cells: Array.from({ length: 64 * 64 }, () => ({ areaM2: cellAreaM2 })),
      layerEdgesM: [0, 10_000],
    };
    const deposition = depositCloudParcelMass([{
      phase: 'liquid', massKg: 123_456, altitudeM: 5_000,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], massGrid);
    const assignedMassKg = deposition.columnsByLayer[0]!.liquidKgM2ByCell.reduce(
      (total, columnKgM2, index) => total + columnKgM2 * massGrid.cells[index]!.areaM2, 0,
    );
    withinRelativeError(assignedMassKg, 123_456, 1e-12);
    assert.equal(deposition.unassignedMassKgByPhase.liquid, 0);
  });

  test('cloud footprint overlap: clipped region leaves uncovered mass in deposition', () => {
    const coverage = cloudFootprintOverlap(UNIT_CIRCLE, grid(0, -0.5, 1, 1));
    const gridForMass = {
      cells: [{ areaM2: 1 }],
      layerEdgesM: [0, 100],
    };
    const result = depositCloudParcelMass([{
      phase: 'liquid', massKg: 10, altitudeM: 50,
      footprintAreaM2: coverage.footprintAreaM2, overlaps: coverage.overlaps,
    }], gridForMass);
    const assignedMassKg = result.columnsByLayer[0]!.liquidKgM2ByCell[0]!;
    withinRelativeError(assignedMassKg, 10 * overlapAreaM2(coverage.overlaps) / Math.PI);
    assert.ok(result.unassignedMassKgByPhase.liquid > 0);
    withinRelativeError(assignedMassKg + result.unassignedMassKgByPhase.liquid, 10);
  });

  test('cloud footprint overlap: invalid geometry is rejected', () => {
    assert.throws(() => cloudFootprintOverlap({ ...UNIT_CIRCLE, radiusM: 0 }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap({ ...UNIT_CIRCLE, eastM: Number.NaN }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 0, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2.5, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(UNIT_CIRCLE, grid(-1, -1, 2, 2, 0, 1)), RangeError);
  });

  test('cloud footprint overlap: equal-axis ellipse at any rotation reproduces the circle', () => {
    for (const azimuthRad of [0, Math.PI / 5, Math.PI / 2, 2.4]) {
      const ellipse: CloudFootprintEllipse = {
        eastM: 0.17, northM: -0.23,
        majorRadiusM: 1.37, minorRadiusM: 1.37, majorAxisAzimuthRad: azimuthRad,
      };
      const circle = cloudFootprintOverlap(
        { eastM: 0.17, northM: -0.23, radiusM: 1.37 }, grid(-2, -2, 4, 4));
      const coverage = cloudFootprintOverlap(ellipse, grid(-2, -2, 4, 4));
      assert.equal(coverage.footprintAreaM2, circle.footprintAreaM2);
      assert.deepEqual(coverage.overlaps.map(({ cellIndex }) => cellIndex),
        circle.overlaps.map(({ cellIndex }) => cellIndex));
      for (const [index, overlap] of coverage.overlaps.entries()) {
        withinRelativeError(overlap.areaM2, circle.overlaps[index]!.areaM2, 1e-12);
      }
    }
  });

  test('cloud footprint overlap: rotated ellipse matches an independent circle-polygon oracle', () => {
    const ellipse: CloudFootprintEllipse = {
      eastM: 0.3, northM: -0.2,
      majorRadiusM: 1.9, minorRadiusM: 0.6, majorAxisAzimuthRad: 0.6,
    };
    const geometry = grid(-4, -3, 8, 6);
    const coverage = cloudFootprintOverlap(ellipse, geometry);
    withinRelativeError(coverage.footprintAreaM2, Math.PI * 1.9 * 0.6);
    // セルごとの交差をアフィン縮退→円∩平行四辺形の独立基準と照合する。
    for (const overlap of coverage.overlaps) {
      const column = overlap.cellIndex % geometry.width;
      const row = (overlap.cellIndex - column) / geometry.width;
      const leftM = geometry.originEastM + column * geometry.cellWidthM;
      const bottomM = geometry.originNorthM + row * geometry.cellHeightM;
      const expected = ellipseRectangleOracleAreaM2(
        ellipse, leftM, bottomM, leftM + geometry.cellWidthM, bottomM + geometry.cellHeightM);
      withinRelativeError(overlap.areaM2, expected, 1e-9);
    }
    // 格子が footprint を含むので、交差の総和は楕円面積に一致する。
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI * 1.9 * 0.6, 1e-11);
  });

  test('cloud footprint overlap: ellipse axis-aligned and clipped cases agree with the oracle', () => {
    const ellipse: CloudFootprintEllipse = {
      eastM: 0, northM: 0, majorRadiusM: 2, minorRadiusM: 0.5, majorAxisAzimuthRad: 0,
    };
    const geometry = grid(-4, -2, 8, 4, 1, 1);
    const coverage = cloudFootprintOverlap(ellipse, geometry);
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI * 2 * 0.5, 1e-11);
    // 右半分を切る格子では交差は半面積になる(左右対称)。
    const half = cloudFootprintOverlap(ellipse, grid(0, -2, 4, 4, 1, 1));
    withinRelativeError(overlapAreaM2(half.overlaps), Math.PI * 2 * 0.5 / 2, 1e-11);
    for (const overlap of coverage.overlaps) {
      const column = overlap.cellIndex % geometry.width;
      const row = (overlap.cellIndex - column) / geometry.width;
      const leftM = geometry.originEastM + column * geometry.cellWidthM;
      const bottomM = geometry.originNorthM + row * geometry.cellHeightM;
      withinRelativeError(overlap.areaM2, ellipseRectangleOracleAreaM2(
        ellipse, leftM, bottomM, leftM + geometry.cellWidthM, bottomM + geometry.cellHeightM), 1e-9);
    }
  });

  test('cloud footprint overlap: a very thin ellipse still conserves its area', () => {
    // 短半径が長半径の 1/10⁴ でも退化せず、oracle の平行四辺形基準と一致する。
    const ellipse: CloudFootprintEllipse = {
      eastM: 0, northM: 0.1,
      majorRadiusM: 1, minorRadiusM: 1e-4, majorAxisAzimuthRad: 0.35,
    };
    const geometry = grid(-2, -2, 8, 8, 0.5, 0.5);
    const coverage = cloudFootprintOverlap(ellipse, geometry);
    assert.ok(coverage.overlaps.length > 0);
    withinRelativeError(overlapAreaM2(coverage.overlaps), Math.PI * 1e-4, 1e-6);
    for (const overlap of coverage.overlaps) {
      const column = overlap.cellIndex % geometry.width;
      const row = (overlap.cellIndex - column) / geometry.width;
      const leftM = geometry.originEastM + column * geometry.cellWidthM;
      const bottomM = geometry.originNorthM + row * geometry.cellHeightM;
      const expected = ellipseRectangleOracleAreaM2(
        ellipse, leftM, bottomM, leftM + geometry.cellWidthM, bottomM + geometry.cellHeightM);
      assert.ok(Math.abs(overlap.areaM2 - expected) < 1e-12,
        `cell ${overlap.cellIndex}: ${overlap.areaM2} vs oracle ${expected}`);
    }
  });

  test('cloud footprint overlap: invalid ellipse geometry is rejected', () => {
    const ellipse: CloudFootprintEllipse = {
      eastM: 0, northM: 0, majorRadiusM: 2, minorRadiusM: 1, majorAxisAzimuthRad: 0,
    };
    assert.throws(() => cloudFootprintOverlap(
      { ...ellipse, minorRadiusM: 0 }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(
      { ...ellipse, minorRadiusM: -1 }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(
      { ...ellipse, majorRadiusM: 0.5 }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(
      { ...ellipse, majorAxisAzimuthRad: Number.NaN }, grid(-1, -1, 2, 2)), RangeError);
    assert.throws(() => cloudFootprintOverlap(
      { ...ellipse, majorRadiusM: Number.POSITIVE_INFINITY }, grid(-1, -1, 2, 2)), RangeError);
  });
}
