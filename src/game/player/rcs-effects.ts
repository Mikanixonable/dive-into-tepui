// RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, cross, lenSq, norm, scale, v3 } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import { RCS_BLOCK_OFFSETS } from '../../render/ships';
import * as C from '../const';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { Sfx } from '../../audio/sfx';

export class RcsEffects {
  private readonly puffs: Billboard[] = Array.from({ length: 4 }, () => new Billboard(0xcfeaff));

  // 4基のパフのビルボードを生成し scene へ追加する。
  constructor(
    scene: THREE.Scene,
    private readonly _sfx: Sfx,
  ) {
    for (const puff of this.puffs) scene.add(puff.mesh);
  }

  // torque から各RCSブロックの噴射方向を求め、対応するパフの位置・大きさを同期する。
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
    // 回転していない、またはズーム視点なら全パフを隠して終える
    const rotating = alive && phasePlaying && !paused && lenSq(torque) > C.RCS_PUFF_TORQUE_EPS * C.RCS_PUFF_TORQUE_EPS;
    this._sfx.setRcs(rotating);
    if (!rotating || camera.zoomActive) {
      for (const puff of this.puffs) puff.hide();
      return;
    }
    // トルクの符号から各ブロック位置での噴射方向を求める
    const tau = v3(Math.sign(torque.x), Math.sign(torque.y), Math.sign(torque.z));
    for (let k = 0; k < 4; k++) {
      const puff = this.puffs[k]!;
      const ro = RCS_BLOCK_OFFSETS[k]!;
      const rb = v3(ro.x, ro.y, ro.z);
      const f = cross(tau, rb);
      // このブロックがトルクに寄与しないなら隠す
      if (lenSq(f) < 0.2) {
        puff.hide();
        continue;
      }
      // 噴射方向と逆側にパフを置き、明滅させる
      const exhaust = scale(norm(f), -1);
      const flick = 0.6 + Math.random() * 0.4;
      const pos = qRotate(q, addScaled(rb, exhaust, 0.55));
      puff.sync(fo.RtoThreeV3(add(playerPos, pos)), 0.55 * flick, 0.75 * flick, camera.activeCamera.quaternion);
    }
  }
}
