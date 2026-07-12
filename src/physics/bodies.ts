export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

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
