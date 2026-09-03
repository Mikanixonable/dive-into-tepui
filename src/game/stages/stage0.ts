// Stage 0: 近傍の色分けクラスタを制限時間内に何機撃墜できるかのスコアアタック。タイムアップで終了。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { generateCluster, STAGE0_PER_GROUP, STAGE0_MAX_RANGE, COLOR_STAGE0_GROUP_ACCENTS } from './spawner/enemy-spawner';
import { ScoreAttackTimer } from './stage-utils/score-attack-timer';
import type { ScoreCounter } from './stage-utils/score-counter';
import type { Player } from '../player/player';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { Stage0SaveData, StageSaveData } from '../save/save-data';

// 制限時間 [実秒]。選択画面の説明(stage0.ts の selectSub)とブリーフィングはこの値から
// 生成されるので、変更すればどちらも自動的に追随する。
const STAGE0_TIME_LIMIT = 120;
const STAGE0_LOGISTICS_INITIAL_AMMO = 4; // 開始時に浮かべておく補給の数
const STAGE0_LOGISTICS_MIN_DIST = 75; // 補給の配置距離 [m](自機から)
const STAGE0_LOGISTICS_MAX_DIST = 225;

// 制限時間を分単位で表す(選択画面の説明文とブリーフィングの両方から参照する)
const stage0TimeLimitMinutes = (): number => Math.floor(STAGE0_TIME_LIMIT / 60);

export class Stage0 extends Stage {
  static readonly id = '0' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'stage 0';
  static readonly selectSub =
    `【近接戦闘訓練】 常時選択可。${STAGE0_MAX_RANGE / 1000}km以内に色分けされた敵集団 ` +
    `約${STAGE0_PER_GROUP * COLOR_STAGE0_GROUP_ACCENTS.length}機、` +
    `制限時間${stage0TimeLimitMinutes()}分の撃墜数スコアアタック`;
  static readonly selectKeys = ['KeyT'];

  private readonly timer: ScoreAttackTimer;

  // saved の型を StageSaveData に留めるのは stage.ts の StageClass 一覧に
  // 収める都合(具象ごとの拡張型では構築シグネチャが揃わない)。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.timer = new ScoreAttackTimer((saved as Stage0SaveData | undefined)?.timeLeft ?? STAGE0_TIME_LIMIT);
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
  protected init(entities: DynamicSystem): void {
    const player = this.addPlayer({ ammo: { mags: 0, rounds: 0 } });
    for (let i = 0; i < STAGE0_LOGISTICS_INITIAL_AMMO; i++) {
      this.logistics.spawnForPlayer(player, STAGE0_LOGISTICS_MIN_DIST, STAGE0_LOGISTICS_MAX_DIST);
    }
    const enemies = generateCluster(player.state, this._worldSfx, this._fx, this._scene);
    for (const enemy of enemies) this.addEnemy(enemy, entities);
  }
  // 敵の行動・補給・制限時間を1フレーム分進める。
  update(dt: number, player: Player | null, entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;

    this.behaveAllEnemies(player, entities, simTime, simSpeed);

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

  serialize(): Stage0SaveData {
    return { ...super.serialize(), timeLeft: this.timer.serialize() };
  }
}

// 撃墜数・命中率をまとめたタイムアップ画面の本文。
function scoreAttackDetailHtml(scoreCounter: ScoreCounter): string {
  const { shots, hits, kills } = scoreCounter;
  const acc = shots > 0 ? ((hits / shots) * 100).toFixed(1) : '0.0';
  return `撃墜数 ${kills} 機<br>発射 ${shots} 発 / 命中 ${hits} 発 (命中率 ${acc}%)`;
}
