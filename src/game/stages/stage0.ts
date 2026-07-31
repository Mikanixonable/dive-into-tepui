// Stage 0: 近傍の色分けクラスタを制限時間内に何機撃墜できるかのスコアアタック。タイムアップで終了。
import * as C from '../const';
import { Stage } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { showScoreAttackResultScreen } from '../hud/result-screen';
import { generateCluster } from './spawner/enemy-spawner';
import { ScoreAttackTimer } from './stage-utils/score-attack-timer';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';

// 制限時間を分単位で表す(選択画面の説明文とブリーフィングの両方から参照する)
const stage0TimeLimitMinutes = (): number => Math.floor(C.STAGE0_TIME_LIMIT / 60);

export class Stage0 extends Stage {
  static readonly id = '0' as const;
  readonly selectLabel = '[T] 訓練ステージ — 近接戦闘訓練 (Stage 0)';
  readonly selectSub =
    `常時選択可。${C.STAGE0_MAX_RANGE / 1000}km以内に色分けされた敵集団 ` +
    `約${C.STAGE0_PER_GROUP * C.STAGE0_GROUP_ACCENTS.length}機、` +
    `制限時間${stage0TimeLimitMinutes()}分の撃墜数スコアアタック`;
  readonly selectKeys = ['KeyT'];
  readonly initialAmmo = { mags: 0, rounds: 0 };

  private readonly timer = new ScoreAttackTimer(C.STAGE0_TIME_LIMIT);

  briefingHtml(): string {
    return (
      `<b>訓練ステージ: 制限時間 ${stage0TimeLimitMinutes()}分で何機撃墜できるか</b><br>` +
      `周囲${C.STAGE0_MAX_RANGE / 1000}km以内の色分けされた集団を撃墜せよ — RCS の並進と回転の練習に最適<br>` +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  init(player: Player, entities: EntityManager): number {
    for (let i = 0; i < C.STAGE0_LOGISTICS_INITIAL_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE0_LOGISTICS_MIN_DIST, C.STAGE0_LOGISTICS_MAX_DIST);
    }
    const enemies = generateCluster(player.state, this._hud, this._sfx, this._fx, this._scene);
    for (const enemy of enemies) this.addEnemy(enemy, entities);
    return enemies.length;
  }
  update(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player);

    if (this.timer.update(dt, (phase) => this.setPhase(phase))) {
      showScoreAttackResultScreen(this._sfx, this.scoreCounter, 'TIME UP');
    }
  }

  checkWin(): boolean { return false; }
  onWin(): void { }

  hudSubStatus(): string {
    return `残り時間: ${Math.ceil(this.timer.timeLeft)}秒`;
  }
}
