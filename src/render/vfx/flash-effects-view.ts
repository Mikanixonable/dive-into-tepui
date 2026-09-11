// 一時エフェクト(閃光・ガスパフ)の表示資源。どの見え方の閃光かという種別の語彙と1件ぶんの
// 表示入力を定め、種別ごとの色・大きさ・明るさを持つ。そのフレームに生きているエフェクトの列を、
// カメラ正対のビルボード群として1本のインスタンスメッシュへ積む。
import * as THREE from 'three/webgpu';
import { flashResources } from '../billboard';
import { InstancedPool } from '../instanced-pool';
import type { CameraFrame } from '../camera/camera-frame';
import type { KinematicState } from '../../physics/kinematic-state';

// フラッシュの種別。どの出来事を示す閃光かを表し、見え方はこれで決まる。
export type FlashKind =
  | 'bulletImpact'
  | 'plasmaImpact'
  | 'muzzle'
  | 'destroy1'
  | 'destroy2'
  | 'gasPuff1'
  | 'gasPuff2'
  | 'proteinCritical'
  | 'proteinDissociated'
  | 'proteinDamaged';

// このフレームに描く一時エフェクト1件。
export interface FlashEffect {
  readonly kind: FlashKind;
  // 発生位置・発生源速度と、その位置が表す時刻。
  readonly state: KinematicState;
  readonly age: number; // 発生からの経過 [s]
  readonly duration: number; // 消えるまでの寿命 [s]
  readonly sizeScale: number; // 見た目の大きさに掛かる倍率
}

const ZOOM_DIM_SCALE = 0.02; // ガンサイトズーム中に減光する種別の最大不透明度倍率(完全には消さない)

const MAX_FLASHES = 128; // 1フレームに描けるフラッシュ(発砲・命中・撃破・ガス)の枠数

// 種別1つぶんの見え方。板の一辺は発生直後の size0 から寿命末の size1 まで広がる。
interface FlashAppearance {
  readonly color: string | number;
  readonly size0: number; // 発生直後の一辺 [m]
  readonly size1: number; // 寿命末の一辺 [m]
  readonly peakBrightness: number; // 発生直後の最大の明るさ倍率
  readonly dimsInGunsight: boolean; // ガンサイトズーム中に減光するか
}

// タンパク質の状態遷移フラッシュの大きさ [m] と明るさ。危篤・解離・それ以外の損傷で共通にし、色だけで分ける。
const PROTEIN_STATE_FLASH_SIZE0 = 2.5;
const PROTEIN_STATE_FLASH_SIZE1 = 13;
const PROTEIN_STATE_FLASH_BRIGHTNESS = 0.9;

// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const FLASH_APPEARANCE: Record<FlashKind, FlashAppearance> = {
  bulletImpact: { color: '#ffe2a0', size0: 1.5, size1: 6, peakBrightness: 1, dimsInGunsight: false },
  plasmaImpact: { color: '#ffa0ff', size0: 2, size1: 8, peakBrightness: 1, dimsInGunsight: false },
  muzzle: { color: '#fff0b8', size0: 2.2, size1: 6, peakBrightness: 1, dimsInGunsight: true },
  // 撃破の芯(1)と外殻(2)の2枚。
  destroy1: { color: '#ffb36b', size0: 10, size1: 110, peakBrightness: 1, dimsInGunsight: false },
  destroy2: { color: '#fffbe8', size0: 6, size1: 40, peakBrightness: 1, dimsInGunsight: false },
  // ガスの放出。薄く広がる灰色の板を2枚重ねて気体らしさを出す。
  gasPuff1: { color: '#aaaaaa', size0: 1.0, size1: 8.0, peakBrightness: 0.3, dimsInGunsight: false },
  gasPuff2: { color: '#ffffff', size0: 0.5, size1: 6.0, peakBrightness: 0.4, dimsInGunsight: false },
  proteinCritical: {
    color: 0xff3d88, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
  proteinDissociated: {
    color: 0xa76dff, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
  proteinDamaged: {
    color: 0x59e7ff, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
};

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

  // 渡された列を、各件の位置・寿命の進み・カメラ向きへ同期して積む。camera が照準ズーム中の
  // フレームでは、それで減光する種別だけが暗くなる。
  public sync(effects: readonly FlashEffect[], camera: CameraFrame): void {
    this.pool.beginFrame();
    const cameraQuat = camera.camera.quaternion;
    for (const fx of effects) {
      const appearance = FLASH_APPEARANCE[fx.kind];
      // 寿命の進み 0..1 が、板の広がりと明るさの減衰の両方を決める。
      const t = fx.age / fx.duration;
      const size0 = appearance.size0 * fx.sizeScale;
      const size1 = appearance.size1 * fx.sizeScale;
      const size = size0 + (size1 - size0) * Math.sqrt(t);
      const zoomScale = camera.zoomed && appearance.dimsInGunsight ? ZOOM_DIM_SCALE : 1;
      const brightness = appearance.peakBrightness * (1 - t) * zoomScale;
      this.transform.position.copy(camera.floatingOrigin.RtoThreeV3(fx.state.r));
      this.transform.scale.setScalar(size);
      this.transform.quaternion.copy(cameraQuat);
      // 加算合成なので、明るさ(寿命による減衰を含む)は色に載せ、不透明度は 1 のままにする。
      this.color.set(appearance.color).multiplyScalar(brightness);
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
