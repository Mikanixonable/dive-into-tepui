import * as THREE from 'three/webgpu';
import { Attitude, qRotate, randomQuat } from '../../physics/attitude';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import { add, addScaled, randVec, scale, v3, Vec3 } from '../../math/vec3';
import { FloatingOrigin } from '../camera/floating-origin';
import { DebrisKind, DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { FlashEffect, FlashEffectManager } from './flash-effect-manager';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import {
  BULLET_IMPACT_FLASH_COLOR, BULLET_IMPACT_FLASH_DURATION, BULLET_IMPACT_FLASH_SIZE0, BULLET_IMPACT_FLASH_SIZE1, DESTROY_FLASH1_DURATION, DESTROY_FLASH1_SIZE0, DESTROY_FLASH1_SIZE1, DESTROY_FLASH2_DURATION, DESTROY_FLASH2_SIZE0, DESTROY_FLASH2_SIZE1, DESTROY_FLASH_COLOR_1, DESTROY_FLASH_COLOR_2, DESTROY_FRAG_SIZE_MAX, DESTROY_FRAG_SIZE_MIN, GAS_PUFF1_BRIGHTNESS, GAS_PUFF1_DURATION, GAS_PUFF1_SIZE0, GAS_PUFF1_SIZE1, GAS_PUFF2_BRIGHTNESS, GAS_PUFF2_DURATION, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF_COLOR_1, GAS_PUFF_COLOR_2, MUZZLE_FLASH_COLOR, MUZZLE_FLASH_DURATION, MUZZLE_FLASH_SIZE0, MUZZLE_FLASH_SIZE1, PLASMA_IMPACT_FLASH_COLOR, PLASMA_IMPACT_FLASH_DURATION, PLASMA_IMPACT_FLASH_SIZE0, PLASMA_IMPACT_FLASH_SIZE1,
} from '../../render/vfx-style';
import {
  BOOSTER_INTERSTAGE_BOLT_Z,
  BOOSTER_INTERSTAGE_COVER_RADIUS,
  BOOSTER_INTERSTAGE_COVER_SEGMENTS,
  BOOSTER_INTERSTAGE_COVER_Z,
  BOOSTER_STAGE_DIMENSIONS,
} from '../../render/booster';

const EJECTED_MAG_PHYS_RADIUS = 1.4; // 排出された空マガジンの物理接触用の半径 [m]

// フラッシュ・破片エフェクトの生成窓口。scene への注入をここに一元化し、破片は
// entities へ追加する。フラッシュの毎フレーム更新・寿命管理は FlashEffectManager が持つ。
export class EffectsSystem {
  private readonly _flashEffects: FlashEffectManager;

  // scene への注入元と、破片の追加先となる entities を受け取る。worldSfx/自身(fx)は DebrisPiece
  // (接触音・弾命中エフェクト)へそのまま渡す。
  constructor(
    private readonly _scene: THREE.Scene,
    private readonly entities: DynamicSystem,
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

  // ガスのような気体が放出されるエフェクト（被弾時やデブリ命中時用）
  spawnGasPuff(state: KinematicState): void {
    this.spawnFlash(state, GAS_PUFF1_SIZE0, GAS_PUFF1_SIZE1, GAS_PUFF1_DURATION, GAS_PUFF_COLOR_1, GAS_PUFF1_BRIGHTNESS);
    this.spawnFlash(state, GAS_PUFF2_SIZE0, GAS_PUFF2_SIZE1, GAS_PUFF2_DURATION, GAS_PUFF_COLOR_2, GAS_PUFF2_BRIGHTNESS);
  }

  // 段間カバーと爆砕ボルトを接続点から切り離し、径方向へ散らす。カバーは内側段側へ、
  // ボルトは両段の平均速度を基準にするので、分離後も接続面に留まらず画面で読める。
  spawnBoosterSeparation(
    t: number,
    joint: Vec3,
    playerVelocity: Vec3,
    boosterVelocity: Vec3,
    att: Attitude,
  ): void {
    const coverBaseZ = BOOSTER_STAGE_DIMENSIONS.length + BOOSTER_INTERSTAGE_COVER_Z;
    const boltBaseZ = BOOSTER_STAGE_DIMENSIONS.length + BOOSTER_INTERSTAGE_BOLT_Z;
    const averageVelocity = scale(add(playerVelocity, boosterVelocity), 0.5);

    for (let i = 0; i < BOOSTER_INTERSTAGE_COVER_SEGMENTS; i++) {
      const angle = (i * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
      const radialLocal = v3(Math.cos(angle), Math.sin(angle), 0);
      const tangentLocal = v3(-Math.sin(angle), Math.cos(angle), 0);
      const radial = qRotate(att.q, radialLocal);
      const tangent = qRotate(att.q, tangentLocal);

      const coverPosition = add(joint, qRotate(att.q, v3(
        Math.cos(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        Math.sin(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        coverBaseZ,
      )));
      const coverVelocity = addScaled(
        addScaled(playerVelocity, radial, 4.5 + Math.random() * 2.5),
        tangent,
        randSym(1.5),
      );
      this.spawnDebrisPiece(
        kinematicState<'eci'>(t, coverPosition, coverVelocity),
        { kind: 'boosterCover', segment: i, bornSim: t },
        { q: att.q, w: v3(randSym(0.8), randSym(1.8), randSym(0.8)), inertia: v3(1, 1.7, 2.4) },
      );

      const boltPosition = add(joint, qRotate(att.q, v3(
        Math.cos(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        Math.sin(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        boltBaseZ,
      )));
      const boltVelocity = addScaled(
        addScaled(
          addScaled(averageVelocity, radial, 6.0 + Math.random() * 3.5),
          tangent,
          randSym(2.0),
        ),
        qRotate(att.q, v3(0, 0, 1)),
        randSym(2.5),
      );
      this.spawnDebrisPiece(
        kinematicState<'eci'>(t, boltPosition, boltVelocity),
        { kind: 'boosterBolt', segment: i, bornSim: t },
        { q: att.q, w: v3(randSym(2.5), randSym(2.5), randSym(2.5)), inertia: v3(0.4, 0.5, 0.7) },
      );
    }
  }

  // マズルフラッシュを生成する。ガンサイトズーム中は sync 側で減光される。
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
      transform: new THREE.Object3D(),
      baseColor: new THREE.Color(color),
      color: new THREE.Color(),
      state, age: 0, duration, size0, size1, peakBrightness, dimsInGunsight,
    };
    this._flashEffects.addFlash(fx);
  }

  // DebrisPiece を組み立てて追加する共通処理。fragment/barrel/magazineFrame/casing の
  // 各 spawnXxx はすべてこれの薄いラッパー — kind ごとの見た目・寿命判定の違いは
  // DebrisPiece/DebrisKind(debris-piece.ts)側の責務。
  private spawnDebrisPiece(state: KinematicState, kind: DebrisKind, att: Attitude, radius?: number): void {
    this.entities.addDebris(new DebrisPiece(state, kind, att, this._worldSfx, this, radius, this._scene));
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

  // 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果。
  // 敵機は自機の ENEMY_SCALE 倍サイズなので、爆発・破片も見合った大きさにする(scale)。
  spawnShipDestroyEffect(state: KinematicState, scale: number, accent: string | number): void {
    const { t, r, v } = state;
    this.spawnFlash(state, DESTROY_FLASH1_SIZE0 * scale, DESTROY_FLASH1_SIZE1 * scale, DESTROY_FLASH1_DURATION, DESTROY_FLASH_COLOR_1);
    this.spawnFlash(state, DESTROY_FLASH2_SIZE0 * scale, DESTROY_FLASH2_SIZE1 * scale, DESTROY_FLASH2_DURATION, DESTROY_FLASH_COLOR_2);
    // 破片のサイズを 1/3 に縮小し、拡散の初速(spread)を大きくして散らせる
    this.scatterFragments(t, r, v, 11, accent, (DESTROY_FRAG_SIZE_MIN * scale) / 3, (DESTROY_FRAG_SIZE_MAX * scale) / 3, 20.0);
  }

  // 破壊片1個を生成する。
  spawnFragment(state: KinematicState, att: Attitude, accent: string | number, size: number): void {
    this.spawnDebrisPiece(state, { kind: 'fragment', accent, size }, att);
  }

  // 排莢: 薬莢は剛体接触半径 0.2m の固定値(実物同様に軽い)。
  spawnCasing(state: KinematicState, att: Attitude, bornSim: number): void {
    this.spawnDebrisPiece(state, { kind: 'casing', bornSim }, att, 0.2);
  }

  // マガジン撃ち尽くし時に排出されるバレル。temperature は排出時の平均温度 [K]、
  // thermalDeviation は薬室側が平均より高い温度差 [K]。
  spawnBarrel(
    state: KinematicState, att: Attitude, temperature: number, thermalDeviation: number,
  ): void {
    this.spawnDebrisPiece(
      state, { kind: 'barrel', bornTemperature: temperature, bornThermalDeviation: thermalDeviation }, att, 0.8);
  }

  // マガジン撃ち尽くし時に排出される空マガジンの外枠。
  spawnMagazineFrame(state: KinematicState, att: Attitude): void {
    this.spawnDebrisPiece(state, { kind: 'magazineFrame' }, att, EJECTED_MAG_PHYS_RADIUS);
  }
}
