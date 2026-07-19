import { Body, Vec3 } from './bodies';

// 万有引力定数 [m^3 kg^-1 s^-2]
const G = 6.6743e-11;

type Derivative = { velocity: Vec3; acceleration: Vec3 }[];

function zero(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

function add(a: Vec3, b: Vec3, scale = 1): Vec3 {
  return { x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale };
}

// 各天体に働く重力加速度を全天体対で合成する (N体問題)
function computeAccelerations(bodies: Body[]): Vec3[] {
  const accelerations = bodies.map(zero);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const bi = bodies[i]!;
      const bj = bodies[j]!;
      const dx = bj.position.x - bi.position.x;
      const dy = bj.position.y - bi.position.y;
      const dz = bj.position.z - bi.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const dist = Math.sqrt(distSq);
      const forceScale = G / (distSq * dist);

      accelerations[i] = add(accelerations[i]!, { x: dx, y: dy, z: dz }, forceScale * bj.mass);
      accelerations[j] = add(accelerations[j]!, { x: -dx, y: -dy, z: -dz }, forceScale * bi.mass);
    }
  }
  return accelerations;
}

function derive(bodies: Body[]): Derivative {
  const accelerations = computeAccelerations(bodies);
  return bodies.map((body, i) => ({
    velocity: body.velocity,
    acceleration: accelerations[i]!,
  }));
}

function applyStep(bodies: Body[], derivative: Derivative, dt: number): Body[] {
  return bodies.map((body, i) => ({
    ...body,
    position: add(body.position, derivative[i]!.velocity, dt),
    velocity: add(body.velocity, derivative[i]!.acceleration, dt),
  }));
}

// 4次のルンゲ=クッタ法 (RK4) による1ステップ積分。
// タイムワープ時の刻み幅制御は呼び出し側で dt を小さく分割して対応する。
export function stepRK4(bodies: Body[], dt: number): Body[] {
  const k1 = derive(bodies);
  const b2 = applyStep(bodies, k1, dt / 2);
  const k2 = derive(b2);
  const b3 = applyStep(bodies, k2, dt / 2);
  const k3 = derive(b3);
  const b4 = applyStep(bodies, k3, dt);
  const k4 = derive(b4);

  return bodies.map((body, i) => {
    const v = add(
      add(add(k1[i]!.velocity, k2[i]!.velocity, 2), k3[i]!.velocity, 2),
      k4[i]!.velocity,
    );
    const a = add(
      add(add(k1[i]!.acceleration, k2[i]!.acceleration, 2), k3[i]!.acceleration, 2),
      k4[i]!.acceleration,
    );
    return {
      ...body,
      position: add(body.position, v, dt / 6),
      velocity: add(body.velocity, a, dt / 6),
    };
  });
}
