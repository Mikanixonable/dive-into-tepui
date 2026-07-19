import type { Vec3 } from '../vec3';

export type { Vec3 };

export interface Body {
  name: string;
  mass: number;
  position: Vec3;
  velocity: Vec3;
}

export interface SimState {
  time: number;
  bodies: Body[];
}
