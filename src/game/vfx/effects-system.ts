import * as THREE from 'three/webgpu';
import { KinematicState } from '../../physics/kinematic-state';
import { FloatingOrigin } from '../camera/floating-origin';
import { FlashEffect, FlashEffectManager } from './flash-effect-manager';
import {
  BULLET_IMPACT_FLASH_COLOR, BULLET_IMPACT_FLASH_DURATION, BULLET_IMPACT_FLASH_SIZE0,
  BULLET_IMPACT_FLASH_SIZE1, GAS_PUFF1_BRIGHTNESS, GAS_PUFF1_DURATION, GAS_PUFF1_SIZE0,
  GAS_PUFF1_SIZE1, GAS_PUFF2_BRIGHTNESS, GAS_PUFF2_DURATION, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1,
  GAS_PUFF_COLOR_1, GAS_PUFF_COLOR_2, MUZZLE_FLASH_COLOR, MUZZLE_FLASH_DURATION,
  MUZZLE_FLASH_SIZE0, MUZZLE_FLASH_SIZE1, PLASMA_IMPACT_FLASH_COLOR,
  PLASMA_IMPACT_FLASH_DURATION, PLASMA_IMPACT_FLASH_SIZE0, PLASMA_IMPACT_FLASH_SIZE1,
} from '../../render/vfx-style';

// フラッシュエフェクトの生成窓口。
export class EffectsSystem {
  private readonly _flashEffects: FlashEffectManager;

  // フラッシュの描画物は scene へ入る。
  constructor(scene: THREE.Scene) {
    this._flashEffects = new FlashEffectManager(scene);
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
}
