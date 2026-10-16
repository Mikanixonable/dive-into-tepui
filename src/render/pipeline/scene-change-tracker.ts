// 描画パイプラインが受けた宣言から、フレームごとの様子を写して前の番号の様子と比べ、時間方向の蓄積へ渡す変化量 d を決める。
// 外から宣言を受けるのは、宣言の差から導けない 2 つ — カメラの同一性の鍵と、基準の受け手の姿勢 — だけ。
import * as THREE from 'three/webgpu';
import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import { norm, sub, v3 } from '../../math/vec3';
import { sphereSunlitFactor } from '../../physics/shadow';
import { frameStepOf } from './screen-space/temporal-accumulation';
import {
  SCENE_CHANGE_WEIGHTS, sceneChangeOf, sceneChangeTermsOf, type SampleLight, type SamplePose, type SampleProjection,
  type SceneChangeSample, type SceneChangeTerms, type SceneChangeWeights,
} from './scene-change';
import type { PlanetLightSource } from './lighting/planet-light-source';
import type { BodyShadow } from './shadow/body-shadow';
import type { SunLight } from './sun-light';

// 毎フレーム描く前に宣言する、変化量の推定の基準(そのフレームの全体を宣言する)。cameraKey はカメラの同一性の鍵で、同じ値の間は
// 同じカメラ、替わった番号で d = ∞。reference* は光の向きとカメラの動きを測る基準の受け手の姿勢(描画座標)。
export interface SceneChangeDeclaration {
  readonly cameraKey: string;
  readonly referencePosition: THREE.Vector3;
  readonly referenceOrientation: THREE.Quaternion;
}

// 外へ見せる口 — 宣言・重み・直前の推定。
export type SceneChangeDeclarations = Pick<SceneChangeTracker, 'set' | 'setWeights' | 'lastTerms' | 'lastChange'>;

// Rec.709 の輝度の係数。天体照の色つきの放射輝度を、照度の割合を比べる 1 つの数へ畳む。
const LUMINANCE = [0.2126, 0.7152, 0.0722] as const;

export class SceneChangeTracker {
  // 直前に受けた宣言(成分を写したもの)。
  private declaration: SceneChangeDeclaration | null = null;
  // 直前に番号を進めたフレームの様子と、その番号。
  private previous: SceneChangeSample | null = null;
  private previousFrame: number | null = null;
  private weights: SceneChangeWeights = SCENE_CHANGE_WEIGHTS;
  private terms: SceneChangeTerms | null = null;
  private change = 0;

  // このフレームの宣言を受ける。成分を写して持つ — 参照で持つと、呼び出し側が次のフレームで書き換えたときに前と今が同じになる。
  public set(declaration: SceneChangeDeclaration): void {
    this.declaration = {
      cameraKey: declaration.cameraKey,
      referencePosition: declaration.referencePosition.clone(),
      referenceOrientation: declaration.referenceOrientation.clone(),
    };
  }

  // 要素の重み。null で本番の重み(SCENE_CHANGE_WEIGHTS)。
  public setWeights(weights: SceneChangeWeights | null): void {
    this.weights = weights === null ? SCENE_CHANGE_WEIGHTS : { ...weights };
  }

  // 直前に番号を進めたときの要素ごとの指標(前の様子と比べなかったなら null)と、蓄積へ渡した d。
  public get lastTerms(): SceneChangeTerms | null { return this.terms; }
  public get lastChange(): number { return this.change; }

  // 直前の宣言と、パイプラインの恒星光・天体照・影を落とす天体の宣言、カメラ camera から、このフレームの様子を写す。宣言が
  // 一度も無ければ投げる。
  public sampleOf(
    camera: THREE.Camera, sunLight: SunLight, planetLight: PlanetLightSource, bodyShadow: BodyShadow,
  ): SceneChangeSample {
    if (this.declaration === null) throw new Error('SceneChangeTracker: declaration has not been set');
    const { cameraKey, referencePosition, referenceOrientation } = this.declaration;
    const reference = vec3Of(referencePosition);
    const sunPosition = vec3Of(sunLight.position.value);
    // 日照率は描いている影と同じ遮り手から、半軸を平均の半径の球へ近似して求める。
    const occluders = bodyShadow.declaredBodies.map(({ center, axes }) => ({
      center: vec3Of(center), radius: (axes.x + axes.y + axes.z) / 3,
    }));
    const sunlit = sphereSunlitFactor(reference, sunPosition, sunLight.radiusValue, occluders);
    const cameraPosition = new THREE.Vector3();
    const cameraOrientation = new THREE.Quaternion();
    camera.matrixWorld.decompose(cameraPosition, cameraOrientation, new THREE.Vector3());
    return {
      cameraKey,
      reference: { position: reference, orientation: quatOf(referenceOrientation) },
      camera: poseOf(cameraPosition, cameraOrientation),
      projection: projectionOf(camera),
      lights: lightsOf(reference, sunPosition, sunLight.intensityValue * sunlit, planetLight),
      sunlit,
    };
  }

  // 番号 frame を描く前に、外から渡す変化量 external とこのフレームの様子 sample から、蓄積へ渡す d を返す。同じ番号の描き直しは
  // 前の様子も d も変えない。連続した番号で鍵が同じなら d = external + 推定、鍵が替われば ∞、番号が飛ぶか external が ∞ なら
  // external(前の様子は今の様子で置き直す)。
  public changeAt(frame: number, external: number, sample: SceneChangeSample): number {
    if (this.declaration === null) throw new Error('SceneChangeTracker: declaration has not been set');
    const step = frameStepOf(this.previousFrame, frame, external);
    if (step === 'repeat') return this.change;
    // 連続した番号でだけ前の様子と比べる。どの場合も前の様子を今の様子で置き直す。
    this.terms = null;
    if (step === 'advance' && this.previous !== null) {
      if (this.previous.cameraKey !== sample.cameraKey) {
        this.change = Infinity;
      } else {
        this.terms = sceneChangeTermsOf(this.previous, sample);
        this.change = external + sceneChangeOf(this.terms, this.weights);
      }
    } else {
      this.change = external;
    }
    this.previous = sample;
    this.previousFrame = frame;
    return this.change;
  }
}

// 基準の位置 reference から見た光源の並び。恒星光の照度 sunIrradianceScale / 距離² は日照率を掛けた後、天体照の照度は
// π × 輝度 × (半径 / 距離)²(1 で頭打ち)。
function lightsOf(
  reference: Vec3, sunPosition: Vec3, sunIrradianceScale: number, planetLight: PlanetLightSource,
): readonly SampleLight[] {
  const toSun = sub(sunPosition, reference);
  const sunDistanceSq = toSun.x * toSun.x + toSun.y * toSun.y + toSun.z * toSun.z;
  const lights: SampleLight[] = [{
    key: 'sun', direction: norm(toSun), irradiance: sunDistanceSq === 0 ? 0 : sunIrradianceScale / sunDistanceSq,
  }];
  // 天体照は宣言の鍵のまま並べる。
  for (const light of planetLight.declaredLights) {
    const toPlanet = sub(vec3Of(light.center), reference);
    const distanceSq = toPlanet.x * toPlanet.x + toPlanet.y * toPlanet.y + toPlanet.z * toPlanet.z;
    const luminance = LUMINANCE.reduce((sum, weight, channel) => sum + weight * light.radiance[channel]!, 0);
    const solidAngleRatio = distanceSq === 0 ? 1 : Math.min(1, light.radius * light.radius / distanceSq);
    lights.push({ key: light.key, direction: norm(toPlanet), irradiance: Math.PI * luminance * solidAngleRatio });
  }
  return lights;
}

// カメラの射影。透視の画角はズームを畳んだ縦の画角、平行の高さはズームを畳んだ半分の高さ。view offset は見ない。
function projectionOf(camera: THREE.Camera): SampleProjection {
  // three のカメラの型ごとに、画角か高さを読む。
  if (camera instanceof THREE.PerspectiveCamera) {
    const fov = camera.fov * Math.PI / 180;
    return { kind: 'perspective', verticalFovRad: 2 * Math.atan(Math.tan(fov / 2) / camera.zoom), aspect: camera.aspect };
  }
  if (camera instanceof THREE.OrthographicCamera) {
    return {
      kind: 'orthographic',
      halfHeight: (camera.top - camera.bottom) / (2 * camera.zoom),
      aspect: (camera.right - camera.left) / (camera.top - camera.bottom),
    };
  }
  throw new Error(`SceneChangeTracker: unsupported camera ${camera.type}`);
}

function vec3Of(value: THREE.Vector3): Vec3 { return v3(value.x, value.y, value.z); }

function quatOf(value: THREE.Quaternion): Quat { return { x: value.x, y: value.y, z: value.z, w: value.w }; }

// three の位置と向きから、成分を写した姿勢を作る。
function poseOf(position: THREE.Vector3, orientation: THREE.Quaternion): SamplePose {
  return { position: vec3Of(position), orientation: quatOf(orientation) };
}
