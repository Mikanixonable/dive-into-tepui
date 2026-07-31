// 爆発・マズルフラッシュなどの一時エフェクト。
import * as THREE from "three/webgpu";
import { Vec3, addScaled } from "../../physics/vec3";
import { Billboard } from "../../render/billboard";
import { FloatingOrigin } from "../floating-origin";

// 軌道速度で流れないよう、発生源の速度で移流させる。
export interface FlashEffect {
  billboard: Billboard;
  pos: Vec3;
  vel: Vec3;
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

  // 経過時間を進め、寿命切れのエフェクトを破棄しつつ生存中のものをカメラへ同期する。
  syncFlashEffects(
    dt: number,
    simDt: number,
    fo: FloatingOrigin,
    activeCamera: THREE.PerspectiveCamera,
  ): void {
    const camQuat = activeCamera.quaternion;
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      // 寿命切れなら破棄する
      if (fx.age >= fx.duration) {
        this._scene.remove(fx.billboard.mesh);
        fx.billboard.dispose();
        return false;
      }
      // 位置・サイズ・不透明度を経過時間に応じて更新する
      fx.pos = addScaled(fx.pos, fx.vel, simDt);
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const opacity = fx.peakOpacity * (1 - t);
      fx.billboard.sync(fo.RtoThreeV3(fx.pos), size, opacity, camQuat);
      return true;
    });
  }

}