// 機体の形状ツリーと、その上に配置された搭載要素。ここから質量特性と接触形状を導く。
import type { MassProperties } from './mass-properties';

export interface VesselAssembly {
  readonly massProperties: MassProperties;
}
