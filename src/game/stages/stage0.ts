// Stage 0: 近傍の色分けクラスタを制限時間内に何機撃墜できるかのスコアアタック。タイムアップで終了。
import { Stage, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { generateCluster, STAGE0_PER_GROUP, STAGE0_MAX_RANGE, COLOR_STAGE0_GROUP_ACCENTS } from './spawner/enemy-spawner';
import { ScoreAttackTimer, type SerializedScoreAttackTimer } from './stage-utils/score-attack-timer';
import type { ScoreCounter } from './stage-utils/score-counter';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';

// 制限時間 [実秒]。
const STAGE0_TIME_LIMIT = 120;
const STAGE0_LOGISTICS_INITIAL_AMMO = 4; // 開始時に浮かべておく補給の数
const STAGE0_LOGISTICS_MIN_DIST = 75; // 補給の配置距離 [m](自機から)
const STAGE0_LOGISTICS_MAX_DIST = 225;

// 制限時間を分単位で表す。
const stage0TimeLimitMinutes = (): number => Math.floor(STAGE0_TIME_LIMIT / 60);

export interface SerializedStage0 extends SerializedStage {
  readonly timeLeft: SerializedScoreAttackTimer;
}

export class Stage0 extends Stage {
  static readonly id = '0' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'stage 0';
  static readonly selectSub =
    `【近接戦闘訓練】 常時選択可。${STAGE0_MAX_RANGE / 1000}km以内に色分けされた敵集団 ` +
    `約${STAGE0_PER_GROUP * COLOR_STAGE0_GROUP_ACCENTS.length}機、` +
    `制限時間${stage0TimeLimitMinutes()}分の撃墜数スコアアタック`;
  static readonly selectKey = 'KeyT';

  private readonly timer: ScoreAttackTimer;

  // 保存があれば残り時間を引き継いでタイマーを組む。
  constructor(saved: SerializedStage | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.timer = new ScoreAttackTimer((saved as SerializedStage0 | undefined)?.timeLeft ?? STAGE0_TIME_LIMIT);
    this.begin();
  }

  // ステージ開始時のブリーフィング文言を返す。
  briefingHtml(): string {
    return (
      `<b>訓練ステージ: 制限時間 ${stage0TimeLimitMinutes()}分で何機撃墜できるか</b><br>` +
      `周囲${STAGE0_MAX_RANGE / 1000}km以内の色分けされた集団を撃墜せよ — RCS の並進と回転の練習に最適<br>` +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 弾薬ゼロの自機を置き、初期補給と敵クラスタを配置する。
  protected init(): void {
    const player = this.addPlayer({ ammo: { mags: 0, rounds: 0 } });
    for (let i = 0; i < STAGE0_LOGISTICS_INITIAL_AMMO; i++) {
      this.logistics.spawnForPlayer(player, STAGE0_LOGISTICS_MIN_DIST, STAGE0_LOGISTICS_MAX_DIST);
    }
    const enemies = generateCluster(
      player.motion.state, this._celestialSystem.celestialMotions,
      this._scene, this._dynamicSystem.idAllocators,
    );
    for (const enemy of enemies) this.addEnemy(enemy);
  }
  // 補給と制限時間を1フレーム分進める。
  update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed);

    if (this.timer.update(dt)) {
      this.decide('timeup', { win: true, title: 'TIME UP', detailHtml: scoreAttackDetailHtml(this.scoreCounter) });
    }
  }

  checkWin(): boolean { return false; }
  onWin(): void { }

  // 残り時間を HUD 表示用の文字列で返す。
  hudSubStatus(): string {
    return `残り時間: ${Math.ceil(this.timer.timeLeft)}秒`;
  }

  serialize(): SerializedStage0 {
    return { ...super.serialize(), timeLeft: this.timer.serialize() };
  }
}

// 撃墜数・命中率をまとめたタイムアップ画面の本文。
function scoreAttackDetailHtml(scoreCounter: ScoreCounter): string {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  return `撃墜数 ${kills} 機<br>発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
}
