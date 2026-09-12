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
  // ノズルごとの取付位置・噴射方向・噴射で機体に生じるトルク(いずれも機体座標)とプルーム。
  private readonly puffs = RCS_NOZZLES.map((nozzle) => {
    const pos = v3(nozzle.pos.x, nozzle.pos.y, nozzle.pos.z);
    const exhaust = v3(nozzle.dir.x, nozzle.dir.y, nozzle.dir.z);
    return { pos, exhaust, torque: cross(pos, scale(exhaust, -1)), plume: new Billboard(RCS_PLUME_COLOR) };
  });

  // 全ノズルのプルームのビルボードを生成し scene へ追加する。ownerId は明滅の種に混ぜる
  // 個体の識別。
  public constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
  ) {
    for (const { plume } of this.puffs) scene.add(plume.mesh);
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
      for (const { plume } of this.puffs) plume.hide();
      return;
    }
    for (const [index, puff] of this.puffs.entries()) {
      // 指令トルクへの寄与が小さいノズルは消す
      if (dot(puff.torque, torque) <= 0.2) {
        puff.plume.hide();
        continue;
      }
      // ノズルの先へプルームを置き、明滅させる
      const flick = 0.6 + mulberry32(plumeNoiseSeed(this.ownerId, displayTime, index))() * 0.4;
      const offsetDist = RCS_PLUME_OFFSET * plumeScale;
      const localPos = add(scale(puff.pos, plumeScale), scale(puff.exhaust, offsetDist));
      const pos = qRotate(attitude, localPos);
      puff.plume.sync(fo.RtoThreeV3(add(position, pos)),
        RCS_PLUME_SIZE * flick * plumeScale, RCS_PLUME_BRIGHTNESS * flick, cameraQuat);
    }
  }

  // 全ノズルのプルームのビルボードを scene から取り除き解放する。
  public dispose(scene: THREE.Scene): void {
    for (const { plume } of this.puffs) {
      scene.remove(plume.mesh);
      plume.dispose();
    }
  }
}
