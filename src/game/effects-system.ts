import * as THREE from 'three/webgpu';
import { randomQuat } from '../physics/attitude';
import { add, clone, randSym, randVec, v3, Vec3 } from '../physics/vec3';
import * as C from './const';
import { DebrisPiece } from './orbit-entity/entities';
import { buildFlashMesh } from '../render/ships';
import { getGlowTexture } from '../render/glow-texture';
import { FlashEffect } from './flash-effect-manager';



// フラッシュ・破片の発生に必要な最小の受け皿(scene は呼び出し側が自身の _scene を
// 明示的な引数として渡す — hud/sfx/scene をひとまとめに ctx 注入する経路は根絶する方針
// のため、ここには含めない)。
export interface EffectsCtx {
  effects: FlashEffect[];
  addDebris(piece: DebrisPiece): void;
}

export function spawnPlasmaFlash(scene: THREE.Scene, ctx: EffectsCtx, pos: Vec3, vel: Vec3): void {
  spawnFlash(scene, ctx, pos, vel,
    C.PLASMA_HIT_FLASH_SIZE0,
    C.PLASMA_HIT_FLASH_SIZE1,
    C.PLASMA_HIT_FLASH_DURATION,
    0xffa0ff);
}

export function spawnBulletFlash(scene: THREE.Scene, ctx: EffectsCtx, pos: Vec3, vel: Vec3): void {
  spawnFlash(scene, ctx, pos, vel,
    C.BULLET_HIT_FLASH_SIZE0,
    C.BULLET_HIT_FLASH_SIZE1,
    C.BULLET_HIT_FLASH_DURATION,
    0xffe2a0);
}

// pos/vel は呼び出し元の生きたオブジェクト(entity の r/v など)を渡してよい。
// 以後 fx が独立して動くよう、ここで clone して保持する。
export function spawnFlash(
  scene: THREE.Scene,
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
  const mesh = buildFlashMesh(getGlowTexture(), color);
  const fx: FlashEffect = { mesh, pos: clone(pos), vel: clone(vel), age: 0, duration, size0, size1, peakOpacity, muzzle };
  ctx.effects.push(fx);
  scene.add(mesh);
}

// 破片を飛散させる共通処理(撃破デブリ・被弾の欠片)
export function spawnFragments(
  scene: THREE.Scene,
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
      { kind: 'fragment', accent, size },
      {
        q: randomQuat(),
        w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
        inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
      },
      undefined,
      scene,
    );
    ctx.addDebris(piece);
  }
}

// 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
// 敵機は自機の ENEMY_SCALE 倍サイズなので、爆発・破片も見合った大きさにする(scale)。
export function spawnShipDestroyEffect(scene: THREE.Scene, ctx: EffectsCtx, r: Vec3, v: Vec3, scale: number, accent: number): void {
  spawnFlash(scene, ctx, r, v, C.DESTROY_FLASH1_SIZE0 * scale, C.DESTROY_FLASH1_SIZE1 * scale, C.DESTROY_FLASH1_DURATION, 0xffb36b);
  spawnFlash(scene, ctx, r, v, C.DESTROY_FLASH2_SIZE0 * scale, C.DESTROY_FLASH2_SIZE1 * scale, C.DESTROY_FLASH2_DURATION, 0xfffbe8);
  spawnFragments(scene, ctx, r, v, 11, accent, C.DEBRIS_SIZE_MIN * scale, C.DEBRIS_SIZE_MAX * scale, 2.8);
}

