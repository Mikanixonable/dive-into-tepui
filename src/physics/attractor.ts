// 天体を重力源として読む計算。ある点に効く加速度、最も強く引く天体、抗力を及ぼす大気天体、
// その場の軌道時間スケール。天体の位置は pivot で厳密に引いた値からその時刻へ外挿したものを
// 使うので、呼び出し側は一覧を解決した時刻を pivot として渡す。
// THREE/DOM 非依存の純関数群。
import type { CelestialMotion } from './celestial-motion';
import { KinematicState } from './kinematic-state';
import { keplerPeriod, orbitalElementsOf } from './elements';
import type { FrameAnchorSource } from './frame';
import { Vec3, len, lenSq, sub, v3 } from '../math/vec3';

// 天体 attractor が位置 r の運動方程式へ寄与する加速度 μ[(r_b − r)/|r_b − r|³ − r_b/|r_b|³]。
// ECI は原点(地球)自身が他の天体に引かれて加速する非慣性系なので、直接引力(第1項)から
// 「原点が attractor から受ける引力」(第2項)を差し引く。attractor が原点天体自身のときは
// 第2項が距離ゼロで消え、直接引力そのものになる。距離ゼロの項は発散を避けて寄与ゼロとして扱う。
// 毎ステップ全エンティティぶん走る経路なので、中間の Vec3 を作らずスカラで畳む。
export function attractorAccel(
  r: Vec3, attractor: CelestialMotion, pivot: number, t: number = pivot,
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
// 地球に勝ってしまう。「何のためにどの天体を選ぶか」は呼び出し側の判断で、この関数は
// 材料を一つ返すだけ。
export function strongestAttractor(
  r: Vec3, attractors: readonly CelestialMotion[], pivot: number,
): CelestialMotion {
  let best: CelestialMotion | null = null;
  let bestMagSq = -Infinity;
  for (let i = 0; i < attractors.length; i++) {
    const attractor = attractors[i]!;
    const magSq = lenSq(attractorAccel(r, attractor, pivot));
    if (best === null || magSq > bestMagSq) { best = attractor; bestMagSq = magSq; }
  }
  return best!;
}

// 位置 r へ大気の抗力を及ぼす天体。大気を持つ天体のうち最も近いものを選ぶ — 密度は高度に対して
// 指数的に減るので、最も近い天体が桁違いに支配する。複数の大気の寄与を足し合わせることは
// 物理的にありえないので、抗力を掛ける相手はここで1体に決まる。候補が無ければ null。
export function nearestAtmosphereBody(
  r: Vec3, bodies: readonly CelestialMotion[], pivot: number,
): CelestialMotion | null {
  let best: CelestialMotion | null = null;
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
  r: Vec3, attractors: readonly CelestialMotion[], pivot: number,
): number {
  const attractor = strongestAttractor(r, attractors, pivot);
  return keplerPeriod(len(sub(r, attractor.positionAt(pivot))), attractor.def.mu);
}

// state が周回している(離心率 1 未満の)主天体。公転回転系の基底を組めるかどうかの判定は
// この条件に一本化する。
export function orbitingAttractorOf(
  state: KinematicState, bodies: readonly CelestialMotion[], pivot: number,
): CelestialMotion | null {
  if (bodies.length === 0) return null;
  const attractor = strongestAttractor(state.r, bodies, pivot);
  const elements = orbitalElementsOf(state, attractor, pivot);
  return elements !== null && elements.e < 1 ? attractor : null;
}

// 天体一覧だけを情報源にする FrameAnchorSource。渡した天体に無い id へは null を答える。
export function bodyAnchorSource(
  bodies: readonly CelestialMotion[], bodiesPivot: number,
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
