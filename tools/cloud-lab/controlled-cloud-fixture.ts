// cloud-lab の制御実験を、実際の生成 CloudSample へ写すための変換。
// 本番の気象場は変更せず、ラボだけが同じ cloud-field / consumer 契約へ制御入力を差し込む。
import * as THREE from 'three/webgpu';
import { clamp, dot, float, max, mix, sin, smoothstep, uniform } from 'three/tsl';
import { advectSphericalPositionUnitVector } from '../../src/physics/cloud-spherical-transport';
import { iceEffectiveRadiusM, iceOpticalDepth } from '../../src/physics/cloud-thermodynamics';
import { cloudLifecycleAt } from '../../src/game/cloud/cloud-lifecycle';
import { v3, type Vec3 } from '../../src/math/vec3';
import { equirectUvFromDirection } from '../../src/render/field-projection';
import type { CloudSampleTransform } from '../../src/render/cloud/cloud-field';
import type { CloudSample } from '../../src/render/cloud/cloud-field-sample';
import type { WeatherSample } from '../../src/render/cloud/weather-model';
import type { FloatNode, FloatUniform, Vec3Node, Vec3Uniform } from '../../src/render/tsl-types';
import type { MeteorologicalCaseId } from './meteorological-cases';

const EARTH_RADIUS_M = 6_371_000;
const BASE_LATITUDE_DEG = 19;
const BASE_LONGITUDE_DEG = 136;
const CORE_INNER_DEG = 1.5;
const CORE_OUTER_DEG = 4.0;
const ANVIL_INNER_DEG = 4.0;
const ANVIL_OUTER_DEG = 9.0;
const ICE_CENTER_M = 10_500;

export interface MeteorologicalFixtureImageState {
  readonly fixture: MeteorologicalCaseId;
  readonly centerA: Vec3;
  readonly centerB: Vec3;
  readonly liquidA: number;
  readonly liquidB: number;
  readonly topA: number;
  readonly topB: number;
  readonly iceA: number;
  readonly iceB: number;
  readonly iceCenterA: number;
  readonly iceCenterB: number;
  readonly waveStrength: number;
  readonly marineStrength: number;
}

function directionAt(latitudeDeg: number, longitudeDeg: number): Vec3 {
  const latitude = THREE.MathUtils.degToRad(latitudeDeg);
  const longitude = THREE.MathUtils.degToRad(longitudeDeg);
  const flat = Math.cos(latitude);
  return v3(
    flat * Math.sin(longitude),
    Math.sin(latitude),
    flat * Math.cos(longitude),
  );
}

function eastAt(direction: Vec3): Vec3 {
  const longitude = Math.atan2(direction.x, direction.z);
  return v3(Math.cos(longitude), 0, -Math.sin(longitude));
}

function northAt(direction: Vec3): Vec3 {
  const east = eastAt(direction);
  return v3(
    east.y * direction.z - east.z * direction.y,
    east.z * direction.x - east.x * direction.z,
    east.x * direction.y - east.y * direction.x,
  );
}

function moved(
  start: Vec3,
  tangentDirection: Vec3,
  speedMps: number,
  seconds: number,
): Vec3 {
  return advectSphericalPositionUnitVector(
    start,
    v3(
      tangentDirection.x * speedMps,
      tangentDirection.y * speedMps,
      tangentDirection.z * speedMps,
    ),
    EARTH_RADIUS_M,
    seconds,
  );
}

function c6Tau(iceWaterPathKgPerM2: number): number {
  const dryAirDensityKgPerM3 = 0.5;
  const referenceMixingRatioKgPerKg = 1e-4 * (iceWaterPathKgPerM2 / 0.1);
  const radius = iceEffectiveRadiusM(
    dryAirDensityKgPerM3,
    referenceMixingRatioKgPerKg,
    1e5,
  );
  if (radius === null) return 0;
  return iceOpticalDepth(iceWaterPathKgPerM2, radius, 2);
}

export function meteorologicalFixtureImageState(
  fixture: MeteorologicalCaseId,
  timeSeconds: number,
): MeteorologicalFixtureImageState {
  if (!Number.isFinite(timeSeconds)) throw new RangeError('timeSeconds must be finite');
  const base = directionAt(BASE_LATITUDE_DEG, BASE_LONGITUDE_DEG);
  const east = eastAt(base);
  const north = northAt(base);
  const westCenter = moved(base, east, -12, 6 * 3_600);
  const eastCenter = moved(base, east, 12, 6 * 3_600);
  const zero = {
    fixture,
    centerA: base,
    centerB: eastCenter,
    liquidA: 0,
    liquidB: 0,
    topA: 1_500,
    topB: 1_500,
    iceA: 0,
    iceB: 0,
    iceCenterA: ICE_CENTER_M,
    iceCenterB: ICE_CENTER_M,
    waveStrength: 0,
    marineStrength: 0,
  } satisfies MeteorologicalFixtureImageState;

  switch (fixture) {
    case 'C1':
      return {
        ...zero,
        centerA: moved(base, east, 10, timeSeconds),
        liquidA: 0.9,
        topA: 3_000,
      };
    case 'C2':
      return {
        ...zero,
        centerA: moved(base, east, 10, timeSeconds),
        centerB: moved(base, north, 10, timeSeconds),
        liquidA: 0.9,
        topA: 2_500,
        iceB: 0.7,
        iceCenterB: 10_000,
      };
    case 'C3': {
      const lifecycle = cloudLifecycleAt({
        eventId: 'cloud-lab-C3',
        ageSeconds: Math.max(0, timeSeconds),
        convectiveDurationSeconds: 3_600,
        upperRelativeHumidity: 0.9,
      });
      return {
        ...zero,
        liquidA: lifecycle.updraftFraction,
        topA: 2_000 + 12_000 * lifecycle.updraftFraction,
        iceA: 0.9 * lifecycle.residualIceFraction,
        iceCenterA: 11_000,
      };
    }
    case 'C4': {
      const ageSeconds = Math.max(0, timeSeconds);
      const moist = cloudLifecycleAt({
        eventId: 'cloud-lab-C4-moist',
        ageSeconds,
        convectiveDurationSeconds: 3_600,
        upperRelativeHumidity: 0.9,
      });
      const dry = cloudLifecycleAt({
        eventId: 'cloud-lab-C4-dry',
        ageSeconds,
        convectiveDurationSeconds: 3_600,
        upperRelativeHumidity: 0.2,
      });
      return {
        ...zero,
        centerA: westCenter,
        centerB: eastCenter,
        liquidA: 0.25 * moist.updraftFraction,
        liquidB: 0.25 * dry.updraftFraction,
        topA: 6_000,
        topB: 6_000,
        iceA: 0.9 * moist.residualIceFraction,
        iceB: 0.9 * dry.residualIceFraction,
      };
    }
    case 'C5':
      return {
        ...zero,
        centerA: westCenter,
        centerB: eastCenter,
        liquidA: 0.9,
        liquidB: 0.9,
        topA: 7_500,
        topB: 2_500,
      };
    case 'C6':
      return {
        ...zero,
        centerA: westCenter,
        centerB: eastCenter,
        iceA: c6Tau(0.10),
        iceB: c6Tau(0.20),
        iceCenterA: 10_000,
        iceCenterB: 10_000,
      };
    case 'C7':
      return {
        ...zero,
        iceA: 0.75,
        waveStrength: 1,
        iceCenterA: 8_500,
      };
    case 'C8':
      return {
        ...zero,
        liquidA: 0.88,
        topA: 1_800,
        marineStrength: 1,
      };
    case 'C9':
      return {
        ...zero,
        centerA: moved(base, east, 8, timeSeconds),
        centerB: moved(base, north, 14, timeSeconds),
        liquidA: 0.9,
        topA: 1_600,
        iceB: 0.75,
        iceCenterB: 10_500,
      };
  }
}

function setVec3(target: THREE.Vector3, value: Vec3): void {
  target.set(value.x, value.y, value.z);
}

function radialMask(
  direction: Vec3Node,
  center: Vec3Node,
  innerRadiusDeg: number,
  outerRadiusDeg: number,
): FloatNode {
  return smoothstep(
    Math.cos(THREE.MathUtils.degToRad(outerRadiusDeg)),
    Math.cos(THREE.MathUtils.degToRad(innerRadiusDeg)),
    dot(direction, center),
  );
}

export class MeteorologicalFixtureCloudControl {
  private readonly weights: Readonly<Record<MeteorologicalCaseId, FloatUniform>> = {
    C1: uniform(1), C2: uniform(0), C3: uniform(0), C4: uniform(0), C5: uniform(0),
    C6: uniform(0), C7: uniform(0), C8: uniform(0), C9: uniform(0),
  };
  private readonly centerA: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly centerB: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly liquidA: FloatUniform = uniform(0);
  private readonly liquidB: FloatUniform = uniform(0);
  private readonly topA: FloatUniform = uniform(1_500);
  private readonly topB: FloatUniform = uniform(1_500);
  private readonly iceA: FloatUniform = uniform(0);
  private readonly iceB: FloatUniform = uniform(0);
  private readonly iceCenterA: FloatUniform = uniform(ICE_CENTER_M);
  private readonly iceCenterB: FloatUniform = uniform(ICE_CENTER_M);
  private readonly waveStrength: FloatUniform = uniform(0);
  private readonly marineStrength: FloatUniform = uniform(0);
  private readonly wavePhase: FloatUniform = uniform(0);
  private selectedFixture: MeteorologicalCaseId = 'C1';
  private lastTimeSeconds = 0;

  public readonly transform: CloudSampleTransform = {
    sample: (direction, weather, sample) => this.sample(direction, weather, sample),
    syncTime: (seconds) => this.syncTime(seconds),
  };

  public setFixture(id: MeteorologicalCaseId): void {
    this.selectedFixture = id;
    for (const [fixture, weight] of Object.entries(this.weights) as [MeteorologicalCaseId, FloatUniform][]) {
      weight.value = fixture === id ? 1 : 0;
    }
    this.syncTime(this.lastTimeSeconds);
  }

  public syncTime(seconds: number): void {
    this.lastTimeSeconds = seconds;
    const state = meteorologicalFixtureImageState(this.selectedFixture, seconds);
    setVec3(this.centerA.value, state.centerA);
    setVec3(this.centerB.value, state.centerB);
    this.liquidA.value = state.liquidA;
    this.liquidB.value = state.liquidB;
    this.topA.value = state.topA;
    this.topB.value = state.topB;
    this.iceA.value = state.iceA;
    this.iceB.value = state.iceB;
    this.iceCenterA.value = state.iceCenterA;
    this.iceCenterB.value = state.iceCenterB;
    this.waveStrength.value = state.waveStrength;
    this.marineStrength.value = state.marineStrength;
    const turns = seconds / (3 * 3_600);
    this.wavePhase.value = (turns - Math.floor(turns)) * 2 * Math.PI;
  }

  private sample(direction: Vec3Node, weather: WeatherSample, base: CloudSample): CloudSample {
    const coreA = radialMask(direction, this.centerA, CORE_INNER_DEG, CORE_OUTER_DEG);
    const coreB = radialMask(direction, this.centerB, CORE_INNER_DEG, CORE_OUTER_DEG);
    const anvilA = radialMask(direction, this.centerA, ANVIL_INNER_DEG, ANVIL_OUTER_DEG);
    const anvilB = radialMask(direction, this.centerB, ANVIL_INNER_DEG, ANVIL_OUTER_DEG);

    const c1Coverage = coreA.mul(this.liquidA);
    const c1Top = this.topA;

    const c2Coverage = coreA.mul(this.liquidA);
    const c2Top = this.topA;
    const c2Ice = anvilB.mul(this.iceB);

    const c3Coverage = coreA.mul(this.liquidA);
    const c3Top = this.topA;
    const c3Ice = anvilA.mul(this.iceA);

    const c4Coverage = max(coreA.mul(this.liquidA), coreB.mul(this.liquidB));
    const c4Top = max(coreA.mul(this.topA), coreB.mul(this.topB));
    const c4Ice = anvilA.mul(this.iceA).add(anvilB.mul(this.iceB));

    const c5Coverage = max(coreA.mul(this.liquidA), coreB.mul(this.liquidB));
    const c5Top = max(coreA.mul(this.topA), coreB.mul(this.topB));

    const c6Ice = anvilA.mul(this.iceA).add(anvilB.mul(this.iceB));

    const uv = equirectUvFromDirection(direction);
    const wave = max(sin(
      uv.x.mul(2 * Math.PI * 24)
        .add(uv.y.mul(2 * Math.PI * 5))
        .sub(this.wavePhase),
    ), 0).mul(anvilA).mul(this.waveStrength);
    const c7Ice = wave.mul(this.iceA);

    const marineWalls = smoothstep(-0.10, 0.16, weather.convection.y);
    const marineCores = smoothstep(0.02, 0.20, weather.convection.x);
    const marinePattern = mix(marineWalls, marineCores, 0.28)
      .mul(coreA).mul(this.marineStrength);
    const c8Coverage = marinePattern.mul(this.liquidA);

    const c9Coverage = coreA.mul(this.liquidA);
    const c9Ice = anvilB.mul(this.iceB);

    const w = this.weights;
    const fixtureWeight = clamp(
      w.C1.add(w.C2).add(w.C3).add(w.C4).add(w.C5).add(w.C6).add(w.C7).add(w.C8).add(w.C9),
      0, 1,
    );
    const coverage = c1Coverage.mul(w.C1)
      .add(c2Coverage.mul(w.C2))
      .add(c3Coverage.mul(w.C3))
      .add(c4Coverage.mul(w.C4))
      .add(c5Coverage.mul(w.C5))
      .add(c8Coverage.mul(w.C8))
      .add(c9Coverage.mul(w.C9));
    const cloudTop = c1Top.mul(w.C1)
      .add(c2Top.mul(w.C2))
      .add(c3Top.mul(w.C3))
      .add(c4Top.mul(w.C4))
      .add(c5Top.mul(w.C5))
      .add(this.topA.mul(w.C8))
      .add(this.topA.mul(w.C9));
    const iceOpticalDepth = c2Ice.mul(w.C2)
      .add(c3Ice.mul(w.C3))
      .add(c4Ice.mul(w.C4))
      .add(c6Ice.mul(w.C6))
      .add(c7Ice.mul(w.C7))
      .add(c9Ice.mul(w.C9));
    const iceCenter = this.iceCenterA.mul(w.C3.add(w.C6).add(w.C7))
      .add(this.iceCenterB.mul(w.C2.add(w.C9)))
      .add(max(this.iceCenterA, this.iceCenterB).mul(w.C4));

    return {
      coverage: mix(base.coverage, clamp(coverage, 0, 1), fixtureWeight),
      cloudTop: mix(base.cloudTop, max(cloudTop, 0), fixtureWeight),
      iceOpticalDepth: mix(base.iceOpticalDepth, max(iceOpticalDepth, 0), fixtureWeight),
      iceCenter: mix(base.iceCenter, max(iceCenter, float(0)), fixtureWeight),
    };
  }
}
