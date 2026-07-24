// RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, cross, lenSq, norm, scale, v3 } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import { RCS_BLOCK_OFFSETS } from '../../render/ships';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';

export class RcsEffects {
  private readonly puffs: Billboard[] = Array.from({ length: 4 }, () => new Billboard(0xcfeaff));

  constructor(scene: THREE.Scene) {
    for (const puff of this.puffs) scene.add(puff.mesh);
  }

  // tau は PlayerThrottle が公開する RCS パフ噴射方向(機体ローカルの符号ベクトル)。
  // ここは可視化のみで、実際のトルク計算・入力読み取りは PlayerThrottle 側に集約されている。
  // playerPos: 自機の絶対 ECI 位置。各パフはその位置を基準に、機体ローカルのスラスタ配置を
  // 姿勢で回転させた変位を慣性座標で足し、末端で fo 経由で描画フレームへ変換する。
  sync(
    fo: FloatingOrigin,
    playerPos: Vec3,
    tau: Vec3,
    att: Attitude,
    alive: boolean,
    phasePlaying: boolean,
    paused: boolean,
    camera: CameraSystem,
  ): void {
    const q = att.q;
    // 計画編集モード中は PlayerThrottle が tau=0 を出すため、mapMode/editMode を見なくても
    // ここは自然にパフ非表示になる(lenSq(tau) 判定で吸収される)。
    const rotating = alive && phasePlaying && !paused && lenSq(tau) > 0.01;
    if (!rotating || camera.zoomActive) {
      for (const puff of this.puffs) puff.hide();
      return;
    }
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
