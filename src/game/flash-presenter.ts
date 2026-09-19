// 直近の進行が記録した出来事を読み、そのフレームに描く一時エフェクト(閃光・ガスパフ)の
// 宣言を作る表示の導出。どの出来事がどの見え方の閃光を伴うか、何枚重ねるか、どれだけ保つか、
// 照準ズーム中に減光するかをここで決める。
import { addScaled } from '../math/vec3';
import { kinematicState } from '../physics/kinematic-state';
import type { KinematicState } from '../physics/kinematic-state';
import type { FlashEffect } from '../render/vfx/flash-effects-view';
import type { ProteinPhase } from '../render/protein/protein-display';
import type { BulletType } from './dynamic/dynamic-entity/bullet-reaction';
import type { RunEvent, RunEventBody } from './run-events';

// 閃光の種別。どの出来事を示す閃光かを表し、見え方はこれで決まる。
type FlashKind =
  | 'bulletImpact'
  | 'plasmaImpact'
  | 'muzzle'
  | 'destroy1'
  | 'destroy2'
  | 'gasPuff1'
  | 'gasPuff2'
  | 'proteinCritical'
  | 'proteinDissociated'
  | 'proteinDamaged';

// 種別1つぶんの見え方。板の一辺は発生直後の size0 から寿命末の size1 まで広がる。
interface FlashAppearance {
  readonly color: string | number;
  readonly size0: number; // 発生直後の一辺 [m]
  readonly size1: number; // 寿命末の一辺 [m]
  readonly peakBrightness: number; // 発生直後の最大の明るさ倍率
  readonly dimsInGunsight: boolean; // 照準ズーム中に減光するか
}

const ZOOM_DIM_SCALE = 0.02; // 照準ズーム中に減光する種別の明るさ倍率(完全には消さない)

// タンパク質の状態遷移フラッシュの大きさ [m] と明るさ。危篤・解離・それ以外の損傷で共通にし、色だけで分ける。
const PROTEIN_STATE_FLASH_SIZE0 = 2.5;
const PROTEIN_STATE_FLASH_SIZE1 = 13;
const PROTEIN_STATE_FLASH_BRIGHTNESS = 0.9;

// TODO: 明るさは 1 天文単位を基準にした目盛りへ手で置いた表示値。ボリュームレンダリングで放射量として組み直す。
const FLASH_APPEARANCE: Record<FlashKind, FlashAppearance> = {
  bulletImpact: { color: '#ffe2a0', size0: 1.5, size1: 6, peakBrightness: 1, dimsInGunsight: false },
  plasmaImpact: { color: '#ffa0ff', size0: 2, size1: 8, peakBrightness: 1, dimsInGunsight: false },
  muzzle: { color: '#fff0b8', size0: 2.2, size1: 6, peakBrightness: 1, dimsInGunsight: true },
  // 撃破の芯(1)と外殻(2)の2枚。
  destroy1: { color: '#ffb36b', size0: 10, size1: 110, peakBrightness: 1, dimsInGunsight: false },
  destroy2: { color: '#fffbe8', size0: 6, size1: 40, peakBrightness: 1, dimsInGunsight: false },
  // ガスの放出。薄く広がる灰色の板を2枚重ねて気体らしさを出す。
  gasPuff1: { color: '#aaaaaa', size0: 1.0, size1: 8.0, peakBrightness: 0.3, dimsInGunsight: false },
  gasPuff2: { color: '#ffffff', size0: 0.5, size1: 6.0, peakBrightness: 0.4, dimsInGunsight: false },
  proteinCritical: {
    color: 0xff3d88, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
  proteinDissociated: {
    color: 0xa76dff, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
  proteinDamaged: {
    color: 0x59e7ff, size0: PROTEIN_STATE_FLASH_SIZE0, size1: PROTEIN_STATE_FLASH_SIZE1,
    peakBrightness: PROTEIN_STATE_FLASH_BRIGHTNESS, dimsInGunsight: true,
  },
};

// 種別ごとの寿命 [s]。
const BULLET_IMPACT_FLASH_DURATION = 0.25;
const PLASMA_IMPACT_FLASH_DURATION = 0.3;
const MUZZLE_FLASH_DURATION = 0.07;
const DESTROY_FLASH1_DURATION = 1.1;
const DESTROY_FLASH2_DURATION = 0.5;
const GAS_PUFF1_DURATION = 0.45;
const GAS_PUFF2_DURATION = 0.35;
const PROTEIN_STATE_FLASH_DURATION = 0.34;

// タンパク質の遷移先のフェーズ、または部位の機能停止('site-disabled')ごとの閃光の種別。
// 危篤・解離はそれぞれの種別、それ以外は損傷として示す。
const PROTEIN_STATE_FLASH_KIND: Readonly<Record<ProteinPhase | 'site-disabled', FlashKind>> = {
  intact: 'proteinDamaged',
  exposed: 'proteinDamaged',
  dissociated: 'proteinDissociated',
  critical: 'proteinCritical',
  'site-disabled': 'proteinDamaged',
};

// 起きた閃光1件。発生時の状態(位置・発生源速度とその時刻)だけを持ち、経過・現在位置は
// そのフレームの表示時刻から出す(R5)。
interface SpawnedFlash {
  readonly kind: FlashKind;
  readonly state: KinematicState;
  readonly duration: number;
  readonly sizeScale: number;
}

export class FlashPresenter {
  // 最後に読んだ出来事の通し番号。同じ出来事から二度閃光を起こさないために持つ。
  private lastSeq = -1;
  private spawned: SpawnedFlash[] = [];
  private effects: FlashEffect[] = [];

  // 直近の present が組んだ、そのフレームに描く一時エフェクト。
  public get live(): readonly FlashEffect[] {
    return this.effects;
  }

  // まだ読んでいない出来事から閃光を起こし、表示時刻 displayTime で生きているものを宣言へ組む。
  // gunsightZoomed は照準ズーム中か。
  public present(events: readonly RunEvent[], displayTime: number, gunsightZoomed: boolean): void {
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.spawn(event.body);
    }
    const spawned: SpawnedFlash[] = [];
    const effects: FlashEffect[] = [];
    for (const flash of this.spawned) {
      const age = displayTime - flash.state.t;
      if (age >= flash.duration) continue;
      spawned.push(flash);
      // 軌道速度で流れて見えないよう、発生源の速度で表示時刻まで運ぶ。
      const { r, v, t } = flash.state;
      const appearance = FLASH_APPEARANCE[flash.kind];
      const dimmed = gunsightZoomed && appearance.dimsInGunsight;
      effects.push({
        state: kinematicState<'eci'>(displayTime, addScaled(r, v, displayTime - t), v),
        age,
        duration: flash.duration,
        color: appearance.color,
        size0: appearance.size0 * flash.sizeScale,
        size1: appearance.size1 * flash.sizeScale,
        brightness: appearance.peakBrightness * (dimmed ? ZOOM_DIM_SCALE : 1),
      });
    }
    this.spawned = spawned;
    this.effects = effects;
  }

  // 出来事1件を、その出来事が伴う閃光へ写す。閃光を伴わない出来事は何も起こさない。
  private spawn(body: RunEventBody): void {
    switch (body.kind) {
      case 'gunFired':
      case 'proteinSiteFired':
        this.add(body.muzzleState, 'muzzle', MUZZLE_FLASH_DURATION);
        return;
      case 'shipStruck':
        if (body.bullet === null) return;
        this.addImpact(
          kinematicState<'eci'>(body.shipState.t, body.impactPoint, body.shipState.v), body.bullet);
        return;
      case 'enemyStruckByBullet':
        this.addImpact(body.state, body.bullet);
        return;
      case 'shipDamagedByContact':
      case 'enemyDamagedByContact':
      case 'debrisStruckByBullet':
        this.addGasPuff(body.state);
        return;
      case 'shipExploded':
        // 撃破の芯と外殻の2枚を、機体模型の倍率へ見合った大きさで重ねる。
        this.add(body.state, 'destroy1', DESTROY_FLASH1_DURATION, body.modelScale);
        this.add(body.state, 'destroy2', DESTROY_FLASH2_DURATION, body.modelScale);
        return;
      case 'proteinStateChanged':
        this.add(
          body.state, PROTEIN_STATE_FLASH_KIND[body.transition], PROTEIN_STATE_FLASH_DURATION);
        return;
      case 'boosterDecoupled':
        this.addGasPuff(body.jointState);
        return;
      default:
        return;
    }
  }

  // 命中の閃光とガスを重ねる。弾種で芯の見え方が変わる。
  private addImpact(state: KinematicState, bullet: BulletType): void {
    if (bullet === 'plasma') this.add(state, 'plasmaImpact', PLASMA_IMPACT_FLASH_DURATION);
    else this.add(state, 'bulletImpact', BULLET_IMPACT_FLASH_DURATION);
    this.addGasPuff(state);
  }

  // 気体が噴き出すエフェクト。大きさと色の違う2枚のパフを重ねる。
  private addGasPuff(state: KinematicState): void {
    this.add(state, 'gasPuff1', GAS_PUFF1_DURATION);
    this.add(state, 'gasPuff2', GAS_PUFF2_DURATION);
  }

  // 閃光1件を起こす。state は発生位置・発生源速度と、その位置が表す時刻(エポック)で、
  // 積分前の座標でもその座標の時刻を渡せば表示時刻まで正しく運ばれる。
  private add(state: KinematicState, kind: FlashKind, duration: number, sizeScale = 1): void {
    this.spawned.push({ kind, state, duration, sizeScale });
  }
}
