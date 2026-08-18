// 機体の狭域の接触形状。ツリーのエッジ1本につきカプセル1つを取る(§F8)。外接球は広域の絞り込みと
// 天体表面への到達判定に残り、球が交わったときだけこの形へ進む。
import { Vec3, add } from '../../physics/vec3';
import { Quat, qRotate } from '../../physics/attitude';
import type { SweptCapsule } from '../../physics/capsule-contact';
import type { VesselTree } from './tree';
import { circumradius, nodeById } from './tree';

export interface HullCapsule {
  readonly edgeId: string;
  readonly a: Vec3; // 船体ローカル座標
  readonly b: Vec3;
  readonly radius: number;
}

// ツリーからカプセルの集合を導く。hull エッジの半径は両端の断面の外接円半径の平均、truss は断面の
// 大きさの半分とする。decoupler は両端のカプセルが接するため自前のカプセルを持たない。
export function deriveCapsules(tree: VesselTree): readonly HullCapsule[] {
  const capsules: HullCapsule[] = [];
  for (const edge of tree.edges) {
    const a = nodeById(tree, edge.a);
    const b = nodeById(tree, edge.b);
    let radius: number;
    if (edge.kind.kind === 'hull') {
      radius = (circumradius(a.section) + circumradius(b.section)) / 2;
    } else if (edge.kind.kind === 'truss') {
      radius = edge.kind.sectionSize / 2;
    } else {
      continue;
    }
    if (!(radius > 0)) continue;
    capsules.push({ edgeId: edge.id, a: a.pos, b: b.pos, radius });
  }
  return capsules;
}

// 船体ローカルのカプセルを、区間の始点と終点の機体位置・姿勢からワールドの掃引カプセルへ移す。
// 姿勢は区間を通して固定して扱う — 1 substep の間の回転は接触の可否を変えるほど大きくない。
export function sweptWorldCapsule(
  capsule: HullCapsule, startPos: Vec3, endPos: Vec3, attitude: Quat,
): SweptCapsule {
  const a = qRotate(attitude, capsule.a);
  const b = qRotate(attitude, capsule.b);
  return {
    aStart: add(startPos, a),
    bStart: add(startPos, b),
    aEnd: add(endPos, a),
    bEnd: add(endPos, b),
    radius: capsule.radius,
  };
}
