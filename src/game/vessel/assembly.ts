// 機体の形状ツリーと、その上に配置された搭載要素(§12)。ここから質量特性と接触形状を導く。
import type { AnyPart } from '../game-entity/parts';
import type { MountPoint, VesselTree } from './tree';

// 搭載要素1つの配置。外装要素は取り付け位置に、内装要素はそれを収める hull エッジに置く。
// edgeIds が配列であるのは、軸方向に連なる複数のエッジをまたぐ1つのタンクを作れるためである(§8-4)。
export type PartPlacement =
  | { readonly kind: 'external'; readonly part: AnyPart; readonly mount: MountPoint }
  | { readonly kind: 'internal'; readonly part: AnyPart; readonly edgeIds: readonly string[] };

export interface VesselAssembly {
  readonly tree: VesselTree;
  readonly placements: readonly PartPlacement[];
}
