import * as THREE from 'three/webgpu';
import { Attitude, randomQuat } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../physics/random';
import { add, randVec, v3, Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { DebrisKind, DebrisPiece } from '../game-entity/debris-piece';
import { FlashEffect, FlashEffectManager } from './flash-effect-manager';
import type { EntityManager } from '../simulation/entity-manager';
import type { Sfx } from '../../audio/sfx';

// フラッシュ・破片エフェクトの生成窓口。scene への注入をここに一元化し、破片は
// entities へ追加する。フラッシュの毎フレーム更新・寿命管理は FlashEffectManager が持つ。
export class EffectsSystem {
  private readonly _flashEffects: FlashEffectManager;

  // scene への注入元と、破片の追加先となる entities を受け取る。sfx/自身(fx)は DebrisPiece
  // (接触音・弾命中エフェクト)へそのまま渡す。
  constructor(
    private readonly _scene: THREE.Scene,
    private readonly entities: EntityManager,
    private readonly _sfx: Sfx,
  ) {
    this._flashEffects = new FlashEffectManager(_scene);
  }

  // フラッシュ群の寿命を1フレーム分進め、simTime まで移流させる。
  update(dt: number, simTime: number): void {
    this._flashEffects.updateFlashEffects(dt, simTime);
  }

  // フラッシュ群のビルボードを現在の状態へ同期する。
  sync(fo: FloatingOrigin, activeCamera: THREE.PerspectiveCamera): void {
    this._flashEffects.syncFlashEffects(fo, activeCamera);
  }

  // プラズマ弾命中フラッシュを生成する。
  spawnPlasmaFlash(state: KinematicState): void {
    this.spawnFlash(state,
      C.PLASMA_IMPACT_FLASH_SIZE0,
      C.PLASMA_IMPACT_FLASH_SIZE1,
      C.PLASMA_IMPACT_FLASH_DURATION,
      C.COLOR_PLASMA_IMPACT_FLASH);
  }

  // 実弾命中フラッシュを生成する。
  spawnBulletFlash(state: KinematicState): void {
    this.spawnFlash(state,
      C.BULLET_IMPACT_FLASH_SIZE0,
      C.BULLET_IMPACT_FLASH_SIZE1,
      C.BULLET_IMPACT_FLASH_DURATION,
      C.COLOR_BULLET_IMPACT_FLASH);
  }

  // ガスのような気体が放出されるエフェクト（被弾時やデブリ命中時用）
  spawnGasPuff(state: KinematicState): void {
    // 灰色の低透明度のビルボードを2つ重ねてガスっぽさを出す
    this.spawnFlash(state, 1.0, 8.0, 0.45, C.COLOR_GAS_PUFF_1, 0.3);
    this.spawnFlash(state, 0.5, 6.0, 0.35, C.COLOR_GAS_PUFF_2, 0.4);
  }

  // state は発生位置・発生源速度と、その位置が表す時刻(エポック)。積分前の座標から
  // 生成する場合も、その座標の時刻をそのまま渡せば取り残されない。
  spawnFlash(
    state: KinematicState,
    size0: number,
    size1: number,
    duration: number,
    color: string | number,
    peakOpacity = 1,
  ): void {
    const fx: FlashEffect = {
      transform: new THREE.Object3D(),
      baseColor: new THREE.Color(color),
      color: new THREE.Color(),
      state, age: 0, duration, size0, size1, peakOpacity,
    };
    this._flashEffects.addFlash(fx);
  }

  // DebrisPiece を組み立てて追加する共通処理。fragment/barrel/magazineFrame/casing の
  // 各 spawnXxx はすべてこれの薄いラッパー — kind ごとの見た目・寿命判定の違いは
  // DebrisPiece/DebrisKind(game-entity.ts)側の責務。
  private spawnDebrisPiece(state: KinematicState, kind: DebrisKind, att: Attitude, radius?: number): void {
    this.entities.addDebris(new DebrisPiece(state, kind, att, this._sfx, this, radius, this._scene));
  }

  // t は発生時刻(破片 state のエポック)。破壊された entity の state.t をそのまま渡す。
  scatterFragments(
    t: number,
    origin: Vec3,
    baseVel: Vec3,
    count: number,
    accent: string | number,
    sizeMin: number,
    sizeMax: number,
    spread: number,
  ): void {
    // 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
    for (let i = 0; i < count; i++) {
      const size = sizeMin + Math.random() * (sizeMax - sizeMin);
      const state = kinematicState(t, add(origin, randVec(2.5)), add(baseVel, randVec(spread)));
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
  spawnShipDestroyEffect(state: KinematicState, scale: number, accent: string | number): void {
    const { t, r, v } = state;
    this.spawnFlash(state, C.DESTROY_FLASH1_SIZE0 * scale, C.DESTROY_FLASH1_SIZE1 * scale, C.DESTROY_FLASH1_DURATION, C.COLOR_DESTROY_FLASH_1);
    this.spawnFlash(state, C.DESTROY_FLASH2_SIZE0 * scale, C.DESTROY_FLASH2_SIZE1 * scale, C.DESTROY_FLASH2_DURATION, C.COLOR_DESTROY_FLASH_2);
    // 破片のサイズを 1/3 に縮小し、拡散の初速(spread)を大きくして散らせる
    this.scatterFragments(t, r, v, 11, accent, (C.DESTROY_FRAG_SIZE_MIN * scale) / 3, (C.DESTROY_FRAG_SIZE_MAX * scale) / 3, 20.0);
  }

  // 破壊片1個を生成する。
  spawnFragment(state: KinematicState, att: Attitude, accent: string | number, size: number): void {
    this.spawnDebrisPiece(state, { kind: 'fragment', accent, size }, att);
  }

  // 排莢: 薬莢は剛体接触半径 0.2m の固定値(実物同様に軽い)。
  spawnCasing(state: KinematicState, att: Attitude, bornSim: number): void {
    this.spawnDebrisPiece(state, { kind: 'casing', bornSim }, att, 0.2);
  }

  // マガジン撃ち尽くし時に排出されるバレル。
  spawnBarrel(state: KinematicState, att: Attitude): void {
    this.spawnDebrisPiece(state, { kind: 'barrel' }, att, 0.8);
  }

  // マガジン撃ち尽くし時に排出される空マガジンの外枠。
  spawnMagazineFrame(state: KinematicState, att: Attitude): void {
    this.spawnDebrisPiece(state, { kind: 'magazineFrame' }, att, C.EJECTED_MAG_PHYS_RADIUS);
  }
}
