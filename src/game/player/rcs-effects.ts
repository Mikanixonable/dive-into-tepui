// RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, cross, lenSq, norm, scale, v3 } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import { RCS_BLOCK_OFFSETS } from '../../render/ships';
import * as C from '../const';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';

export class RcsEffects {
  private readonly puffs: Billboard[] = Array.from({ length: 4 }, () => new Billboard(0xcfeaff));

  constructor(scene: THREE.Scene) {
    for (const puff of this.puffs) scene.add(puff.mesh);
  }

  // torque は PlayerThrottle が算出し stepAttitude に渡す実トルク(機体座標系)。
  // 表示に必要なのは軸ごとの符号(どちら向きのパフを焚くか)だけなので、ここで
  // 符号ベクトルへ逆算する — 視覚効果は論理更新(torque)の下流に位置させる。
  // playerPos: 自機の絶対 ECI 位置。各パフはその位置を基準に、機体ローカルのスラスタ配置を
  // 姿勢で回転させた変位を慣性座標で足し、末端で fo 経由で描画フレームへ変換する。
  sync(
    fo: FloatingOrigin,
    playerPos: Vec3,
    torque: Vec3,
    att: Attitude,
    alive: boolean,
    phasePlaying: boolean,
    paused: boolean,
    camera: CameraSystem,
  ): void {
    const q = att.q;
    const rotating = alive && phasePlaying && !paused && lenSq(torque) > C.RCS_PUFF_TORQUE_EPS * C.RCS_PUFF_TORQUE_EPS;
    if (!rotating || camera.zoomActive) {
      for (const puff of this.puffs) puff.hide();
      return;
    }
    const tau = v3(Math.sign(torque.x), Math.sign(torque.y), Math.sign(torque.z));
    for (let k = 0; k < 4; k++) {
      const puff = this.puffs[k]!;
      const ro = RCS_BLOCK_OFFSETS[k]!;
      const rb = v3(ro.x, ro.y, ro.z);
      const f = cross(tau, rb);
      if (lenSq(f) < 0.2) {
        puff.hide();
        continue;
      }
      const exhaust = scale(norm(f), -1);
      const flick = 0.6 + Math.random() * 0.4;
      const pos = qRotate(q, addScaled(rb, exhaust, 0.55));
      puff.sync(fo.RtoThreeV3(add(playerPos, pos)), 0.55 * flick, 0.75 * flick, camera.activeCamera.quaternion);
    }
  }
}
