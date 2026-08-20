// 外装の搭載要素1つを、どの造形(FittingShape)でどれだけの大きさに作るか。艦体へ実際に
// 取り付けるとき(hull-mesh.ts)と、掴んで運んでいる間の見た目(assembly-drag-controller.ts)の
// 両方がこの表を読む — 別々に持つと、掴んでいる間と取り付いた後で見た目が食い違いうる。
import type { FittingShape } from '../../render/hull/part-meshes';
import type { PartType } from '../game-entity/parts';

export interface FittingSpec {
  readonly shape: FittingShape;
  readonly ratio: number;
}

// 機体の代表寸法に対する大きさの比。ここに無い種別は外装として何も描かない。
export const FITTINGS: Partial<Record<PartType, FittingSpec>> = {
  engine: { shape: 'nozzle', ratio: 1.1 },
  weapon: { shape: 'barrel', ratio: 1.0 },
  rcs_thruster: { shape: 'thruster', ratio: 0.24 },
  communication: { shape: 'dish', ratio: 0.3 },
  heat_shield: { shape: 'shield', ratio: 0.7 },
  robot_arm: { shape: 'block', ratio: 0.4 },
  docking_port: { shape: 'block', ratio: 0.5 },
  container_coupling: { shape: 'block', ratio: 0.4 },
  combat_shield: { shape: 'block', ratio: 0.8 },
};
