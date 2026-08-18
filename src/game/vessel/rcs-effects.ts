// RCS パフ(姿勢制御スラスタの噴射煙)。配分の結果、実際に噴いているスラスタの先へ噴射煙を置く。
// 固定のノズル表ではなくアクチュエータ集合を読むので、機体ごとに違う配置がそのまま見える。
import * as THREE from 'three/webgpu';
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, add, lenSq, scale } from '../../physics/vec3';
import type { ActuatorSet, Allocation } from '../../physics/attitude-control';
import { inertiaTimes, invertInertia } from '../../physics/inertia-tensor';
import { Billboard } from '../../render/billboard';
import * as C from '../const';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { WorldSfx } from '../../audio/sfx/world-sfx';

// ノズルからプルーム中心までの距離 [m]
const PLUME_OFFSET = 0.55;

export class RcsEffects {
  // スラスタ1基につき1つのプルーム。集合の大きさは設計ごとに決まるので、必要になった時点で足す。
  private readonly plumes: Billboard[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly _worldSfx: WorldSfx,
  ) {}

  // 噴いているスラスタのプルームだけを出し、位置・大きさを同期する。torque はこのフレームに
  // 機体が実際に受けたトルクで、音を鳴らすかどうかの判定にだけ使う。
  sync(
    fo: FloatingOrigin,
    playerPos: Vec3,
    allocation: Allocation | null,
    actuators: ActuatorSet,
    torque: Vec3,
    att: Attitude,
    visible: boolean,
    camera: CameraSystem,
    audible: boolean,
    plumeScale = 1.0,
  ): void {
    // 回っていない、またはズーム視点なら全パフを隠して終える。しきい値は角加速度なので、
    // トルクを慣性テンソルで割り戻してから比べる — そうしないと重い機体ほど常に噴いて見える。
    const invInertia = invertInertia(att.inertia);
    const angAccel = invInertia ? inertiaTimes(invInertia, torque) : torque;
    const rotating = visible && lenSq(angAccel) > C.RCS_PUFF_TORQUE_EPS * C.RCS_PUFF_TORQUE_EPS;
    // 全艦のプルームは描画するが、共有音源を更新するのは操作対象だけ。
    if (audible) this._worldSfx.setRcs(rotating);
    if (!rotating || camera.zoomActive || !allocation) {
      for (const plume of this.plumes) plume.hide();
      return;
    }
    for (let i = 0; i < actuators.thrusters.length; i++) {
      const plume = this.plumeAt(i);
      const thruster = actuators.thrusters[i]!;
      const force = allocation.thrusterForces[i] ?? 0;
      if (!(force > 0) || !(thruster.maxThrust > 0)) {
        plume.hide();
        continue;
      }
      // ノズルは推力の逆向きへ噴く。噴射の強さに応じてプルームを明滅させながら伸ばす。
      const flick = 0.6 + Math.random() * 0.4;
      const output = Math.min(1, force / thruster.maxThrust);
      const exhaust = scale(thruster.direction, -1);
      const localPos = add(
        scale(thruster.position, plumeScale), scale(exhaust, PLUME_OFFSET * plumeScale));
      const pos = qRotate(att.q, localPos);
      plume.sync(
        fo.RtoThreeV3(add(playerPos, pos)),
        0.55 * flick * output * plumeScale, 0.75 * flick * output, camera.activeCamera.quaternion);
    }
    for (let i = actuators.thrusters.length; i < this.plumes.length; i++) this.plumes[i]!.hide();
  }

  // i 番目のプルーム。まだ無ければ作って scene へ加える。
  private plumeAt(i: number): Billboard {
    let plume = this.plumes[i];
    if (!plume) {
      plume = new Billboard(0xcfeaff);
      this.scene.add(plume.mesh);
      this.plumes[i] = plume;
    }
    return plume;
  }

  dispose(scene: THREE.Scene): void {
    for (const plume of this.plumes) {
      scene.remove(plume.mesh);
      plume.dispose();
    }
    this.plumes.length = 0;
  }
}
