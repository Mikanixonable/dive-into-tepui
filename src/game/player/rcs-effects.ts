// RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, addScaled, cross, lenSq, norm, scale, v3 } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import { RCS_BLOCK_OFFSETS } from '../../render/ships';
import type { CameraSystem } from '../camera/camera-system';
import { Input } from '../input';
import * as C from '../const';

export class RcsEffects {
  private readonly puffs: Billboard[] = Array.from({ length: 4 }, () => new Billboard(0xcfeaff));

  constructor(scene: THREE.Scene) {
    for (const puff of this.puffs) scene.add(puff.mesh);
  }

  // RCS パフの噴射方向(機体ローカル、body frame のトルク軸)。無回転ならゼロベクトル。
  // ダンピングの符号反転を含め updateAttitude のトルク計算と同じ入力読み取りを行うが、
  // ここでは可視化のみで実際のトルクは適用しない。
  computeRcsTau(input: Input, rcsDamp: boolean, w: Vec3, alive: boolean, phasePlaying: boolean, mapMode: boolean): Vec3 {
    let tauX = (input.down('KeyI') ? 1 : 0) + (input.down('KeyK') ? -1 : 0);
    let tauY = (input.down('KeyL') ? 1 : 0) + (input.down('KeyJ') ? -1 : 0);
    let tauZ = (input.down('KeyO') ? 1 : 0) + (input.down('KeyU') ? -1 : 0);
    if (rcsDamp && alive && phasePlaying && !mapMode) {
      const eps = C.RCS_DAMP_PUFF_EPS;
      if (tauX === 0 && Math.abs(w.x) > eps) tauX = -Math.sign(w.x);
      if (tauY === 0 && Math.abs(w.y) > eps) tauY = -Math.sign(w.y);
      if (tauZ === 0 && Math.abs(w.z) > eps) tauZ = -Math.sign(w.z);
    }
    return v3(tauX, tauY, tauZ);
  }

  sync(
    input: Input,
    rcsDamp: boolean,
    att: Attitude,
    alive: boolean,
    phasePlaying: boolean,
    paused: boolean,
    camera: CameraSystem,
  ): void {
    const tau = this.computeRcsTau(input, rcsDamp, att.w, alive, phasePlaying, camera.mapMode);
    const q = att.q;
    const rotating = alive && phasePlaying && !paused && !camera.mapMode && lenSq(tau) > 0.01;
    if (!rotating || camera.zoomActive) {
      for (const puff of this.puffs) puff.hide();
      return;
    }
    const camQuat = camera.activeCamera.quaternion;
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
      puff.sync(pos, 0.55 * flick, 0.75 * flick, camQuat);
    }
  }
}
