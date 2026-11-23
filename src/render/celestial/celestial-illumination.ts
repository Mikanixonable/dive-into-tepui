// 星系の天体から、この1フレームの照らす源・遮る源・霞ませる源を選び、恒星光・露出・環境光・
// 天体照・影・大気の各パスへ描画座標で書き込む。
import * as THREE from 'three/webgpu';
import { shapeAxes, shapeInscribedRadius, shapeOf } from '../../physics/celestial-body-def';
import { DEFAULT_ALBEDO } from './celestial-albedo';
import { atmosphereDraws } from '../atmosphere';
import {
  REFERENCE_RADIANT_INTENSITY, STARLESS_SUN_COLOR, STARLESS_SUN_DISTANCE, STARLESS_SUN_RADIUS, type SunLight,
  scaledRadiantIntensity,
} from '../pipeline/sun-light';
import { ambientFraction, nightObservationFraction } from '../pipeline/lighting/ambient-source';
import { selectPlanetLights } from '../pipeline/lighting/planet-light-select';
import {
  MAX_PLANET_LIGHT_SLOTS, type PlanetLightValue,
} from '../pipeline/lighting/planet-light-source';
import { MAX_SHADOW_BODIES, type BodyShadow, type ShadowBody } from '../pipeline/shadow/body-shadow';
import {
  cloudShadowKinds, selectRingShadow, selectShadowBodies,
  type CloudShadowKinds, type RingShadowCandidate,
} from '../pipeline/shadow/shadow-select';
import { ringShadowBands, type RingBand } from '../pipeline/shadow/ring-shadow';
import { writeBodyFromWorld } from './body-frame';
import type { Vec3 } from '../../math/vec3';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { AtmosphereBody, AtmosphereCandidate, AtmosphereDraw } from '../atmosphere';
import type { ShadowCloud } from '../pipeline/shadow/cloud-shadow-renderer';
import type { CameraFrame } from '../camera/camera-frame';
import type { FloatingOrigin } from '../camera/floating-origin';
import type {
  CelestialIlluminationSource, DefinedCelestialBody, StellarLightSource,
} from './entity/celestial-view';

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
  readonly cloudShadow: { set(cloud: ShadowCloud | null, kinds: CloudShadowKinds): void };
  readonly planetLight: { set(lights: readonly PlanetLightValue[]): void };
  readonly ambient: {
    setFraction(fraction: number): void;
    setNightObservation(center: THREE.Vector3, radius: number, fraction: number): void;
  };
  readonly atmosphere: { setDraws(draws: readonly AtmosphereDraw[]): void };
  // 直射光が抜ける大気。atmosphere へ渡すのと同じ天体の列を受ける。
  readonly sunExtinction: { set(bodies: readonly AtmosphereBody[]): void };
  // 天空光を届ける大気。sunExtinction と同じ列を受ける。
  readonly skyLight: { set(bodies: readonly AtmosphereBody[]): void };
}

export class CelestialIllumination {
  // 影を落とす天体へ渡す形の置き場。スロット本数ぶんを毎フレーム書き換えて使い回す。
  private readonly shadowBodyShapes = Array.from({ length: MAX_SHADOW_BODIES }, () => ({
    axes: new THREE.Vector3(), bodyFromWorld: new THREE.Matrix4(),
  }));

  // 天体照の光源へ渡す向きの置き場。スロット本数ぶんを毎フレーム書き換えて使い回す。
  private readonly planetLightFrames = Array.from({ length: MAX_PLANET_LIGHT_SLOTS }, () => ({
    starDirection: new THREE.Vector3(), bodyFromWorld: new THREE.Matrix4(),
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
  // 後に呼ぶ。sources は星系の全天体、focusPosition は注視中の天体の ECI 位置
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
    const starIntensity = star === null
      ? REFERENCE_RADIANT_INTENSITY : scaledRadiantIntensity(star.motion.def.radiantIntensity);
    this.targets.exposure.setReference(reference, sunPos, starIntensity);
    this.targets.sunLight.set(
      sunPos, star?.motion.def.radius ?? STARLESS_SUN_RADIUS,
      star?.stellarLight.color ?? STARLESS_SUN_COLOR, starIntensity);
    this.targets.ambient.setFraction(ambientFraction(graphics));
    this.syncNightObservation(sources, fo, displayTime, graphics);
    // 大気を持つ天体は、天体照の写しにも大気パスにも同じ 1 体として渡す。
    const atmospheres = this.atmosphereCandidates(sources, displayTime, camera, graphics);
    this.syncPlanetLights(sources, atmospheres, displayTime, camera, sunPos);
    this.syncShadowSources(sources, fo, displayTime, focusPosition, graphics);
    // 大気パスが描く天体と同じ列を、直射光の消衰へも渡す — 描かない大気は光も減らさない。
    const draws = atmosphereDraws([...atmospheres.values()], graphics);
    this.targets.atmosphere.setDraws(draws);
    const bodies = draws.map((draw) => draw.body);
    this.targets.sunExtinction.set(bodies);
    this.targets.skyLight.set(bodies);
  }

  // 「夜側の観察」の強めた環境光を、観察球を差し出した天体(いまは地球だけ)へ描画座標で
  // 書き込む。設定が切れているか、差し出す天体が無ければ消灯する。
  private syncNightObservation(
    sources: readonly CelestialIlluminationSource[], fo: FloatingOrigin,
    displayTime: number, graphics: GraphicsSettingsData,
  ): void {
    const fraction = nightObservationFraction(graphics);
    let observation: { readonly motion: DefinedCelestialBody; readonly radius: number } | null = null;
    if (fraction !== 0) {
      for (const source of sources) {
        const radius = source.view.nightObservationRadius(source.motion);
        if (radius !== null) { observation = { motion: source.motion, radius }; break; }
      }
    }
    this.targets.ambient.setNightObservation(
      observation === null ? ZERO_VECTOR : fo.RtoThreeV3(observation.motion.positionAt(displayTime)),
      observation?.radius ?? 0,
      observation === null ? 0 : fraction,
    );
  }

  // 天体照の光源の候補を組んで選定へ渡し、選ばれたものを描画座標へ移してライティング側の
  // スロットへ入れる。基準点は露出と同じ注視点で、atmospheres は天体ごとの大気の候補、sunPos は
  // 描画座標の恒星の位置。
  private syncPlanetLights(
    sources: readonly CelestialIlluminationSource[],
    atmospheres: ReadonlyMap<DefinedCelestialBody, AtmosphereCandidate>, displayTime: number,
    camera: CameraFrame, sunPos: THREE.Vector3,
  ): void {
    // 全天体を候補にし、注視点から見た明るさで選ぶ。
    const candidates = sources.map((source) => ({
      celestialBody: source.motion,
      albedo: source.view.lightSourceAlbedo ?? DEFAULT_ALBEDO,
    }));
    const lights = selectPlanetLights(candidates, displayTime, camera.viewpoint.lookTarget);
    // 選ばれた天体を描画座標へ移し、内接球の半径と、写しへ焼く見た目を添えて渡す。
    this.targets.planetLight.set(lights.map((light, slot): PlanetLightValue => {
      const center = camera.floatingOrigin.RtoThreeV3(light.celestialBody.positionAt(displayTime));
      // 選定は天体だけを返すので、見た目はその天体を差し出した源から引き直す。
      const view = sources.find((source) => source.motion === light.celestialBody)?.view ?? null;
      const frame = this.planetLightFrames[slot]!;
      frame.starDirection.subVectors(sunPos, center).normalize();
      writeBodyFromWorld(frame.bodyFromWorld, light.celestialBody, displayTime);
      return {
        key: light.celestialBody.def.id,
        center,
        radius: shapeInscribedRadius(light.celestialBody.def.radius, shapeOf(light.celestialBody.def)),
        radiance: light.radiance,
        appearance: {
          map: view?.lightSourceMap ?? null,
          albedo: view?.lightSourceAlbedo ?? DEFAULT_ALBEDO,
          sunIrradiance: light.sunIrradiance,
          starDirection: frame.starDirection,
          bodyFromWorld: frame.bodyFromWorld,
          atmosphere: atmospheres.get(light.celestialBody)?.body ?? null,
        },
      };
    }));
  }

  // 影パスへ、この1フレームの影を落とす天体・環の帯・雲の影の源を渡す。
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
    this.syncCloudShadow(sources, fo, displayTime, graphics);
  }

  // 雲の影の源を返す最初の1体を、種類ごとの有無とともに影パスへ渡す。源が無いか、設定が
  // どちらの影も切るなら null を渡す。影の細部の段数は、影を落とす天体の雲がこの
  // フレームに立てた実効段数と揃える。
  private syncCloudShadow(
    sources: readonly CelestialIlluminationSource[], fo: FloatingOrigin, displayTime: number,
    graphics: GraphicsSettingsData,
  ): void {
    const gate = cloudShadowKinds(graphics);
    const casters = gate.cumulus || gate.cirrus
      ? sources.flatMap((source) => source.view.cloudShadowAt(source.motion, fo, displayTime) ?? [])
      : [];
    const cloud = casters[0] ?? null;
    this.targets.cloudShadow.set(cloud, cloudShadowKinds(graphics, cloud?.cloud ?? null));
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
        bands: ringShadowBands(rings.bands),
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

  // このフレームの大気の候補を、大気を持つ天体ごとに返す。
  private atmosphereCandidates(
    sources: readonly CelestialIlluminationSource[], displayTime: number, camera: CameraFrame,
    graphics: GraphicsSettingsData,
  ): ReadonlyMap<DefinedCelestialBody, AtmosphereCandidate> {
    const candidates = new Map<DefinedCelestialBody, AtmosphereCandidate>();
    for (const source of sources) {
      const candidate = source.view.atmosphereCandidateAt(
        source.motion, camera.floatingOrigin, displayTime, camera.position, camera.radialScale, graphics);
      if (candidate !== null) candidates.set(source.motion, candidate);
    }
    return candidates;
  }

  // ECI の法線を描画座標のベクトルへ移し、単位長へそろえる。
  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }
}
