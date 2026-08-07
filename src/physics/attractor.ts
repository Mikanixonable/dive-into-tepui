// 重力を及ぼすもの。位置・速度は ECI(地球は原点に静止)。THREE/DOM 非依存の純関数群。
import { OrbitState, orbitState } from './orbital-state';
import { Elements, elementsFromState, keplerPeriod } from './elements';
import { Vec3, add, lenSq, len, sub, v3 } from './vec3';

export type AttractorId = 'earth' | 'moon' | 'sun';

export type Attractor = {
  readonly id: AttractorId;
  readonly mu: number; // GM [m^3/s^2]
  readonly radius: number; // 表面半径 [m]
  readonly r: Vec3; // ECI 位置(地球は原点)
  readonly v: Vec3; // ECI 速度
};

// 天体 body が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が body から受ける引力」(第2項)を差し引く。body が原点天体自身のときは第2項が
// 距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(r: Vec3, body: Attractor): Vec3 {
  let ax = 0, ay = 0, az = 0;

  const dx = body.r.x - r.x;
  const dy = body.r.y - r.y;
  const dz = body.r.z - r.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= 1) {
    const k = body.mu / (d2 * Math.sqrt(d2));
    ax += dx * k; ay += dy * k; az += dz * k;
  }

  const o2 = body.r.x * body.r.x + body.r.y * body.r.y + body.r.z * body.r.z;
  if (o2 >= 1) {
    const k = body.mu / (o2 * Math.sqrt(o2));
    ax -= body.r.x * k; ay -= body.r.y * k; az -= body.r.z * k;
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
  return keplerPeriod(len(sub(r, body.r)), body.mu);
}

// 天体中心相対 ⇄ ECI(時刻 t は保つ)。
export function relativeTo(s: OrbitState, body: Attractor): OrbitState {
  return orbitState(s.t, sub(s.r, body.r), sub(s.v, body.v));
}
export function toAbsolute(rel: OrbitState, body: Attractor): OrbitState {
  return orbitState(rel.t, add(rel.r, body.r), add(rel.v, body.v));
}

// 天体 body を中心とする接触軌道要素。中心の選び方には関与しない — 呼び出し側が
// strongestAttractor などで選んだ body をそのまま渡す。
export function elementsAround(s: OrbitState, body: Attractor): Elements | null {
  const rel = relativeTo(s, body);
  return elementsFromState(rel.r, rel.v, body.mu, body.id);
}

// 位置 r がいずれかの天体の表面から margin 以内まで沈み込んでいるか。margin(大気圏突入高度
// など)はゲーム側の判断なので呼び出し側から受け取る — physics/ はその値自体を知らない。
export function hitsAnySurface(r: Vec3, bodies: readonly Attractor[], margin: number): boolean {
  for (const body of bodies) {
    if (len(sub(r, body.r)) < body.radius + margin) return true;
  }
  return false;
}
