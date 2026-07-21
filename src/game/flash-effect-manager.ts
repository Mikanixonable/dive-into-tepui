// 爆発・マズルフラッシュなどの一時エフェクト。
import * as THREE from "three/webgpu";
import { Vec3, addScaled } from "../physics/vec3";

// 軌道速度で流れないよう、発生源の速度で移流させる。
export interface FlashEffect {
  mesh: THREE.Mesh;
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
    this._scene.add(fx.mesh);
  }

  updateFlashEffects(
    dt: number,
    simDt: number,
    origin: Vec3,
    activeCamera: THREE.PerspectiveCamera,
  ): void {
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) {
        this._scene.remove(fx.mesh);
        (fx.mesh.material as THREE.Material).dispose();
        fx.mesh.geometry.dispose();
        return false;
      }
      fx.pos = addScaled(fx.pos, fx.vel, simDt);
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      fx.mesh.position.set(fx.pos.x - origin.x, fx.pos.y - origin.y, fx.pos.z - origin.z);
      fx.mesh.scale.setScalar(size);
      fx.mesh.quaternion.copy(activeCamera.quaternion);
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = fx.peakOpacity * (1 - t);
      return true;
    });
  }

  
  // ズームウィンドウ(PIP)描画中、マズルフラッシュを非表示にする(pip-renderer.ts から
  // playerShipObj.visible=false と同じタイミングで呼ばれる)。this.effects には被弾スパーク・
  // 撃破爆発のフラッシュも入っているため、muzzle フラグ付きのものだけを切り替える
  // (ズーム中でも敵側の命中・爆発の閃光は照準フィードバックとして見せたい)。
  setMuzzleFlashesVisible(v: boolean): void {
    for (const fx of this.effects) if (fx.muzzle) fx.mesh.visible = v;
  }
}