import { add, addScaled, v3 } from '../vec3';
import { Body, Vec3 } from './bodies';

// 万有引力定数 [m^3 kg^-1 s^-2]
const G = 6.6743e-11;

type Derivative = { velocity: Vec3; acceleration: Vec3 }[];

// 各天体に働く重力加速度を全天体対で合成する (N体問題)
function computeAccelerations(bodies: Body[]): Vec3[] {
  const accelerations = bodies.map(() => v3(0, 0, 0));
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

      accelerations[i] = addScaled(accelerations[i]!, v3(dx, dy, dz), forceScale * bj.mass);
      accelerations[j] = addScaled(accelerations[j]!, v3(-dx, -dy, -dz), forceScale * bi.mass);
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
    position: addScaled(body.position, derivative[i]!.velocity, dt),
    velocity: addScaled(body.velocity, derivative[i]!.acceleration, dt),
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
      addScaled(addScaled(k1[i]!.velocity, k2[i]!.velocity, 2), k3[i]!.velocity, 2),
      k4[i]!.velocity,
    );
    const a = add(
      addScaled(addScaled(k1[i]!.acceleration, k2[i]!.acceleration, 2), k3[i]!.acceleration, 2),
      k4[i]!.acceleration,
    );
    return {
      ...body,
      position: addScaled(body.position, v, dt / 6),
      velocity: addScaled(body.velocity, a, dt / 6),
    };
  });
}
