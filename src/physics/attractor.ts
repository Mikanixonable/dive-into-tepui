// 重力を及ぼすもの。位置・速度は ECI(地球は原点に静止)。THREE/DOM 非依存の純関数群。
import { Atmosphere } from './atmosphere';
import { Quat } from './attitude';
import { FrameTransform, toFrameState } from './frame';
import { KinematicState, hermiteInterpolate, kinematicState } from './kinematic-state';
import { OrbitalElements, orbitalElementsFromState, keplerPeriod } from './elements';
import { SweptVelocities, containingBody, sweptSphereContact } from './sphere-contact';
import { Vec3, lenSq, len, sub, v3 } from './vec3';

// 天体の識別子。具体的なレジストリ(solar-system.ts の SOLAR_SYSTEM など)が実行時に
// 差し替え可能なので、ここでは閉じた union にできない — 網羅性の強制は各レジストリの
// keyof(SolarSystemId 等)が個別に持つ。
export type AttractorId = string;
// 公転している天体を指すべき引数の注釈(型としては AttractorId と同じで強制力は無い)。
// 回転基準系・軌道法線・ラグランジュ点は、公転を持たない恒星には存在しない。
export type OrbitingId = AttractorId;

// 2次重力場の非軸対称成分(赤道断面の楕円性)。主軸座標系で表すため S22 は恒等的に 0 になり、
// 長軸の向きだけで姿勢が決まる。
export type TesseralGravity = {
  readonly c22: number;
  readonly longAxis: Vec3; // 主軸座標系の長軸(単位ベクトル、ECI)
};

// 天体の2次(degree 2)の重力場。係数は非正規化。refRadius は係数が定義された基準半径で、
// 地形としての表面半径(Attractor.radius)とは別の量。
export type Degree2Gravity = {
  readonly j2: number; // 極方向の扁平(= −C20)
  readonly refRadius: number; // [m]
  readonly pole: Vec3; // 自転軸(単位ベクトル、ECI)
  readonly tesseral: TesseralGravity | null; // null なら軸対称
};

export type Attractor = {
  readonly id: AttractorId;
  readonly mu: number; // GM [m^3/s^2]
  readonly radius: number; // 表面半径 [m]。形状(solar-system.ts の ShapeDef)を持つ天体では
  // その外接球の半径 — 衝突・高度判定を楕円体化しない当面の間、極方向で安全側に倒す選択
  readonly state: KinematicState; // ECI 位置・速度(同一時刻。地球は原点に静止)
  readonly accel: Vec3; // この天体自身が受けている ECI 加速度 [m/s²]。state(t, r, v)と合わせて
  // 天体の短時間の局所軌道を表し、RK4 の各段の時刻へ位置を外挿する(attractorPositionAt)ために持つ
  readonly degree2: Degree2Gravity | null; // null なら質点として扱う
  readonly atmosphere: Atmosphere | null; // null なら大気を持たない(抗力・焼失ともに起きない)
  readonly isStar: boolean; // 太陽輻射圧の輻射源として加算するか
};

// attractor 自身の state.t と accel から、時刻 t での位置を弾道外挿する。天体は実質的に
// 弾道運動しており、1ステップぶんの時間幅では3次以上の項が無視できるので2次で足りる。
// この外挿の唯一の定義箇所 — 他所で同じ式を書かないこと。
export function attractorPositionAt(a: Attractor, t: number): Vec3 {
  const s = t - a.state.t;
  if (s === 0) return a.state.r;
  return v3(
    a.state.r.x + a.state.v.x * s + 0.5 * a.accel.x * s * s,
    a.state.r.y + a.state.v.y * s + 0.5 * a.accel.y * s * s,
    a.state.r.z + a.state.v.z * s + 0.5 * a.accel.z * s * s,
  );
}

// 天体 attractor が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が attractor から受ける引力」(第2項)を差し引く。attractor が原点天体自身のときは
// 第2項が距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 天体位置は attractor が自分の state.t から t へ外挿したもの(attractorPositionAt)を使う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(r: Vec3, attractor: Attractor, t: number): Vec3 {
  const b = attractorPositionAt(attractor, t);
  let ax = 0, ay = 0, az = 0;

  // 直接引力 μ(r_b − r)/|r_b − r|³。
  const dx = b.x - r.x;
  const dy = b.y - r.y;
  const dz = b.z - r.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= 1) {
    const k = attractor.mu / (d2 * Math.sqrt(d2));
    ax += dx * k; ay += dy * k; az += dz * k;
  }

  // ECI 原点(地球)自身が attractor から受ける引力 μ·r_b/|r_b|³ を差し引く。
  const o2 = b.x * b.x + b.y * b.y + b.z * b.z;
  if (o2 >= 1) {
    const k = attractor.mu / (o2 * Math.sqrt(o2));
    ax -= b.x * k; ay -= b.y * k; az -= b.z * k;
  }

  return v3(ax, ay, az);
}

// 位置 r で最も強く重力を及ぼしている天体(|attractorAccel| が最大)。素の引力 μ/d² では
// なく、ECI の運動方程式に実際に現れる寄与(attractorAccel)で比べる — 素の引力で比べると
// ECI が太陽と共に自由落下していることを無視した比較になり、地心 2.6e5 km 以遠で太陽が
// 地球に勝ってしまう。「何のためにどの天体を選ぶか」は呼び出し側の判断で、この関数は
// 材料を一つ返すだけ。
export function strongestAttractor(r: Vec3, attractors: readonly Attractor[]): Attractor {
  let best: Attractor | null = null;
  let bestMagSq = -Infinity;
  for (let i = 0; i < attractors.length; i++) {
    const attractor = attractors[i]!;
    // どの天体が最強かは窓自身の時刻で比べれば足りるので、各天体を自分の state.t で評価する。
    const magSq = lenSq(attractorAccel(r, attractor, attractor.state.t));
    if (best === null || magSq > bestMagSq) { best = attractor; bestMagSq = magSq; }
  }
  return best!;
}

// 位置 r へ大気の抗力を及ぼす天体。大気を持つ天体のうち最も近いものを選ぶ — 密度は高度に対して
// 指数的に減るので、最も近い天体が桁違いに支配する。複数の大気の寄与を足し合わせることは
// 物理的にありえないので、抗力を掛ける相手はここで1体に決まる。候補が無ければ null。
export function nearestAtmosphereBody(r: Vec3, bodies: readonly Attractor[]): Attractor | null {
  let best: Attractor | null = null;
  let bestDistSq = Infinity;
  for (const body of bodies) {
    if (body.atmosphere === null) continue;
    const distSq = lenSq(sub(r, body.state.r));
    if (distSq < bestDistSq) { best = body; bestDistSq = distSq; }
  }
  return best;
}

// 位置 r における軌道運動の時間スケール [s]。最も強く引く天体を中心とする円軌道の周期。
// 刻み幅・サンプル間隔を決めるためのもので、「その天体を中心に軌道要素を出す」こととは無関係。
export function localOrbitPeriod(r: Vec3, attractors: readonly Attractor[]): number {
  const attractor = strongestAttractor(r, attractors);
  return keplerPeriod(len(sub(r, attractor.state.r)), attractor.mu);
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// center を原点とする ECI 恒等姿勢の座標系変換。frame.ts の ReferenceFrame
// ({center: center.id, rotatingWith: null}) と等価だが、天体暦を引き直さず既に手元にある
// Attractor のスナップショットからその場で組む。
export function frameOfAttractor(center: Attractor): FrameTransform {
  return { origin: center.state.r, originVel: center.state.v, q: IDENTITY_QUAT, omega: v3() };
}

// 天体表面へ到達した瞬間の状態と、その相手の天体。
export interface BodyImpact {
  readonly body: Attractor;
  readonly state: KinematicState;
}

// 掃引の近似。'hermite' は端点の速度を接線に取る三次曲線、'linear' は端点を結ぶ線分。
export type ReachSolver = 'hermite' | 'linear';

// prev→next の1ステップの間に、半径 + margin の表面へ到達した天体と、到達した瞬間の状態。
// 到達が無ければ null。複数に到達していれば最も早いものを、掃引が求めた到達割合(toi)から
// hermiteInterpolate で組んだ状態とともに返す。掃引が空振りした(開始時点で既に沈んでいる、
// または区間が無い)場合は離散判定へ委譲し、prev/next いずれかそのものを到達状態として返す。
export function reachedBody(
  prev: KinematicState,
  next: KinematicState,
  bodies: readonly Attractor[],
  margin: number,
  solver: ReachSolver = 'hermite',
): BodyImpact | null {
  // 1ステップの間に天体自身が動く距離は、その半径に対しても軌道速度で進む距離に対しても
  // 十分小さいので、どの天体も区間を通して静止しているものとして掃引する。
  const sweep: SweptVelocities | null = solver === 'linear' ? null : {
    aStart: prev.v, aEnd: next.v, bStart: v3(), bEnd: v3(), dt: next.t - prev.t,
  };
  let earliest: Attractor | null = null;
  let earliestToi = Infinity;
  for (const body of bodies) {
    const contact = sweptSphereContact(
      prev.r, next.r, body.state.r, body.state.r, body.radius + margin, sweep);
    if (contact !== null && contact.toi < earliestToi) {
      earliest = body;
      earliestToi = contact.toi;
    }
  }
  if (earliest !== null) {
    return { body: earliest, state: hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * earliestToi) };
  }
  const containingPrev = containingBody(prev.r, bodies, margin);
  if (containingPrev !== null) return { body: containingPrev, state: prev };
  const containingNext = containingBody(next.r, bodies, margin);
  if (containingNext !== null) return { body: containingNext, state: next };
  return null;
}

// 天体 center を中心とする接触軌道要素。中心の選び方には関与しない — 呼び出し側が
// strongestAttractor などで選んだ center をそのまま渡す。
export function orbitalElementsOf(s: KinematicState, center: Attractor): OrbitalElements | null {
  const rel = toFrameState(frameOfAttractor(center), s);
  return orbitalElementsFromState(kinematicState(s.t, rel.r, rel.v), center);
}
