import * as THREE from 'three/webgpu';
import { Attitude, randomQuat } from '../../physics/attitude';
import { OrbitState, orbitState } from '../../physics/orbital';
import { add, randSym, randVec, v3, Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { DebrisKind, DebrisPiece } from '../game-entity/game-entity';
import { Billboard } from '../../render/billboard';
import { FlashEffect, FlashEffectManager } from './flash-effect-manager';
import type { EntityManager } from '../game-entity/entity-manager';

// FlashEffectとDebrisPieceの生成・管理を一元化するエフェクトシステム。ゲーム内のフラッシュ・破片はすべてここを経由する
// FlashEffectはFlashEffectManagerが管理する。DebrisPieceはspawn系メソッドで生成されentitiesに追加される
// フラッシュ・破片エフェクトの発生源。scene への注入をここに一元化し、呼び出し側
// (Player/Enemy/PlayerFire)は scene を持ち回さずに済む。フラッシュの毎フレーム更新・
// 寿命管理(FlashEffectManager)もここが私有し、game.ts からは spawn 系メソッドと
// 同じ窓口(sync)経由でのみ触る。
export class EffectsSystem {
  private readonly _flashEffects: FlashEffectManager;

  constructor(
    private readonly _scene: THREE.Scene,
    private readonly entities: EntityManager,
  ) {
    this._flashEffects = new FlashEffectManager(_scene);
  }

  sync(dt: number, simDt: number, fo: FloatingOrigin, activeCamera: THREE.PerspectiveCamera): void {
    // debrisはentitiesが管理するので、syncもそちらが行い、こちらではentitiesの責務外になるflashEffectsのみ更新する
    this._flashEffects.syncFlashEffects(dt, simDt, fo, activeCamera);
  }

  spawnPlasmaFlash(pos: Vec3, vel: Vec3): void {
    this.spawnFlash(pos, vel,
      C.PLASMA_HIT_FLASH_SIZE0,
      C.PLASMA_HIT_FLASH_SIZE1,
      C.PLASMA_HIT_FLASH_DURATION,
      0xffa0ff);
  }

  spawnBulletFlash(pos: Vec3, vel: Vec3): void {
    this.spawnFlash(pos, vel,
      C.BULLET_HIT_FLASH_SIZE0,
      C.BULLET_HIT_FLASH_SIZE1,
      C.BULLET_HIT_FLASH_DURATION,
      0xffe2a0);
  }

  // pos/vel は呼び出し元の生きたオブジェクト(entity の r/v など)を渡してよい。
  // 以後 fx が独立して動くよう、ここで clone して保持する。
  spawnFlash(
    pos: Vec3,
    vel: Vec3,
    size0: number,
    size1: number,
    duration: number,
    color: number,
    peakOpacity = 1,
  ): void {
    const billboard = new Billboard(color);
    const fx: FlashEffect = { billboard, pos, vel, age: 0, duration, size0, size1, peakOpacity };
    this._flashEffects.addFlash(fx);
  }

  // DebrisPiece を組み立てて追加する共通処理。fragment/barrel/magazineFrame/casing の
  // 各 spawnXxx はすべてこれの薄いラッパー — kind ごとの見た目・寿命判定の違いは
  // DebrisPiece/DebrisKind(game-entity.ts)側の責務。
  private spawnDebrisPiece(state: OrbitState, kind: DebrisKind, att: Attitude, collideRadius?: number): void {
    this.entities.addDebris(new DebrisPiece(state, kind, att, collideRadius, this._scene));
  }

  // t は発生時刻(破片 state のエポック)。破壊された entity の state.t をそのまま渡す。
  scatterFragments(
    t: number,
    origin: Vec3,
    baseVel: Vec3,
    count: number,
    accent: number,
    sizeMin: number,
    sizeMax: number,
    spread: number,
  ): void {
    // 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
    for (let i = 0; i < count; i++) {
      const size = sizeMin + Math.random() * (sizeMax - sizeMin);
      const state = orbitState(t, add(origin, randVec(2.5)), add(baseVel, randVec(spread)));
      const att = {
        q: randomQuat(),
        w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
        inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
      };
      this.spawnFragment(state, att, accent, size);
    }
  }

  // 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
  // 敵機は自機の ENEMY_SCALE 倍サイズなので、爆発・破片も見合った大きさにする(scale)。
  spawnShipDestroyEffect(state: OrbitState, scale: number, accent: number): void {
    const { t, r, v } = state;
    this.spawnFlash(r, v, C.DESTROY_FLASH1_SIZE0 * scale, C.DESTROY_FLASH1_SIZE1 * scale, C.DESTROY_FLASH1_DURATION, 0xffb36b);
    this.spawnFlash(r, v, C.DESTROY_FLASH2_SIZE0 * scale, C.DESTROY_FLASH2_SIZE1 * scale, C.DESTROY_FLASH2_DURATION, 0xfffbe8);
    this.scatterFragments(t, r, v, 11, accent, C.DESTROY_FRAG_SIZE_MIN * scale, C.DESTROY_FRAG_SIZE_MAX * scale, 2.8);
  }

  spawnFragment(state: OrbitState, att: Attitude, accent: number, size: number): void {
    this.spawnDebrisPiece(state, { kind: 'fragment', accent, size }, att);
  }

  // 排莢: 薬莢は剛体接触半径 0.2m の固定値(実物同様に軽い)。
  spawnCasing(state: OrbitState, att: Attitude, bornSim: number): void {
    this.spawnDebrisPiece(state, { kind: 'casing', bornSim }, att, 0.2);
  }

  // マガジン撃ち尽くし時に排出されるバレル(手動リロードからも呼ばれる)。
  spawnBarrel(state: OrbitState, att: Attitude): void {
    this.spawnDebrisPiece(state, { kind: 'barrel' }, att, 0.8);
  }

  // マガジン撃ち尽くし時に排出される空マガジンの外枠。
  spawnMagazineFrame(state: OrbitState, att: Attitude): void {
    this.spawnDebrisPiece(state, { kind: 'magazineFrame' }, att, C.EJECTED_MAG_PHYS_RADIUS);
  }
}
