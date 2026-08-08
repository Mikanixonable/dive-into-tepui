// 爆発・マズルフラッシュなどの一時エフェクト。
import * as THREE from "three/webgpu";
import { OrbitState, orbitState } from "../../physics/orbital-state";
import { addScaled } from "../../physics/vec3";
import { Billboard } from "../../render/billboard";
import { FloatingOrigin } from "../floating-origin";

// 軌道速度で流れないよう、発生源の速度で移流させる。位置は時刻つきの state として
// 持ち、その時刻から現在の simTime までを毎フレーム移流させる。
export interface FlashEffect {
  billboard: Billboard;
  state: OrbitState;
  age: number;
  duration: number;
  size0: number;
  size1: number;
  peakOpacity: number; // 発生直後の最大不透明度倍率(ズーム中のマズルフラッシュ減光などに使う)
}

export class FlashEffectManager {
  effects: FlashEffect[] = [];

  constructor(private readonly _scene: THREE.Scene) {}

  // フラッシュエフェクトを追加し、そのビルボードメッシュをシーンへ登録する。
  addFlash(fx: FlashEffect): void {
    this.effects.push(fx);
    this._scene.add(fx.billboard.mesh);
  }

  // 経過時間を進めて各エフェクトを simTime まで移流させ、寿命切れのものを破棄する。
  updateFlashEffects(dt: number, simTime: number): void {
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      // 寿命切れなら破棄する
      if (fx.age >= fx.duration) {
        this._scene.remove(fx.billboard.mesh);
        fx.billboard.dispose();
        return false;
      }
      const s = fx.state;
      fx.state = orbitState(simTime, addScaled(s.r, s.v, simTime - s.t), s.v);
      return true;
    });
  }

  // 生存中のビルボードを現在の位置・寿命進捗・カメラ向きへ同期する。
  syncFlashEffects(fo: FloatingOrigin, activeCamera: THREE.PerspectiveCamera): void {
    const camQuat = activeCamera.quaternion;
    for (const fx of this.effects) {
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const opacity = fx.peakOpacity * (1 - t);
      fx.billboard.sync(fo.RtoThreeV3(fx.state.r), size, opacity, camQuat);
    }
  }

}
