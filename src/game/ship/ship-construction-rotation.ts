// 選択中モジュールの回転リングの幾何。接続軸まわりの円の中心・軸・面内基底を ECI で求め、
// 視線との交点の角度・ドラッグ角の 90° 単位への丸めを純関数で答える。
// 表示の導出(リングの描画宣言)とポインタの解釈(掴み・角度追従)が同じ面を読む。
import { LOCAL_FORWARD, qFromBasis, qRotate, type Quat } from '../../math/quat';
import type { Ray } from '../../math/ray';
import { addScaled, cross, dot, len, norm, scale, sub, v3, type Vec3 } from '../../math/vec3';
import type { ShipAssembly } from './ship-assembly';

// 回転リングの幾何(ECI)。axisEci まわりに右手則で角度を取る。uEci/vEci は面内の
// 角度基準で、視線からの角度計算とリング上の矢印・弧の配置を同じ基準に揃える。
export interface ConstructionRotationRing {
  readonly centerEci: Vec3; // ECI [m]
  readonly axisEci: Vec3; // ECI 単位ベクトル。rotate が回す軸と同じ向き
  readonly uEci: Vec3; // 面内の角度基準(単位ベクトル)
  readonly vEci: Vec3; // = axisEci × uEci
  // 局所基底 (u, v, axis) を ECI へ写す回転。表示姿勢としてそのまま渡せる。
  readonly rotation: Quat;
  readonly radius: number; // m
}

// リング面への視線の交点。angle は uEci/vEci 基準の角 [rad]。
export interface RotationRingHit {
  readonly point: Vec3; // 交点 ECI [m]
  readonly distance: number; // リング中心からの距離 [m]
  readonly angle: number; // 基準角 [rad]
}

// リングのドラッグ中の角度情報。表示の導出が弧とスナップ位置を組む材料。
export interface ConstructionRotationDrag {
  // 掴んだ点の基準角 [rad]
  readonly startAngle: number;
  // 掴んだ点からの累積角 [rad](軸の向きに右手則)
  readonly angle: number;
  // いま離したときに適用される 90° 単位の段数。ドラッグ中の強調表示と
  // 実際の適用がずれないよう、入力の解釈と同じ丸めを前もって持つ。
  readonly appliedSteps: number;
}

// リングが読む船体の面。表示の導出とポインタの解釈が渡す共通の形。
interface RotationRingShip {
  readonly assembly: ShipAssembly;
  readonly motion: {
    readonly att: { readonly q: Quat };
    assemblyToEci(local: Vec3): Vec3;
  };
}

// モジュールの半径に足すリングの隙間 [m]。
const RING_RADIUS_MARGIN_M = 0.6;

// 回転の 1 段 [rad]。
const ROTATION_STEP_RAD = Math.PI / 2;

const WORLD_UP = v3(0, 1, 0);
const WORLD_RIGHT = v3(1, 0, 0);

// moduleId の回転リングを ECI で求める。回転軸はモジュールの根元の接続部の軸で、
// rotate(delta) が回す軸と同じ向き(モジュールの局所 +Z を船体姿勢へ写したもの)。
// モジュール・定義が読めないときは null。
export function constructionRotationRing(
  ship: RotationRingShip, moduleId: string,
): ConstructionRotationRing | null {
  const { assembly } = ship;
  const transform = assembly.worldTransformOf(moduleId);
  const definition = assembly.definition(moduleId);
  if (transform === null || definition === null) return null;
  const q = ship.motion.att.q;
  const axis = norm(qRotate(q, qRotate(transform.rotation, LOCAL_FORWARD)));
  // 面内の角度基準は環境の上方向から取る。軸がほぼ上向きなら基準を横へ換えて
  // 基底が縮退しないようにする。
  const up = Math.abs(dot(axis, WORLD_UP)) < 0.9 ? WORLD_UP : WORLD_RIGHT;
  const u = norm(cross(up, axis));
  const v = cross(axis, u);
  return {
    centerEci: ship.motion.assemblyToEci(transform.position),
    axisEci: axis,
    uEci: u,
    vEci: v,
    rotation: qFromBasis(axis, v),
    radius: definition.diameter / 2 + RING_RADIUS_MARGIN_M,
  };
}

// 視線 ray とリング面(中心・軸が定める平面)の交点。面とほぼ平行・視点の背後・
// 中心へ当たるときは null。リングの帯の内側かどうかは distance と半径の比較で呼び側が決める。
export function ringPlaneHit(ring: ConstructionRotationRing, ray: Ray): RotationRingHit | null {
  const denom = dot(ray.dir, ring.axisEci);
  if (Math.abs(denom) < 1e-4) return null;
  const t = dot(sub(ring.centerEci, ray.origin), ring.axisEci) / denom;
  if (t <= 0) return null;
  const point = addScaled(ray.origin, ray.dir, t);
  const offset = sub(point, ring.centerEci);
  const distance = len(offset);
  if (!(distance > 1e-9)) return null;
  // 中心へのオフセットを面内の基底へ投影して基準角を取る。
  const dir = scale(offset, 1 / distance);
  return {
    point,
    distance,
    angle: Math.atan2(dot(dir, ring.vEci), dot(dir, ring.uEci)),
  };
}

// 累積角を 90° 単位の段数へ丸める。正負は角の向きを保つ。
function rotationSteps(angle: number): number {
  return Math.round(angle / ROTATION_STEP_RAD);
}

// 角度 a を (−π, π] へ畳む。ドラッグの差分角が ±π を跨いでも向きが反転しないようにする。
export function wrapAnglePi(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

// 押した位置の基準角から、最も近い回転矢印の向きを答える。
// 矢印は基準角 0(右回り = +1)と π(左回り = −1)の2箇所にあり、等距離なら +1。
function ringArrowDelta(angle: number): 1 | -1 {
  const nearRight = Math.abs(wrapAnglePi(angle)) <= Math.abs(wrapAnglePi(angle - Math.PI));
  return nearRight ? 1 : -1;
}

// ドラッグをいま離したときに適用される段数。累積角は 90° 単位へ丸め、
// ほとんど動いていなければ掴んだ位置に最も近い矢印の向きへ 1 段。
export function appliedRotationSteps(startAngle: number, angle: number): number {
  const steps = rotationSteps(angle);
  return steps !== 0 ? steps : ringArrowDelta(startAngle);
}
