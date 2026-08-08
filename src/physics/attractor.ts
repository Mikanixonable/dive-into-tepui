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

// 天体 attractor が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が attractor から受ける引力」(第2項)を差し引く。attractor が原点天体自身のときは
// 第2項が距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(r: Vec3, attractor: Attractor): Vec3 {
  const b = attractor.state.r;
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
  let best = attractors[0]!;
  let bestMagSq = lenSq(attractorAccel(r, best));
  for (let i = 1; i < attractors.length; i++) {
    const attractor = attractors[i]!;
    const magSq = lenSq(attractorAccel(r, attractor));
    if (magSq > bestMagSq) { best = attractor; bestMagSq = magSq; }
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

// 天体 center を中心とする接触軌道要素。中心の選び方には関与しない — 呼び出し側が
// strongestAttractor などで選んだ center をそのまま渡す。
export function elementsAround(s: OrbitState, center: Attractor): Elements | null {
  const rel = toFrameState(frameOfAttractor(center), s);
  return elementsFromState(orbitState(s.t, rel.r, rel.v), center);
}

// 位置 r がいずれかの天体の表面から margin 以内まで沈み込んでいるか。margin(大気圏突入高度
// など)はゲーム側の判断なので呼び出し側から受け取る — physics/ はその値自体を知らない。
export function hitCelestialBody(r: Vec3, attractors: readonly Attractor[], margin: number): boolean {
  for (const attractor of attractors) {
    if (len(sub(r, attractor.state.r)) < attractor.radius + margin) return true;
  }
  return false;
}
