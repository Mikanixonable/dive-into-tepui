// RCS パフ(姿勢制御スラスタの噴射煙)。指令トルクに寄与するノズルを選び、その先へ噴射煙を置く。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, add, cross, dot, lenSq, scale, v3 } from '../../math/vec3';
import { Billboard } from '../../render/billboard';
import {
  RCS_PLUME_BRIGHTNESS, RCS_PLUME_COLOR, RCS_PLUME_OFFSET, RCS_PLUME_SIZE,
} from '../../render/vfx-style';
import { RCS_NOZZLES } from '../../render/rcs-nozzles';
import * as C from '../const';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { WorldSfx } from '../../audio/sfx/world-sfx';


export class RcsEffects {
  // ノズルごとの取付位置・噴射方向・噴射で機体に生じるトルク(いずれも機体座標)とプルーム。
  private readonly puffs = RCS_NOZZLES.map((nozzle) => {
    const pos = v3(nozzle.pos.x, nozzle.pos.y, nozzle.pos.z);
    const exhaust = v3(nozzle.dir.x, nozzle.dir.y, nozzle.dir.z);
    return { pos, exhaust, torque: cross(pos, scale(exhaust, -1)), plume: new Billboard(RCS_PLUME_COLOR) };
  });

  // 全ノズルのプルームのビルボードを生成し scene へ追加する。
  constructor(
    scene: THREE.Scene,
    private readonly _worldSfx: WorldSfx,
  ) {
    for (const { plume } of this.puffs) scene.add(plume.mesh);
  }

  // 機体座標の指令 torque に寄与するノズルだけプルームを出し、位置・大きさを同期する。
  sync(
    fo: FloatingOrigin,
    playerPos: Vec3,
    torque: Vec3,
    att: Attitude,
    visible: boolean,
    camera: CameraSystem,
    audible: boolean,
    plumeScale = 1.0,
  ): void {
    // 回転していない、またはズーム視点なら全パフを隠して終える
    const rotating = visible && lenSq(torque) > C.RCS_PUFF_TORQUE_EPS * C.RCS_PUFF_TORQUE_EPS;
    // 全艦のプルームは描画するが、共有音源を更新するのは操作対象だけ。
    if (audible) this._worldSfx.setRcs(rotating);
    if (!rotating || camera.zoomActive) {
      for (const { plume } of this.puffs) plume.hide();
      return;
    }
    for (const puff of this.puffs) {
      // 噴くと指令トルクから遠ざかるノズルは点火しない
      if (dot(puff.torque, torque) <= 0.2) {
        puff.plume.hide();
        continue;
      }
      // ノズルの先へプルームを置き、明滅させる
      const flick = 0.6 + Math.random() * 0.4;
      const offsetDist = RCS_PLUME_OFFSET * plumeScale;
      const localPos = add(scale(puff.pos, plumeScale), scale(puff.exhaust, offsetDist));
      const pos = qRotate(att.q, localPos);
      puff.plume.sync(fo.RtoThreeV3(add(playerPos, pos)),
        RCS_PLUME_SIZE * flick * plumeScale, RCS_PLUME_BRIGHTNESS * flick, camera.activeCamera.quaternion);
    }
  }

  dispose(scene: THREE.Scene): void {
    for (const { plume } of this.puffs) {
      scene.remove(plume.mesh);
      plume.dispose();
    }
  }
}
