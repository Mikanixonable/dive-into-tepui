// 星系の天体を、この1フレームの照らす源・遮る源・霞ませる源として選び、描画パスへ渡す。
// 恒星と露出の基準・環境光・天体照・天体と環と積雲の影・大気の描画対象を、ECI で組んだ候補から
// 選び、描画座標へ移したうえで書き込む。
import * as THREE from 'three/webgpu';
import { shapeAxes, shapeInscribedRadius, shapeOf } from '../../physics/celestial-body-def';
import { DEFAULT_ALBEDO } from '../../render/celestial-albedo';
import { atmosphereDraws } from '../../render/atmosphere';
import {
  REFERENCE_STAR_RADIANT_INTENSITY, STARLESS_SUN_COLOR, STARLESS_SUN_DISTANCE,
  STARLESS_SUN_RADIUS, SunLight,
} from '../../render/pipeline/sun-light';
import { ambientFraction, type AmbientSource } from '../../render/pipeline/lighting/ambient-source';
import { selectPlanetLights } from '../../render/pipeline/lighting/planet-light-select';
import { MAX_SHADOW_BODIES, type BodyShadow, type ShadowBody } from '../../render/pipeline/shadow/body-shadow';
import {
  castsCumulusShadow, selectRingShadow, selectShadowBodies, type RingShadowCandidate,
} from '../../render/pipeline/shadow/shadow-select';
import { focusTargetId } from '../camera/focus-target';
import { writeBodyFromWorld } from './body-frame';
import type { Vec3 } from '../../math/vec3';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { Exposure } from '../../render/pipeline/exposure';
import type { PlanetLightSource } from '../../render/pipeline/lighting/planet-light-source';
import type { AtmospherePass } from '../../render/pipeline/atmosphere-pass';
import type { RingShadow } from '../../render/pipeline/shadow/ring-shadow';
import type { CumulusShadow } from '../../render/pipeline/shadow/cumulus-shadow';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { CelestialBodies } from './celestial-bodies';
import type { CelestialEntity } from './celestial-entity/celestial-entity';
import type { StellarLightSource } from './celestial-entity/celestial-view';
import type { MapVisibilityPolicy } from '../map/visibility-policy';

const ZERO_VECTOR = new THREE.Vector3();
const UP_VECTOR = new THREE.Vector3(0, 1, 0);

// 光源・影・大気が、この1フレームぶんの値を書き込まれる先。
export interface IlluminationTargets {
  readonly sunLight: SunLight;
  readonly exposure: Exposure;
  readonly bodyShadow: BodyShadow;
  readonly ringShadow: RingShadow;
  readonly cumulusShadow: CumulusShadow;
  readonly planetLight: PlanetLightSource;
  readonly ambient: AmbientSource;
  readonly atmosphere: AtmospherePass;
}

export class CelestialIllumination {
  // 影を落とす天体へ渡す形の置き場。スロット本数ぶんを毎フレーム書き換えて使い回す。
  private readonly shadowBodyShapes = Array.from({ length: MAX_SHADOW_BODIES }, () => ({
    axes: new THREE.Vector3(), bodyFromWorld: new THREE.Matrix4(),
  }));

  // entities はこの星系の全天体(宣言順)、star はその主星の恒星光で、恒星を持たない星系では null。
  public constructor(
    private readonly celestialBodies: CelestialBodies,
    private readonly entities: readonly CelestialEntity[],
    private readonly star: StellarLightSource | null,
    private readonly targets: IlluminationTargets,
  ) {}

  // 露出に順応しない表示物(星殻・点群)へ掛ける明るさ係数。同じフレームの sync が露出の基準を
  // 確定させた後にだけ正しい値を返す。
  public get fixedBrightnessScale(): number { return this.targets.exposure.fixedBrightnessScale; }

  // 恒星・露出・環境光・天体照・影・大気を、この1フレームの表示状態に同期する。
  // **全天体の sync より後に呼ぶこと** — 積雲と大気の候補は個体の表示状態から決まる。
  public sync(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem,
    graphics: GraphicsSettingsData, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const star = this.star;
    // 主星が無いレジストリでは、描画原点から見た恒星方向へ 1 天文単位の位置に半径 0 の光源を置く
    // (基準強度どおりの放射照度が届き、影パスは誰も遮らないと答える)。
    const starPos = star === null ? null : star.motion.stateAt(displayTime).r;
    const sunPos = starPos === null
      ? this.toThreeNormal(this.celestialBodies.sunDirFrom(fo.r, displayTime))
        .multiplyScalar(STARLESS_SUN_DISTANCE)
      : fo.RtoThreeV3(starPos);
    // 露出の順応と天体照の選定の基準点。カメラ位置ではなく注視点から取る —
    // マップビューではカメラが太陽系の外にいることがあり、そこを基準にすると露出が発散する。
    const reference = fo.RtoThreeV3(cameraSystem.activeViewpoint.lookTarget);
    const starIntensity = star?.stellarLight.radiantIntensity ?? REFERENCE_STAR_RADIANT_INTENSITY;
    this.targets.exposure.setReference(reference, sunPos, starIntensity);
    this.targets.sunLight.set(
      sunPos, star?.motion.def.radius ?? STARLESS_SUN_RADIUS,
      star?.stellarLight.color ?? STARLESS_SUN_COLOR, starIntensity);
    this.targets.ambient.setFraction(ambientFraction(cameraSystem.view === 'map', graphics));
    this.syncPlanetLights(fo, displayTime, cameraSystem);
    this.syncShadowSources(fo, displayTime, cameraSystem, graphics);
    this.syncAtmosphere(fo, displayTime, cameraSystem, graphics, visibilityPolicy);
  }

  // 天体照の光源の候補を組んで選定へ渡し、選ばれたものを描画座標へ移してライティング側の
  // スロットへ入れる。基準点は露出と同じ注視点。
  private syncPlanetLights(fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem): void {
    // 全天体を候補にし、注視点から見た明るさで選ぶ。
    const candidates = this.entities.map((entity) => ({
      celestialBody: entity.motion,
      albedo: entity.view.lightSourceAlbedo ?? DEFAULT_ALBEDO,
    }));
    const lights = selectPlanetLights(
      candidates, displayTime, this.star?.stellarLight.radiantIntensity ?? null,
      cameraSystem.activeViewpoint.lookTarget);
    // 選ばれた天体を描画座標へ移し、内接球の半径で渡す。
    this.targets.planetLight.set(lights.map((light) => ({
      center: fo.RtoThreeV3(light.celestialBody.positionAt(displayTime)),
      radius: shapeInscribedRadius(light.celestialBody.def.radius, shapeOf(light.celestialBody.def)),
      radiance: light.radiance,
    })));
  }

  // 影パスへ、この1フレームの影を落とす天体と環の帯を渡す。候補を組んで選定へ回し、選ばれた
  // ものを描画座標へ移す。
  private syncShadowSources(
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem, graphics: GraphicsSettingsData,
  ): void {
    // マップの注視点(天体でない対象なら null)。
    const focusId = focusTargetId(cameraSystem.mapCamera.focus);
    const focusPos = focusId === undefined
      ? null
      : this.celestialBodies.findMotion(focusId)?.positionAt(displayTime) ?? null;
    // 選ばれた天体の形を、天体固定の半軸と向きの行列にして渡す。
    this.targets.bodyShadow.set(
      selectShadowBodies(this.celestialBodies.celestialMotions, displayTime, fo.r, focusPos)
        .map((body, slot): ShadowBody => {
          const shape = this.shadowBodyShapes[slot]!;
          const axes = shapeAxes(body.def.radius, shapeOf(body.def));
          shape.axes.set(axes.x, axes.y, axes.z);
          writeBodyFromWorld(shape.bodyFromWorld, body, displayTime);
          return { center: fo.RtoThreeV3(body.positionAt(displayTime)), ...shape };
        }));
    this.syncRingShadow(fo, displayTime, graphics);
    this.syncCumulusShadow(fo, displayTime, graphics);
  }

  // 積雲の殻を持つ天体を影パスへ渡す。持つ天体が無いか、雲そのものか雲の影を切る設定なら
  // 源ごと切る。
  private syncCumulusShadow(
    fo: FloatingOrigin, displayTime: number, graphics: GraphicsSettingsData,
  ): void {
    const casters = castsCumulusShadow(graphics)
      ? this.entities.flatMap((body) => body.view.cumulusShadowAt(body.motion, fo, displayTime) ?? [])
      : [];
    this.targets.cumulusShadow.set(casters[0] ?? null);
  }

  // 環を持つ天体を候補として選定へ回し、選ばれた1体の帯を影パスへ渡す。選ばれなければ
  // 帯を空にする(影は落ちない)。
  private syncRingShadow(fo: FloatingOrigin, displayTime: number, graphics: GraphicsSettingsData): void {
    // 環を持つ天体を候補に組む(ECI)。
    const candidates = this.entities.flatMap((body): RingShadowCandidate[] => {
      const rings = body.view.rings(body.motion);
      if (rings === null) return [];
      return [{
        center: body.motion.stateAt(displayTime).r,
        axis: body.motion.orientationAt(displayTime)?.axis ?? null,
        radius: body.motion.def.radius,
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
    fo: FloatingOrigin, displayTime: number, cameraSystem: CameraSystem,
    graphics: GraphicsSettingsData, visibilityPolicy: MapVisibilityPolicy | null,
  ): void {
    const scale = cameraSystem.activeCameraRadialScale;
    const candidates = this.entities.flatMap((body) => {
      if (visibilityPolicy !== null && !visibilityPolicy.body(body.id).category) return [];
      const candidate = body.view.atmosphereCandidateAt(
        body.motion, fo, displayTime, cameraSystem.activeCameraPos, scale, graphics);
      return candidate === null ? [] : [candidate];
    });
    this.targets.atmosphere.setDraws(atmosphereDraws(candidates, graphics.atmosphere));
  }

  // ECI の法線を描画座標のベクトルへ移し、単位長へそろえる。
  private toThreeNormal(normal: Vec3): THREE.Vector3 {
    return new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
  }
}
