// 軌道上に居る個体の契約。自分の id と現在状態、ある天体を中心に取った接触軌道要素を答える。
import type { CelestialBody } from '../../../physics/celestial-body';
import type { OrbitalElements } from '../../../physics/elements';
import type { KinematicState } from '../../../physics/kinematic-state';

export interface OrbitingObject {
  readonly id: string;
  readonly state: KinematicState;
  // center を中心とする接触軌道要素。縮退していれば null。
  orbitalElementsAround(center: CelestialBody, centerPivot: number): OrbitalElements | null;
}
