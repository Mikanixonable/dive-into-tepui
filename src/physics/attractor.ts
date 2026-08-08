// 重力を及ぼすもの。位置・速度は ECI(地球は原点に静止)。THREE/DOM 非依存の純関数群。
import { Quat } from './attitude';
import { FrameTransform, toFrameState } from './frame';
import { OrbitState, orbitState } from './orbital-state';
import { Elements, elementsFromState, keplerPeriod } from './elements';
import { Vec3, lenSq, len, sub, v3 } from './vec3';

// 天体の分類。恒星は動かず、惑星は太陽まわりのケプラー軌道、衛星は惑星まわりのケプラー軌道
// (+ 太陽摂動)を描く — solar-system.ts の CelestialBodyDef がこの分類で判別される。
export type StarId = 'sun';
export type PlanetId = 'earth' | 'jupiter';
export type SatelliteId = 'moon';
export type AttractorId = StarId | PlanetId | SatelliteId;
// 公転している天体(惑星 + 衛星)。回転基準系・軌道法線・ラグランジュ点は、公転を持たない
// 恒星には存在しない — この型に絞ることで呼び出し側の null 分岐が要らなくなる。
export type OrbitingId = PlanetId | SatelliteId;

export type Attractor = {
  readonly id: AttractorId;
  readonly mu: number; // GM [m^3/s^2]
  readonly radius: number; // 表面半径 [m]
  readonly state: OrbitState; // ECI 位置・速度(同一時刻。地球は原点に静止)
};

// 天体 body が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が body から受ける引力」(第2項)を差し引く。body が原点天体自身のときは第2項が
// 距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(r: Vec3, body: Attractor): Vec3 {
  const b = body.state.r;
  let ax = 0, ay = 0, az = 0;

  // 直接引力 μ(r_b − r)/|r_b − r|³。
  const dx = b.x - r.x;
  const dy = b.y - r.y;
  const dz = b.z - r.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= 1) {
    const k = body.mu / (d2 * Math.sqrt(d2));
    ax += dx * k; ay += dy * k; az += dz * k;
  }

  // ECI 原点(地球)自身が body から受ける引力 μ·r_b/|r_b|³ を差し引く。
  const o2 = b.x * b.x + b.y * b.y + b.z * b.z;
  if (o2 >= 1) {
    const k = body.mu / (o2 * Math.sqrt(o2));
    ax -= b.x * k; ay -= b.y * k; az -= b.z * k;
  }

  return v3(ax, ay, az);
}

// 位置 r で最も強く重力を及ぼしている天体(|attractorAccel| が最大)。素の引力 μ/d² では
// なく、ECI の運動方程式に実際に現れる寄与(attractorAccel)で比べる — 素の引力で比べると
// ECI が太陽と共に自由落下していることを無視した比較になり、地心 2.6e5 km 以遠で太陽が
// 地球に勝ってしまう。「何のためにどの天体を選ぶか」は呼び出し側の判断で、この関数は
// 材料を一つ返すだけ。
export function strongestAttractor(r: Vec3, bodies: readonly Attractor[]): Attractor {
  let best = bodies[0]!;
  let bestMagSq = lenSq(attractorAccel(r, best));
  for (let i = 1; i < bodies.length; i++) {
    const body = bodies[i]!;
    const magSq = lenSq(attractorAccel(r, body));
    if (magSq > bestMagSq) { best = body; bestMagSq = magSq; }
  }
  return best;
}

// 位置 r における軌道運動の時間スケール [s]。最も強く引く天体を中心とする円軌道の周期。
// 刻み幅・サンプル間隔を決めるためのもので、「その天体を中心に軌道要素を出す」こととは無関係。
export function localOrbitPeriod(r: Vec3, bodies: readonly Attractor[]): number {
  const body = strongestAttractor(r, bodies);
  return keplerPeriod(len(sub(r, body.state.r)), body.mu);
}

const IDENTITY_QUAT: Quat = { x: 0, y: 0, z: 0, w: 1 };

// body を原点とする ECI 恒等姿勢の座標系変換。frame.ts の ReferenceFrame
// ({center: body.id, rotatingWith: null}) と等価だが、天体暦を引き直さず既に手元にある
// Attractor のスナップショットからその場で組む。
export function frameOfAttractor(body: Attractor): FrameTransform {
  return { origin: body.state.r, originVel: body.state.v, q: IDENTITY_QUAT, omega: v3() };
}

// 天体 body を中心とする接触軌道要素。中心の選び方には関与しない — 呼び出し側が
// strongestAttractor などで選んだ body をそのまま渡す。
export function elementsAround(s: OrbitState, body: Attractor): Elements | null {
  const rel = toFrameState(frameOfAttractor(body), s);
  return elementsFromState(orbitState(s.t, rel.r, rel.v), body);
}

// 位置 r がいずれかの天体の表面から margin 以内まで沈み込んでいるか。margin(大気圏突入高度
// など)はゲーム側の判断なので呼び出し側から受け取る — physics/ はその値自体を知らない。
export function hitsAnySurface(r: Vec3, bodies: readonly Attractor[], margin: number): boolean {
  for (const body of bodies) {
    if (len(sub(r, body.state.r)) < body.radius + margin) return true;
  }
  return false;
}
