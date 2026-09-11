// 星系の天体から、この1フレームの照らす源・遮る源・霞ませる源を選び、恒星光・露出・環境光・
// 天体照・影・大気の各パスへ描画座標で書き込む。
import * as THREE from 'three/webgpu';
import { shapeAxes, shapeInscribedRadius, shapeOf } from '../../physics/celestial-body-def';
import { DEFAULT_ALBEDO } from '../../render/celestial-albedo';
import { atmosphereDraws } from '../../render/atmosphere';
import {
  REFERENCE_STAR_RADIANT_INTENSITY, STARLESS_SUN_COLOR, STARLESS_SUN_DISTANCE,
  STARLESS_SUN_RADIUS, SunLight,
} from '../../render/pipeline/sun-light';
import { ambientFraction } from '../../render/pipeline/lighting/ambient-source';
import { selectPlanetLights } from '../../render/pipeline/lighting/planet-light-select';
import { MAX_SHADOW_BODIES, type BodyShadow, type ShadowBody } from '../../render/pipeline/shadow/body-shadow';
import {
  castsCumulusShadow, selectRingShadow, selectShadowBodies, type RingShadowCandidate,
} from '../../render/pipeline/shadow/shadow-select';
import { writeBodyFromWorld } from '../../render/celestial/body-frame';
import type { Vec3 } from '../../math/vec3';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { PlanetLightValue } from '../../render/pipeline/lighting/planet-light-source';
import type { AtmosphereDraw } from '../../render/atmosphere';
import type { RingBand } from '../../render/pipeline/shadow/ring-shadow';
import type { ShadowCumulus } from '../../render/pipeline/shadow/cloud-shadow-renderer';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { FloatingOrigin } from '../../render/camera/floating-origin';
import type {
  CelestialIlluminationSource, StellarLightSource,
} from './celestial-entity/celestial-view';

const ZERO_VECTOR = new THREE.Vector3();
const UP_VECTOR = new THREE.Vector3(0, 1, 0);

// 光源・影・大気が、この1フレームぶんの値を書き込まれる先。
export interface IlluminationTargets {
  // 恒星光と、影を落とす天体の形の書き込み先。
  readonly sunLight: SunLight;
  readonly bodyShadow: BodyShadow;
  // 以下は値を書き込むメソッドの口で受ける。
  readonly exposure: {
    setReference(reference: THREE.Vector3, sunPosition: THREE.Vector3, sunIntensity: number): void;
    readonly fixedBrightnessScale: number;
  };
  readonly ringShadow: { set(center: THREE.Vector3, axis: THREE.Vector3, bands: readonly RingBand[]): void };
  readonly cumulusShadow: { set(cumulus: ShadowCumulus | null): void };
  readonly planetLight: { set(lights: readonly PlanetLightValue[]): void };
  readonly ambient: { setFraction(fraction: number): void };
  readonly atmosphere: { setDraws(draws: readonly AtmosphereDraw[]): void };
}

export class CelestialIllumination {
  // 影を落とす天体へ渡す形の置き場。スロット本数ぶんを毎フレーム書き換えて使い回す。
  private readonly shadowBodyShapes = Array.from({ length: MAX_SHADOW_BODIES }, () => ({
    axes: new THREE.Vector3(), bodyFromWorld: new THREE.Matrix4(),
  }));

  // star はこの星系の主星の恒星光で、恒星光を持たない星系では null。
  public constructor(
    private readonly star: StellarLightSource | null,
    private readonly targets: IlluminationTargets,
  ) {}

  // 露出に順応しない表示物(星殻・点群)へ掛ける明るさ係数。同じフレームの sync が露出の基準を
  // 確定させた後にだけ正しい値を返す。
  public get fixedBrightnessScale(): number { return this.targets.exposure.fixedBrightnessScale; }

  // 恒星・露出・環境光・天体照・影・大気を、この1フレームの表示状態に同期する。全天体の sync の
  // 後に呼ぶ。sources は星系の全天体とその表示可否、focusPosition は注視中の天体の ECI 位置
  // (天体以外を注視中は null)、sunDirection は恒星を持たない星系で光源を置く向き。
  public sync(
    sources: readonly CelestialIlluminationSource[], displayTime: number, camera: CameraFrame,
    graphics: GraphicsSettingsData, focusPosition: Vec3 | null, sunDirection: Vec3,
  ): void {
    const fo = camera.floatingOrigin;
    const star = this.star;
    // 主星が無い星系の光源は、sunDirection の向きの固定距離に置く。
    const starPos = star === null ? null : star.motion.stateAt(displayTime).r;
    const sunPos = starPos === null
      ? this.toThreeNormal(sunDirection).multiplyScalar(STARLESS_SUN_DISTANCE)
      : fo.RtoThreeV3(starPos);
    // 露出と天体照の基準点は注視点 — カメラ位置だと、太陽系の外にいるマップビューで露出が発散する。
    const reference = fo.RtoThreeV3(camera.viewpoint.lookTarget);
    const starIntensity = star?.stellarLight.radiantIntensity ?? REFERENCE_STAR_RADIANT_INTENSITY;
    this.targets.exposure.setReference(reference, sunPos, starIntensity);
    this.targets.sunLight.set(
      sunPos, star?.motion.def.radius ?? STARLESS_SUN_RADIUS,
      star?.stellarLight.color ?? STARLESS_SUN_COLOR, starIntensity);
    this.targets.ambient.setFraction(ambientFraction(camera.mode === 'map', graphics));
    this.syncPlanetLights(sources, displayTime, camera);
    this.syncShadowSources(sources, fo, displayTime, focusPosition, graphics);
    this.syncAtmosphere(sources, displayTime, camera, graphics);
  }

  // 天体照の光源の候補を組んで選定へ渡し、選ばれたものを描画座標へ移してライティング側の
  // スロットへ入れる。基準点は露出と同じ注視点。
  private syncPlanetLights(
    sources: readonly CelestialIlluminationSource[], displayTime: number, camera: CameraFrame,
  ): void {
    // 全天体を候補にし、注視点から見た明るさで選ぶ。
    const candidates = sources.map((source) => ({
      celestialBody: source.motion,
      albedo: source.view.lightSourceAlbedo ?? DEFAULT_ALBEDO,
    }));
    const lights = selectPlanetLights(
      candidates, displayTime, this.star?.stellarLight.radiantIntensity ?? null,
      camera.viewpoint.lookTarget);
    // 選ばれた天体を描画座標へ移し、内接球の半径で渡す。
    this.targets.planetLight.set(lights.map((light) => ({
      center: camera.floatingOrigin.RtoThreeV3(light.celestialBody.positionAt(displayTime)),
      radius: shapeInscribedRadius(light.celestialBody.def.radius, shapeOf(light.celestialBody.def)),
      radiance: light.radiance,
    })));
  }

  // 影パスへ、この1フレームの影を落とす天体・環の帯・積雲の殻を渡す。
  private syncShadowSources(
    sources: readonly CelestialIlluminationSource[], fo: FloatingOrigin, displayTime: number,
    focusPosition: Vec3 | null, graphics: GraphicsSettingsData,
  ): void {
    // 選ばれた天体の形を、天体固定の半軸と向きの行列にして渡す。
    this.targets.bodyShadow.set(
      selectShadowBodies(sources.map((source) => source.motion), displayTime, fo.r, focusPosition)
        .map((body, slot): ShadowBody => {
          const shape = this.shadowBodyShapes[slot]!;
          const axes = shapeAxes(body.def.radius, shapeOf(body.def));
          shape.axes.set(axes.x, axes.y, axes.z);
          writeBodyFromWorld(shape.bodyFromWorld, body, displayTime);
          return { center: fo.RtoThreeV3(body.positionAt(displayTime)), ...shape };
        }));
    this.syncRingShadow(sources, fo, displayTime, graphics);
    this.syncCumulusShadow(sources, fo, displayTime, graphics);
  }

  // 積雲の殻を返す最初の1体を影パスへ渡す。該当が無いか、設定が雲の影を切るなら null を渡す。
  private syncCumulusShadow(
    sources: readonly CelestialIlluminationSource[], fo: FloatingOrigin, displayTime: number,
    graphics: GraphicsSettingsData,
  ): void {
    const casters = castsCumulusShadow(graphics)
      ? sources.flatMap((source) => source.view.cumulusShadowAt(source.motion, fo, displayTime) ?? [])
      : [];
    this.targets.cumulusShadow.set(casters[0] ?? null);
  }

  // 環を持つ天体を候補として選定へ回し、選ばれた1体の帯を影パスへ渡す。選ばれなければ
  // 帯を空にする(影は落ちない)。
  private syncRingShadow(
    sources: readonly CelestialIlluminationSource[], fo: FloatingOrigin, displayTime: number,
    graphics: GraphicsSettingsData,
  ): void {
    // 環を持つ天体を候補に組む(ECI)。
    const candidates = sources.flatMap((source): RingShadowCandidate[] => {
      const rings = source.view.rings(source.motion);
      if (rings === null) return [];
      return [{
        center: source.motion.stateAt(displayTime).r,
        axis: source.motion.orientationAt(displayTime)?.axis ?? null,
        radius: source.motion.def.radius,
        bands: rings.bands.map((band) => ({
          innerRadius: band.innerRadius,
          outerRadius: band.outerRadius,
          normalOpticalDepth: band.optics.normalOpticalDepth,
        })),
      }];
    });
    // 選ばれた 1 体を描画座標へ移す。
    const ringed = selectRingShadow(candidates, fo.r, graphics);
    if (ringed === null) {
      this.targets.ringShadow.set(ZERO_VECTOR, UP_VECTOR, []);
      return;
    }
    this.targets.ringShadow.set(
      fo.RtoThreeV3(ringed.center),
      ringed.axis === null ? UP_VECTOR : this.toThreeNormal(ringed.axis),
      ringed.bands,
    );
  }

  // 大気パスへ、このフレームに大気を描く天体とそのサンプル点の数を渡す。
  private syncAtmosphere(
    sources: readonly CelestialIlluminationSource[], displayTime: number, camera: CameraFrame,
    graphics: GraphicsSettingsData,
  ): void {
    const scale = camera.radialScale;
    const candidates = sources.flatMap((source) => {
      if (!source.visible) return [];
      const candidate = source.view.atmosphereCandidateAt(
        source.motion, camera.floatingOrigin, displayTime, camera.position, scale, graphics);
      return candidate === null ? [] : [candidate];
    });
    this.targets.atmosphere.setDraws(atmosphereDraws(candidates, graphics.atmosphere));
  }

  // ECI の法線を描画座標のベクトルへ移し、単位長へそろえる。
  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }
}
