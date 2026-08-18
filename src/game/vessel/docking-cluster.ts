import { add, scale, type Vec3 } from '../../physics/vec3';

export interface ClusterBody { readonly id: string; readonly mass: number; readonly position: Vec3; readonly velocity: Vec3; readonly radius: number; }
export interface DockingCluster { readonly bodies: readonly ClusterBody[]; readonly mass: number; readonly centerOfMass: Vec3; readonly velocity: Vec3; }

export function mergeCluster(a: ClusterBody, b: ClusterBody): DockingCluster {
  if (!(a.mass > 0) || !(b.mass > 0)) throw new RangeError('cluster body mass must be positive');
  const mass = a.mass + b.mass;
  const centerOfMass = scale(add(scale(a.position, a.mass), scale(b.position, b.mass)), 1 / mass);
  const velocity = scale(add(scale(a.velocity, a.mass), scale(b.velocity, b.mass)), 1 / mass);
  return { bodies: [a, b], mass, centerOfMass, velocity };
}

export function addToCluster(cluster: DockingCluster, body: ClusterBody): DockingCluster {
  const mass = cluster.mass + body.mass;
  return { bodies: [...cluster.bodies, body], mass, centerOfMass: scale(add(scale(cluster.centerOfMass, cluster.mass), scale(body.position, body.mass)), 1 / mass), velocity: scale(add(scale(cluster.velocity, cluster.mass), scale(body.velocity, body.mass)), 1 / mass) };
}
export function removeFromCluster(cluster: DockingCluster, id: string): { cluster: DockingCluster | null; body: ClusterBody } {
  const body = cluster.bodies.find((candidate) => candidate.id === id);
  if (!body) throw new Error(`unknown cluster body ${id}`);
  const rest = cluster.bodies.filter((candidate) => candidate.id !== id);
  if (rest.length === 0) return { cluster: null, body };
  const first = rest[0]!;
  let result = mergeCluster(first, rest[1] ?? first);
  if (rest.length === 1) result = { bodies: rest, mass: first.mass, centerOfMass: first.position, velocity: first.velocity };
  for (const candidate of rest.slice(2)) result = addToCluster(result, candidate);
  return { cluster: result, body };
}
