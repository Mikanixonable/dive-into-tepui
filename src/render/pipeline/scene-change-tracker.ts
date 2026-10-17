// フレームごとに、パイプラインが受けた恒星光・天体照・影を落とす天体の宣言とカメラから場面の様子を写し、前の番号の様子と
// 比べて時間方向の蓄積の変化量 d を決める。宣言の差から導けない 2 つ — カメラの同一性の鍵と基準の受け手の姿勢 — は、
// 毎フレーム外から宣言を受ける。
import * as THREE from 'three/webgpu';
import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import { lenSq, norm, v3 } from '../../math/vec3';
import { sphereSunlitFactor } from '../../physics/shadow';
import { rec709Luminance } from '../celestial-albedo';
import { frameStepOf } from './screen-space/temporal-accumulation';
import {
  SCENE_CHANGE_WEIGHTS, sceneChangeOf, sceneChangeTermsOf, type SampleLight, type SampleProjection,
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

export class SceneChangeTracker {
  // 直前に受けた宣言(成分を写したもの)。
  private declaration: SceneChangeDeclaration | null = null;
  // 直前に番号を進めたフレームの様子と、その番号。
  private previous: SceneChangeSample | null = null;
  private previousFrame: number | null = null;
  // 要素の重み。
  private weights: SceneChangeWeights = SCENE_CHANGE_WEIGHTS;
  // 直前に番号を進めたときの要素ごとの指標(前の様子と比べなかったなら null)と、決めた d。
  private terms: SceneChangeTerms | null = null;
  private change = 0;

  // このフレームの宣言を受ける。成分を写して持つので、呼び出し側は渡した値をこの後に書き換えてよい。
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
    const toSun = offsetOf(sunLight.position.value, referencePosition);
    // 日照率は描いている影と同じ遮り手から、半軸を平均の半径の球へ近似して求める。
    const occluders = bodyShadow.declaredBodies.map(({ center, axes }) => ({
      center: offsetOf(center, referencePosition), radius: (axes.x + axes.y + axes.z) / 3,
    }));
    const sunlit = sphereSunlitFactor(v3(0, 0, 0), toSun, sunLight.radiusValue, occluders);
    // カメラの置き方と射影を写す。
    const cameraPosition = new THREE.Vector3();
    const cameraOrientation = new THREE.Quaternion();
    camera.matrixWorld.decompose(cameraPosition, cameraOrientation, new THREE.Vector3());
    return {
      cameraKey,
      referenceOrientation: quatOf(referenceOrientation),
      camera: { offset: offsetOf(cameraPosition, referencePosition), orientation: quatOf(cameraOrientation) },
      projection: projectionOf(camera),
      lights: lightsOf(toSun, sunLight.intensityValue * sunlit, planetLight, referencePosition),
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

// 描画座標の位置 reference から見た光源の並び。toSun は reference から恒星への変位。恒星光の照度 sunIrradianceScale /
// 距離² は日照率を掛けた後、天体照の照度は π × 輝度 × (半径 / 距離)²(1 で頭打ち)。
function lightsOf(
  toSun: Vec3, sunIrradianceScale: number, planetLight: PlanetLightSource, reference: THREE.Vector3,
): readonly SampleLight[] {
  const sunDistanceSq = lenSq(toSun);
  const lights: SampleLight[] = [{
    key: 'sun', direction: norm(toSun), irradiance: sunDistanceSq === 0 ? 0 : sunIrradianceScale / sunDistanceSq,
  }];
  // 天体照は宣言の鍵のまま並べる。
  for (const light of planetLight.declaredLights) {
    const toPlanet = offsetOf(light.center, reference);
    const distanceSq = lenSq(toPlanet);
    const luminance = rec709Luminance(light.radiance);
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
    return {
      kind: 'perspective', verticalFovRad: 2 * Math.atan(Math.tan(fov / 2) / camera.zoom), aspect: camera.aspect,
    };
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

// 描画座標の位置 reference から position への変位(軸は ECI)。描画座標の原点はフレームごとに動くので、位置は変位で比べる。
function offsetOf(position: THREE.Vector3, reference: THREE.Vector3): Vec3 {
  return v3(position.x - reference.x, position.y - reference.y, position.z - reference.z);
}

function quatOf(value: THREE.Quaternion): Quat { return { x: value.x, y: value.y, z: value.z, w: value.w }; }
