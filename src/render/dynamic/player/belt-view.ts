import * as THREE from 'three/webgpu';
import { LOCAL_RIGHT, Q_IDENTITY, qFromAxisAngle, qFromUnitVectors, qMul, qRotate, type Quat } from '../../../math/quat';
import { len, scale, sub, type Vec3 } from '../../../math/vec3';
import { markSharedResources } from '../model-template';
import { getMagazineTemplate } from '../ammo-models';
import { prepareStaticModel } from '../../static-model';
import { BeltHardwareView, linkCable } from './belt-hardware-view';

// 下ごしらえを済ませた、マガジンと背面ケーブルからなるリンク 1 個のテンプレート。
let linkTemplate: THREE.Group | null = null;

// マガジンリンク 1 個分のモデルを、全リンクで共有する資源の複製として作る。
function beltLink(): THREE.Group {
  if (linkTemplate === null) {
    // マガジンの姿勢はリンクが持つので、模型の根の位置と向きは原点へ戻す。
    const magazine = getMagazineTemplate().clone(true);
    magazine.position.set(0, 0, 0);
    magazine.quaternion.identity();
    linkTemplate = new THREE.Group();
    linkTemplate.add(magazine, linkCable());
    prepareStaticModel(linkTemplate);
  }
  const link = linkTemplate.clone(true);
  markSharedResources(link);
  return link;
}

// 給弾ベルトの節点配置(いずれも機体座標系)。
export interface BeltNodes {
  readonly anchor: Vec3; // 給弾口側の吊り元
  readonly positions: readonly Vec3[]; // 吊り元から順に並ぶ各節の位置
  readonly twists: readonly number[]; // 各節のチェーン軸まわりのねじれ角 [rad]
}

// 給弾ベルトのリンク列を組み、供給された各節の位置とねじれへ同期する。
export class BeltView {
  private readonly links: THREE.Group[] = [];
  private readonly hardware: BeltHardwareView;

  // root は自機の表示ツリーの根。linkCount ぶんのリンクを給弾口から並べて作る。
  public constructor(root: THREE.Object3D, linkCount: number) {
    const group = new THREE.Group();
    for (let i = 0; i < linkCount; i++) {
      const link = beltLink();
      group.add(link);
      this.links.push(link);
    }
    this.hardware = new BeltHardwareView(group, linkCount);
    root.add(group);
  }

  // リンク列を nodes の節点へ合わせ、先頭から magsLeft 本(残マガジン数)を見せる。
  public sync(magsLeft: number, nodes: BeltNodes): void {
    const { anchor, positions, twists } = nodes;
    let prevPoint = anchor;
    let prevQ: Quat = Q_IDENTITY;
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      link.visible = i < Math.min(magsLeft, this.links.length);
      // リンクは前の節との中点へ置く。
      const pos = positions[i]!;
      link.position.set((prevPoint.x + pos.x) / 2, (prevPoint.y + pos.y) / 2, (prevPoint.z + pos.z) / 2);
      // 前のリンクの向きから節の向きへ倒し、ベルトのねじれを重ねる。
      const dir = sub(pos, prevPoint);
      const segLen = len(dir);
      let bendQ = prevQ;
      if (segLen > 1e-6) bendQ = qMul(qFromUnitVectors(qRotate(prevQ, LOCAL_RIGHT), scale(dir, 1 / segLen)), prevQ);
      const q = qMul(bendQ, qFromAxisAngle(LOCAL_RIGHT, twists[i]!));
      link.quaternion.set(q.x, q.y, q.z, q.w);
      prevQ = bendQ;
      prevPoint = pos;
    }
    this.hardware.sync(magsLeft, nodes, this.links);
  }
}
