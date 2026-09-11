// 一時エフェクト(閃光・ガスパフ)の表示資源。種別ごとの色・大きさ・明るさを持ち、その
// フレームに生きているエフェクトの列を、カメラ正対のビルボード群として1本のインスタンス
// メッシュへ積む。
import * as THREE from 'three/webgpu';
import { flashResources } from '../billboard';
import { InstancedPool } from '../instanced-pool';
import {
  BULLET_IMPACT_FLASH_COLOR, BULLET_IMPACT_FLASH_SIZE0, BULLET_IMPACT_FLASH_SIZE1,
  DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1,
  DESTROY_FLASH_COLOR_1, DESTROY_FLASH_COLOR_2, GAS_PUFF1_BRIGHTNESS, GAS_PUFF1_SIZE0,
  GAS_PUFF1_SIZE1, GAS_PUFF2_BRIGHTNESS, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF_COLOR_1,
  GAS_PUFF_COLOR_2, MUZZLE_FLASH_COLOR, MUZZLE_FLASH_SIZE0, MUZZLE_FLASH_SIZE1,
  PLASMA_IMPACT_FLASH_COLOR, PLASMA_IMPACT_FLASH_SIZE0, PLASMA_IMPACT_FLASH_SIZE1,
  PROTEIN_CRITICAL_FLASH_COLOR, PROTEIN_DAMAGED_FLASH_COLOR, PROTEIN_DISSOCIATED_FLASH_COLOR,
  PROTEIN_STATE_FLASH_BRIGHTNESS, PROTEIN_STATE_FLASH_SIZE0, PROTEIN_STATE_FLASH_SIZE1,
} from '../vfx-style';
import type { FlashEffect, FlashKind } from '../../game/vfx/flash-effects';
import type { CameraFrame } from '../camera/camera-frame';

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

const FLASH_APPEARANCE: Record<FlashKind, FlashAppearance> = {
  bulletImpact: {
    color: BULLET_IMPACT_FLASH_COLOR, size0: BULLET_IMPACT_FLASH_SIZE0,
    size1: BULLET_IMPACT_FLASH_SIZE1, peakBrightness: 1, dimsInGunsight: false,
  },
  plasmaImpact: {
    color: PLASMA_IMPACT_FLASH_COLOR, size0: PLASMA_IMPACT_FLASH_SIZE0,
    size1: PLASMA_IMPACT_FLASH_SIZE1, peakBrightness: 1, dimsInGunsight: false,
  },
  muzzle: {
    color: MUZZLE_FLASH_COLOR, size0: MUZZLE_FLASH_SIZE0,
    size1: MUZZLE_FLASH_SIZE1, peakBrightness: 1, dimsInGunsight: true,
  },
  destroy1: {
    color: DESTROY_FLASH_COLOR_1, size0: DESTROY_FLASH1_SIZE0,
    size1: DESTROY_FLASH1_SIZE1, peakBrightness: 1, dimsInGunsight: false,
  },
  destroy2: {
    color: DESTROY_FLASH_COLOR_2, size0: DESTROY_FLASH2_SIZE0,
    size1: DESTROY_FLASH2_SIZE1, peakBrightness: 1, dimsInGunsight: false,
  },
  gasPuff1: {
    color: GAS_PUFF_COLOR_1, size0: GAS_PUFF1_SIZE0,
    size1: GAS_PUFF1_SIZE1, peakBrightness: GAS_PUFF1_BRIGHTNESS, dimsInGunsight: false,
  },
  gasPuff2: {
    color: GAS_PUFF_COLOR_2, size0: GAS_PUFF2_SIZE0,
    size1: GAS_PUFF2_SIZE1, peakBrightness: GAS_PUFF2_BRIGHTNESS, dimsInGunsight: false,
  },
  proteinCritical: {
    color: PROTEIN_CRITICAL_FLASH_COLOR, size0: PROTEIN_STATE_FLASH_SIZE0,
    size1: PROTEIN_STATE_FLASH_SIZE1, peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS,
    dimsInGunsight: true,
  },
  proteinDissociated: {
    color: PROTEIN_DISSOCIATED_FLASH_COLOR, size0: PROTEIN_STATE_FLASH_SIZE0,
    size1: PROTEIN_STATE_FLASH_SIZE1, peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS,
    dimsInGunsight: true,
  },
  proteinDamaged: {
    color: PROTEIN_DAMAGED_FLASH_COLOR, size0: PROTEIN_STATE_FLASH_SIZE0,
    size1: PROTEIN_STATE_FLASH_SIZE1, peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS,
    dimsInGunsight: true,
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
      // **明るさは色に載せ、不透明度は 1 のままにする**(render/billboard.ts と同じ規約)。
      // 加算ブレンドでは 最終色 = テクスチャ × material.color × instanceColor なので、
      // 寿命による減衰も instanceColor 一本へ畳める。
      this.color.set(appearance.color).multiplyScalar(brightness);
      this.pool.push(this.transform, this.color);
    }
    this.pool.endFrame();
  }

  // flashResources() が個体ごとに新規生成する geometry/material を、プールと共に破棄する。
  public dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
