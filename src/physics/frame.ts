// 表示に使う時間依存の座標系(慣性系・回転系)を「原点天体 × 回転」の直積として表し、
// 点・方向・KinematicState の順・逆変換を供給する。座標系相対の値は branded type(FramePoint /
// FrameDir / FrameKinematicState)になり、変換忘れ・二重変換・慣性系との取り違えが型エラーに
// なる(vec3.ts の Vec3 と同手法)。原点が動く座標系では「点」(位置。回転+平行移動で変換)と
// 「方向」(変位・速度差・上方向など。回転のみで変換)を取り違えると静かに壊れるため、
// この2つを別の型にしている。
//
// 座標系の中身(その時刻の原点・姿勢・角速度 = FrameTransform)は天体暦
// (Ephemeris.frameTransformAt)が組む。ここは変換値を受け取って変換するだけの純関数群で、
// Ephemeris を import しない — これにより frame.ts と ephemeris.ts の間に循環依存が生まれない。
//
// シミュレーション全体は地球中心の慣性系(ECI)で回っている。座標系はあくまで「軌道線など
// 個々の描画物」の表示用で、シーン全体を差し替えるものではない。
import { AttractorId, OrbitingId } from './attractor';
import { KinematicState, kinematicState } from './kinematic-state';
import { add, cross, sub, v3, Vec3 } from './vec3';
import { Quat, qInvert, qRotate } from './attitude';

// 座標系 = 「どの天体を原点に置くか」×「どの天体の公転に合わせて回すか(null = 回さない)」。
// 値は必ず Ephemeris.frames/frameFor の要素を参照する — リテラルで組むと参照同一性が崩れ、
// trajectory-line.ts の `frame === lastFrame` によるキャッシュ判定が毎フレーム外れて描画が
// 無駄に重くなる。
export type ReferenceFrame = {
  readonly center: AttractorId;
  readonly rotatingWith: OrbitingId | null;
};

// Frame の時刻 t における剛体運動。origin/originVel は ECI での原点の位置・速度、
// q は「座標系相対 → ECI」の姿勢、omega は ECI 成分の角速度。回転軸が時刻とともに向きを
// 変える系(月回転系など)もあるため、軸と回転角の対ではなくこの対で扱う。
export type FrameTransform = {
  readonly origin: Vec3;
  readonly originVel: Vec3;
  readonly q: Quat;
  readonly omega: Vec3;
};

// 座標系相対の「点」(位置。原点移動 + 回転のアフィン変換)。
export type FramePoint = { x: number; y: number; z: number } & { readonly __tag: 'framePoint'; };
// 座標系相対の「方向・変位」(速度差・オフセット・上方向など。回転のみの線形変換)。
export type FrameDir = { x: number; y: number; z: number } & { readonly __tag: 'frameDir'; };
// 座標系相対の KinematicState。デフォルトの KinematicState とは __tag の有無で非互換にし、
// 慣性系との取り違えを型で防ぐ(vec3.ts の Vec3 と同手法)。
export type FrameKinematicState = { r: Vec3; v: Vec3; } & { readonly __tag: 'frameKinematicState'; };

// FrameKinematicState を組み立てる、toFrameState 以外で唯一信頼できる入口。軌道要素から解析的に
// 求めた近地点位置のように「すでに座標系相対と分かっている r/v」を toInertialState へ渡すために
// 使う — kinematicState() が KinematicState に対して果たす役割と同じ。
export function frameKinematicState(r: Vec3, v: Vec3): FrameKinematicState {
  return { r, v } as FrameKinematicState;
}

// FrameDir を組み立てる、toFrameDir 以外で唯一信頼できる入口。すでに座標系相対と分かっている
// 方向・変位(セーブデータからの復元など)を toInertialDir へ渡すために使う。
export function frameDir(x: number, y: number, z: number): FrameDir {
  return { x, y, z } as FrameDir;
}

// FramePoint を組み立てる、toFramePoint 以外で唯一信頼できる入口。すでに座標系相対と分かっている
// 位置(セーブデータからの復元など)を toInertialPoint へ渡すために使う。
export function framePoint(x: number, y: number, z: number): FramePoint {
  return { x, y, z } as FramePoint;
}

// 慣性系 → 座標系相対の点(順変換, bake)。
export function toFramePoint(tf: FrameTransform, p: Vec3): FramePoint {
  const r = qRotate(qInvert(tf.q), sub(p, tf.origin));
  return { x: r.x, y: r.y, z: r.z } as FramePoint;
}

// 座標系相対の点 → 慣性系(逆変換, un-bake)。
export function toInertialPoint(tf: FrameTransform, p: FramePoint): Vec3 {
  return add(qRotate(tf.q, v3(p.x, p.y, p.z)), tf.origin);
}

// 慣性系 → 座標系相対の方向(順変換)。原点移動は効かない。
export function toFrameDir(tf: FrameTransform, d: Vec3): FrameDir {
  const r = qRotate(qInvert(tf.q), d);
  return { x: r.x, y: r.y, z: r.z } as FrameDir;
}

// 座標系相対の方向 → 慣性系(逆変換)。原点移動は効かない。
export function toInertialDir(tf: FrameTransform, d: FrameDir): Vec3 {
  return qRotate(tf.q, v3(d.x, d.y, d.z));
}

// 慣性系 → 座標系相対(順変換, bake)。速度は v_rel = R⁻¹(v − ȯ − ω×(r − o))。
export function toFrameState(tf: FrameTransform, s: KinematicState): FrameKinematicState {
  const qi = qInvert(tf.q);
  const rel = sub(s.r, tf.origin);
  return frameKinematicState(qRotate(qi, rel), qRotate(qi, sub(sub(s.v, tf.originVel), cross(tf.omega, rel))));
}

// 座標系相対 → 慣性系(逆変換, un-bake)。時刻 t は復元する KinematicState 自身のエポックになる
// (un-bake なら現在の表示時刻)— FrameKinematicState は時刻を持たない(bake 時刻と un-bake 時刻は
// 別物なので、どちらを持たせても取り違えを招く)。速度は v = ȯ + R·v_rel + ω×(r − o)
// (toFrameState の逆)。
export function toInertialState(tf: FrameTransform, t: number, s: FrameKinematicState): KinematicState {
  const r = add(qRotate(tf.q, s.r), tf.origin);
  const v = add(add(tf.originVel, qRotate(tf.q, s.v)), cross(tf.omega, sub(r, tf.origin)));
  return kinematicState(t, r, v);
}
