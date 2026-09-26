// 1基の噴射口のプルーム: ノズル出口から排気方向へ置く発光ビルボード 2 枚(コア+アウター)と、模式図用のコーン。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { Billboard } from '../../billboard';
import { SchematicThrustCone } from '../../schematic-thrust-cone';
import { plumeNoiseSeed } from './plume-noise';
import type { RenderStyle } from '../../render-style';

const THRUST_PLUME_CORE_COLOR = 0xaee6ff;
const THRUST_PLUME_OUTER_COLOR = 0x4f9fff;
// 出力比 0..1 に対するプルームの基準サイズ [m]。
const THRUST_PLUME_SIZE_MIN = 1.5;
const THRUST_PLUME_SIZE_SPAN = 2.5;
// 基準サイズに対するコア・アウターの倍率と、ノズル出口から排気方向へのずらし量 [m]。
const THRUST_PLUME_CORE_SIZE_RATIO = 1.6;
const THRUST_PLUME_OUTER_SIZE_RATIO = 3.6;
const THRUST_PLUME_CORE_OFFSET = 2.1;
const THRUST_PLUME_OUTER_OFFSET = 4.3;
// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const THRUST_PLUME_CORE_BRIGHTNESS = 0.85;
const THRUST_PLUME_OUTER_BRIGHTNESS = 0.32;

export class ThrustEffects {
  private readonly core = new Billboard(THRUST_PLUME_CORE_COLOR);
  private readonly outer = new Billboard(THRUST_PLUME_OUTER_COLOR);
  private readonly schematicCone = new SchematicThrustCone();

  // core/outer ビルボードと模式図用コーンを scene に登録する。ownerId と nozzleIndex は明滅の種に混ぜる
  // 個体と噴射口の識別。
  public constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
    private readonly nozzleIndex = 0,
  ) {
    scene.add(this.core.mesh, this.outer.mesh, this.schematicCone.mesh);
  }

  // 噴射口 anchor(+Z が排気方向。ship root の world matrix 更新後に渡す)から出力比 ratio(0..1)の
  // プルームを出す。ratio が 0 なら隠す。displayTime が明滅の位相を決め、同じ時刻には同じ絵になる。
  // 模式図ではコーンを出す。
  public syncFromAnchor(
    anchor: THREE.Object3D, ratio: number, visible: boolean, cameraQuat: THREE.Quaternion,
    zoomActive: boolean, style: RenderStyle, displayTime: number, plumeScale = 1.0,
  ): void {
    if (!(ratio > 0) || !visible || zoomActive) {
      this.hide();
      return;
    }
    const position = anchor.getWorldPosition(new THREE.Vector3());
    const exhaust = new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()));

    if (style === 'schematic') {
      this.core.hide();
      this.outer.hide();
      this.schematicCone.sync(position, exhaust, ratio, plumeScale);
      return;
    }
    this.schematicCone.hide();

    const noise = mulberry32(plumeNoiseSeed(this.ownerId, displayTime, this.nozzleIndex));
    const flick = 0.8 + 0.2 * noise();
    const sc = (THRUST_PLUME_SIZE_MIN + THRUST_PLUME_SIZE_SPAN * ratio) * flick * plumeScale;
    this.core.sync(position.clone().addScaledVector(exhaust, THRUST_PLUME_CORE_OFFSET * plumeScale),
      sc * THRUST_PLUME_CORE_SIZE_RATIO, THRUST_PLUME_CORE_BRIGHTNESS * flick, cameraQuat);
    this.outer.sync(position.clone().addScaledVector(exhaust, THRUST_PLUME_OUTER_OFFSET * plumeScale),
      sc * THRUST_PLUME_OUTER_SIZE_RATIO, THRUST_PLUME_OUTER_BRIGHTNESS * flick, cameraQuat);
  }

  // プルームとコーンを隠す。
  public hide(): void {
    this.core.hide();
    this.outer.hide();
    this.schematicCone.hide();
  }

  // core/outer ビルボードと模式図用コーンを scene から取り除き解放する。
  public dispose(scene: THREE.Scene): void {
    scene.remove(this.core.mesh, this.outer.mesh, this.schematicCone.mesh);
    this.core.dispose();
    this.outer.dispose();
    this.schematicCone.dispose();
  }
}
