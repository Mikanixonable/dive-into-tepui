// 直近の進行が記録した出来事を読み、そのフレームに描く一時エフェクト(閃光・ガスパフ)の
// 宣言を作る。どの出来事がどの見え方の閃光を伴うか、何枚重ねるか、どれだけ保つかはここで決める。
// これは表示の導出で、段 7 で presentation/ へ移る。
import { addScaled } from '../math/vec3';
import { kinematicState } from '../physics/kinematic-state';
import type { KinematicState } from '../physics/kinematic-state';
import type { FlashEffect, FlashKind } from '../render/vfx/flash-effects-view';
import type { ProteinPhase } from '../render/protein/protein-display';
import type { BulletType } from './dynamic/dynamic-entity/bullet-reaction';
import type { RunEvent, RunEventBody } from './run-events';

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
  public present(events: readonly RunEvent[], displayTime: number): void {
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
      effects.push({
        kind: flash.kind,
        state: kinematicState<'eci'>(displayTime, addScaled(r, v, displayTime - t), v),
        age,
        duration: flash.duration,
        sizeScale: flash.sizeScale,
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

  // state は発生位置・発生源速度と、その位置が表す時刻(エポック)。積分前の座標から
  // 起こす場合も、その座標の時刻をそのまま渡せば取り残されない。
  private add(state: KinematicState, kind: FlashKind, duration: number, sizeScale = 1): void {
    this.spawned.push({ kind, state, duration, sizeScale });
  }
}
