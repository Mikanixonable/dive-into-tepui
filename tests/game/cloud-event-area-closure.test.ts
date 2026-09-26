// 環境・輸送から source/footprint 形状を導く閉包の物理的性質を検査する。
import * as assert from 'node:assert/strict';
import { cross, lenSq, v3 } from '../../src/math/vec3';
import { deriveCloudEventAreas } from '../../src/game/cloud/cloud-event-area-closure';
import { depositCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-local-deposition';
import type { CloudEventFootprintShape } from '../../src/game/cloud/cloud-event-local-deposition';
import type { CloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import type { ConvectiveCloudEvent, CloudEventSourcePosition } from '../../src/game/cloud/cloud-events';
import type { CloudEventMaterialCohorts, CloudEventWindAt, CloudIceMaterialCohort } from '../../src/game/cloud/cloud-event-transport';
import type { CloudFootprintGrid } from '../../src/game/cloud/cloud-footprint-overlap';
import type { CloudMassGrid } from '../../src/game/cloud/cloud-mass-deposition';
import { test } from '../harness';

const SOURCE_POSITION: CloudEventSourcePosition = {
  directionUnitVector: v3(1, 0, 0),
  geometricHeightM: 1_000,
};
const MIN_AREA_M2 = 1_000;
const MAX_AREA_M2 = 1e12;

const STILL_WIND: CloudEventWindAt = () => ({
  tangentVelocityMPerS: v3(0, 0, 0),
  verticalVelocityMPerS: 0,
});

// 風が高度に比例する一様な鉛直シア。
function shearedWindMPerSPerM(gradientPerM: number): CloudEventWindAt {
  return (_directionUnitVector, geometricHeightM) => ({
    tangentVelocityMPerS: v3(gradientPerM * geometricHeightM, 0, 0),
    verticalVelocityMPerS: 0,
  });
}

// 源位置 (1,0,0) の接平面上で +y 向きに強まる風。接平面内のシア方位が
// footprint の伸長方位として読めることを見るための風。
function tangentShearedWindMPerSPerM(gradientPerM: number): CloudEventWindAt {
  return (_directionUnitVector, geometricHeightM) => ({
    tangentVelocityMPerS: v3(0, gradientPerM * geometricHeightM, 0),
    verticalVelocityMPerS: 0,
  });
}

function environmentProfile(options: {
  readonly capeJPerKg?: number;
  readonly equilibriumHeightM?: number | null;
  readonly stabilityPerS2?: number;
} = {}): CloudEnvironmentProfile {
  const equilibriumHeightM = options.equilibriumHeightM === undefined
    ? 10_000
    : options.equilibriumHeightM;
  return {
    levels: [],
    layerStability: [{
      lowerHeightM: 0,
      upperHeightM: 15_000,
      buoyancyFrequencySquaredPerS2: options.stabilityPerS2 ?? 1e-4,
    }],
    columnWaterVaporKgPerM2: 0,
    boundaryLayer: {
      depthM: 1_000,
      inversionBaseM: null,
      inversionTopM: null,
      potentialTemperatureIncreaseK: 0,
    },
    parcel: {
      profile: [],
      lclHeightM: null,
      lfcHeightM: null,
      equilibriumHeightM,
      capeJPerKg: options.capeJPerKg ?? 1_000,
      cinJPerKg: 0,
    },
    upperIceMoistureFactor: 0,
    surfaceSensibleHeatFluxWPerM2: 0,
    surfaceLatentHeatFluxWPerM2: 0,
    cloudTopLongwaveCoolingKPerS: 0,
    gravityWaveDriver: {
      active: false,
      cloudCondensationPossible: false,
      sourceHeightM: null,
      verticalDisplacementM: 0,
      liftedAirTemperatureK: null,
      liftedAirPressurePa: null,
      buoyancyFrequencySquaredPerS2: 0,
      restoringAccelerationMagnitudeMPerS2: 0,
      intrinsicAngularFrequencyRadPerS: 0,
      horizontalPhaseSpeedMps: 0,
      verticalPhaseSpeedMps: 0,
      eastwardPhaseSpeedMps: 0,
      northwardPhaseSpeedMps: 0,
    },
  };
}

function event(options: {
  readonly ageSeconds?: number;
  readonly meanReleaseTimeSeconds?: number | null;
  readonly sublimationRatePerSecond?: number;
  readonly liquidKgM2?: number;
  readonly iceKgM2?: number;
  readonly sourcePosition?: CloudEventSourcePosition;
} = {}): ConvectiveCloudEvent {
  const liquidKgM2 = options.liquidKgM2 ?? 0.02;
  const iceKgM2 = options.iceKgM2 ?? 0.01;
  const meanReleaseTimeSeconds = options.meanReleaseTimeSeconds === undefined
    ? 1_800
    : options.meanReleaseTimeSeconds;
  return {
    id: 'event', cellId: 'cell', birthEpoch: 0,
    birthTimeSeconds: 0, ageSeconds: options.ageSeconds ?? 3_600,
    sourcePosition: options.sourcePosition ?? SOURCE_POSITION,
    supplyActive: false,
    mass: {
      initialKgM2: 0,
      suppliedKgM2: liquidKgM2 + iceKgM2,
      lostKgM2: 0,
      liquidKgM2,
      iceKgM2,
    },
    iceRelease: {
      id: 'event:ice', parentEventId: 'event',
      releasedKgM2: iceKgM2, remainingKgM2: iceKgM2,
      meanReleaseTimeSeconds,
      releaseRateKgM2S: 0,
      releaseStartTimeSeconds: meanReleaseTimeSeconds === null ? null : 900,
      releaseEndTimeSeconds: meanReleaseTimeSeconds === null ? null : 3_600,
      sublimationRatePerSecond: options.sublimationRatePerSecond ?? 1 / 7_200,
      releaseHeightM: 6_000,
    },
    lifecycle: {
      liquidSupplyRateKgM2S: 1e-6,
      convectiveDurationSeconds: 3_600,
      iceYieldFraction: 0.5,
      upperRelativeHumidity: 0.8,
    },
    generation: 0,
    parentEventId: null,
  };
}

function cohort(
  cohortIndex: number,
  meanReleaseTimeSeconds: number,
  geometricHeightM = 6_000,
  massKgM2 = 0.005,
): CloudIceMaterialCohort {
  return {
    directionUnitVector: SOURCE_POSITION.directionUnitVector,
    geometricHeightM,
    massKgM2,
    steps: 0,
    cohortIndex,
    releaseStartTimeSeconds: meanReleaseTimeSeconds - 100,
    releaseEndTimeSeconds: meanReleaseTimeSeconds + 100,
    meanReleaseTimeSeconds,
  };
}

function material(options: {
  readonly parentHeightM?: number;
  readonly withoutParent?: boolean;
  readonly cohorts?: readonly {
    readonly cohortIndex: number;
    readonly meanReleaseTimeSeconds: number;
    readonly geometricHeightM: number;
    readonly massKgM2: number;
  }[];
} = {}): CloudEventMaterialCohorts {
  const parent = options.withoutParent === true
    ? null
    : {
      directionUnitVector: SOURCE_POSITION.directionUnitVector,
      geometricHeightM: options.parentHeightM ?? SOURCE_POSITION.geometricHeightM,
      massKgM2: 0.02,
      steps: 0,
    };
  const releasedIceCohorts = (options.cohorts ?? [
    { cohortIndex: 0, meanReleaseTimeSeconds: 1_200, geometricHeightM: 6_000, massKgM2: 0.005 },
    { cohortIndex: 1, meanReleaseTimeSeconds: 2_400, geometricHeightM: 6_000, massKgM2: 0.005 },
  ]).map((options_) => cohort(
    options_.cohortIndex, options_.meanReleaseTimeSeconds, options_.geometricHeightM, options_.massKgM2,
  ));
  return {
    parent,
    releasedIceCohorts,
    totalMassKgM2: (parent?.massKgM2 ?? 0)
      + releasedIceCohorts.reduce((total, cohort) => total + cohort.massKgM2, 0),
  };
}

// 形状行列 G = c²I + Σvvᵀ の行列式から footprint 面積を復元する。
function shapeAreaM2(shape: CloudEventFootprintShape): number {
  const isotropicSquaredM2 = shape.isotropicRadiusM * shape.isotropicRadiusM;
  let stretchedSquaredM2 = 0;
  let pairCrossSquaredM4 = 0;
  for (const [index, vector] of shape.elongationVectorsM.entries()) {
    stretchedSquaredM2 += lenSq(vector);
    for (const other of shape.elongationVectorsM.slice(index + 1)) {
      pairCrossSquaredM4 += lenSq(cross(vector, other));
    }
  }
  return Math.PI * Math.sqrt(isotropicSquaredM2 * isotropicSquaredM2
    + isotropicSquaredM2 * stretchedSquaredM2 + pairCrossSquaredM4);
}

function cohortArea(
  result: ReturnType<typeof deriveCloudEventAreas>,
  cohortIndex: number,
): number {
  const footprint = result.footprints.releasedIceCohorts.find((c) => c.cohortIndex === cohortIndex);
  assert.ok(footprint, `cohort ${cohortIndex} footprint`);
  return shapeAreaM2(footprint.shape);
}

function parentAreaM2(result: ReturnType<typeof deriveCloudEventAreas>): number {
  assert.ok(result.footprints.parentLiquid, 'parent liquid footprint');
  return shapeAreaM2(result.footprints.parentLiquid);
}

export function register(): void {
  test('cloud event area closure: source and footprint areas grow with CAPE', () => {
    const e = event();
    const m = material();
    const areas = [250, 1_000, 4_000].map((capeJPerKg) => deriveCloudEventAreas(
      e, m, environmentProfile({ capeJPerKg }), STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    ));
    assert.ok(areas[0]!.sourceAreaM2 < areas[1]!.sourceAreaM2);
    assert.ok(areas[1]!.sourceAreaM2 < areas[2]!.sourceAreaM2);
    // A_src = π·(√(2·CAPE)·τ_mix)² = 2π·CAPE·τ_mix² なので同じ τ_mix では CAPE に比例する。
    assert.ok(Math.abs(areas[2]!.sourceAreaM2 / areas[1]!.sourceAreaM2 - 4) < 1e-9);
    assert.ok(parentAreaM2(areas[0]!) < parentAreaM2(areas[2]!));
    assert.ok(cohortArea(areas[0]!, 0) < cohortArea(areas[2]!, 0));
  });

  test('cloud event area closure: zero CAPE collapses every area to the minimum', () => {
    const result = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 0 }),
      shearedWindMPerSPerM(0.005), MIN_AREA_M2, MAX_AREA_M2,
    );
    assert.equal(result.sourceAreaM2, MIN_AREA_M2);
    assert.ok(result.footprints.parentLiquid);
    assert.ok(Math.abs(shapeAreaM2(result.footprints.parentLiquid) - MIN_AREA_M2) < 1e-9);
    for (const footprint of result.footprints.releasedIceCohorts) {
      assert.ok(Math.abs(shapeAreaM2(footprint.shape) - MIN_AREA_M2) < 1e-9);
    }
  });

  test('cloud event area closure: windless environment leaves no area difference between cohorts', () => {
    const result = deriveCloudEventAreas(
      event(), material({
        cohorts: [
          { cohortIndex: 0, meanReleaseTimeSeconds: 900, geometricHeightM: 5_000, massKgM2: 0.003 },
          { cohortIndex: 1, meanReleaseTimeSeconds: 1_800, geometricHeightM: 7_000, massKgM2: 0.004 },
          { cohortIndex: 2, meanReleaseTimeSeconds: 3_000, geometricHeightM: 6_000, massKgM2: 0.003 },
        ],
      }),
      environmentProfile({ capeJPerKg: 2_000 }), STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    );
    const areas = result.footprints.releasedIceCohorts.map((footprint) => shapeAreaM2(footprint.shape));
    assert.equal(areas.length, 3);
    for (const areaM2 of areas) assert.equal(areaM2, areas[0]);
    // footprint は source 以上である。
    assert.ok(areas[0]! >= result.sourceAreaM2);
    assert.ok(parentAreaM2(result) >= result.sourceAreaM2);
    // 無風では伸長ベクトルは立たず、全 footprint は等半径の円。
    for (const footprint of result.footprints.releasedIceCohorts) {
      assert.equal(footprint.shape.elongationVectorsM.length, 0);
    }
    assert.equal(result.footprints.parentLiquid!.elongationVectorsM.length, 0);
  });

  test('cloud event area closure: vertical shear spreads ice beyond the parent liquid', () => {
    const e = event();
    const m = material();
    const still = deriveCloudEventAreas(
      e, m, environmentProfile({ capeJPerKg: 1_000 }), STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    );
    const sheared = deriveCloudEventAreas(
      e, m, environmentProfile({ capeJPerKg: 1_000 }),
      shearedWindMPerSPerM(0.002), MIN_AREA_M2, MAX_AREA_M2,
    );
    // 親液水は源と同じ高さに留まり、シア項が効かない。
    assert.equal(still.footprints.parentLiquid!.isotropicRadiusM,
      sheared.footprints.parentLiquid!.isotropicRadiusM);
    assert.equal(sheared.footprints.parentLiquid!.elongationVectorsM.length, 0);
    for (const cohort of [0, 1]) {
      assert.ok(cohortArea(sheared, cohort) > cohortArea(still, cohort));
      assert.ok(cohortArea(sheared, cohort) > parentAreaM2(sheared));
    }
  });

  test('cloud event area closure: shear elongates ice footprints along the shear direction', () => {
    const result = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 1_000 }),
      tangentShearedWindMPerSPerM(0.002), MIN_AREA_M2, MAX_AREA_M2,
    );
    for (const footprint of result.footprints.releasedIceCohorts) {
      // シアずれとかなとこ風下のどちらの伸長も、源の接平面上で +y 向き。
      assert.equal(footprint.shape.elongationVectorsM.length, 2);
      for (const vector of footprint.shape.elongationVectorsM) {
        assert.ok(vector.y > 0);
        assert.equal(vector.x, 0);
        assert.equal(vector.z, 0);
      }
      // 長半径は等方半径より大きく伸びている。
      assert.ok(shapeAreaM2(footprint.shape)
        > Math.PI * footprint.shape.isotropicRadiusM ** 2);
    }
    // 親は源と同じ高さに留まるので、一様シアでは伸びない。
    assert.equal(result.footprints.parentLiquid!.elongationVectorsM.length, 0);
  });

  test('cloud event area closure: uniform wind stretches ice downwind without shear', () => {
    // 全高度で同じ風なら層間風差は零で、氷はかなとこ流出だけで風下へ伸びる。
    const uniformWind: CloudEventWindAt = () => ({
      tangentVelocityMPerS: v3(0, 15, 0),
      verticalVelocityMPerS: 0,
    });
    const result = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 1_000 }),
      uniformWind, MIN_AREA_M2, MAX_AREA_M2,
    );
    for (const footprint of result.footprints.releasedIceCohorts) {
      assert.equal(footprint.shape.elongationVectorsM.length, 1);
      const vector = footprint.shape.elongationVectorsM[0]!;
      assert.ok(vector.y > 0 && vector.x === 0 && vector.z === 0);
      // 伸長は風速 × 流出時間。氷の平均滞留 1800 s は昇華寿命 7200 s 未満で cap されない。
      assert.ok(Math.abs(lenSq(vector) ** 0.5 - 15 * 1_800) < 1e-6);
    }
    // 親液水は風下へは伸びず等半径の円。
    assert.equal(result.footprints.parentLiquid!.elongationVectorsM.length, 0);
  });

  test('cloud event area closure: longer ice residence under shear spreads cohorts more', () => {
    const result = deriveCloudEventAreas(
      event(), material({
        cohorts: [
          { cohortIndex: 0, meanReleaseTimeSeconds: 600, geometricHeightM: 6_000, massKgM2: 0.005 },
          { cohortIndex: 1, meanReleaseTimeSeconds: 2_400, geometricHeightM: 6_000, massKgM2: 0.005 },
          { cohortIndex: 2, meanReleaseTimeSeconds: 3_300, geometricHeightM: 6_000, massKgM2: 0.005 },
        ],
      }),
      environmentProfile({ capeJPerKg: 1_000 }),
      shearedWindMPerSPerM(0.002), MIN_AREA_M2, MAX_AREA_M2,
    );
    assert.ok(cohortArea(result, 0) > cohortArea(result, 1));
    assert.ok(cohortArea(result, 1) > cohortArea(result, 2));
  });

  test('cloud event area closure: areas stay finite, positive, and inside the bounds', () => {
    const bounded = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 1e9 }),
      shearedWindMPerSPerM(1), MIN_AREA_M2, MAX_AREA_M2,
    );
    assert.equal(bounded.sourceAreaM2, MAX_AREA_M2);
    assert.ok(Math.abs(shapeAreaM2(bounded.footprints.parentLiquid!) - MAX_AREA_M2)
      < MAX_AREA_M2 * 1e-12);
    for (const footprint of bounded.footprints.releasedIceCohorts) {
      assert.ok(Math.abs(shapeAreaM2(footprint.shape) - MAX_AREA_M2) < MAX_AREA_M2 * 1e-12);
    }
    const tiny = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 1e-12 }),
      STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    );
    assert.equal(tiny.sourceAreaM2, MIN_AREA_M2);
    const typical = deriveCloudEventAreas(
      event(), material(), environmentProfile({ capeJPerKg: 800 }),
      STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    );
    for (const areaM2 of [
      typical.sourceAreaM2,
      parentAreaM2(typical),
      ...typical.footprints.releasedIceCohorts.map((c) => shapeAreaM2(c.shape)),
    ]) {
      assert.ok(Number.isFinite(areaM2) && areaM2 > 0);
      assert.ok(areaM2 >= MIN_AREA_M2 && areaM2 <= MAX_AREA_M2);
    }
  });

  test('cloud event area closure: missing parent and empty cohorts are reported as absent', () => {
    const result = deriveCloudEventAreas(
      event(), material({ withoutParent: true, cohorts: [] }),
      environmentProfile(), STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    );
    assert.equal(result.footprints.parentLiquid, null);
    assert.equal(result.footprints.releasedIceCohorts.length, 0);
    assert.ok(result.sourceAreaM2 > MIN_AREA_M2);
  });

  test('cloud event area closure: derived areas feed the deposition adapter unchanged', () => {
    const e = event({ liquidKgM2: 0.02, iceKgM2: 0.01 });
    const m = material();
    const areas = deriveCloudEventAreas(
      e, m, environmentProfile({ capeJPerKg: 500 }),
      STILL_WIND, 62_500, 4e8,
    );
    const footprintGrid: CloudFootprintGrid = {
      originEastM: -20_000, originNorthM: -20_000,
      cellWidthM: 1_000, cellHeightM: 1_000, width: 40, height: 40,
    };
    const massGrid: CloudMassGrid = {
      cells: Array.from({ length: 1_600 }, () => ({ areaM2: 1e6 })),
      layerEdgesM: [0, 3_000, 9_000],
    };
    // kg/m² × sourceAreaM2 = kg の次元が堆積の質量収支検査を通ること。
    const deposition = depositCloudEventMaterialCohorts(
      m, areas.sourceAreaM2, areas.footprints,
      {
        centerDirectionUnitVector: v3(1, 0, 0),
        eastUnitVector: v3(0, 1, 0),
        northUnitVector: v3(0, 0, 1),
        sphereRadiusM: 6_371_000,
        maxAngularDistanceRad: 0.05,
      },
      footprintGrid, massGrid,
    );
    const liquidKg = deposition.columnsByLayer[0]!.liquidKgM2ByCell
      .reduce((total, columnKgM2) => total + columnKgM2 * 1e6, 0);
    const iceKg = deposition.columnsByLayer[1]!.iceKgM2ByCell
      .reduce((total, columnKgM2) => total + columnKgM2 * 1e6, 0);
    assert.ok(Math.abs(liquidKg - 0.02 * areas.sourceAreaM2)
      <= 1e-9 * 0.02 * areas.sourceAreaM2 + deposition.unassignedMassKgByPhase.liquid);
    assert.ok(Math.abs(iceKg - 0.01 * areas.sourceAreaM2)
      <= 1e-9 * 0.01 * areas.sourceAreaM2 + deposition.unassignedMassKgByPhase.ice);
  });

  test('cloud event area closure: invalid inputs are rejected', () => {
    const e = event();
    const m = material();
    const env = environmentProfile();
    assert.throws(() => deriveCloudEventAreas(
      e, m, env, STILL_WIND, 0, MAX_AREA_M2,
    ), RangeError);
    assert.throws(() => deriveCloudEventAreas(
      e, m, env, STILL_WIND, MAX_AREA_M2, MIN_AREA_M2,
    ), RangeError);
    assert.throws(() => deriveCloudEventAreas(
      e, m, environmentProfile({ capeJPerKg: -1 }), STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    ), RangeError);
    assert.throws(() => deriveCloudEventAreas(
      { ...e, sourcePosition: undefined }, m, env, STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    ), RangeError);
    assert.throws(() => deriveCloudEventAreas(
      event({ meanReleaseTimeSeconds: null }), m, env, STILL_WIND, MIN_AREA_M2, MAX_AREA_M2,
    ), RangeError);
    assert.throws(() => deriveCloudEventAreas(
      e, m, env,
      () => ({ tangentVelocityMPerS: v3(Number.NaN, 0, 0), verticalVelocityMPerS: 0 }),
      MIN_AREA_M2, MAX_AREA_M2,
    ), RangeError);
  });
}
