import * as THREE from 'three/webgpu';
import { randomQuat } from '../physics/attitude';
import { add, addScaled, clone, randSym, randVec, v3, Vec3 } from '../physics/vec3';
import * as C from './const';
import { DebrisPiece } from './entities';
import { buildDebrisMesh, buildFlashMesh } from '../render/ships';

// 爆発・マズルフラッシュなどの一時エフェクト。
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

// フラッシュ・破片の発生に必要な最小の受け皿。呼び出し元(player-fire.ts / combat/hit.ts /
// combat.ts の destroyShip)が持つ scene・glowTex・effects 配列・debris 追加口をそのまま渡す。
export interface EffectsCtx {
  scene: THREE.Scene;
  glowTex: THREE.Texture;
  effects: FlashEffect[];
  addDebris(piece: DebrisPiece): void;
}

export function spawnFlash(
  ctx: EffectsCtx,
  pos: Vec3,
  vel: Vec3,
  size0: number,
  size1: number,
  duration: number,
  color: number,
  peakOpacity = 1,
  muzzle = false,
): void {
  const mesh = buildFlashMesh(ctx.glowTex, color);
  const fx: FlashEffect = { mesh, pos, vel, age: 0, duration, size0, size1, peakOpacity, muzzle };
  ctx.effects.push(fx);
  ctx.scene.add(mesh);
}

// 破片を飛散させる共通処理(撃破デブリ・被弾の欠片)
export function spawnFragments(
  ctx: EffectsCtx,
  origin: Vec3,
  baseVel: Vec3,
  count: number,
  accent: number,
  sizeMin: number,
  sizeMax: number,
  spread: number,
): void {
  for (let i = 0; i < count; i++) {
    const size = sizeMin + Math.random() * (sizeMax - sizeMin);
    const piece = new DebrisPiece(
      {
        r: add(origin, randVec(2.5)),
        v: add(baseVel, randVec(spread)),
      },
      buildDebrisMesh(accent, size),
      {
        q: randomQuat(),
        w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
        inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
      },
      undefined,
      ctx.scene,
    );
    ctx.addDebris(piece);
  }
}

// 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
// 敵機は自機の ENEMY_SCALE 倍サイズなので、爆発・破片も見合った大きさにする(scale)。
export function spawnShipDestroyEffect(ctx: EffectsCtx, r: Vec3, v: Vec3, scale: number, accent: number): void {
  spawnFlash(ctx, clone(r), clone(v), C.DESTROY_FLASH1_SIZE0 * scale, C.DESTROY_FLASH1_SIZE1 * scale, C.DESTROY_FLASH1_DURATION, 0xffb36b);
  spawnFlash(ctx, clone(r), clone(v), C.DESTROY_FLASH2_SIZE0 * scale, C.DESTROY_FLASH2_SIZE1 * scale, C.DESTROY_FLASH2_DURATION, 0xfffbe8);
  spawnFragments(ctx, r, v, 11, accent, C.DEBRIS_SIZE_MIN * scale, C.DEBRIS_SIZE_MAX * scale, 2.8);
}

export class EffectsSystem {
  updateFlashEffects(
    effects: FlashEffect[],
    dt: number,
    simDt: number,
    origin: Vec3,
    activeCamera: THREE.PerspectiveCamera,
    scene: THREE.Scene,
  ): FlashEffect[] {
    return effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) {
        scene.remove(fx.mesh);
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
}
