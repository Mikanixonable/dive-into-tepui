// RCS パフ(姿勢制御スラスタの噴射煙)。指令トルクに寄与するノズルを選び、その先へ噴射煙を置く。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { Vec3, lenSq } from '../../../math/vec3';
import { Billboard } from '../../billboard';
import { plumeNoiseSeed } from './plume-noise';

export const RCS_PUFF_TORQUE_EPS = 0.15; // RCSパフを表示する実トルクしきい値 [rad/s^2](inertia=1前提)

const RCS_PLUME_COLOR = 0xcfeaff;
const RCS_PLUME_OFFSET = 0.55; // ノズルからプルーム中心までの距離 [m]
const RCS_PLUME_SIZE = 0.55;
// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const RCS_PLUME_BRIGHTNESS = 0.75;

export class RcsEffects {
  private readonly plumes: Billboard[] = [];

  // 全ノズルのプルームのビルボードを生成し scene へ追加する。ownerId は明滅の種に混ぜる
  // 個体の識別。
  public constructor(
    private readonly scene: THREE.Scene,
    private readonly ownerId: string,
  ) {
  }

  // module asset の rcs:* anchor をノズルとして使う。anchor の +Z が排気方向で、shipRoot
  // の原点は船体 COM。位置と向きを船体座標へ戻して、指令 torque に寄与するノズルだけを選ぶ。
  public syncFromAnchors(
    shipRoot: THREE.Object3D,
    anchors: readonly THREE.Object3D[],
    torque: Vec3,
    visible: boolean,
    cameraQuat: THREE.Quaternion,
    zoomActive: boolean,
    displayTime: number,
    plumeScale = 1.0,
  ): void {
    this.ensurePlumeCount(anchors.length);
    if (!visible || zoomActive || anchors.length === 0
      || lenSq(torque) <= RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS) {
      this.hideAll();
      return;
    }

    const rootWorldQ = shipRoot.getWorldQuaternion(new THREE.Quaternion());
    const inverseRootQ = rootWorldQ.clone().invert();
    for (const [index, anchor] of anchors.entries()) {
      const plume = this.plumes[index]!;
      const worldPosition = anchor.getWorldPosition(new THREE.Vector3());
      const bodyPosition = shipRoot.worldToLocal(worldPosition.clone());
      const worldExhaust = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()));
      const bodyExhaust = worldExhaust.clone().applyQuaternion(inverseRootQ);
      const contribution = bodyPosition.clone().cross(bodyExhaust.clone().multiplyScalar(-1));
      if (contribution.dot(new THREE.Vector3(torque.x, torque.y, torque.z)) <= 0) {
        plume.hide();
        continue;
      }
      const flick = 0.6 + mulberry32(plumeNoiseSeed(this.ownerId, displayTime, index))() * 0.4;
      const position = worldPosition.addScaledVector(worldExhaust, RCS_PLUME_OFFSET * plumeScale);
      plume.sync(
        position,
        RCS_PLUME_SIZE * flick * plumeScale,
        RCS_PLUME_BRIGHTNESS * flick,
        cameraQuat,
      );
    }
    for (let i = anchors.length; i < this.plumes.length; i++) this.plumes[i]!.hide();
  }

  private ensurePlumeCount(count: number): void {
    while (this.plumes.length < count) {
      const plume = new Billboard(RCS_PLUME_COLOR);
      this.plumes.push(plume);
      this.scene.add(plume.mesh);
    }
  }

  private hideAll(): void {
    for (const plume of this.plumes) plume.hide();
  }

  // 全ノズルのプルームのビルボードを scene から取り除き解放する。
  public dispose(scene: THREE.Scene): void {
    for (const plume of this.plumes) {
      scene.remove(plume.mesh);
      plume.dispose();
    }
    this.plumes.length = 0;
  }
}
