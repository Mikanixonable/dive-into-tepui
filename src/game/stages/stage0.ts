// Stage 0: 近傍の色分けクラスタを制限時間内に何機撃墜できるかのスコアアタック。タイムアップで終了。
import { Stage, type CommonStageState, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { generateCluster, STAGE0_PER_GROUP, STAGE0_MAX_RANGE, COLOR_STAGE0_GROUP_ACCENTS } from './spawner/enemy-spawner';
import { ScoreAttackTimer, type SerializedScoreAttackTimer } from './stage-utils/score-attack-timer';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { ScoreCounter } from './stage-utils/score-counter';

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
  public static readonly id = '0' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'stage 0';
  public static readonly selectSub =
    `【近接戦闘訓練】 常時選択可。${STAGE0_MAX_RANGE / 1000}km以内に色分けされた敵集団 ` +
    `約${STAGE0_PER_GROUP * COLOR_STAGE0_GROUP_ACCENTS.length}機、` +
    `制限時間${stage0TimeLimitMinutes()}分の撃墜数スコアアタック`;
  public static readonly selectKey = 'KeyT';

  // 制限時間のタイマーと共通の状態から組む。省いたタイマーは制限時間いっぱいから始まる。
  private constructor(
    deps: StageDeps,
    private readonly timer = new ScoreAttackTimer(STAGE0_TIME_LIMIT),
    ...common: CommonStageState
  ) {
    super(deps, ...common);
  }

  // 弾薬ゼロの自機を置き、初期補給と敵クラスタを配置して始める。
  public static create(...deps: StageDeps): Stage0 {
    const stage = new Stage0(deps);
    // 弾切れの自機のまわりに補給を浮かべる
    const player = stage.addPlayer({ ammo: { mags: 0, rounds: 0 } });
    for (let i = 0; i < STAGE0_LOGISTICS_INITIAL_AMMO; i++) {
      stage.logistics.spawnForPlayer(player, STAGE0_LOGISTICS_MIN_DIST, STAGE0_LOGISTICS_MAX_DIST);
    }
    // 自機の近傍に色分けクラスタを置く
    const enemies = generateCluster(
      player.motion.state, stage._celestialSystem.celestialMotions,
      stage._scene, stage._dynamicSystem.idAllocators,
    );
    for (const enemy of enemies) stage.addEnemy(enemy);
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedStage0 | null, ...deps: StageDeps): Stage0 {
    const timeLeft = serialized?.timeLeft;
    return new Stage0(
      deps,
      // null も欠けと同じく制限時間いっぱいから始める(既定引数は undefined でしか働かない)。
      timeLeft == null ? undefined : ScoreAttackTimer.deserialize(timeLeft),
      ...Stage.deserializeCommonState(serialized, deps, Stage0.stageRules),
    );
  }

  // ステージ開始時のブリーフィング文言を返す。
  protected briefingHtml(): string {
    return (
      `<b>訓練ステージ: 制限時間 ${stage0TimeLimitMinutes()}分で何機撃墜できるか</b><br>` +
      `周囲${STAGE0_MAX_RANGE / 1000}km以内の色分けされた集団を撃墜せよ — RCS の並進と回転の練習に最適<br>` +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 補給と制限時間を1フレーム分進める。
  public update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed);

    if (this.timer.update(dt)) {
      this.decide('timeup', { win: true, title: 'TIME UP', detailHtml: scoreAttackDetailHtml(this.scoreCounter) });
    }
  }

  // 撃破数では決着させず、制限時間切れを決着とする。
  protected checkWin(): boolean { return false; }
  protected onWin(): void { }

  // 残り時間を HUD 表示用の文字列で返す。
  protected hudSubStatus(): string {
    return `残り時間: ${Math.ceil(this.timer.timeLeft)}秒`;
  }

  // 共通の内訳へ残り時間を足して直列化する。
  public serialize(): SerializedStage0 {
    return { ...super.serialize(), timeLeft: this.timer.serialize() };
  }
}

// 撃墜数・命中率をまとめたタイムアップ画面の本文。
function scoreAttackDetailHtml(scoreCounter: ScoreCounter): string {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  return `撃墜数 ${kills} 機<br>発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
}
