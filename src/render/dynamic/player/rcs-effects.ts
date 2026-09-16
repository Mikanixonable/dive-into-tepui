// RCS パフ(姿勢制御スラスタの噴射煙)。指令トルクに寄与するノズルを選び、その先へ噴射煙を置く。
import * as THREE from 'three/webgpu';
import { qRotate, type Quat } from '../../../math/quat';
import { mulberry32 } from '../../../math/random';
import { Vec3, add, cross, dot, lenSq, scale, v3 } from '../../../math/vec3';
import { Billboard } from '../../billboard';
import { RCS_NOZZLES } from '../../rcs-nozzles';
import { FloatingOrigin } from '../../camera/floating-origin';
import { plumeNoiseSeed } from './plume-noise';

export const RCS_PUFF_TORQUE_EPS = 0.15; // RCSパフを表示する実トルクしきい値 [rad/s^2](inertia=1前提)

const RCS_PLUME_COLOR = 0xcfeaff;
const RCS_PLUME_OFFSET = 0.55; // ノズルからプルーム中心までの距離 [m]
const RCS_PLUME_SIZE = 0.55;
// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const RCS_PLUME_BRIGHTNESS = 0.75;

export class RcsEffects {
  // 旧固定モデルの取付位置は Base 移行までの互換入力にだけ使う。
  private readonly legacyNozzles = RCS_NOZZLES.map((nozzle) => {
    const pos = v3(nozzle.pos.x, nozzle.pos.y, nozzle.pos.z);
    const exhaust = v3(nozzle.dir.x, nozzle.dir.y, nozzle.dir.z);
    return { pos, exhaust, torque: cross(pos, scale(exhaust, -1)) };
  });
  private readonly plumes: Billboard[] = [];

  // 全ノズルのプルームのビルボードを生成し scene へ追加する。ownerId は明滅の種に混ぜる
  // 個体の識別。
  public constructor(
    private readonly scene: THREE.Scene,
    private readonly ownerId: string,
  ) {
    this.ensurePlumeCount(this.legacyNozzles.length);
  }

  // 機体座標の指令 torque に寄与するノズルだけプルームを出し、位置・大きさを同期する。
  // position は機体を置く ECI 位置で、表示時刻の状態を引けないフレームは null。displayTime は
  // 明滅の位相を決める表示時刻で、同じ時刻に何度呼んでも同じ絵になる。
  public sync(
    fo: FloatingOrigin,
    position: Vec3 | null,
    torque: Vec3,
    attitude: Quat,
    visible: boolean,
    cameraQuat: THREE.Quaternion,
    zoomActive: boolean,
    displayTime: number,
    plumeScale = 1.0,
  ): void {
    // 置けない・見えない・ズーム中・指令トルクが小さいフレームは全パフを隠す
    if (position === null || !visible || zoomActive
      || lenSq(torque) <= RCS_PUFF_TORQUE_EPS * RCS_PUFF_TORQUE_EPS) {
      this.hideAll();
      return;
    }
    for (const [index, nozzle] of this.legacyNozzles.entries()) {
      const plume = this.plumes[index]!;
      // 指令トルクへの寄与が小さいノズルは消す
      if (dot(nozzle.torque, torque) <= 0.2) {
        plume.hide();
        continue;
      }
      // ノズルの先へプルームを置き、明滅させる
      const flick = 0.6 + mulberry32(plumeNoiseSeed(this.ownerId, displayTime, index))() * 0.4;
      const offsetDist = RCS_PLUME_OFFSET * plumeScale;
      const localPos = add(scale(nozzle.pos, plumeScale), scale(nozzle.exhaust, offsetDist));
      const pos = qRotate(attitude, localPos);
      plume.sync(fo.RtoThreeV3(add(position, pos)),
        RCS_PLUME_SIZE * flick * plumeScale, RCS_PLUME_BRIGHTNESS * flick, cameraQuat);
    }
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
