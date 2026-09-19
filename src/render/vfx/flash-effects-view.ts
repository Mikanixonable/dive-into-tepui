// 一時エフェクト(閃光・ガスパフ)の表示資源。1件ぶんの見え方の宣言を定め、そのフレームに生きている
// エフェクトの列を、カメラ正対のビルボード群として1本のインスタンスメッシュへ積む。
import * as THREE from 'three/webgpu';
import { flashResources } from '../billboard';
import { InstancedPool } from '../instanced-pool';
import type { CameraFrame } from '../camera/camera-frame';
import type { KinematicState } from '../../physics/kinematic-state';

// このフレームに描く一時エフェクト1件の見え方。板の一辺は発生直後の size0 から寿命末の size1 [m] まで
// 広がり、明るさは発生直後の brightness から寿命末の 0 まで減る。
export interface FlashEffect {
  // 発生位置・発生源速度と、その位置が表す時刻。
  readonly state: KinematicState;
  readonly age: number; // 発生からの経過 [s]
  readonly duration: number; // 消えるまでの寿命 [s]
  readonly color: string | number;
  readonly size0: number;
  readonly size1: number;
  readonly brightness: number;
}

const MAX_FLASHES = 128; // 1フレームに描けるフラッシュ(発砲・命中・撃破・ガス)の枠数

export class FlashEffectsView {
  private readonly pool: InstancedPool;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  // 1件を InstancedPool へ積むための姿勢と色の置き場所。
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();

  // フラッシュ用のインスタンス群を scene へ1つ置く。
  public constructor(scene: THREE.Scene) {
    const { geometry, material } = flashResources();
    this.geometry = geometry;
    this.material = material;
    // Billboard の既定 renderOrder(5)に合わせる。
    this.pool = new InstancedPool(scene, geometry, material, MAX_FLASHES, true, 5);
  }

  // 渡された列を、各件の位置・寿命の進み・カメラ向きへ同期して積む。
  public sync(effects: readonly FlashEffect[], camera: CameraFrame): void {
    this.pool.beginFrame();
    const cameraQuat = camera.camera.quaternion;
    for (const fx of effects) {
      // 寿命の進み 0..1 が、板の広がりと明るさの減衰の両方を決める。
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      this.transform.position.copy(camera.floatingOrigin.RtoThreeV3(fx.state.r));
      this.transform.scale.setScalar(size);
      this.transform.quaternion.copy(cameraQuat);
      // 加算合成なので、明るさ(寿命による減衰を含む)は色に載せ、不透明度は 1 のままにする。
      this.color.set(fx.color).multiplyScalar(fx.brightness * (1 - t));
      this.pool.push(this.transform, this.color);
    }
    this.pool.endFrame();
  }

  // プールと、このインスタンス用に作った geometry/material を破棄する。
  public dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
