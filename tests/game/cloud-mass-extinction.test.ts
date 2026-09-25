// 面積質量列から相別の消散係数への変換を独立式と零水量で検査する。
import * as assert from 'node:assert/strict';
import { depositCloudParcelMass } from '../../src/game/cloud/cloud-mass-deposition';
import { extinctionFromCloudMass } from '../../src/game/cloud/cloud-mass-extinction';
import { test } from '../harness';

export function register(): void {
  test('cloud mass extinction: phase columns yield distinct optical depths by layer', () => {
    const deposition = depositCloudParcelMass([
      {
        phase: 'liquid', massKg: 0.2, altitudeM: 500, footprintAreaM2: 1,
        overlaps: [{ cellIndex: 0, areaM2: 1 }],
      },
      {
        phase: 'ice', massKg: 0.1, altitudeM: 1500, footprintAreaM2: 1,
        overlaps: [{ cellIndex: 0, areaM2: 1 }],
      },
    ], { cells: [{ areaM2: 1 }, { areaM2: 1 }], layerEdgesM: [0, 1000, 3000] });
    const layers = extinctionFromCloudMass(deposition, [
      { liquidEffectiveRadiusM: 10e-6, iceEffectiveRadiusM: 30e-6, iceExtinctionEfficiency: 2 },
      { liquidEffectiveRadiusM: 10e-6, iceEffectiveRadiusM: 50e-6, iceExtinctionEfficiency: 2 },
    ]);
    assert.equal(layers.length, 2);
    assert.ok(Math.abs(layers[0]!.liquidPerMByCell[0]! * 1000 - 30) < 1e-12);
    assert.equal(layers[0]!.icePerMByCell[0], 0);
    assert.ok(Math.abs(layers[1]!.icePerMByCell[0]! * 2000 - 3 * 2 * 0.1 / (4 * 917 * 50e-6)) < 1e-12);
    assert.equal(layers[1]!.liquidPerMByCell[0], 0);
    assert.equal(layers[0]!.liquidPerMByCell[1], 0);
    assert.equal(layers[1]!.icePerMByCell[1], 0);
  });

  test('cloud mass extinction: rejects missing or unphysical microphysics and columns', () => {
    const deposition = depositCloudParcelMass([], {
      cells: [{ areaM2: 1 }], layerEdgesM: [0, 100],
    });
    const good = { liquidEffectiveRadiusM: 10e-6, iceEffectiveRadiusM: 30e-6, iceExtinctionEfficiency: 2 };
    assert.throws(() => extinctionFromCloudMass(deposition, []), RangeError);
    assert.throws(() => extinctionFromCloudMass(deposition, [{ ...good, liquidEffectiveRadiusM: 0 }]), RangeError);
    assert.throws(() => extinctionFromCloudMass(deposition, [{ ...good, iceEffectiveRadiusM: Number.NaN }]), RangeError);
    assert.throws(() => extinctionFromCloudMass(deposition, [{ ...good, iceExtinctionEfficiency: -1 }]), RangeError);
    assert.throws(() => extinctionFromCloudMass({
      ...deposition,
      columnsByLayer: [{ ...deposition.columnsByLayer[0]!, liquidKgM2ByCell: [-1] }],
    }, [good]), RangeError);
    assert.throws(() => extinctionFromCloudMass({
      ...deposition,
      columnsByLayer: [{ ...deposition.columnsByLayer[0]!, iceKgM2ByCell: [] }],
    }, [good]), RangeError);
  });
}
