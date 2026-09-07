// 爆発・マズルフラッシュなどの一時エフェクト。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { addScaled } from '../../math/vec3';
import { flashResources } from '../../render/billboard';
import { InstancedPool } from '../../render/instanced-pool';
import { FloatingOrigin } from '../camera/floating-origin';

const ZOOM_MUZZLE_FLASH_SCALE = 0.02; // ズーム中のマズルフラッシュ最大不透明度倍率(完全には消さない)

const MAX_FLASHES = 128; // 同時に存在しうるフラッシュ(発砲・命中・撃破・ガス)の上限。超過分は描画されない

// 生存中のフラッシュ1件を InstancedPool へ積むための姿勢と色の置き場所。
const scratchTransform = new THREE.Object3D();
const scratchColor = new THREE.Color();

// 一時エフェクト1件。軌道速度で流れて見えないよう、時刻つきの state を持ち、発生源の
// 速度で現在の simTime まで移流させる。
export interface FlashEffect {
  readonly baseColor: string | number;
  state: KinematicState;
  age: number;
  readonly duration: number;
  readonly size0: number;
  readonly size1: number;
  readonly peakBrightness: number; // 発生直後の最大の明るさ倍率
  readonly dimsInGunsight: boolean; // ガンサイトズーム中に減光するか
}

export class FlashEffectManager {
  private effects: FlashEffect[] = [];
  private readonly pool: InstancedPool;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;

  // フラッシュ用のインスタンス群を scene へ1つ置く。
  constructor(scene: THREE.Scene) {
    const { geometry, material } = flashResources();
    this.geometry = geometry;
    this.material = material;
    // Billboard の既定 renderOrder(5)に合わせる。
    this.pool = new InstancedPool(scene, geometry, material, MAX_FLASHES, true, 5);
  }

  // フラッシュエフェクトを追加する。
  addFlash(fx: FlashEffect): void {
    this.effects.push(fx);
  }

  // 経過時間を進めて各エフェクトを simTime まで移流させ、寿命切れのものを破棄する。
  updateFlashEffects(dt: number, simTime: number): void {
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) return false;
      const s = fx.state;
      fx.state = kinematicState<'eci'>(simTime, addScaled(s.r, s.v, simTime - s.t), s.v);
      return true;
    });
  }

  // 生存中のフラッシュを現在の位置・寿命進捗・カメラ向きへ同期し、InstancedPool へ積む。
  // zoomActive はガンサイトズーム中かどうか(dimsInGunsight なフラッシュだけ減光する)。
  syncFlashEffects(fo: FloatingOrigin, activeCamera: THREE.Camera, zoomActive: boolean): void {
    this.pool.beginFrame();
    const camQuat = activeCamera.quaternion;
    for (const fx of this.effects) {
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const zoomScale = zoomActive && fx.dimsInGunsight ? ZOOM_MUZZLE_FLASH_SCALE : 1;
      const brightness = fx.peakBrightness * (1 - t) * zoomScale;
      scratchTransform.position.copy(fo.RtoThreeV3(fx.state.r));
      scratchTransform.scale.setScalar(size);
      scratchTransform.quaternion.copy(camQuat);
      // **明るさは色に載せ、不透明度は 1 のままにする**(render/billboard.ts と同じ規約)。
      // 加算ブレンドでは 最終色 = テクスチャ × material.color × instanceColor なので、
      // 寿命による減衰も instanceColor 一本へ畳める。
      scratchColor.set(fx.baseColor).multiplyScalar(brightness);
      this.pool.push(scratchTransform, scratchColor);
    }
    this.pool.endFrame();
  }

  // flashResources() が個体ごとに新規生成する geometry/material を、プールと共に破棄する。
  dispose(): void {
    this.pool.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.effects.length = 0;
  }
}
