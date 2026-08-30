// 状態ベクトル(KinematicState)そのものの定義と、それだけで完結する幾何演算(軌道基底・
// エルミート補間)。THREE/DOM 非依存の純粋関数群。
import { Vec3, add, cross, norm, sub, v3 } from '../math/vec3';

// 位置・速度を**どの供給源から、どの原点で**測っているか。軸はどれもゲーム ECI 軸
// (icrf だけ ICRF 軸)。**供給源の違いも原点の違いも値からは見分けられない**ので、型で
// 持たせて取り違えを型検査に拾わせる。
//
// 守っている不変条件は「**絶対 − 絶対は供給源を揃える**」— 暦パックと解析暦は同じ天体に
// 別の位置を答えるので、片方だけを差し替えると差がそのまま相対位置の誤りになる。
// 一方「**絶対 + 相対は混ぜてよい**」ので、`primaryRel` は供給源を持たない
// (解析の相対軌道をパックの惑星本体へ足す合成が、そのために要る)。
//
// - `eci` — ECI 原点天体(ステージが選ぶ中心天体)中心。無標の既定。
// - `analytic` — 解析暦が答える位置。原点は恒星(星系の階層の根)中心。
// - `packed` — 暦パックが答える位置。原点は太陽系重心。
// - `primaryRel` — 主天体中心の相対量(惑星なら恒星、衛星なら惑星、軌道要素なら el.center)。
// - `icrf` — 太陽系重心中心・ICRF 軸。暦パックの生の座標。
export type FrameTag = 'eci' | 'analytic' | 'primaryRel' | 'packed' | 'icrf';

// ある時刻における位置・速度(エポック付き状態ベクトル)。不変で、進めるときは新しい
// KinematicState を作って差し替える(参照を共有したまま書き換えると、保持側が変化を検知
// できなくなるため)。t を state 自身が持つので「状態」と「その時刻」が引数として
// 分かれて食い違うことがない — 予測点列もエンティティの履歴
// (dynamic/dynamic-entity/dynamic-entity.ts)も同じこの型で表す。
// 型引数は原点(FrameTag)。既定が 'eci' なので、ECI を扱う側は型引数を書かなくてよい。
export type KinematicState<F extends FrameTag = 'eci'> = {
  readonly t: number; // 絶対 simTime [s](時刻軸の契約は CODING-RULE 1.9)
  readonly r: Vec3; // 位置 [m]
  readonly v: Vec3; // 速度 [m/s]
} & { readonly __frame: F; }

// KinematicState を組み立てる唯一の入口。ECI 以外を組むときは型引数を明示する
// (`kinematicState<'analytic'>(...)`)— 書き忘れると暗黙に ECI を名乗ることになる。
export function kinematicState<F extends FrameTag = 'eci'>(t: number, r: Vec3, v: Vec3): KinematicState<F> {
  return { t, r, v } as KinematicState<F>;
}

// 主天体を原点に置き直した状態。**両者は同じ原点で測られていなければならない**(同じ F)。
export function toPrimaryRelative<F extends FrameTag>(
  t: number, body: KinematicState<F>, primary: KinematicState<F>,
): KinematicState<'primaryRel'> {
  return kinematicState<'primaryRel'>(t, sub(body.r, primary.r), sub(body.v, primary.v));
}

// ECI 原点天体を原点に置き直した状態。**両者は同じ原点で、かつ同じ供給源から引かれて
// いなければならない** — 暦パックと解析暦は同じ天体に別の位置を答えるので、片方だけを
// 差し替えると差がそのまま相対位置の誤りになる。
export function toEci<F extends FrameTag>(
  t: number, body: KinematicState<F>, origin: KinematicState<F>,
): KinematicState {
  return kinematicState(t, sub(body.r, origin.r), sub(body.v, origin.v));
}

// 主天体相対を、その主天体の状態へ足し戻したもの。**主天体をどの原点で測っていても
// 足し戻せる**(相対量は原点に依らない)ので、返る原点は主天体側のものを引き継ぐ。
export function addPrimaryRelative<F extends FrameTag>(
  primary: KinematicState<F>, rel: KinematicState<'primaryRel'>,
): KinematicState<F> {
  return kinematicState<F>(primary.t, add(primary.r, rel.r), add(primary.v, rel.v));
}

// 軌道基底: 進行方向・軌道面法線・面内で進行方向に直交する向きからなる正規直交系。
// radOut が動径外向き r̂ と一致するのは r⊥v のとき(円軌道)だけで、離心軌道では
// 動径から傾く — マーカーの RADIAL OUT/IN や Δv の OUT/IN はこの軸を指す。
export type OrbitAxes = {
  readonly pro: Vec3; // 進行方向
  readonly nrm: Vec3; // 軌道面法線
  readonly radOut: Vec3; // 面内・進行方向に直交(外向き)
};

// 状態ベクトルから軌道基底を組む。速度または角運動量が縮退していると各軸は NaN になる。
export function orbitAxes<F extends FrameTag>(s: KinematicState<F>): OrbitAxes {
  const pro = norm(s.v);
  const nrm = norm(cross(s.r, s.v));
  return { pro, nrm, radOut: cross(pro, nrm) };
}

// 軌道基底で表したベクトル(x=pro, y=nrm, z=radOut 成分)をワールド ECI へ変換する。
export function fromOrbitAxes<F extends FrameTag>(s: KinematicState<F>, x: Vec3): Vec3 {
  const { pro, nrm, radOut } = orbitAxes(s);
  return v3(
    pro.x * x.x + nrm.x * x.y + radOut.x * x.z,
    pro.y * x.x + nrm.y * x.y + radOut.y * x.z,
    pro.z * x.x + nrm.z * x.y + radOut.z * x.z,
  );
}

// 2状態間の3次エルミート補間。両端の位置を通り、両端の速度を接線とする3次多項式で
// 時刻 t の位置を、その微分で速度を求める(粗いサンプル列でも軌道を滑らかに再現できる)。
// a.t > b.t(逆順)でも同じ多項式が定まるので、順序は問わない。
// 区間外の t は拒否する。多項式は区間外で急速に発散し、軌道として破綻した状態
// (地球内部の位置、脱出速度を超える速度など)を平然と返すため。
export function hermiteInterpolate<F extends FrameTag>(
  a: KinematicState<F>,
  b: KinematicState<F>,
  t: number,
): KinematicState<F> {
  const h = b.t - a.t;
  if (h === 0) throw new Error(`hermiteInterpolate: 両端が同時刻 (t=${a.t}) で補間できない`);
  if ((t - a.t) * (t - b.t) > 0) {
    throw new Error(`hermiteInterpolate: t=${t} が区間 [${a.t}, ${b.t}] の外`);
  }

  const s = (t - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  // 位置の基底(a.r, a.v, b.r, b.v の順)と、その s 微分
  const w = [2 * s3 - 3 * s2 + 1, s3 - 2 * s2 + s, -2 * s3 + 3 * s2, s3 - s2];
  const dw = [6 * s2 - 6 * s, 3 * s2 - 4 * s + 1, -6 * s2 + 6 * s, 3 * s2 - 2 * s];

  const combine = (wr0: number, wv0: number, wr1: number, wv1: number): Vec3 => v3(
    wr0 * a.r.x + wv0 * a.v.x + wr1 * b.r.x + wv1 * b.v.x,
    wr0 * a.r.y + wv0 * a.v.y + wr1 * b.r.y + wv1 * b.v.y,
    wr0 * a.r.z + wv0 * a.v.z + wr1 * b.r.z + wv1 * b.v.z,
  );

  return kinematicState<F>(
    t,
    combine(w[0]!, w[1]! * h, w[2]!, w[3]! * h),
    combine(dw[0]! / h, dw[1]!, dw[2]! / h, dw[3]!),
  );
}
