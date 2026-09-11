// 照明・影・大気の書き込み(render/celestial/celestial-illumination.ts)の回帰テスト。固定の
// 表示入力から各パスへ書かれる値が決まること、非表示の候補が外れること、恒星光を持たない星系でも
// 基準どおりの光源が置かれることを見る。露出の係数・影の枠数・色の調整値そのものは固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CelestialIllumination, type IlluminationTargets } from '../../src/render/celestial/celestial-illumination';
import { SunLight, STARLESS_SUN_DISTANCE } from '../../src/render/pipeline/sun-light';
import { BodyShadow } from '../../src/render/pipeline/shadow/body-shadow';
import { CameraView } from '../../src/render/camera/camera-view';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3, type Vec3 } from '../../src/math/vec3';
import { DEFAULT_GRAPHICS } from '../../src/render/graphics-settings';
import type { AtmosphereDraw } from '../../src/render/atmosphere';
import type { PlanetLightValue } from '../../src/render/pipeline/lighting/planet-light-source';
import type { ShadowCumulus } from '../../src/render/pipeline/shadow/cloud-shadow-renderer';
import type { RingBand } from '../../src/render/pipeline/shadow/ring-shadow';
import type {
  CelestialIlluminationSource, CelestialIlluminationView, DefinedCelestialBody,
} from '../../src/render/celestial/celestial-entity/celestial-view';
import type { CameraFrame } from '../../src/render/camera/camera-frame';
import type { Viewpoint } from '../../src/math/projection';
import type { Viewport } from '../../src/render/viewport';

const VIEWPORT: Viewport = { width: 1280, height: 720, pixelRatio: 1 };

// 原点を見下ろす視点。露出と天体照の基準点は注視点なので、注視点を原点に置く。
const VIEWPOINT: Viewpoint = {
  position: v3(0, 0, 2e7),
  lookTarget: v3(),
  up: v3(0, 1, 0),
  fovDeg: 50,
  aspect: VIEWPORT.width / VIEWPORT.height,
  projection: 'perspective',
};

function cameraFrame(): CameraFrame {
  return new CameraView().sync(VIEWPOINT, VIEWPOINT.fovDeg, 2e7, VIEWPORT, 'map', false, v3());
}

// 各パスへ書かれた値の記録。illumination が書き込む口だけを持つ。
interface RecordedTargets extends IlluminationTargets {
  readonly planetLights: PlanetLightValue[][];
  readonly atmosphereDraws: (readonly AtmosphereDraw[])[];
  readonly cumulusCasters: (ShadowCumulus | null)[];
  readonly ambientFractions: number[];
  readonly sunPositions: THREE.Vector3[];
}

// 置かれた恒星光の位置を控える。影の形が実体の SunLight を要るので、差し替えでなく派生で覗く。
class RecordingSunLight extends SunLight {
  public readonly positions: THREE.Vector3[] = [];

  public override set(
    position: THREE.Vector3, radius: number, color: THREE.Color, intensity: number,
  ): void {
    this.positions.push(position.clone());
    super.set(position, radius, color, intensity);
  }
}

// 書き込みを控えるだけの書き込み先。恒星光と影の形だけは実体を使う(環のマテリアルと同じもの)。
function recordingTargets(): RecordedTargets {
  const sunLight = new RecordingSunLight();
  const planetLights: PlanetLightValue[][] = [];
  const atmosphereDraws: (readonly AtmosphereDraw[])[] = [];
  const cumulusCasters: (ShadowCumulus | null)[] = [];
  const ambientFractions: number[] = [];
  return {
    sunLight,
    bodyShadow: new BodyShadow(sunLight),
    exposure: { setReference: () => {}, fixedBrightnessScale: 1 },
    ringShadow: { set: (_center: THREE.Vector3, _axis: THREE.Vector3, _bands: readonly RingBand[]) => {} },
    cumulusShadow: { set: (cumulus: ShadowCumulus | null) => { cumulusCasters.push(cumulus); } },
    planetLight: { set: (lights: readonly PlanetLightValue[]) => { planetLights.push([...lights]); } },
    ambient: { setFraction: (fraction: number) => { ambientFractions.push(fraction); } },
    atmosphere: { setDraws: (draws: readonly AtmosphereDraw[]) => { atmosphereDraws.push([...draws]); } },
    planetLights,
    atmosphereDraws,
    cumulusCasters,
    ambientFractions,
    sunPositions: sunLight.positions,
  };
}

// 半径 radius [m]、ECI 位置 position に静止した、自転も大気も持たない天体。
function body(id: string, radius: number, position: Vec3): DefinedCelestialBody {
  const def = { id, mu: 0, radius } as DefinedCelestialBody['def'];
  const motion: DefinedCelestialBody = {
    id,
    kind: 'planet',
    def,
    primary: null,
    stateAt: (pivot: number, t?: number) => kinematicState<'eci'>(t ?? pivot, position, v3()),
    positionAt: () => position,
    atmosphereAt: () => null,
    degree2At: () => null,
    orientationAt: () => null,
    spinRotationAt: () => null,
    spinRate: null,
  };
  return motion;
}

// 地球ほどの大気の光学。値そのものは検証しないので、実在の桁に合わせた 1 組を使う。
const TEST_OPTICS = {
  rayleigh: new THREE.Vector3(5.8e-6, 1.35e-5, 3.31e-5),
  rayleighScaleHeight: 8.5e3,
  mie: 2.1e-5,
  mieScaleHeight: 1.2e3,
  mieAnisotropy: 0.76,
};

// 大気の候補を必ず1つ返す表示。可視のフレームだけ illumination がこれを読む。
function atmosphereView(): CelestialIlluminationView {
  return {
    lightSourceAlbedo: null,
    rings: () => null,
    cumulusShadowAt: () => null,
    atmosphereCandidateAt: (motion, floatingOrigin, displayTime) => ({
      body: {
        center: floatingOrigin.RtoThreeV3(motion.positionAt(displayTime)),
        surfaceRadius: motion.def.radius,
        polarAxis: new THREE.Vector3(0, 1, 0),
        polarRatio: 1,
        optics: TEST_OPTICS,
        clouds: null,
      },
      distance: 2e7,
      metersPerPixel: 1e4,
    }),
  };
}

// 何も答えない表示。光源にも影にも大気にもならない。
function plainView(): CelestialIlluminationView {
  return {
    lightSourceAlbedo: null,
    rings: () => null,
    cumulusShadowAt: () => null,
    atmosphereCandidateAt: () => null,
  };
}

function source(
  motion: DefinedCelestialBody, view: CelestialIlluminationView, visible: boolean,
): CelestialIlluminationSource {
  return { motion, view, visible };
}

export function register(): void {
  test('celestial-illumination: 恒星光を持たない星系では、渡された向きの先へ光源が置かれる', () => {
    const targets = recordingTargets();
    const illumination = new CelestialIllumination(null, targets);
    const camera = cameraFrame();
    const sunDirection = v3(1, 0, 0);

    illumination.sync([], 0, camera, DEFAULT_GRAPHICS, null, sunDirection);

    assert.equal(targets.sunPositions.length, 1, '恒星光が1度だけ書かれていない');
    const placed = targets.sunPositions[0]!;
    assert.ok(Math.abs(placed.length() - STARLESS_SUN_DISTANCE) < 1, '基準の距離に置かれていない');
    // 渡された向きへ置く。向きだけで決まり、天体の顔ぶれには依らない。
    assert.ok(placed.x > 0 && Math.abs(placed.y) < 1e-6 && Math.abs(placed.z) < 1e-6, '向きが渡した値と違う');
  });

  test('celestial-illumination: 非表示の天体は大気の候補から外れる', () => {
    const targets = recordingTargets();
    const illumination = new CelestialIllumination(null, targets);
    const camera = cameraFrame();
    const earthLike = body('earth-like', 6.371e6, v3());

    illumination.sync(
      [source(earthLike, atmosphereView(), true)], 0, camera, DEFAULT_GRAPHICS, null, v3(1, 0, 0));
    const visibleDraws = targets.atmosphereDraws[0]!.length;
    assert.ok(visibleDraws > 0, '表示中の天体の大気が描かれていない');

    illumination.sync(
      [source(earthLike, atmosphereView(), false)], 0, camera, DEFAULT_GRAPHICS, null, v3(1, 0, 0));
    assert.equal(targets.atmosphereDraws[1]!.length, 0, '非表示の天体の大気が残っている');
  });

  test('celestial-illumination: 同じ入力を再び sync すると、同じ値が書かれる', () => {
    const targets = recordingTargets();
    const illumination = new CelestialIllumination(null, targets);
    const camera = cameraFrame();
    const sources = [source(body('a', 1e6, v3(2e7, 0, 0)), plainView(), true)];

    illumination.sync(sources, 100, camera, DEFAULT_GRAPHICS, null, v3(0, 1, 0));
    illumination.sync(sources, 100, camera, DEFAULT_GRAPHICS, null, v3(0, 1, 0));

    assert.deepEqual(targets.sunPositions[1]!.toArray(), targets.sunPositions[0]!.toArray(), '恒星光が再現しない');
    assert.deepEqual(targets.planetLights[1], targets.planetLights[0], '天体照が再現しない');
    assert.deepEqual(targets.ambientFractions[1], targets.ambientFractions[0], '環境光が再現しない');
    assert.deepEqual(targets.atmosphereDraws[1], targets.atmosphereDraws[0], '大気が再現しない');
  });

  test('celestial-illumination: 積雲の影を落とす天体が無ければ、源そのものを切る', () => {
    const targets = recordingTargets();
    const illumination = new CelestialIllumination(null, targets);
    illumination.sync(
      [source(body('a', 1e6, v3()), plainView(), true)], 0, cameraFrame(), DEFAULT_GRAPHICS, null, v3(1, 0, 0));
    assert.equal(targets.cumulusCasters[0], null, '雲を持たないのに影の源が置かれた');
  });

  test('celestial-illumination: 露出の基準が確定した後の明るさ係数を読み返せる', () => {
    const targets = recordingTargets();
    const illumination = new CelestialIllumination(null, targets);
    illumination.sync([], 0, cameraFrame(), DEFAULT_GRAPHICS, null, v3(1, 0, 0));
    assert.equal(illumination.fixedBrightnessScale, targets.exposure.fixedBrightnessScale);
  });
}

