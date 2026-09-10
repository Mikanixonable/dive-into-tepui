import * as THREE from 'three/webgpu';
import { LOCAL_RIGHT, Q_IDENTITY, qFromAxisAngle, qFromUnitVectors, qMul, qRotate, type Quat } from '../../../math/quat';
import { len, scale, sub, type Vec3 } from '../../../math/vec3';
import { buildMagazineMesh } from '../ships';
import { MAG_BELT_ANCHOR_X, MAG_BELT_PITCH } from '../../../physics/player-shape';

// 給弾ベルトの節点配置(いずれも機体座標系)。
export interface BeltNodes {
  readonly anchor: Vec3; // 給弾口側の吊り元
  readonly positions: readonly Vec3[]; // 吊り元から順に並ぶ各節の位置
  readonly twists: readonly number[]; // 各節のチェーン軸まわりのねじれ角 [rad]
}

// 給弾ベルトのリンク列を組み、供給された各節の位置とねじれへ同期する。
export class BeltView {
  private readonly links: THREE.Group[] = [];

  // root は自機の表示ツリーの根。linkCount ぶんのリンクを給弾口から並べて作る。
  public constructor(root: THREE.Object3D, linkCount: number) {
    const group = new THREE.Group();
    for (let i = 0; i < linkCount; i++) {
      const link = buildMagazineMesh();
      link.position.x = MAG_BELT_ANCHOR_X + (i + 0.5) * MAG_BELT_PITCH;
      group.add(link);
      this.links.push(link);
    }
    root.add(group);
  }

  // magsLeft は残弾数(その本数までのリンクだけを見せる)。各リンクは前の節との中点へ置き、
  // 節の向きへ倒したうえでベルトのねじれを重ねる。
  public sync(magsLeft: number, nodes: BeltNodes): void {
    const { anchor, positions, twists } = nodes;
    let prevPoint = anchor;
    let prevQ: Quat = Q_IDENTITY;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      link.visible = i < Math.min(magsLeft, this.links.length);
      const pos = positions[i]!;
      link.position.set((prevPoint.x + pos.x) / 2, (prevPoint.y + pos.y) / 2, (prevPoint.z + pos.z) / 2);
      const dir = sub(pos, prevPoint);
      const segLen = len(dir);
      let bendQ = prevQ;
      if (segLen > 1e-6) bendQ = qMul(qFromUnitVectors(qRotate(prevQ, LOCAL_RIGHT), scale(dir, 1 / segLen)), prevQ);
      const q = qMul(bendQ, qFromAxisAngle(LOCAL_RIGHT, twists[i]!));
      link.quaternion.set(q.x, q.y, q.z, q.w);
      prevQ = bendQ;
      prevPoint = pos;
    }
  }
}
