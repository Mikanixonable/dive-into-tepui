// 軌道上に居る個体の契約。自分の id と現在状態、ある天体を中心に取った接触軌道要素を答える。
import type { DynamicMotion } from '../dynamic-motion';

export interface OrbitingObject {
  readonly id: string;
  readonly motion: DynamicMotion;
}
