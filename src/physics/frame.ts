// 表示に使う時間依存の座標系(慣性系・回転系)を「原点天体 × 回転」の直積として表し、
// 点・方向・KinematicState の順・逆変換を供給する。座標系相対の値は branded type(FramePoint /
// FrameDir / FrameKinematicState)になり、変換忘れ・二重変換・慣性系との取り違えが型エラーに
// なる(vec3.ts の Vec3 と同手法)。原点が動く座標系では「点」(位置。回転+平行移動で変換)と
// 「方向」(変位・速度差・上方向など。回転のみで変換)を取り違えると静かに壊れるため、
// この2つを別の型にしている。
//
// 座標系の中身(その時刻の原点・姿勢・角速度 = FrameTransform)は game/celestial の
// ReferenceFrames が組む。ここは渡された FrameTransform だけで値を変換する純関数群。
//
// シミュレーション全体は地球中心の慣性系(ECI)で回っている。座標系はあくまで「軌道線など
// 個々の描画物」の表示用で、シーン全体を差し替えるものではない。
import type { CelestialMotion } from './celestial-motion';
import { KinematicState, kinematicState } from './kinematic-state';
import { add, cross, sub, v3, Vec3 } from '../math/vec3';
import { Q_IDENTITY, Quat, qInvert, qRotate } from '../math/quat';

// 座標系 = 「どの天体を原点に置くか」×「何の回転(公転か自転)に合わせて回すか
// (null = 回さない)」。値は必ず ReferenceFrames の frames/frameFor/frameOf の要素を参照する —
// リテラルで組むと参照同一性が崩れ、trajectory-line.ts の `frame === lastFrame` による
// キャッシュ判定が毎フレーム外れて描画が無駄に重くなる。
export type ReferenceFrame = {
  readonly center: string; // 登録天体・生存中の重力天体・機体の id か、役割トークン
  readonly rotatingWith: FrameRotationSource | null;
};

// 参照フレームの基準・回転対象を、特定の対象を名指しせず役割で指すためのもの。予約 id では
// '@' を頭に付ける — 天体・機体の id は小文字 ASCII と '-'/':' だけで組まれる。
export type FrameRole = 'activeShip' | 'navTarget';

// 何の回転に合わせて座標系を回すか。
export type FrameRotationSource =
  | { readonly kind: 'revolution'; readonly id: string }  // 主天体まわりの公転
  | { readonly kind: 'spin'; readonly id: string };       // 自転(天体のみ)

// 役割トークンの全種。役割を列挙するときの唯一の出所。
export const FRAME_ROLES: readonly FrameRole[] = ['activeShip', 'navTarget'];

// 役割を、参照フレームの基準 id として書いた形。
export function frameRoleAnchorId(role: FrameRole): string {
  return `@${role}`;
}

// id が指す役割。天体・機体の id と、'@' で始まっていても FRAME_ROLES に無いものは null
// — 検証を挟まないと、解決できない役割が外から来た文字列のまま座標系へ入り込む。
export function frameRoleOf(id: string): FrameRole | null {
  const role = id.startsWith('@') ? id.slice(1) : null;
  return role !== null && FRAME_ROLES.includes(role as FrameRole) ? role as FrameRole : null;
}

// 天体レジストリに載らない基準の位置・主天体を引く解決役。座標系の変換は
// これ越しにしか未登録の基準へ触れない。
export interface FrameAnchorSource {
  // このフレームの重力天体一覧。
  readonly bodies: readonly CelestialMotion[];
  // bodies の位置を厳密に引く時刻。
  readonly bodiesPivot: number;
  // 登録天体でない基準(生存中の重力天体・機体・役割トークン)の ECI 状態。解決できなければ null。
  stateOf(id: string, t: number): KinematicState | null;
  // その基準が公転している主天体。公転回転系を組めないなら null。
  attractorOf(id: string, t: number): string | null;
}

// frameOf のキャッシュキー。同じ選択には必ず同じ文字列を返す(参照同一性の維持に使う)。
export function rotationSourceKey(rotatingWith: FrameRotationSource | null): string {
  if (rotatingWith === null) return '';
  return rotatingWith.kind === 'spin' ? `spin:${rotatingWith.id}` : rotatingWith.id;
}

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
type FrameKinematicState = { r: Vec3; v: Vec3; } & { readonly __tag: 'frameKinematicState'; };

// FrameKinematicState を組み立てる、toFrameState 以外で唯一信頼できる入口。軌道要素から解析的に
// 求めた近地点位置のように「すでに座標系相対と分かっている r/v」を toInertialState へ渡すために
// 使う — kinematicState<'eci'>() が KinematicState に対して果たす役割と同じ。
function frameKinematicState(r: Vec3, v: Vec3): FrameKinematicState {
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
  return kinematicState<'eci'>(t, r, v);
}

// 時刻 t における位置 r (慣性系) を、表示時刻 displayTime の frame 基準系に un-bake して求める
export function unbakeToDisplayPoint(
  unbakeTf: FrameTransform,
  pointTf: FrameTransform,
  r: Vec3,
): Vec3 {
  return toInertialPoint(unbakeTf, toFramePoint(pointTf, r));
}

// center を原点とする ECI 恒等姿勢の座標系変換。ReferenceFrame
// ({center: center.id, rotatingWith: null}) と等価な変換を、天体1体から直に組む。
export function frameOfCelestialBody(center: CelestialMotion, pivot: number): FrameTransform {
  const state = center.stateAt(pivot);
  return { origin: state.r, originVel: state.v, q: Q_IDENTITY, omega: v3() };
}
