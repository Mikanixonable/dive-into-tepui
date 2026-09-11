// マヌーバ噴射プルーム: 推力方向の逆側に置く発光ビルボード 2 枚(コア+アウター)+ エンジン音。
import * as THREE from 'three/webgpu';
import { Vec3, addScaled, len, scale } from '../../../math/vec3';
import { mulberry32 } from '../../../math/random';
import { Billboard } from '../../billboard';
import { SchematicThrustCone } from '../../schematic-thrust-cone';
import { FloatingOrigin } from '../../camera/floating-origin';
import { plumeNoiseSeed } from './plume-noise';
import type { RenderStyle } from '../../render-style';

const THRUST_PLUME_CORE_COLOR = 0xaee6ff;
const THRUST_PLUME_OUTER_COLOR = 0x4f9fff;
// 出力比 0..1 に対するプルームの基準サイズ [m]。
const THRUST_PLUME_SIZE_MIN = 1.5;
const THRUST_PLUME_SIZE_SPAN = 2.5;
// 基準サイズに対するコア・アウターの倍率と、機体からノズル方向へのずらし量 [m]。
const THRUST_PLUME_CORE_SIZE_RATIO = 1.6;
const THRUST_PLUME_OUTER_SIZE_RATIO = 3.6;
const THRUST_PLUME_CORE_OFFSET = -3.4;
const THRUST_PLUME_OUTER_OFFSET = -5.6;
// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const THRUST_PLUME_CORE_BRIGHTNESS = 0.85;
const THRUST_PLUME_OUTER_BRIGHTNESS = 0.32;

// 本体の噴射口は1つなので、揺らぎの種はこの番号で引く。
const MAIN_NOZZLE_INDEX = 0;

export class ThrustEffects {
  private readonly core = new Billboard(THRUST_PLUME_CORE_COLOR);
  private readonly outer = new Billboard(THRUST_PLUME_OUTER_COLOR);
  private readonly schematicCone = new SchematicThrustCone();

  // core/outer ビルボードと模式図用コーンを scene に登録する。ownerId は明滅の種に混ぜる
  // 個体の識別。
  constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
  ) {
    scene.add(this.core.mesh, this.outer.mesh, this.schematicCone.mesh);
  }

  // 噴射プルームを thrust(今フレームの推力ベクトル、非噴射時は null)へ同期する。position は
  // 噴射口を置く ECI 位置で、表示時刻の状態を引けないフレームは null。maxAccel は出力比
  // (プルームの大きさ)を求めるための全開加速度。displayTime は明滅の位相を決める表示時刻で、
  // 同じ時刻に何度呼んでも同じ絵になる。style が模式図なら、ビルボードの代わりに輪郭抽出へ
  // 拾われるコーンを出す。
  sync(
    fo: FloatingOrigin, position: Vec3 | null, thrust: Vec3 | null, maxAccel: number,
    visible: boolean, cameraQuat: THREE.Quaternion, zoomActive: boolean,
    style: RenderStyle, displayTime: number, plumeScale = 1.0,
  ): void {
    if (thrust === null || position === null || !visible || zoomActive) {
      this.core.hide();
      this.outer.hide();
      this.schematicCone.hide();
      return;
    }
    const mag = len(thrust);
    const d = mag > 0 ? scale(thrust, 1 / mag) : thrust;
    // 出力比(全開加速度に対する比、0..1)からサイズを決める
    const ratio = maxAccel > 0 ? Math.min(1, mag / maxAccel) : 0;

    if (style === 'schematic') {
      this.core.hide();
      this.outer.hide();
      const backward = new THREE.Vector3(-d.x, -d.y, -d.z);
      this.schematicCone.sync(fo.RtoThreeV3(position), backward, ratio, plumeScale);
      return;
    }
    this.schematicCone.hide();

    const noise = mulberry32(plumeNoiseSeed(this.ownerId, displayTime, MAIN_NOZZLE_INDEX));
    const flick = 0.8 + 0.2 * noise();
    const sc = (THRUST_PLUME_SIZE_MIN + THRUST_PLUME_SIZE_SPAN * ratio) * flick * plumeScale;
    // 推力方向の逆側にコア・アウターを置く
    const offsetCore = THRUST_PLUME_CORE_OFFSET * plumeScale;
    const offsetOuter = THRUST_PLUME_OUTER_OFFSET * plumeScale;
    this.core.sync(fo.RtoThreeV3(addScaled(position, d, offsetCore)),
      sc * THRUST_PLUME_CORE_SIZE_RATIO, THRUST_PLUME_CORE_BRIGHTNESS * flick, cameraQuat);
    this.outer.sync(fo.RtoThreeV3(addScaled(position, d, offsetOuter)),
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
