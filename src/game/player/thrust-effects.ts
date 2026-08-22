// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)+ エンジン音。
// GameEntity 自身が持つ this.thrust(今フレームの推力ベクトルそのもの)を直接読む —
// PlayerThrottle 固有の状態(thrustVizDir/throttleIdx)には依存しない(RcsEffects が
// PlayerThrottle 経由ではなく ship.torque を直接読むのと同じ理由・同じ形)。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, len, scale } from '../../physics/vec3';
import { Billboard } from '../../render/billboard';
import type { CameraSystem } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { WorldSfx } from '../../audio/sfx/world-sfx';

export class ThrustEffects {
  private readonly core = new Billboard(0xaee6ff);
  private readonly outer = new Billboard(0x4f9fff);

  // core/outer ビルボードを scene に登録する。
  constructor(
    scene: THREE.Scene,
    private readonly _worldSfx: WorldSfx,
  ) {
    scene.add(this.core.mesh);
    scene.add(this.outer.mesh);
  }

  // 噴射プルーム・エンジン音を thrust(今フレームの推力ベクトル、非噴射時は null)に合わせて
  // 同期する。maxAccel は出力比(プルームの大きさ)を求めるための全開加速度。
  // ズームガンサイト表示中や自機死亡時はプルームを隠す。audible は共有音源を鳴らすかどうか
  // (RcsEffects.sync と同じ役割 — 全艦のプルームは描画するが、音は操作対象だけ)。
  sync(
    fo: FloatingOrigin, playerPos: Vec3, thrust: Vec3 | null, maxAccel: number,
    visible: boolean, audible: boolean, camera: CameraSystem, plumeScale = 1.0,
  ): void {
    const firing = thrust !== null && visible;
    if (audible) this._worldSfx.setThrust(firing);

    if (!firing || camera.zoomActive) {
      this.core.hide();
      this.outer.hide();
      return;
    }
    const mag = len(thrust!);
    const d = mag > 0 ? scale(thrust!, 1 / mag) : thrust!;
    // 揺らぎと出力比(全開加速度に対する比、0..1)からサイズを決める
    const ratio = maxAccel > 0 ? Math.min(1, mag / maxAccel) : 0;
    const flick = 0.8 + 0.2 * Math.random();
    const sc = (1.5 + 2.5 * ratio) * flick * plumeScale;
    const camQuat = camera.activeCamera.quaternion;
    // 推力方向の逆側にコア・アウターを置く
    const offsetCore = -3.4 * plumeScale;
    const offsetOuter = -5.6 * plumeScale;
    this.core.sync(fo.RtoThreeV3(addScaled(playerPos, d, offsetCore)), sc * 1.6, 0.85 * flick, camQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(playerPos, d, offsetOuter)), sc * 3.6, 0.32 * flick, camQuat);
  }

  // core/outer ビルボードを scene から取り除き解放する。
  dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh);
    this.core.dispose();
    this.outer.dispose();
  }
}
