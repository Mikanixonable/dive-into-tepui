// 前のフレームから動きベクトルでは追えない場面の変化の量 d を、2 つのフレームの様子の差から見積もる純関数。
// 要素ごとの指標はどれも完全一致で 0、小さな変化について 1 次で、d は重みを掛けた和。
import type { Quat } from '../../math/quat';
import { qInvert, qMul, qRotate } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import { add, cross, dot, len, sub, v3 } from '../../math/vec3';

// 基準の受け手から見たカメラの置き方。offset は基準の位置からの変位(軸は ECI)、orientation は局所の座標から ECI の軸への回転。
export interface SamplePose { readonly offset: Vec3; readonly orientation: Quat }

// カメラの射影。aspect は幅 / 高さ。
export type SampleProjection =
  | { readonly kind: 'perspective'; readonly verticalFovRad: number; readonly aspect: number }
  | { readonly kind: 'orthographic'; readonly halfHeight: number; readonly aspect: number };

// 光源 1 つ。key はフレームをまたいで同じ光源を引く鍵、direction は基準の位置から光源への単位ベクトル(軸は ECI)、irradiance は
// 基準の位置の照度(光源どうしを均す割合。恒星光は日照率を掛けた後)。
export interface SampleLight { readonly key: string; readonly direction: Vec3; readonly irradiance: number }

// 1 描画フレームの様子。referenceOrientation は光の向きとカメラの動きを測る基準の受け手の、局所の座標から ECI の軸への回転。
// camera は three の規約(局所の −Z を見る)、sunlit は基準の位置の日照率 0..1。
export interface SceneChangeSample {
  readonly cameraKey: string;
  readonly referenceOrientation: Quat;
  readonly camera: SamplePose;
  readonly projection: SampleProjection;
  readonly lights: readonly SampleLight[];
  readonly sunlit: number;
}

// 要素ごとの指標。lightDirection は基準の座標系での光の向きの回転 [rad](照度で均す)、sunlit は |log f_今 − log f_前|、
// cameraSlide は基準の座標系で画面が 1 フレームに滑る量 [画面の高さ](可視性の出入りの代わり)。
export interface SceneChangeTerms {
  readonly lightDirection: number;
  readonly sunlit: number;
  readonly cameraSlide: number;
}

// 要素ごとの重み w(d = Σ w·指標)。1/w は残像が 1/e に減るまでに場面が変わる量。
export type SceneChangeWeights = { readonly [K in keyof SceneChangeTerms]: number };

// 本番の重み。
// TODO: 参考値。render-lab の再生と実機で詰める。
export const SCENE_CHANGE_WEIGHTS: SceneChangeWeights = {
  lightDirection: 10,
  sunlit: 1,
  cameraSlide: 4,
};

// 画面の滑りを測る点の NDC の座標と、基準までの距離に対する奥行きの倍率。奥行きを 3 つ取るのは、回転(どの奥行きも同じだけ
// 滑る — 画面の端から物が入る)と並進・周回(奥行きで滑り方が違う視差 — 物が別の物の裏から出る)を 1 つの量で数えるため。
const SLIDE_NDC = [-1, 0, 1] as const;
const SLIDE_DEPTH_SCALES = [0.5, 1, 2] as const;
// 基準までの距離の下限 [m]。カメラが基準に重なっても奥行きが 0 にならないようにする。
const MIN_REFERENCE_DISTANCE = 1e-3;

// previous から current への要素ごとの指標。
export function sceneChangeTermsOf(previous: SceneChangeSample, current: SceneChangeSample): SceneChangeTerms {
  return {
    lightDirection: lightDirectionTermOf(previous, current),
    sunlit: sunlitTermOf(previous.sunlit, current.sunlit),
    cameraSlide: cameraSlideTermOf(previous, current),
  };
}

// 指標 terms を重み weights で足した変化量。重み 0 の要素は足さない(0·∞ を NaN にしない)。負・非有限の重みは投げる。
export function sceneChangeOf(terms: SceneChangeTerms, weights: SceneChangeWeights): number {
  let total = 0;
  for (const key of Object.keys(terms) as (keyof SceneChangeTerms)[]) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`scene-change: invalid ${key} weight ${weight}`);
    if (weight !== 0) total += weight * terms[key];
  }
  return total;
}

// 光源を鍵で対にし、基準の局所の座標での向きの角を、前と今の照度の平均で均す。片方の様子にしか無い光源は角 π。
function lightDirectionTermOf(previous: SceneChangeSample, current: SceneChangeSample): number {
  const previousByKey = new Map(previous.lights.map((light) => [light.key, light]));
  const currentByKey = new Map(current.lights.map((light) => [light.key, light]));
  const previousInverse = qInvert(previous.referenceOrientation);
  const currentInverse = qInvert(current.referenceOrientation);
  let weightedAngle = 0;
  let irradianceSum = 0;
  // 前と今のどちらかにある光源ごとに、局所の向きの角を照度の重みで積む。
  for (const key of new Set([...previousByKey.keys(), ...currentByKey.keys()])) {
    const before = previousByKey.get(key);
    const now = currentByKey.get(key);
    const weight = ((before?.irradiance ?? 0) + (now?.irradiance ?? 0)) / 2;
    if (weight === 0) continue;
    const angle = before === undefined || now === undefined ? Math.PI : angleBetween(
      qRotate(previousInverse, before.direction), qRotate(currentInverse, now.direction),
    );
    weightedAngle += weight * angle;
    irradianceSum += weight;
  }
  return irradianceSum === 0 ? 0 : weightedAngle / irradianceSum;
}

// 日照率 previous から current への |log 比|。両方 0 なら 0、片方だけ 0 なら ∞(本影への出入り)。
function sunlitTermOf(previous: number, current: number): number {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0 || current === 0) return Infinity;
  return Math.abs(Math.log(current) - Math.log(previous));
}

// 画面の 3×3 の点を前のカメラで奥行き D/2・D・2D(D は今のカメラから基準までの距離)の点へ戻し、今のカメラで射影し直したときの
// 滑り [画面の高さ] の RMS。どちらのカメラも基準の局所の座標で扱う。局所の姿勢と射影が前と同じならちょうど 0、射影の種類が替わる
// か点が今のカメラの後ろへ回ると ∞。
function cameraSlideTermOf(previous: SceneChangeSample, current: SceneChangeSample): number {
  const before = localPoseOf(previous.referenceOrientation, previous.camera);
  const now = localPoseOf(current.referenceOrientation, current.camera);
  if (samePose(before, now) && sameProjection(previous.projection, current.projection)) return 0;
  if (previous.projection.kind !== current.projection.kind) return Infinity;
  const distance = Math.max(len(now.offset), MIN_REFERENCE_DISTANCE);
  const nowInverse = qInvert(now.orientation);
  let squares = 0;
  let count = 0;
  // 奥行き 3 つ × 画面の 3×3 の点ごとに、前のカメラから戻した点を今のカメラで射影し直した滑りの二乗を積む。
  for (const scale of SLIDE_DEPTH_SCALES) {
    for (const x of SLIDE_NDC) {
      for (const y of SLIDE_NDC) {
        const point = add(
          before.offset, qRotate(before.orientation, unprojected(previous.projection, x, y, distance * scale)),
        );
        const projected = projectedNdc(current.projection, qRotate(nowInverse, sub(point, now.offset)));
        if (projected === null) return Infinity;
        const aspect = current.projection.aspect;
        squares += ((projected[0] - x) * aspect / 2) ** 2 + ((projected[1] - y) / 2) ** 2;
        count++;
      }
    }
  }
  return Math.sqrt(squares / count);
}

// 射影 projection の NDC (x, y) を、カメラ座標の奥行き depth の点へ戻す。
function unprojected(projection: SampleProjection, x: number, y: number, depth: number): Vec3 {
  if (projection.kind === 'perspective') {
    const tanHalfFov = Math.tan(projection.verticalFovRad / 2);
    return v3(x * projection.aspect * tanHalfFov * depth, y * tanHalfFov * depth, -depth);
  }
  return v3(x * projection.aspect * projection.halfHeight, y * projection.halfHeight, -depth);
}

// カメラ座標の点 point を射影 projection の NDC へ。透視でカメラの後ろ(−z ≤ 0)なら null。
function projectedNdc(projection: SampleProjection, point: Vec3): readonly [number, number] | null {
  if (projection.kind === 'perspective') {
    if (-point.z <= 0) return null;
    const tanHalfFov = Math.tan(projection.verticalFovRad / 2);
    return [point.x / (-point.z * projection.aspect * tanHalfFov), point.y / (-point.z * tanHalfFov)];
  }
  return [point.x / (projection.aspect * projection.halfHeight), point.y / projection.halfHeight];
}

// 置き方 pose を、向き referenceOrientation の基準の局所の座標へ移す。
function localPoseOf(referenceOrientation: Quat, pose: SamplePose): SamplePose {
  const inverse = qInvert(referenceOrientation);
  return { offset: qRotate(inverse, pose.offset), orientation: qMul(inverse, pose.orientation) };
}

// 2 つの置き方の成分がすべて等しいか。
function samePose(a: SamplePose, b: SamplePose): boolean {
  return a.offset.x === b.offset.x && a.offset.y === b.offset.y && a.offset.z === b.offset.z
    && a.orientation.x === b.orientation.x && a.orientation.y === b.orientation.y
    && a.orientation.z === b.orientation.z && a.orientation.w === b.orientation.w;
}

// 2 つの射影の種類と値がすべて等しいか。
function sameProjection(a: SampleProjection, b: SampleProjection): boolean {
  if (a.kind !== b.kind || a.aspect !== b.aspect) return false;
  return a.kind === 'perspective' && b.kind === 'perspective'
    ? a.verticalFovRad === b.verticalFovRad
    : a.kind === 'orthographic' && b.kind === 'orthographic' && a.halfHeight === b.halfHeight;
}

// 2 つの向きの間の角 [rad]。0 と π の近くでも丸めで潰れない。
function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(len(cross(a, b)), dot(a, b));
}
