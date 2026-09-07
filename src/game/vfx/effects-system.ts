import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { randomQuat } from '../../math/quat';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import { add, randVec, v3, Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { DebrisKind, DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { FlashEffect, FlashEffectManager } from './flash-effect-manager';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import {
  BULLET_IMPACT_FLASH_COLOR, BULLET_IMPACT_FLASH_DURATION, BULLET_IMPACT_FLASH_SIZE0, BULLET_IMPACT_FLASH_SIZE1, DESTROY_FLASH1_DURATION, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1, DESTROY_FLASH2_DURATION, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1, DESTROY_FLASH_COLOR_1, DESTROY_FLASH_COLOR_2, DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, GAS_PUFF1_BRIGHTNESS, GAS_PUFF1_DURATION, GAS_PUFF1_SIZE0, GAS_PUFF1_SIZE1, GAS_PUFF2_BRIGHTNESS, GAS_PUFF2_DURATION, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF_COLOR_1, GAS_PUFF_COLOR_2, MUZZLE_FLASH_COLOR, MUZZLE_FLASH_DURATION, MUZZLE_FLASH_SIZE0, MUZZLE_FLASH_SIZE1, PLASMA_IMPACT_FLASH_COLOR, PLASMA_IMPACT_FLASH_DURATION, PLASMA_IMPACT_FLASH_SIZE0, PLASMA_IMPACT_FLASH_SIZE1,
} from '../../render/vfx-style';

// フラッシュ・破片エフェクトの生成窓口。scene への注入をここに一元化し、破片は
// dynamicSystem へ追加する。
export class EffectsSystem {
  private readonly _flashEffects: FlashEffectManager;

  // 生成した破片は dynamicSystem へ、その描画物は scene へ入る。
  constructor(
    private readonly _scene: THREE.Scene,
    private readonly dynamicSystem: DynamicSystem,
    private readonly _worldSfx: WorldSfx,
  ) {
    this._flashEffects = new FlashEffectManager(_scene);
  }

  // フラッシュ群の寿命を1フレーム分進め、simTime まで移流させる。
  update(dt: number, simTime: number): void {
    this._flashEffects.updateFlashEffects(dt, simTime);
  }

  // フラッシュ群のビルボードを現在の状態へ同期する。
  sync(fo: FloatingOrigin, activeCamera: THREE.Camera, zoomActive: boolean): void {
    this._flashEffects.syncFlashEffects(fo, activeCamera, zoomActive);
  }

  // フラッシュ群の描画資源を破棄する。
  dispose(): void {
    this._flashEffects.dispose();
  }

  // プラズマ弾命中フラッシュを生成する。
  spawnPlasmaFlash(state: KinematicState): void {
    this.spawnFlash(state,
      PLASMA_IMPACT_FLASH_SIZE0,
      PLASMA_IMPACT_FLASH_SIZE1,
      PLASMA_IMPACT_FLASH_DURATION,
      PLASMA_IMPACT_FLASH_COLOR);
  }

  // 実弾命中フラッシュを生成する。
  spawnBulletFlash(state: KinematicState): void {
    this.spawnFlash(state,
      BULLET_IMPACT_FLASH_SIZE0,
      BULLET_IMPACT_FLASH_SIZE1,
      BULLET_IMPACT_FLASH_DURATION,
      BULLET_IMPACT_FLASH_COLOR);
  }

  // 気体が噴き出すエフェクト。大きさと色の違う2枚のパフを重ねる。
  spawnGasPuff(state: KinematicState): void {
    this.spawnFlash(state, GAS_PUFF1_SIZE0, GAS_PUFF1_SIZE1, GAS_PUFF1_DURATION, GAS_PUFF_COLOR_1, GAS_PUFF1_BRIGHTNESS);
    this.spawnFlash(state, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF2_DURATION, GAS_PUFF_COLOR_2, GAS_PUFF2_BRIGHTNESS);
  }

  // マズルフラッシュを生成する(ガンサイトズーム中は減光される)。
  spawnMuzzleFlash(state: KinematicState): void {
    this.spawnFlash(
      state,
      MUZZLE_FLASH_SIZE0,
      MUZZLE_FLASH_SIZE1,
      MUZZLE_FLASH_DURATION,
      MUZZLE_FLASH_COLOR,
      1,
      true,
    );
  }

  // タンパク質の状態遷移フラッシュ。kind('critical' / 'dissociated' / その他)で色を分ける。
  spawnProteinStateFlash(state: KinematicState, kind: string): void {
    const color = kind === 'critical' ? 0xff3d88 : kind === 'dissociated' ? 0xa76dff : 0x59e7ff;
    this.spawnFlash(state, 2.5, 13, 0.34, color, 0.9, true);
  }

  // state は発生位置・発生源速度と、その位置が表す時刻(エポック)。積分前の座標から
  // 生成する場合も、その座標の時刻をそのまま渡せば取り残されない。
  spawnFlash(
    state: KinematicState,
    size0: number,
    size1: number,
    duration: number,
    color: string | number,
    peakBrightness = 1,
    dimsInGunsight = false,
  ): void {
    const fx: FlashEffect = {
      baseColor: color,
      state, age: 0, duration, size0, size1, peakBrightness, dimsInGunsight,
    };
    this._flashEffects.addFlash(fx);
  }

  // DebrisPiece を組み立てて dynamicSystem へ追加する。
  private spawnDebrisPiece(state: KinematicState, kind: DebrisKind, att: Attitude, radius?: number): void {
    this.dynamicSystem.add(new DebrisPiece(state, kind, att, this._worldSfx, this, radius, this._scene));
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
      const state = kinematicState<'eci'>(t, add(origin, randVec(2.5)), add(baseVel, randVec(spread)));
      const att = {
        q: randomQuat(),
        w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
        inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
      };
      this.spawnFragment(state, att, accent, size);
    }
  }

  // 撃破時の閃光2発と破片。scale は機体の大きさ倍率(敵機は自機の ENEMY_SCALE 倍)。
  spawnShipDestroyEffect(state: KinematicState, scale: number, accent: string | number): void {
    const { t, r, v } = state;
    this.spawnFlash(state, DESTROY_FLASH1_SIZE0 * scale, DESTROY_FLASH1_SIZE1 * scale, DESTROY_FLASH1_DURATION, DESTROY_FLASH_COLOR_1);
    this.spawnFlash(state, DESTROY_FLASH2_SIZE0 * scale, DESTROY_FLASH2_SIZE1 * scale, DESTROY_FLASH2_DURATION, DESTROY_FLASH_COLOR_2);
    this.scatterFragments(t, r, v, 11, accent, (DESTROY_FRAG_SIZE_MIN * scale) / 3, (DESTROY_FRAG_SIZE_MAX * scale) / 3, 20.0);
  }

  // 破壊片1個を生成する。
  spawnFragment(state: KinematicState, att: Attitude, accent: string | number, size: number): void {
    this.spawnDebrisPiece(state, { kind: 'fragment', accent, size }, att);
  }

}
