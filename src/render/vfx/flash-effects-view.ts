// 一時エフェクト(閃光・ガスパフ・黒煙)の表示資源。1件ぶんの見え方の宣言を定め、そのフレームに生きている
// エフェクトの列を、カメラ正対のビルボード群として合成方式ごとのインスタンスメッシュへ積む。
import * as THREE from 'three/webgpu';
import { flashResources, smokeResources } from '../billboard';
import { InstancedPool } from '../instanced-pool';
import type { CameraFrame } from '../camera/camera-frame';
import type { KinematicState } from '../../physics/kinematic-state';

// 合成の方式。additive は発光(閃光・ガス)、smoke は通常合成の暗い塊(黒煙)。
export type FlashBlend = 'additive' | 'smoke';

// このフレームに描く一時エフェクト1件の見え方。板の一辺は発生直後の size0 から寿命末の size1 [m] まで
// 広がり、明るさは発生直後の brightness から寿命末の 0 まで減る。smoke は明るさで減らず、寿命の終わりに縮んで消える。
export interface FlashEffect {
  // 発生位置・発生源速度と、その位置が表す時刻。
  readonly state: KinematicState;
  readonly age: number; // 発生からの経過 [s]
  readonly duration: number; // 消えるまでの寿命 [s]
  readonly color: string | number;
  readonly size0: number;
  readonly size1: number;
  readonly brightness: number;
  readonly blend: FlashBlend;
}

const MAX_FLASHES = 128; // 1フレームに描けるフラッシュ(発砲・命中・撃破・ガス)の枠数
const MAX_SMOKE = 32; // 1フレームに描ける黒煙の枠数

// 寿命の終わり側で黒煙が縮みきる区間の始まり(寿命に対する比)。
const SMOKE_CONVERGE_START = 0.6;

// 寿命に対する比 t(0..1)から、黒煙の縮み具合(1..0)を出す。
function smokeConvergence(t: number): number {
  const u = Math.min(1, Math.max(0, (t - SMOKE_CONVERGE_START) / (1 - SMOKE_CONVERGE_START)));
  return 1 - u * u * (3 - 2 * u);
}

export class FlashEffectsView {
  private readonly pool: InstancedPool;
  private readonly smokePool: InstancedPool;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly smokeGeometry: THREE.BufferGeometry;
  private readonly smokeMaterial: THREE.Material;
  // 1件を InstancedPool へ積むための姿勢と色の置き場所。
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();

  // フラッシュ用と黒煙用のインスタンス群を scene へそれぞれ1つ置く。
  public constructor(scene: THREE.Scene) {
    const flash = flashResources();
    this.geometry = flash.geometry;
    this.material = flash.material;
    // Billboard の既定 renderOrder(5)に合わせる。
    this.pool = new InstancedPool(scene, this.geometry, this.material, MAX_FLASHES, true, 5);
    const smoke = smokeResources();
    this.smokeGeometry = smoke.geometry;
    this.smokeMaterial = smoke.material;
    this.smokePool = new InstancedPool(scene, this.smokeGeometry, this.smokeMaterial, MAX_SMOKE, true, 5);
  }

  // 渡された列を、各件の位置・寿命の進み・カメラ向きへ同期して積む。
  public sync(effects: readonly FlashEffect[], camera: CameraFrame): void {
    this.pool.beginFrame();
    this.smokePool.beginFrame();
    const cameraQuat = camera.camera.quaternion;
    for (const fx of effects) {
      // 寿命の進み 0..1 が、板の広がりと明るさの減衰の両方を決める。
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      this.transform.position.copy(camera.floatingOrigin.RtoThreeV3(fx.state.r));
      this.transform.quaternion.copy(cameraQuat);
      if (fx.blend === 'smoke') {
        this.transform.scale.setScalar(size * smokeConvergence(t));
        this.color.set(fx.color).multiplyScalar(fx.brightness);
        this.smokePool.push(this.transform, this.color);
        continue;
      }
      this.transform.scale.setScalar(size);
      // 加算合成なので、明るさ(寿命による減衰を含む)は色に載せ、不透明度は 1 のままにする。
      this.color.set(fx.color).multiplyScalar(fx.brightness * (1 - t));
      this.pool.push(this.transform, this.color);
    }
    this.pool.endFrame();
    this.smokePool.endFrame();
  }

  // プールと、このインスタンス用に作った geometry/material を破棄する。
  public dispose(): void {
    this.pool.dispose();
    this.smokePool.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.smokeGeometry.dispose();
    this.smokeMaterial.dispose();
  }
}
