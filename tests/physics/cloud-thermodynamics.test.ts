import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  iceEffectiveRadiusM,
  iceOpticalDepth,
  liftingCondensationLevel,
  liquidEffectiveRadiusM,
  liquidOpticalDepth,
  parcelBuoyancyMPerS2,
  parcelBuoyancyProfile,
  saturationSpecificHumidityOverIceKgPerKg,
  saturationSpecificHumidityOverMixedPhaseKgPerKg,
  saturationSpecificHumidityOverLiquidKgPerKg,
  saturationVaporPressureOverIcePa,
  saturationVaporPressureOverMixedPhasePa,
  saturationVaporPressureOverLiquidPa,
  virtualTemperatureK,
} from '../../src/physics/cloud-thermodynamics';
import type { CloudProfileLevel } from '../../src/physics/cloud-thermodynamics';

export function register(): void {
  test('cloud thermodynamics: WMO saturation pressures match tabulated phase points', () => {
    assert.ok(Math.abs(saturationVaporPressureOverLiquidPa(273.15) - 611.2) < 0.01);
    assert.ok(Math.abs(saturationVaporPressureOverLiquidPa(293.15) - 2332.6) < 0.1);
    assert.ok(Math.abs(saturationVaporPressureOverIcePa(253.15) - 103.3) < 0.5);
    assert.throws(() => saturationVaporPressureOverLiquidPa(220), RangeError);
    assert.throws(() => saturationVaporPressureOverIcePa(280), RangeError);
    for (const temperatureK of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => saturationVaporPressureOverLiquidPa(temperatureK), RangeError);
      assert.throws(() => saturationVaporPressureOverIcePa(temperatureK), RangeError);
      assert.throws(() => saturationVaporPressureOverMixedPhasePa(temperatureK), RangeError);
    }
  });

  test('cloud thermodynamics: mixed-phase saturation joins the pure-phase curves continuously', () => {
    assert.equal(
      saturationVaporPressureOverMixedPhasePa(233.15),
      saturationVaporPressureOverIcePa(233.15),
    );
    assert.equal(
      saturationVaporPressureOverMixedPhasePa(273.15),
      saturationVaporPressureOverLiquidPa(273.15),
    );
    const ice = saturationVaporPressureOverIcePa(253.15);
    const liquid = saturationVaporPressureOverLiquidPa(253.15);
    const mixed = saturationVaporPressureOverMixedPhasePa(253.15);
    assert.ok(mixed > ice && mixed < liquid);
    assert.ok(saturationSpecificHumidityOverMixedPhaseKgPerKg(253.15, 80_000) > 0);
  });

  test('cloud thermodynamics: specific humidity uses vapor pressure and moist-air pressure', () => {
    const liquid = saturationSpecificHumidityOverLiquidKgPerKg(273.15, 100_000);
    const ice = saturationSpecificHumidityOverIceKgPerKg(253.15, 80_000);
    assert.ok(Math.abs(liquid - 0.0038105) < 2e-7);
    assert.ok(Math.abs(ice - 0.000802) < 3e-6);
    assert.ok(ice < liquid);
    assert.throws(() => saturationSpecificHumidityOverLiquidKgPerKg(273.15, 500), RangeError);
  });

  test('cloud thermodynamics: virtual temperature includes vapor buoyancy and condensate loading', () => {
    assert.equal(virtualTemperatureK(300, 0, 0, 0), 300);
    const moist = virtualTemperatureK(300, 0.01, 0, 0);
    const loaded = virtualTemperatureK(300, 0.01, 0.01, 0);
    assert.ok(moist > 300);
    assert.ok(loaded < moist);
    assert.ok(Math.abs(parcelBuoyancyMPerS2(301, 300) - 9.80665 / 300) < 1e-12);
    assert.throws(() => virtualTemperatureK(300, 1, 0, 0), RangeError);
    assert.throws(() => virtualTemperatureK(300, 1.01, 0, 0), RangeError);
  });

  test('cloud thermodynamics: Bolton LCL for 30 °C air with a 20 °C dew point', () => {
    const lcl = liftingCondensationLevel(303.15, 100_000, 293.15);
    assert.ok(Math.abs(lcl.temperatureK - 290.8) < 0.1);
    assert.ok(Math.abs(lcl.heightM - 1_263) < 20);
    assert.ok(lcl.pressurePa < 100_000);
    assert.throws(() => liftingCondensationLevel(293.15, 100_000, 294), RangeError);
  });

  test('cloud thermodynamics: dry-neutral sounding has no diagnosed CAPE, CIN, or LFC', () => {
    const baseTemperatureK = 290;
    const basePressurePa = 100_000;
    const qv = 0;
    const profile: CloudProfileLevel[] = [0, 100, 200, 300].map((heightM) => {
      const temperatureK = baseTemperatureK - 9.80665 / 1004 * heightM;
      const pressurePa = basePressurePa * (temperatureK / baseTemperatureK) ** (1004 / 287.05);
      return {
        heightM,
        temperatureK,
        pressurePa,
        waterVaporSpecificHumidityKgPerKg: qv,
        liquidWaterMixingRatioKgPerKg: 0,
        iceMixingRatioKgPerKg: 0,
      };
    });
    const diagnostic = parcelBuoyancyProfile(profile);
    assert.ok(diagnostic.capeJPerKg < 1e-8);
    assert.ok(diagnostic.cinJPerKg < 1e-8);
    assert.equal(diagnostic.lclHeightM, null);
    assert.equal(diagnostic.lfcHeightM, null);
    assert.equal(diagnostic.equilibriumHeightM, null);
    assert.equal(diagnostic.profile.length, profile.length);
  });

  test('cloud thermodynamics: dry analytic sounding has independently known CAPE, CIN, LFC, and EL', () => {
    const baseTemperatureK = 300;
    const gravityMPerS2 = 9.80665;
    const dryLapseKPerM = gravityMPerS2 / 1004;
    const knownBuoyancyMPerS2 = [0, -0.02, 0, 0.04, 0];
    const profile: CloudProfileLevel[] = knownBuoyancyMPerS2.map((buoyancyMPerS2, index) => {
      const heightM = index * 500;
      const parcelTemperatureK = baseTemperatureK - dryLapseKPerM * heightM;
      return {
        heightM,
        temperatureK: parcelTemperatureK / (1 + buoyancyMPerS2 / gravityMPerS2),
        pressurePa: 100_000 * Math.exp(-gravityMPerS2 * heightM / (287.05 * baseTemperatureK)),
        waterVaporSpecificHumidityKgPerKg: 0,
        liquidWaterMixingRatioKgPerKg: 0,
        iceMixingRatioKgPerKg: 0,
      };
    });
    const diagnostic = parcelBuoyancyProfile(profile);
    assert.equal(diagnostic.lclHeightM, null);
    assert.equal(diagnostic.lfcHeightM, 1000);
    assert.ok(diagnostic.equilibriumHeightM !== null);
    assert.ok(Math.abs(diagnostic.equilibriumHeightM - 2000) < 1e-8);
    assert.ok(Math.abs(diagnostic.capeJPerKg - 20) < 1e-8);
    assert.ok(Math.abs(diagnostic.cinJPerKg - 10) < 1e-8);
  });

  test('cloud thermodynamics: mixed-phase deep sounding reaches the ice-phase ascent closure', () => {
    const profile: CloudProfileLevel[] = [];
    for (let heightM = 0; heightM <= 16_000; heightM += 250) {
      const temperatureK = 300 - (heightM <= 1000
        ? 9.8 * heightM / 1000
        : 9.8 + 5.5 * (heightM - 1000) / 1000);
      const pressurePa = 100_000 * Math.exp(-9.80665 * heightM / (287.05 * 285));
      const environmentalSaturationKgPerKg = temperatureK > 273.15
        ? saturationSpecificHumidityOverLiquidKgPerKg(temperatureK, pressurePa)
        : temperatureK >= 233.15
          ? saturationSpecificHumidityOverMixedPhaseKgPerKg(temperatureK, pressurePa)
          : saturationSpecificHumidityOverIceKgPerKg(temperatureK, pressurePa);
      profile.push({
        heightM,
        temperatureK,
        pressurePa,
        waterVaporSpecificHumidityKgPerKg: heightM < 1000
          ? 0.012
          : Math.min(0.002, environmentalSaturationKgPerKg * 0.5),
        liquidWaterMixingRatioKgPerKg: heightM === 0 ? 0.002 : 0,
        iceMixingRatioKgPerKg: 0,
      });
    }
    const diagnostic = parcelBuoyancyProfile(profile);
    assert.ok(diagnostic.lclHeightM !== null);
    assert.ok(diagnostic.lclHeightM > 1000 && diagnostic.lclHeightM < 1500);
    assert.equal(diagnostic.lfcHeightM, 0);
    assert.ok(diagnostic.equilibriumHeightM !== null);
    assert.ok(diagnostic.capeJPerKg > 100);
    assert.ok(diagnostic.cinJPerKg >= 0);
    assert.ok(diagnostic.equilibriumHeightM < profile[profile.length - 1]!.heightM);
    assert.ok(diagnostic.profile[diagnostic.profile.length - 1]!.temperatureK < 233.15);
  });

  test('cloud thermodynamics: liquid and ice closures recover a specified monodisperse radius', () => {
    // Fixed bulk references: 0.30 g/m³ liquid water at 100 cm⁻³ and 0.05 g/m³
    // ice at 0.1 cm⁻³. Expected volume-equivalent radii are independently evaluated
    // from mass per particle and spherical material density.
    const liquidRadiusM = liquidEffectiveRadiusM(1.2, 0.00025, 1e8);
    const iceRadiusM = iceEffectiveRadiusM(0.8, 0.0000625, 1e5);
    assert.ok(liquidRadiusM !== null && Math.abs(liquidRadiusM - 8.947e-6) < 1e-9);
    assert.ok(iceRadiusM !== null && Math.abs(iceRadiusM - 50.680e-6) < 1e-8);
    assert.equal(liquidEffectiveRadiusM(1, 0, 1e8), null);
    assert.equal(iceEffectiveRadiusM(1, 0, 1e5), null);
  });

  test('cloud thermodynamics: optical depth has the expected geometric path scaling', () => {
    assert.ok(Math.abs(liquidOpticalDepth(0.1, 10e-6) - 15) < 1e-12);
    assert.ok(Math.abs(iceOpticalDepth(0.1, 10e-6, 2) - 16.3576881134) < 1e-9);
    assert.equal(liquidOpticalDepth(0, 10e-6), 0);
    assert.equal(iceOpticalDepth(0, 10e-6, 1.5), 0);
    assert.throws(() => liquidOpticalDepth(-0.1, 10e-6), RangeError);
    assert.throws(() => iceOpticalDepth(0.1, 10e-6, 0), RangeError);
  });
}
