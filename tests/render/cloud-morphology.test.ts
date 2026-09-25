import * as assert from 'node:assert/strict';
import {
  deepConvectivePenetrationFraction,
  marineBoundaryLayerDiagnostics,
  waveCloudDiagnostics,
} from '../../src/render/cloud/cloud-morphology';
import { test } from '../harness';

export function register(): void {
  test('cloud morphology: marine organization responds to environment without latitude input', () => {
    const organized = marineBoundaryLayerDiagnostics({
      oceanFraction: 1, relativeHumidity: 0.85, subsidenceMps: 0.02,
      cloudTopCoolingKPerS: 1.5e-4, inversionStrengthK: 6, convectiveActivity: 0.2,
    });
    const dry = marineBoundaryLayerDiagnostics({
      oceanFraction: 1, relativeHumidity: 0.4, subsidenceMps: 0.02,
      cloudTopCoolingKPerS: 1.5e-4, inversionStrengthK: 6, convectiveActivity: 0.2,
    });
    assert.ok(organized.organization > dry.organization);
    assert.ok(organized.cellDiameterKm > 10);
    assert.ok(organized.holeFraction > 0);
    assert.ok(Math.abs(
      organized.openCellFraction + organized.closedCellFraction - organized.organization,
    ) < 1e-12);
  });

  test('cloud morphology: coherent wave power requires humid lifted air', () => {
    const moist = waveCloudDiagnostics({
      humidityFactor: 1, verticalDisplacementM: 500,
      horizontalWavelengthM: 10_000, phaseSpeedMps: 8,
    });
    const dry = waveCloudDiagnostics({
      humidityFactor: 0.5, verticalDisplacementM: 500,
      horizontalWavelengthM: 10_000, phaseSpeedMps: 8,
    });
    assert.ok(moist.directionalPower > dry.directionalPower);
    assert.equal(moist.wavelengthKm, 10);
    assert.equal(moist.phaseTravelMPerHour, 28_800);
  });

  test('cloud morphology: normalized convective reach is bounded and monotone', () => {
    const shallow = deepConvectivePenetrationFraction(2_000, 1_500, 12_000);
    const deep = deepConvectivePenetrationFraction(9_000, 1_500, 12_000);
    assert.ok(shallow >= 0 && shallow <= 1);
    assert.ok(deep > shallow);
    assert.equal(deepConvectivePenetrationFraction(1_000, 1_500, 12_000), 0);
  });
}
