// 軌道上に存在する個体の共通インターフェース。識別子 id と現在運動状態を保持する。
import type { DynamicMotion } from '../dynamic-motion';

export interface OrbitingObject {
  readonly id: string;
  readonly motion: DynamicMotion;
}
