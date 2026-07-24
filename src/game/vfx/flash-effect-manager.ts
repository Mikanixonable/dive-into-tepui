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
  muzzle?: boolean; // マズルフラッシュのみ true。ズームウィンドウ(PIP)描画時はこれだけを非表示にする
}

export class FlashEffectManager {
  effects: FlashEffect[] = [];

  constructor(private readonly _scene: THREE.Scene) {}

  addFlash(fx: FlashEffect): void {
    this.effects.push(fx);
    this._scene.add(fx.billboard.mesh);
  }

  syncFlashEffects(
    dt: number,
    simDt: number,
    fo: FloatingOrigin,
    activeCamera: THREE.PerspectiveCamera,
  ): void {
    const camQuat = activeCamera.quaternion;
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) {
        this._scene.remove(fx.billboard.mesh);
        fx.billboard.dispose();
        return false;
      }
      fx.pos = addScaled(fx.pos, fx.vel, simDt);
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      const opacity = fx.peakOpacity * (1 - t);
      fx.billboard.sync(fo.RtoThreeV3(fx.pos), size, opacity, camQuat);
      return true;
    });
  }

  // ズームウィンドウ(PIP)描画中、マズルフラッシュを非表示にする(pip-renderer.ts から
  // playerShipObj.visible=false と同じタイミングで呼ばれる)。this.effects には被弾スパーク・
  // 撃破爆発のフラッシュも入っているため、muzzle フラグ付きのものだけを切り替える
  // (ズーム中でも敵側の命中・爆発の閃光は照準フィードバックとして見せたい)。
  setMuzzleFlashesVisible(v: boolean): void {
    for (const fx of this.effects) if (fx.muzzle) fx.billboard.mesh.visible = v;
  }
}