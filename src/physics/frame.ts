// 表示に使う時間依存の座標系(慣性系・回転系)を「原点天体 × 回転」の直積として表し、
// 点・方向・OrbitState の順・逆変換を供給する。座標系相対の値は branded type(FramePoint /
// FrameDir / FrameOrbitState)になり、変換忘れ・二重変換・慣性系との取り違えが型エラーに
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
import { bodyDef, SOLAR_SYSTEM } from './solar-system';
import { OrbitState, orbitState } from './orbital-state';
import { add, cross, sub, v3, Vec3 } from './vec3';
import { Quat, qInvert, qRotate } from './attitude';

// 座標系 = 「どの天体を原点に置くか」×「どの天体の公転に合わせて回すか(null = 回さない)」。
// 値は必ず FRAMES の要素を参照する — リテラルで組むと参照同一性が崩れ、sampled-line.ts の
// `frame === lastFrame` によるキャッシュ判定が毎フレーム外れて描画が無駄に重くなる。
export type Frame = {
  readonly center: AttractorId;
  readonly rotatingWith: OrbitingId | null;
};

// 回転系(rotatingWith が非 null)の原点。衛星は惑星まわりの公転を止めて見せたいので
// その惑星(例: 月回転系は地球中心)、惑星は自分自身(例: 太陽-地球回転系は地球中心のまま、
// 地球自身の公転方向へ向きだけ合わせる。原点ごと太陽へ移した完全な太陽中心系が欲しければ
// {center:'sun', rotatingWith:null} を使う)。
function rotatingFrameCenterOf(id: AttractorId): AttractorId {
  const def = bodyDef(id);
  return def.kind === 'satellite' ? def.planet : id;
}

// SOLAR_SYSTEM から生成した正準インスタンス。全天体の慣性系(center=X, rotatingWith=null)と、
// 公転している全天体(恒星以外)ぶんの回転系。天体を1つ増やすと、このリストは手を加えずに
// 増える。
export const FRAMES: readonly Frame[] = (() => {
  const ids = Object.keys(SOLAR_SYSTEM) as AttractorId[];
  const frames: Frame[] = ids.map((id) => ({ center: id, rotatingWith: null }));
  for (const id of ids) {
    if (bodyDef(id).kind === 'star') continue;
    frames.push({ center: rotatingFrameCenterOf(id), rotatingWith: id as OrbitingId });
  }
  return frames;
})();

// 地球中心慣性系。ECI そのものを表す座標系として、UI・描画側の既定値に使う。
export const INERTIAL_FRAME: Frame = FRAMES.find((f) => f.center === 'earth' && f.rotatingWith === null)!;

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
// 座標系相対の OrbitState。デフォルトの OrbitState とは __tag の有無で非互換にし、
// 慣性系との取り違えを型で防ぐ(vec3.ts の Vec3 と同手法)。
export type FrameOrbitState = { r: Vec3; v: Vec3; } & { readonly __tag: 'frameOrbitState'; };

// FrameOrbitState を組み立てる、toFrameState 以外で唯一信頼できる入口。軌道要素から解析的に
// 求めた近地点位置のように「すでに座標系相対と分かっている r/v」を toInertialState へ渡すために
// 使う — orbitState() が OrbitState に対して果たす役割と同じ。
export function frameOrbitState(r: Vec3, v: Vec3): FrameOrbitState {
  return { r, v } as FrameOrbitState;
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
export function toFrameState(tf: FrameTransform, s: OrbitState): FrameOrbitState {
  const qi = qInvert(tf.q);
  const rel = sub(s.r, tf.origin);
  return frameOrbitState(qRotate(qi, rel), qRotate(qi, sub(sub(s.v, tf.originVel), cross(tf.omega, rel))));
}

// 座標系相対 → 慣性系(逆変換, un-bake)。時刻 t は復元する OrbitState 自身のエポックになる
// (un-bake なら現在の表示時刻)— FrameOrbitState は時刻を持たない(bake 時刻と un-bake 時刻は
// 別物なので、どちらを持たせても取り違えを招く)。速度は v = ȯ + R·v_rel + ω×(r − o)
// (toFrameState の逆)。
export function toInertialState(tf: FrameTransform, t: number, s: FrameOrbitState): OrbitState {
  const r = add(qRotate(tf.q, s.r), tf.origin);
  const v = add(add(tf.originVel, qRotate(tf.q, s.v)), cross(tf.omega, sub(r, tf.origin)));
  return orbitState(t, r, v);
}
