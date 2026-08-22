// 天体のある瞬間のスナップショットと、それを読む重力・軌道の計算。位置・速度は ECI
// (地球は原点に静止)。THREE/DOM 非依存の純関数群。
import { Atmosphere } from './atmosphere';
import { Quat } from './attitude';
import { FrameAnchorId, FrameAnchorSource, FrameTransform, toFrameState } from './frame';
import { KinematicState, kinematicState } from './kinematic-state';
import { OrbitalElements, orbitalElementsFromState, keplerPeriod } from './elements';
import { Vec3, addScaled, lenSq, len, sub, v3 } from './vec3';

// 天体の識別子。具体的なレジストリ(solar-system.ts の SOLAR_SYSTEM など)が実行時に
// 差し替え可能なので、ここでは閉じた union にできない — 網羅性の強制は各レジストリの
// keyof(SolarSystemId 等)が個別に持つ。
export type CelestialBodyId = string;
// 公転している天体を指すべき引数の注釈(型としては CelestialBodyId と同じで強制力は無い)。
// 回転基準系・軌道法線・ラグランジュ点は、公転を持たない恒星には存在しない。
export type OrbitingId = CelestialBodyId;

// 2次重力場の非軸対称成分(赤道断面の楕円性)。主軸座標系で表すため S22 は恒等的に 0 になり、
// 長軸の向きだけで姿勢が決まる。
export type TesseralGravity = {
  readonly c22: number;
  readonly longAxis: Vec3; // 主軸座標系の長軸(単位ベクトル、ECI)
};

// 天体の2次(degree 2)の重力場。係数は非正規化。refRadius は係数が定義された基準半径で、
// 地形としての表面半径(CelestialBody.radius)とは別の量。
export type Degree2Gravity = {
  readonly j2: number; // 極方向の扁平(= −C20)
  readonly refRadius: number; // [m]
  readonly pole: Vec3; // 自転軸(単位ベクトル、ECI)
  readonly tesseral: TesseralGravity | null; // null なら軸対称
};

export type CelestialBody = {
  readonly id: CelestialBodyId;
  readonly mu: number; // GM [m^3/s^2]
  readonly radius: number; // 表面半径 [m]。形状(solar-system.ts の ShapeDef)を持つ天体では
  // その外接球の半径 — 衝突・高度判定を楕円体化しない当面の間、極方向で安全側に倒す選択
  readonly state: KinematicState; // ECI 位置・速度(同一時刻。地球は原点に静止)
  readonly accel: Vec3; // この天体自身が受けている ECI 加速度 [m/s²]。state(t, r, v)と合わせて
  // 天体の短時間の局所軌道を表し、RK4 の各段の時刻へ位置を外挿する(celestialBodyPositionAt)ために持つ
  readonly degree2: Degree2Gravity | null; // null なら質点として扱う
  readonly atmosphere: Atmosphere | null; // null なら大気を持たない(抗力・焼失ともに起きない)
  readonly isStar: boolean; // 太陽輻射圧の輻射源として加算するか
};

// 天体自身の state.t と accel から、時刻 t での位置を弾道外挿する。天体は実質的に
// 弾道運動しており、1ステップぶんの時間幅では3次以上の項が無視できるので2次で足りる。
// この外挿の唯一の定義箇所 — 他所で同じ式を書かないこと。
export function celestialBodyPositionAt(a: CelestialBody, t: number): Vec3 {
  const s = t - a.state.t;
  if (s === 0) return a.state.r;
  return v3(
    a.state.r.x + a.state.v.x * s + 0.5 * a.accel.x * s * s,
    a.state.r.y + a.state.v.y * s + 0.5 * a.accel.y * s * s,
    a.state.r.z + a.state.v.z * s + 0.5 * a.accel.z * s * s,
  );
}

// 同じ外挿で、時刻 t での位置と速度を揃えて返す。位置だけで足りる場所では
// celestialBodyPositionAt を使う — こちらは Vec3 を2つ余分に作る。
export function celestialBodyStateAt(a: CelestialBody, t: number): KinematicState {
  const s = t - a.state.t;
  if (s === 0) return a.state;
  return kinematicState(t, celestialBodyPositionAt(a, t), addScaled(a.state.v, a.accel, s));
}

// 天体 attractor が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が attractor から受ける引力」(第2項)を差し引く。attractor が原点天体自身のときは
// 第2項が距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 天体位置は attractor が自分の state.t から t へ外挿したもの(celestialBodyPositionAt)を使う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(r: Vec3, attractor: CelestialBody, t: number): Vec3 {
  const b = celestialBodyPositionAt(attractor, t);
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
export function strongestAttractor(r: Vec3, attractors: readonly CelestialBody[]): CelestialBody {
  let best: CelestialBody | null = null;
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
export function nearestAtmosphereBody(r: Vec3, bodies: readonly CelestialBody[]): CelestialBody | null {
  let best: CelestialBody | null = null;
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
export function localOrbitPeriod(r: Vec3, attractors: readonly CelestialBody[]): number {
  const attractor = strongestAttractor(r, attractors);
  return keplerPeriod(len(sub(r, attractor.state.r)), attractor.mu);
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// center を原点とする ECI 恒等姿勢の座標系変換。frame.ts の ReferenceFrame
// ({center: center.id, rotatingWith: null}) と等価だが、天体暦を引き直さず既に手元にある
// CelestialBody のスナップショットからその場で組む。
export function frameOfCelestialBody(center: CelestialBody): FrameTransform {
  return { origin: center.state.r, originVel: center.state.v, q: IDENTITY_QUAT, omega: v3() };
}

// 天体 center を中心とする接触軌道要素。中心の選び方には関与しない — 呼び出し側が
// strongestAttractor などで選んだ center をそのまま渡す。
export function orbitalElementsOf(s: KinematicState, center: CelestialBody): OrbitalElements | null {
  const rel = toFrameState(frameOfCelestialBody(center), s);
  return orbitalElementsFromState(kinematicState(s.t, rel.r, rel.v), center);
}

// state が周回している(離心率 1 未満の)主天体。frame.ts の FrameAnchorSource.attractorOf の
// 実装がここへ集約する — 公転回転系の基底を組めるかどうかの判定はこの条件に一本化する。
export function orbitingAttractorOf(state: KinematicState, bodies: readonly CelestialBody[]): CelestialBody | null {
  if (bodies.length === 0) return null;
  const attractor = strongestAttractor(state.r, bodies);
  const elements = orbitalElementsOf(state, attractor);
  return elements !== null && elements.e < 1 ? attractor : null;
}

// celestialBodies 配列だけを情報源にする FrameAnchorSource。機体・役割トークンの文脈を
// 持たない呼び出し元(HUD マーカーの向き計算など)が frameTransformAt へ渡すための簡易実装で、
// 天体以外の基準・回転対象は解決できない(null)。
export function bodyAnchorSource(bodies: readonly CelestialBody[]): FrameAnchorSource {
  return {
    bodies,
    stateOf: (id: FrameAnchorId) => bodies.find((b) => b.id === id)?.state ?? null,
    attractorOf: (id: FrameAnchorId) => {
      const state = bodies.find((b) => b.id === id)?.state;
      return state ? orbitingAttractorOf(state, bodies)?.id ?? null : null;
    },
  };
}
