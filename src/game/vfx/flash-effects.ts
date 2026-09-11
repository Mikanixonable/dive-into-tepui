// 爆発・マズルフラッシュなどの一時エフェクトの発生と寿命。生きているあいだ発生源の速度で
// 移流させ、寿命が尽きたものを列から落とす。1件が何を示す閃光かは種別として持つ。
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { addScaled } from '../../math/vec3';
import type { FlashEffect, FlashKind } from '../../render/vfx/flash-effects-view';

// 種別ごとの寿命 [s]。
const BULLET_IMPACT_FLASH_DURATION = 0.25;
const PLASMA_IMPACT_FLASH_DURATION = 0.3;
const MUZZLE_FLASH_DURATION = 0.07;
const DESTROY_FLASH1_DURATION = 1.1;
const DESTROY_FLASH2_DURATION = 0.5;
const GAS_PUFF1_DURATION = 0.45;
const GAS_PUFF2_DURATION = 0.35;
const PROTEIN_STATE_FLASH_DURATION = 0.34;

export class FlashEffects {
  private effects: FlashEffect[] = [];

  // いま生きているエフェクト。spawn した順に並ぶ。
  public get live(): readonly FlashEffect[] {
    return this.effects;
  }

  // 経過時間を進めて各エフェクトを simTime まで移流させ、寿命の尽きたものを落とす。
  public update(dt: number, simTime: number): void {
    const live: FlashEffect[] = [];
    for (const fx of this.effects) {
      const age = fx.age + dt;
      if (age >= fx.duration) continue;
      // 軌道速度で流れて見えないよう、発生源の速度で現在の simTime まで運ぶ。
      const s = fx.state;
      const state = kinematicState<'eci'>(simTime, addScaled(s.r, s.v, simTime - s.t), s.v);
      live.push({ kind: fx.kind, state, age, duration: fx.duration, sizeScale: fx.sizeScale });
    }
    this.effects = live;
  }

  // プラズマ弾命中フラッシュを生成する。
  public spawnPlasmaFlash(state: KinematicState): void {
    this.spawn(state, 'plasmaImpact', PLASMA_IMPACT_FLASH_DURATION);
  }

  // 実弾命中フラッシュを生成する。
  public spawnBulletFlash(state: KinematicState): void {
    this.spawn(state, 'bulletImpact', BULLET_IMPACT_FLASH_DURATION);
  }

  // 自機の撃破フラッシュ。芯と外殻の2枚を重ねる。
  public spawnPlayerDestroyFlash(state: KinematicState): void {
    this.spawn(state, 'destroy1', DESTROY_FLASH1_DURATION);
    this.spawn(state, 'destroy2', DESTROY_FLASH2_DURATION);
  }

  // 敵機の撃破フラッシュ。芯と外殻の2枚を、機体メッシュのスケール meshScale へ見合った
  // 大きさで重ねる。
  public spawnEnemyDestroyFlash(state: KinematicState, meshScale: number): void {
    this.spawn(state, 'destroy1', DESTROY_FLASH1_DURATION, meshScale);
    this.spawn(state, 'destroy2', DESTROY_FLASH2_DURATION, meshScale);
  }

  // 気体が噴き出すエフェクト。大きさと色の違う2枚のパフを重ねる。
  public spawnGasPuff(state: KinematicState): void {
    this.spawn(state, 'gasPuff1', GAS_PUFF1_DURATION);
    this.spawn(state, 'gasPuff2', GAS_PUFF2_DURATION);
  }

  // マズルフラッシュを生成する。
  public spawnMuzzleFlash(state: KinematicState): void {
    this.spawn(state, 'muzzle', MUZZLE_FLASH_DURATION);
  }

  // タンパク質の状態遷移フラッシュ。示す状態('critical' / 'dissociated' / それ以外の損傷)で
  // 種別を分ける。
  public spawnProteinStateFlash(state: KinematicState, proteinState: string): void {
    const kind = proteinState === 'critical' ? 'proteinCritical'
      : proteinState === 'dissociated' ? 'proteinDissociated' : 'proteinDamaged';
    this.spawn(state, kind, PROTEIN_STATE_FLASH_DURATION);
  }

  // state は発生位置・発生源速度と、その位置が表す時刻(エポック)。積分前の座標から
  // 生成する場合も、その座標の時刻をそのまま渡せば取り残されない。
  private spawn(state: KinematicState, kind: FlashKind, duration: number, sizeScale = 1): void {
    this.effects.push({ kind, state, age: 0, duration, sizeScale });
  }
}
