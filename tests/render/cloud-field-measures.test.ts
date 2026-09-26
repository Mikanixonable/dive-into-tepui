import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  cloudExtinctionLayersFromVolume,
  cloudOpticalVolumeLayerPlane,
  equivalentDiameterM,
  fieldValueCentroid,
  interiorHoleShare,
  labelFieldComponents,
  measureComponentPersistence,
  unionShiftedSupportAreaM2,
  type CloudFieldPlane,
} from '../../tools/cloud-lab/meteorological-field-measures';
import { directionalPowerSpectrum } from '../../tools/cloud-lab/meteorological-field-spectrum';
import {
  buildC9TwoDiscField,
  buildCellFieldPlane,
  buildCellFieldSeries,
  buildWaveFieldPlane,
} from '../../tools/cloud-lab/meteorological-fixture-fields';
import { integrateCloudLocalFieldRayCpu } from '../../src/render/cloud/cloud-local-field';
import { v3 } from '../../src/math/vec3';

function plane(values: readonly number[], width: number, height: number): CloudFieldPlane {
  return {
    width,
    height,
    cellWidthM: 100,
    cellHeightM: 100,
    originEastM: -width * 50,
    originNorthM: -height * 50,
    values: Float32Array.from(values),
  };
}

export function register(): void {
  test('field measures: connected components find cells, boundary touch, and weighted centroids', () => {
    // 5x5: 内部に 2x2 の雲ブロックと、縁へ触れる孤立セル。孤立セルはブロックから
    // 2 セル以上離すので、8 近傍でも別成分のまま。
    const grid = [
      0, 0, 0, 0, 1,
      0, 0, 0, 0, 0,
      0, 2, 2, 0, 0,
      0, 2, 2, 0, 0,
      0, 0, 0, 0, 0,
    ];
    const p = plane(grid, 5, 5);
    const labeled = labelFieldComponents(p, 0, 'above', false);
    assert.equal(labeled.components.length, 2);
    const block = labeled.components.find((component) => component.cellCount === 4)!;
    assert.equal(block.touchesBoundary, false);
    assert.ok(Math.abs(block.centroidEastM + 50) < 1e-12);
    assert.ok(Math.abs(block.centroidNorthM - 50) < 1e-12);
    const edge = labeled.components.find((component) => component.cellCount === 1)!;
    assert.equal(edge.touchesBoundary, true);
    const diagonal = labelFieldComponents(p, 0, 'above', true);
    assert.equal(diagonal.components.length, 2);
  });

  test('field measures: interior hole share counts only enclosed clear components', () => {
    // 5x5 の外周と内側リングを雲、中央 1 セルと隅(縁)を晴れにする。
    const grid = [
      0, 1, 1, 1, 0,
      1, 1, 1, 1, 1,
      1, 1, 0, 1, 1,
      1, 1, 1, 1, 1,
      0, 1, 1, 1, 0,
    ];
    const p = plane(grid, 5, 5);
    const clear = labelFieldComponents(p, 0, 'at-or-below', false);
    const holes = interiorHoleShare(clear, 25);
    // 内部の穴は中央の 1 セルだけ。隅は 4 近傍では縁へ接する。
    assert.equal(holes.interiorComponentCount, 1);
    assert.equal(holes.interiorShare, 1 / 25);
  });

  test('field measures: value centroid follows the weight distribution', () => {
    const grid = [
      0, 0, 0, 0,
      0, 1, 3, 0,
      0, 0, 0, 0,
    ];
    const p = plane(grid, 4, 3);
    const centroid = fieldValueCentroid(p)!;
    // 重み 1 と 3 の重心はセル中心 (50,50) と (150,50) の重み付き平均 (125,50)。
    assert.ok(Math.abs(centroid.eastM - 25) < 1e-9);
    assert.ok(Math.abs(centroid.northM - 0) < 1e-9);
    assert.equal(fieldValueCentroid(plane([0, 0, 0, 0], 2, 2)), null);
  });

  test('field measures: equivalent diameter and shifted union support', () => {
    assert.ok(Math.abs(equivalentDiameterM(4, 25) - Math.sqrt(400 / Math.PI)) < 1e-9);
    const p = plane([
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ], 4, 4);
    // 同じ mask を東へ 1 セルずらして重ねると和集合は 2 セル。
    const area = unionShiftedSupportAreaM2([
      { plane: p, shiftEastCells: 0, shiftNorthCells: 0, memberThreshold: 0 },
      { plane: p, shiftEastCells: 1, shiftNorthCells: 0, memberThreshold: 0 },
    ]);
    assert.equal(area, 2 * 100 * 100);
  });

  test('field measures: persistence tracks components across frames', () => {
    const member = (cells: readonly number[]): Uint8Array => {
      const mask = new Uint8Array(16);
      for (const cell of cells) mask[cell] = 1;
      return mask;
    };
    const frames = [
      { timeMinutes: 0, memberCells: member([5, 6, 13]) },
      { timeMinutes: 10, memberCells: member([5, 6, 13]) },
      { timeMinutes: 20, memberCells: member([5, 6]) },
      { timeMinutes: 30, memberCells: member([5, 6]) },
    ];
    // 下端の孤立セル(13)は 10 分まで存続し、2 セルブロック(5,6)は全系列を存続する。
    const { durationsMinutes } = measureComponentPersistence(
      frames, 4, 4, 100, 100, -200, -200, false);
    assert.equal(durationsMinutes.length, 2);
    assert.ok(durationsMinutes.includes(10));
    assert.ok(durationsMinutes.includes(30));
  });

  test('field spectrum: directional power of a plane wave peaks at the propagation azimuth', () => {
    const wave = buildWaveFieldPlane({
      cellCount: 64, spanM: 60_000, wavelengthM: 10_000,
      propagationAzimuthRad: Math.PI / 2, extinctionPerM: 1e-4,
    });
    const spectrum = directionalPowerSpectrum(wave, 18);
    assert.ok(Math.abs(spectrum.peakComponentAzimuthRad! - Math.PI / 2) < 1e-12);
    assert.ok(spectrum.directionalConcentration > 0.9);
    // 直交方位の波は 0° へピークを立てる。
    const eastWave = buildWaveFieldPlane({
      cellCount: 64, spanM: 60_000, wavelengthM: 10_000,
      propagationAzimuthRad: 0, extinctionPerM: 1e-4,
    });
    const eastSpectrum = directionalPowerSpectrum(eastWave, 18);
    assert.ok(Math.abs(eastSpectrum.peakComponentAzimuthRad!) < 1e-12);
  });

  test('c9 fixture: two discs integrate to the fixed analytic optical depths', () => {
    const { data, frame } = buildC9TwoDiscField({ eastM: 0, northM: 0 }, { eastM: 0, northM: 0 });
    const vertical = integrateCloudLocalFieldRayCpu(
      v3(0, 0, 1), v3(0, 0, 1), data, frame, 1_024);
    assert.ok(Math.abs(vertical.liquidTau - 0.4) < 0.005);
    assert.ok(Math.abs(vertical.iceTau - 0.2) < 0.005);
    assert.ok(Math.abs(vertical.transmittance - Math.exp(-0.6)) < 0.005);
    const slant = integrateCloudLocalFieldRayCpu(
      v3(0, 0, 1), v3(Math.SQRT1_2, 0, Math.SQRT1_2), data, frame, 1_024);
    assert.ok(Math.abs(slant.totalTau - 0.6 / Math.SQRT1_2) < 0.005);
    // 層抽出の確認: 層 0 は液水、層 1 は空隙、層 2 は氷。
    const grid = {
      originEastM: frame.gridOriginEastM, originNorthM: frame.gridOriginNorthM,
      cellWidthM: frame.cellWidthM, cellHeightM: frame.cellHeightM,
    };
    const gapPlane = cloudOpticalVolumeLayerPlane(data, grid, 1, 'liquid');
    assert.ok(gapPlane.values.every((value) => value === 0));
    const layers = cloudExtinctionLayersFromVolume(data);
    assert.equal(layers.length, 3);
    assert.equal(layers[1]!.lowerAltitudeM, 3_000);
    assert.equal(layers[1]!.upperAltitudeM, 6_000);
  });

  test('c8 fixture: open-cell web leaves enclosed holes and a finite lifetime series', () => {
    const cellPlane = buildCellFieldPlane();
    const clear = labelFieldComponents(cellPlane, 0, 'at-or-below', false);
    const holes = interiorHoleShare(clear, cellPlane.width * cellPlane.height);
    assert.ok(holes.interiorComponentCount > 0);
    assert.ok(holes.interiorShare > 0 && holes.interiorShare < 1);
    const series = buildCellFieldSeries();
    assert.equal(series.length, 7);
    // 30 分以降で中央の穴が埋まる。
    const early = labelFieldComponents(series[0]!.plane, 0, 'at-or-below', false);
    const late = labelFieldComponents(series[6]!.plane, 0, 'at-or-below', false);
    assert.ok(interiorHoleShare(late, 64 * 64).interiorComponentCount
      < interiorHoleShare(early, 64 * 64).interiorComponentCount);
  });
}
