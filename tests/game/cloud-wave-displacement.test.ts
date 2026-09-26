import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type {
  CloudEnvironmentLevelInput, CloudEnvironmentProfile, GravityWaveSourceInput,
} from '../../src/game/cloud/cloud-environment';
import {
  cloudGravityWaveFieldFromEnvironment, displaceCloudMassByWave,
  gravityWaveDisplacementM,
} from '../../src/game/cloud/cloud-wave-displacement';
import { ConvectiveCloudLocalFieldSupply } from '../../src/game/cloud/cloud-local-field-supply';
import { earthConvectiveCloudEnvironmentAt } from '../../src/game/cloud/earth-cloud-environment';
import type { CloudMassDeposition } from '../../src/game/cloud/cloud-mass-deposition';
import type { CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';

const RADIUS_M = 6_378_137;
const CENTER = v3(0, 0, 1);

// C7 対照系と同じ波源入力(源高・変位・波長・方位)を使う。
const WAVE_SOURCE: GravityWaveSourceInput = {
  sourceHeightM: 5_500,
  verticalDisplacementM: 500,
  horizontalWavelengthM: 10_000,
  verticalWavelengthM: 5_000,
  propagationAzimuthRad: Math.PI / 2,
};

// 制御柱。upperHumidityScale で上層の湿りだけを変え、凝結ゲートを開閉する。
function makeEnvironment(
  upperHumidityScale: number,
  gravityWaveSource: GravityWaveSourceInput | null,
): CloudEnvironmentProfile {
  const levels: CloudEnvironmentLevelInput[] = [];
  for (let index = 0; index <= 48; index += 1) {
    const heightM = index * 250;
    levels.push({
      heightM,
      pressurePa: 100_000 * Math.exp(-heightM / 8_400),
      temperatureK: 289 - 6.5 * heightM / 1_000,
      waterVaporSpecificHumidityKgPerKg: 0.009 * Math.exp(-heightM / 2_200)
        * (heightM >= 4_000 ? upperHumidityScale : 1),
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: 8,
      northWindMps: 0,
      largeScaleVerticalVelocityMps: 0,
    });
  }
  return createCloudEnvironmentProfile({
    levels,
    surfaceSensibleHeatFluxWPerM2: 80,
    surfaceLatentHeatFluxWPerM2: 120,
    cloudTopLongwaveCoolingKPerS: 1e-4,
    gravityWaveSource,
    upperIceLayerBottomM: 5_500,
    upperIceLayerTopM: 6_000,
  });
}

function totalExtinction(data: {
  readonly liquidExtinctionPerM: Float32Array;
  readonly iceExtinctionPerM: Float32Array;
}): number {
  let total = 0;
  for (const value of data.liquidExtinctionPerM) total += value;
  for (const value of data.iceExtinctionPerM) total += value;
  return total;
}

// 64×8 セル・1 km 角の合成堆積。全列が同じ内容なので、位相場だけが列間の差を作る。
function uniformDeposition(): { deposition: CloudMassDeposition; grid: CloudFootprintGrid } {
  const grid: CloudFootprintGrid = {
    originEastM: -32_000, originNorthM: -4_000,
    cellWidthM: 1_000, cellHeightM: 1_000, width: 64, height: 8,
  };
  const cellCount = grid.width * grid.height;
  return {
    grid,
    deposition: {
      columnsByLayer: [
        {
          lowerAltitudeM: 0, upperAltitudeM: 1_500,
          liquidKgM2ByCell: new Array<number>(cellCount).fill(0),
          iceKgM2ByCell: new Array<number>(cellCount).fill(1),
        },
        {
          lowerAltitudeM: 1_500, upperAltitudeM: 4_000,
          liquidKgM2ByCell: new Array<number>(cellCount).fill(0),
          iceKgM2ByCell: new Array<number>(cellCount).fill(0),
        },
      ],
      unassignedMassKgByPhase: { liquid: 0, ice: 0 },
    },
  };
}

// 東向きに伝播する波場。λ_h = 8 セル、振幅 400 m で層0の氷が層1へ出入りする。
const EASTWARD_WAVE = {
  eastWavenumberPerM: 2 * Math.PI / 8_000,
  northWavenumberPerM: 0,
  angularFrequencyRadPerS: 0.005,
  displacementAmplitudeM: 400,
};

export function register(): void {
  test('cloud wave: 波場は active かつ凝結可能な環境でだけ立つ', () => {
    const moist = cloudGravityWaveFieldFromEnvironment(makeEnvironment(1.3, WAVE_SOURCE));
    assert.ok(moist !== null);
    // 方位 π/2(北向き)なので波数は北成分だけを持ち、大きさは 2π/λ_h。
    const expectedWavenumber = 2 * Math.PI / WAVE_SOURCE.horizontalWavelengthM;
    assert.ok(Math.abs(moist.eastWavenumberPerM) < expectedWavenumber * 1e-10);
    assert.ok(Math.abs(moist.northWavenumberPerM - expectedWavenumber)
      < expectedWavenumber * 1e-10);
    const driver = makeEnvironment(1.3, WAVE_SOURCE).gravityWaveDriver;
    assert.ok(Math.abs(moist.angularFrequencyRadPerS
      - driver.intrinsicAngularFrequencyRadPerS) < 1e-20);
    assert.ok(Math.abs(moist.displacementAmplitudeM - driver.verticalDisplacementM) < 1e-12);
    // 位相速度の整合: k·c = ω(伝播方向へ)。
    const kDotC = moist.eastWavenumberPerM * driver.eastwardPhaseSpeedMps
      + moist.northWavenumberPerM * driver.northwardPhaseSpeedMps;
    assert.ok(Math.abs(kDotC - moist.angularFrequencyRadPerS)
      < moist.angularFrequencyRadPerS * 1e-10);
    // 波源なしと、波があっても凝結に届かない乾いた対照では場を立てない。
    assert.equal(cloudGravityWaveFieldFromEnvironment(makeEnvironment(1.3, null)), null);
    assert.equal(cloudGravityWaveFieldFromEnvironment(makeEnvironment(0.1, WAVE_SOURCE)), null);
  });

  test('cloud wave: 変位は質量を保存し、波の位相で層間を移す', () => {
    const { deposition, grid } = uniformDeposition();
    const displaced = displaceCloudMassByWave(deposition, EASTWARD_WAVE, grid, 0);
    // 相別の総質量(列 + 未割当)は保存される。
    for (const [layerIndex, layer] of displaced.columnsByLayer.entries()) {
      const totalKgM2 = layer.iceKgM2ByCell.reduce((sum, value) => sum + value, 0);
      if (layerIndex === 0) assert.ok(totalKgM2 < grid.width * grid.height);
      assert.ok(totalKgM2 >= 0);
    }
    const iceTotal = displaced.columnsByLayer.reduce(
      (sum, layer) => sum + layer.iceKgM2ByCell.reduce((s, v) => s + v, 0), 0);
    assert.ok(Math.abs(iceTotal - grid.width * grid.height) < grid.width * grid.height * 1e-12);
    // 各セルの層1ぶんは、層0区間を η だけずらした解析値 max(0, min(η, depth))/depth に一致。
    const layer1 = displaced.columnsByLayer[1]!;
    for (let column = 0; column < grid.width; column += 1) {
      const eastM = grid.originEastM + (column + 0.5) * grid.cellWidthM;
      const etaM = gravityWaveDisplacementM(EASTWARD_WAVE, eastM, 0, 0);
      const expected = Math.max(0, Math.min(etaM, 1_500)) / 1_500;
      for (let row = 0; row < grid.height; row += 1) {
        const cellIndex = row * grid.width + column;
        assert.ok(Math.abs(layer1.iceKgM2ByCell[cellIndex]! - expected) < 1e-12,
          `cell ${cellIndex}: expected ${expected}, got ${layer1.iceKgM2ByCell[cellIndex]}`);
      }
    }
    // 変位の山(k_e·east = π/2 mod 2π)では層1へ質量が出、谷では出ない。
    const crestColumn = Math.round((2_000 - grid.originEastM - 500) / 1_000);
    const troughColumn = Math.round((6_000 - grid.originEastM - 500) / 1_000);
    assert.ok(layer1.iceKgM2ByCell[crestColumn]! > 0.2);
    assert.equal(layer1.iceKgM2ByCell[troughColumn], 0);
  });

  test('cloud wave: 縞は位相速度で伝わり、物質の運動へ依存しない', () => {
    const { deposition, grid } = uniformDeposition();
    // 位相速度 c = ω/k_e。Δt = 4 セルぶん進む時間にすると、縞はちょうど東へ4列動く。
    const phaseSpeedMps = EASTWARD_WAVE.angularFrequencyRadPerS
      / EASTWARD_WAVE.eastWavenumberPerM;
    const deltaTimeSeconds = 4 * grid.cellWidthM / phaseSpeedMps;
    const earlier = displaceCloudMassByWave(deposition, EASTWARD_WAVE, grid, 0);
    const later = displaceCloudMassByWave(deposition, EASTWARD_WAVE, grid, deltaTimeSeconds);
    const earlierLayer1 = earlier.columnsByLayer[1]!.iceKgM2ByCell;
    const laterLayer1 = later.columnsByLayer[1]!.iceKgM2ByCell;
    let differences = 0;
    for (let row = 0; row < grid.height; row += 1) {
      for (let column = 0; column < grid.width; column += 1) {
        const cellIndex = row * grid.width + column;
        const sourceIndex = row * grid.width + ((column - 4 + grid.width) % grid.width);
        assert.ok(Math.abs(laterLayer1[cellIndex]! - earlierLayer1[sourceIndex]!) < 1e-9,
          `cell ${cellIndex}: stripe did not translate by the phase speed`);
        if (laterLayer1[cellIndex] !== earlierLayer1[cellIndex]!) differences += 1;
      }
    }
    // 堆積はこの間に物質輸送を受けていない(同じ堆積へ別時刻の位相を当てただけ)のに、
    // 縞は位相速度ぶんだけ動く — 波の伝播が物質風から独立していることの確認。
    assert.ok(differences > 0);
  });

  test('cloud wave: 凝結ゲートが閉じると場は無波と一致し、開けば変わる', () => {
    // 乾いた対照は波源があっても凝結へ届かず、波源なしと同じ場を返す。
    const dryWave = new ConvectiveCloudLocalFieldSupply(
      () => makeEnvironment(0.1, WAVE_SOURCE), 7, RADIUS_M);
    const dryControl = new ConvectiveCloudLocalFieldSupply(
      () => makeEnvironment(0.1, null), 7, RADIUS_M);
    const dryWaveResult = dryWave.derive(7_200, CENTER);
    const dryControlResult = dryControl.derive(7_200, CENTER);
    assert.ok(dryWaveResult !== null && dryControlResult !== null);
    assert.deepEqual(dryWaveResult.data.liquidExtinctionPerM,
      dryControlResult.data.liquidExtinctionPerM);
    assert.deepEqual(dryWaveResult.data.iceExtinctionPerM,
      dryControlResult.data.iceExtinctionPerM);

    // 湿った対照は同じ波源でゲートが開き、無波の場とは違う形へ出る。
    const moistWave = new ConvectiveCloudLocalFieldSupply(
      () => makeEnvironment(1.3, WAVE_SOURCE), 7, RADIUS_M);
    const moistControl = new ConvectiveCloudLocalFieldSupply(
      () => makeEnvironment(1.3, null), 7, RADIUS_M);
    const moistWaveResult = moistWave.derive(7_200, CENTER);
    const moistControlResult = moistControl.derive(7_200, CENTER);
    assert.ok(moistWaveResult !== null && moistControlResult !== null);
    // そもそも対照場に雲が乗っていることを確かめてから差を見る。
    assert.ok(totalExtinction(moistControlResult.data) > 0);
    assert.notDeepEqual(moistWaveResult.data.iceExtinctionPerM,
      moistControlResult.data.iceExtinctionPerM);
  });

  test('cloud wave: 地球環境は中緯度で波が凝結まで届き、赤道・高緯度では立たない', () => {
    const directionAt = (degrees: number) => {
      const latitude = degrees * Math.PI / 180;
      return v3(0, Math.sin(latitude), Math.cos(latitude));
    };
    for (const degrees of [-45, -40, 40, 45]) {
      const driver = earthConvectiveCloudEnvironmentAt(directionAt(degrees)).gravityWaveDriver;
      assert.equal(driver.active, true, `latitude ${degrees}`);
      assert.equal(driver.cloudCondensationPossible, true, `latitude ${degrees}`);
      // 西向き伝播(後退波)なので、中緯度の東流の物質風とは位相速度が逆符号になる。
      assert.ok(driver.eastwardPhaseSpeedMps < 0);
      assert.ok(driver.horizontalPhaseSpeedMps > 0);
    }
    for (const degrees of [0, 10, 70, 90]) {
      const driver = earthConvectiveCloudEnvironmentAt(directionAt(degrees)).gravityWaveDriver;
      assert.equal(driver.active, false, `latitude ${degrees}`);
    }
    // 場への接続でも同じ判定が効く。
    const field = cloudGravityWaveFieldFromEnvironment(
      earthConvectiveCloudEnvironmentAt(directionAt(40)));
    assert.ok(field !== null);
    assert.equal(cloudGravityWaveFieldFromEnvironment(
      earthConvectiveCloudEnvironmentAt(directionAt(0))), null);
  });
}
