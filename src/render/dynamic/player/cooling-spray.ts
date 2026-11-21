// 冷却ダンプのベント噴霧。流し中だけ船体のベント口から白い噴霧を出す。
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../../math/random';
import { Billboard } from '../../billboard';
import { plumeNoiseSeed } from './plume-noise';

const SPRAY_COLOR = 0xd8f0ff;
// ベント口から噴霧中心までの距離 [m]。
const SPRAY_OFFSET = 0.9;
const SPRAY_SIZE = 0.9;
const SPRAY_BRIGHTNESS = 0.55;
// ベント口の船体ローカル位置と噴出方向。機体下面寄りの側面から斜め外へ放出する。
const VENT_POSITION = new THREE.Vector3(0.9, -0.5, -0.8);
const VENT_DIRECTION = new THREE.Vector3(0.9, -0.6, -0.4).normalize();

export class CoolingSpray {
  private readonly mist = new Billboard(SPRAY_COLOR);
  private readonly anchor = new THREE.Object3D();

  // 噴霧のビルボードを scene へ、ベント口 anchor を shipRoot へ登録する。
  // ownerId は明滅の種に混ぜる個体の識別。
  public constructor(
    scene: THREE.Scene,
    private readonly ownerId: string,
    shipRoot: THREE.Object3D,
  ) {
    this.anchor.position.copy(VENT_POSITION);
    this.anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), VENT_DIRECTION);
    shipRoot.add(this.anchor);
    scene.add(this.mist.mesh);
  }

  // 流し中ならベント口から噴霧を出し、そうでなければ隠す。
  // ship root の world matrix 更新後に呼ぶ。
  public sync(
    active: boolean, visible: boolean, cameraQuat: THREE.Quaternion, zoomActive: boolean,
    displayTime: number,
  ): void {
    if (!active || !visible || zoomActive) {
      this.mist.hide();
      return;
    }
    const position = this.anchor.getWorldPosition(new THREE.Vector3());
    const exhaust = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.anchor.getWorldQuaternion(new THREE.Quaternion()));
    const flick = 0.7 + 0.3 * mulberry32(plumeNoiseSeed(this.ownerId, displayTime, 0))();
    this.mist.sync(
      position.addScaledVector(exhaust, SPRAY_OFFSET),
      SPRAY_SIZE * flick,
      SPRAY_BRIGHTNESS * flick,
      cameraQuat,
    );
  }

  // 噴霧とベント口 anchor を取り除き解放する。
  public dispose(scene: THREE.Scene): void {
    this.anchor.parent?.remove(this.anchor);
    scene.remove(this.mist.mesh);
    this.mist.dispose();
  }
}
