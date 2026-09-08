// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)+ エンジン音。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, len, scale } from '../../math/vec3';
import { Billboard } from '../../render/billboard';
import {
  THRUST_PLUME_CORE_BRIGHTNESS, THRUST_PLUME_CORE_COLOR, THRUST_PLUME_CORE_OFFSET,
  THRUST_PLUME_CORE_SIZE_RATIO, THRUST_PLUME_OUTER_BRIGHTNESS, THRUST_PLUME_OUTER_COLOR,
  THRUST_PLUME_OUTER_OFFSET, THRUST_PLUME_OUTER_SIZE_RATIO, THRUST_PLUME_SIZE_MIN,
  THRUST_PLUME_SIZE_SPAN,
} from '../../render/vfx-style';
import { SchematicThrustCone } from '../../render/schematic-thrust-cone';
import { FloatingOrigin } from '../camera/floating-origin';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import type { RenderStyle } from '../../render/render-style';

export class ThrustEffects {
  private readonly core = new Billboard(THRUST_PLUME_CORE_COLOR);
  private readonly outer = new Billboard(THRUST_PLUME_OUTER_COLOR);
  private readonly schematicCone = new SchematicThrustCone();

  // core/outer ビルボードと模式図用コーンを scene に登録する。
  constructor(
    scene: THREE.Scene,
    private readonly _worldSfx: WorldSfx,
  ) {
    scene.add(this.core.mesh, this.outer.mesh, this.schematicCone.mesh);
  }

  // 噴射プルーム・エンジン音を thrust(今フレームの推力ベクトル、非噴射時は null)に合わせて
  // 同期する。maxAccel は出力比(プルームの大きさ)を求めるための全開加速度。style が模式図
  // なら、ビルボードの代わりに輪郭抽出へ拾われるコーンを出す。visible=false のときは
  // どちらも隠し、audible=false のときは共有のエンジン音へ触れない。
  sync(
    fo: FloatingOrigin, playerPos: Vec3, thrust: Vec3 | null, maxAccel: number,
    visible: boolean, audible: boolean, cameraQuat: THREE.Quaternion, zoomActive: boolean,
    style: RenderStyle, plumeScale = 1.0,
  ): void {
    const firing = thrust !== null && visible;
    if (audible) this._worldSfx.setThrust(firing);

    if (!firing || zoomActive) {
      this.core.hide();
      this.outer.hide();
      this.schematicCone.hide();
      return;
    }
    const mag = len(thrust!);
    const d = mag > 0 ? scale(thrust!, 1 / mag) : thrust!;
    // 出力比(全開加速度に対する比、0..1)からサイズを決める
    const ratio = maxAccel > 0 ? Math.min(1, mag / maxAccel) : 0;

    if (style === 'schematic') {
      this.core.hide();
      this.outer.hide();
      const backward = new THREE.Vector3(-d.x, -d.y, -d.z);
      this.schematicCone.sync(fo.RtoThreeV3(playerPos), backward, ratio, plumeScale);
      return;
    }
    this.schematicCone.hide();

    const flick = 0.8 + 0.2 * Math.random();
    const sc = (THRUST_PLUME_SIZE_MIN + THRUST_PLUME_SIZE_SPAN * ratio) * flick * plumeScale;
    // 推力方向の逆側にコア・アウターを置く
    const offsetCore = THRUST_PLUME_CORE_OFFSET * plumeScale;
    const offsetOuter = THRUST_PLUME_OUTER_OFFSET * plumeScale;
    this.core.sync(fo.RtoThreeV3(addScaled(playerPos, d, offsetCore)),
      sc * THRUST_PLUME_CORE_SIZE_RATIO, THRUST_PLUME_CORE_BRIGHTNESS * flick, cameraQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(playerPos, d, offsetOuter)),
      sc * THRUST_PLUME_OUTER_SIZE_RATIO, THRUST_PLUME_OUTER_BRIGHTNESS * flick, cameraQuat);
  }

  // core/outer ビルボードと模式図用コーンを scene から取り除き解放する。
  dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh, this.schematicCone.mesh);
    this.core.dispose();
    this.outer.dispose();
    this.schematicCone.dispose();
  }
}
