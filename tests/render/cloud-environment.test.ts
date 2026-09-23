import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  createCloudEnvironmentProfile,
  type CloudEnvironmentInput,
  type CloudEnvironmentLevelInput,
} from '../../src/game/cloud/cloud-environment';

function makeInput(options: {
  readonly inversionK?: number;
  readonly upperHumidityScale?: number;
  readonly lapseRateKPerKm?: number;
  readonly eastWindMps?: number;
  readonly northWindMps?: number;
  readonly splitWindDirections?: boolean;
  readonly includeWave?: boolean;
} = {}): CloudEnvironmentInput {
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let index = 0; index <= 24; index += 1) {
    const heightM = index * 250;
    const inversionK = options.inversionK ?? 0;
    const inversionFraction = Math.max(0, Math.min(1, (heightM - 1_000) / 250));
    const upperHumidityScale = options.upperHumidityScale ?? 1;
    const humidityScale = heightM < 4_000 ? 1 : upperHumidityScale;
    levels.push({
      heightM,
      pressurePa: 100_000 * Math.exp(-heightM / 8_400),
      temperatureK: 289 - (options.lapseRateKPerKm ?? 6.5) * heightM / 1_000
        + inversionK * inversionFraction,
      waterVaporSpecificHumidityKgPerKg: 0.009 * Math.exp(-heightM / 2_200) * humidityScale,
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: options.eastWindMps ?? (options.splitWindDirections
        ? (heightM < 2_000 ? 10 : 0)
        : (heightM < 2_000 ? 5 : 20)),
      northWindMps: options.northWindMps ?? (options.splitWindDirections && heightM >= 2_000 ? 10 : 0),
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return {
    levels,
    surfaceSensibleHeatFluxWPerM2: 80,
    surfaceLatentHeatFluxWPerM2: 120,
    cloudTopLongwaveCoolingKPerS: 1e-4,
    gravityWaveSource: options.includeWave === false
      ? null
      : {
        sourceHeightM: 5_500,
        verticalDisplacementM: 500,
        horizontalWavelengthM: 10_000,
        verticalWavelengthM: 5_000,
        propagationAzimuthRad: Math.PI / 2,
      },
    upperIceLayerBottomM: 5_500,
    upperIceLayerTopM: 6_000,
  };
}

function maximumPositiveBuoyancyHeightM(input: CloudEnvironmentInput): number {
  let maximumHeightM = 0;
  for (const level of createCloudEnvironmentProfile(input).parcel.profile) {
    if (level.buoyancyMPerS2 > 0) maximumHeightM = level.heightM;
  }
  return maximumHeightM;
}

export function register(): void {
  test('cloud environment: prescribed controls produce deterministic immutable profiles', () => {
    const input = makeInput();
    const first = createCloudEnvironmentProfile(input);
    const second = createCloudEnvironmentProfile(input);
    assert.deepEqual(first, second);
    assert.equal(first.surfaceSensibleHeatFluxWPerM2, 80);
    assert.equal(first.surfaceLatentHeatFluxWPerM2, 120);
    assert.equal(first.cloudTopLongwaveCoolingKPerS, 1e-4);
    assert.ok(first.columnWaterVaporKgPerM2 > 0);
    const condensateInput: CloudEnvironmentInput = {
      ...input,
      levels: input.levels.map((level) => ({
        ...level,
        liquidWaterMixingRatioKgPerKg: 4e-4,
        iceMixingRatioKgPerKg: 2e-4,
      })),
    };
    assert.ok(Math.abs(createCloudEnvironmentProfile(condensateInput).columnWaterVaporKgPerM2
      - first.columnWaterVaporKgPerM2) < 1e-12);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.levels));
    assert.ok(Object.isFrozen(first.levels[0]));
    assert.ok(Object.isFrozen(first.parcel.profile));
    assert.throws(() => createCloudEnvironmentProfile({
      ...input,
      levels: [input.levels[0]!],
    }), RangeError);
  });

  test('cloud environment: prescribed wind directions differ by height; track transport is not evaluated', () => {
    const profile = createCloudEnvironmentProfile(makeInput({ splitWindDirections: true }));
    assert.ok(profile.levels[4]!.eastWindMps > profile.levels[4]!.northWindMps);
    assert.ok(profile.levels[20]!.northWindMps > profile.levels[20]!.eastWindMps);
    assert.equal(profile.gravityWaveDriver.northwardPhaseSpeedMps,
      profile.gravityWaveDriver.horizontalPhaseSpeedMps);
    assert.ok(Math.abs(profile.gravityWaveDriver.eastwardPhaseSpeedMps) < 1e-12);
  });

  test('cloud environment: upper-layer drying lowers the coefficient supplied to ice-lifetime evaluation', () => {
    const moist = createCloudEnvironmentProfile(makeInput());
    const dry = createCloudEnvironmentProfile(makeInput({ upperHumidityScale: 0.25 }));
    assert.ok(dry.upperIceMoistureFactor < moist.upperIceMoistureFactor);
    assert.ok(dry.upperIceMoistureFactor >= 0);
    assert.ok(dry.upperIceMoistureFactor <= 1);
  });

  test('cloud environment: a stronger inversion increases stability and suppresses parcel ascent', () => {
    const weakInput = makeInput({ inversionK: 0.5 });
    const strongInput = makeInput({ inversionK: 8 });
    const weak = createCloudEnvironmentProfile(weakInput);
    const strong = createCloudEnvironmentProfile(strongInput);
    assert.ok(strong.boundaryLayer.potentialTemperatureIncreaseK
      > weak.boundaryLayer.potentialTemperatureIncreaseK);
    assert.ok(strong.layerStability[4]!.buoyancyFrequencySquaredPerS2
      > weak.layerStability[4]!.buoyancyFrequencySquaredPerS2);
    assert.ok(maximumPositiveBuoyancyHeightM(strongInput)
      < maximumPositiveBuoyancyHeightM(weakInput));
  });

  test('cloud environment: source-wave dispersion and saturation gate are diagnostic; material tracks are not advanced', () => {
    const stable = createCloudEnvironmentProfile(makeInput({ lapseRateKPerKm: 3 }));
    const unstable = createCloudEnvironmentProfile(makeInput({ lapseRateKPerKm: 12 }));
    const absent = createCloudEnvironmentProfile(makeInput({ lapseRateKPerKm: 3, includeWave: false }));
    assert.equal(stable.gravityWaveDriver.active, true, 'stable stratification with a source activates the driver');
    assert.ok(stable.gravityWaveDriver.restoringAccelerationMagnitudeMPerS2 > 0);
    assert.ok(stable.gravityWaveDriver.intrinsicAngularFrequencyRadPerS > 0);
    const sourceLevel = stable.levels.find((level) => level.heightM === 5_500)!;
    const expectedLiftedTemperatureK = sourceLevel.temperatureK - 9.80665 / 1004 * 500;
    const expectedLiftedPressurePa = sourceLevel.pressurePa
      * (expectedLiftedTemperatureK / sourceLevel.temperatureK) ** (1004 / 287.05);
    assert.equal(stable.gravityWaveDriver.liftedAirTemperatureK, expectedLiftedTemperatureK);
    assert.ok(Math.abs(stable.gravityWaveDriver.liftedAirPressurePa! - expectedLiftedPressurePa) < 1e-8);
    assert.equal(unstable.gravityWaveDriver.active, false);
    assert.equal(unstable.gravityWaveDriver.restoringAccelerationMagnitudeMPerS2, 0);
    assert.equal(unstable.gravityWaveDriver.intrinsicAngularFrequencyRadPerS, 0);
    assert.equal(absent.gravityWaveDriver.active, false);
    const saturated = createCloudEnvironmentProfile(makeInput({ upperHumidityScale: 1.3 }));
    const unsaturated = createCloudEnvironmentProfile(makeInput({ upperHumidityScale: 0.1 }));
    assert.equal(saturated.gravityWaveDriver.active, true);
    assert.equal(unsaturated.gravityWaveDriver.active, true);
    assert.equal(saturated.gravityWaveDriver.cloudCondensationPossible, true,
      'near-saturated air condenses after the prescribed wave lift');
    assert.equal(unsaturated.gravityWaveDriver.cloudCondensationPossible, false,
      'dry air does not form a wave cloud');
  });
}
