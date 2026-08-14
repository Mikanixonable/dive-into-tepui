// 爆発・マズルフラッシュなどの一時エフェクト。
import * as THREE from "three/webgpu";
import { KinematicState, kinematicState } from "../../physics/kinematic-state";
import { addScaled } from "../../physics/vec3";
import { flashResources } from "../../render/billboard";
import { InstancedPool } from "../../render/instanced-pool";
import { FloatingOrigin } from "../floating-origin";
import * as C from "../const";

// 軌道速度で流れないよう、発生源の速度で移流させる。位置は時刻つきの state として
// 持ち、その時刻から現在の simTime までを毎フレーム移流させる。transform は
// InstancedPool へ push するための姿勢の置き場所であり、描画資源は持たない。
export interface FlashEffect {
  transform: THREE.Object3D;
  baseColor: THREE.Color;
  color: THREE.Color;
  state: KinematicState;
  age: number;
  duration: number;
  size0: number;
  size1: number;
  peakOpacity: number; // 発生直後の最大不透明度倍率
  dimsInGunsight: boolean; // ガンサイトズーム中に減光するか
}

export class FlashEffectManager {
  effects: FlashEffect[] = [];
  private readonly pool: InstancedPool;

  constructor(scene: THREE.Scene) {
    const { geometry, material } = flashResources();
    // Billboard の既定 renderOrder(5)に合わせる。
    this.pool = new InstancedPool(scene, geometry, material, C.MAX_FLASHES, true, 5);
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
      fx.state = kinematicState(simTime, addScaled(s.r, s.v, simTime - s.t), s.v);
      return true;
    });
  }

  // 生存中のフラッシュを現在の位置・寿命進捗・カメラ向きへ同期し、InstancedPool へ積む。
  // zoomActive はガンサイトズーム中かどうか(dimsInGunsight なフラッシュだけ減光する)。
  syncFlashEffects(fo: FloatingOrigin, activeCamera: THREE.PerspectiveCamera, zoomActive: boolean): void {
    this.pool.beginFrame();
    const camQuat = activeCamera.quaternion;
    for (const fx of this.effects) {
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const zoomScale = zoomActive && fx.dimsInGunsight ? C.ZOOM_MUZZLE_FLASH_SCALE : 1;
      const opacity = fx.peakOpacity * (1 - t) * zoomScale;
      fx.transform.position.copy(fo.RtoThreeV3(fx.state.r));
      fx.transform.scale.setScalar(size);
      fx.transform.quaternion.copy(camQuat);
      // 加算ブレンドでは 最終色 = テクスチャ × material.color × instanceColor なので、
      // 色×不透明度を instanceColor 一本に畳めば不透明度を個別に持つのと数学的に等価になる。
      fx.color.copy(fx.baseColor).multiplyScalar(opacity);
      this.pool.push(fx.transform, fx.color);
    }
    this.pool.endFrame();
  }
}
