// 天体を重力源として読む計算。ある点に生じる加速度、最も強く引く天体、抗力を及ぼす大気天体、
// その場の軌道時間スケール。天体位置は基準時刻 pivot で取得した値から目標時刻へ外挿して用いるため、
// 引数 pivot には天体一覧を解決した基準時刻を指定する。
// THREE/DOM 非依存の純関数群。
import type { KinematicState } from './kinematic-state';
import { keplerPeriod, orbitalElementsOf } from './elements';
import type { FrameAnchorSource } from './frame';
import { type Vec3, distSq, len, lenSq, sub, v3 } from '../math/vec3';
import type { CelestialBody } from './celestial-body';

// 天体 attractor が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が attractor から受ける引力」(第2項)を差し引く。attractor が原点天体自身のときは
// 第2項が距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(
  r: Vec3, attractor: CelestialBody, pivot: number, t: number = pivot,
): Vec3 {
  const b = attractor.positionAt(pivot, t);
  const mu = attractor.def.mu;
  let ax = 0, ay = 0, az = 0;

  // 直接引力 μ(r_b − r)/|r_b − r|³。
  const dx = b.x - r.x;
  const dy = b.y - r.y;
  const dz = b.z - r.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= 1) {
    const k = mu / (d2 * Math.sqrt(d2));
    ax += dx * k; ay += dy * k; az += dz * k;
  }

  // ECI 原点(地球)自身が attractor から受ける引力 μ·r_b/|r_b|³ を差し引く。
  const o2 = b.x * b.x + b.y * b.y + b.z * b.z;
  if (o2 >= 1) {
    const k = mu / (o2 * Math.sqrt(o2));
    ax -= b.x * k; ay -= b.y * k; az -= b.z * k;
  }

  return v3(ax, ay, az);
}

// 位置 r で最も強く重力を及ぼしている天体(|attractorAccel| が最大)。素の引力 μ/d² では
// なく、ECI の運動方程式に実際に現れる寄与(attractorAccel)で比べる — 素の引力で比べると
// ECI が太陽と共に自由落下していることを無視した比較になり、地心 2.6e5 km 以遠で太陽が
// 地球に勝ってしまう。運動方程式上で有効な摂動加速度が最大の天体を判定して返す。
export function strongestAttractor(
  r: Vec3, attractors: readonly CelestialBody[], pivot: number,
): CelestialBody {
  let best: CelestialBody | null = null;
  let bestMagSq = -Infinity;
  for (const attractor of attractors) {
    const magSq = lenSq(attractorAccel(r, attractor, pivot));
    if (best === null || magSq > bestMagSq) { best = attractor; bestMagSq = magSq; }
  }
  return best!;
}

// 位置 r へ大気の抗力を及ぼす天体。大気を持つ天体のうち最も近いものを選ぶ — 密度は高度に対して
// 指数的に減るので、最も近い天体が桁違いに支配する。複数の大気の寄与を足し合わせることは
// 物理的にありえないので、抗力を掛ける相手はここで1体に決まる。候補が無ければ null。
export function nearestAtmosphereBody(
  r: Vec3, bodies: readonly CelestialBody[], pivot: number,
): CelestialBody | null {
  let best: CelestialBody | null = null;
  let bestDistSq = Infinity;
  for (const body of bodies) {
    if (body.atmosphereAt(pivot) === null) continue;
    const distSq = lenSq(sub(r, body.positionAt(pivot)));
    if (distSq < bestDistSq) { best = body; bestDistSq = distSq; }
  }
  return best;
}

// 位置 r における軌道運動の時間スケール [s]。最も強く引く天体を中心とする円軌道の周期。
// 刻み幅・サンプル間隔を決めるためのもので、「その天体を中心に軌道要素を出す」こととは無関係。
export function localOrbitPeriod(
  r: Vec3, attractors: readonly CelestialBody[], pivot: number,
): number {
  const attractor = strongestAttractor(r, attractors, pivot);
  return keplerPeriod(len(sub(r, attractor.positionAt(pivot))), attractor.def.mu);
}

// state が周回している(離心率 1 未満の)主天体。公転回転系の基底を組めるかどうかの判定は
// この条件に一本化する。
export function orbitingAttractorOf(
  state: KinematicState, bodies: readonly CelestialBody[], pivot: number,
): CelestialBody | null {
  if (bodies.length === 0) return null;
  const attractor = strongestAttractor(state.r, bodies, pivot);
  const elements = orbitalElementsOf(state, attractor, pivot);
  return elements !== null && elements.e < 1 ? attractor : null;
}

// 天体一覧だけを情報源にする FrameAnchorSource。渡した天体に無い id へは null を返す。
export function bodyAnchorSource(
  bodies: readonly CelestialBody[], bodiesPivot: number,
): FrameAnchorSource {
  // 引き先は生成時に確定するので、id の表もここで1度だけ組む。
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const stateOf = (id: string): KinematicState | null =>
    byId.get(id)?.stateAt(bodiesPivot) ?? null;
  return {
    bodies,
    bodiesPivot,
    stateOf,
    attractorOf: (id: string) => {
      const state = stateOf(id);
      return state !== null ? orbitingAttractorOf(state, bodies, bodiesPivot)?.id ?? null : null;
    },
  };
}

// ── 重力源の分類と近傍問い合わせ ──


// 一覧から落とす天体1体の寄与の上限 [m/s^2]。
export const GRAVITY_NEGLIGIBLE_ACCEL = 1e-8;

// 引力 mu の天体の寄与が GRAVITY_NEGLIGIBLE_ACCEL を割ると言い切れる距離(到達量)[m]。直達項 mu/d²
// と ECI 原点補正項 mu/D² の和は 2mu/min(d,D)² を超えないので、min(d,D) がこれを上回れば寄与は
// 無視できる。
export function gravityReachOf(mu: number): number {
  return Math.sqrt(2 * mu / GRAVITY_NEGLIGIBLE_ACCEL);
}

// 到達量の内側で加算する天体。r は分類した時刻の ECI 位置 [m]、limitSq は到達量に区間の
// 移動ぶんを足した判定距離の2乗 [m²]。
interface RangedAttractor {
  readonly motion: CelestialBody;
  readonly r: Vec3;
  readonly limitSq: number;
}

// 天体が区間 [tStart, tEnd] のあいだに pivot の位置から離れうる距離の上限 [m]。
// **pivot は区間の中点であること。** 天体の位置モデルは pivot まわりの2次式 Δ(s) = v·s + ½a·s²
// なので、半幅を h として |Δ(+h)| + |Δ(−h)| ≥ max(2|v|h, |a|h²) ≥ |v|h + ½|a|h² ≥ max|Δ| が
// 成り立ち、両端の変位の和がそのまま上界になる(加速度を外へ出さずに済む)。
function intervalDrift(
  motion: CelestialBody, pivot: number, tStart: number, tEnd: number,
): number {
  const r = motion.positionAt(pivot);
  return len(sub(motion.positionAt(pivot, tStart), r)) + len(sub(motion.positionAt(pivot, tEnd), r));
}

// 重力源一覧を、常に含める天体(always)と到達量の内側で含める天体(ranged)へ分けたもの。
export interface ClassifiedAttractors {
  readonly always: readonly CelestialBody[];
  readonly ranged: readonly RangedAttractor[];
}

// 重力源一覧を、区間 [tStart, tEnd] の中点 pivot の位置で分類する。ECI 原点を到達量の内側に
// 持つ天体は、原点補正項 mu/D² が問い合わせ位置に依らず残るので always へ入る(原点天体は
// D = 0 なので必ず入る)。残りは、問い合わせ位置が到達量の内側に来たときに効く ranged へ入る。
//
// **判定距離には区間の移動ぶんを足す。** そうすることで、この1組を区間のどの時刻の問い合わせ
// でも使い回せる — 区間の途中で到達量の内側へ入ってくる天体を落とさない。
//
// **1回の分類を多数の問い合わせ位置で使い回すことが成立条件。** 分類が全天体の位置解決を1回
// 払い、以降の問い合わせは解決済みの位置との距離比較で済む。1点ごとに分類し直すと、その1点の
// ために全天体を解決し直すので、一覧をそのまま走査する費用に分類の費用が上乗せになる。
export function classifyAttractors(
  attractors: readonly CelestialBody[], pivot: number, tStart: number, tEnd: number,
): ClassifiedAttractors {
  const always: CelestialBody[] = [];
  const ranged: RangedAttractor[] = [];
  for (const motion of attractors) {
    const r = motion.positionAt(pivot);
    const limit = gravityReachOf(motion.def.mu) + intervalDrift(motion, pivot, tStart, tEnd);
    const limitSq = limit * limit;
    // 原点との距離で振り分け、ranged には問い合わせ側の距離比較に要る位置と判定距離を添える。
    if (lenSq(r) <= limitSq) always.push(motion);
    else ranged.push({ motion, r, limitSq });
  }
  return { always, ranged };
}

// 位置 pos から見た重力源一覧（常に含める天体 + pos が影響範囲内にある天体）を out へ
// 書き込む。out は作業用配列で、内容をクリアしてから書き込む。
export function attractorsNearInto(
  pos: Vec3, classified: ClassifiedAttractors, out: CelestialBody[],
): CelestialBody[] {
  out.length = 0;
  for (const a of classified.always) out.push(a);
  for (const a of classified.ranged) {
    if (distSq(pos, a.r) <= a.limitSq) out.push(a.motion);
  }
  return out;
}
