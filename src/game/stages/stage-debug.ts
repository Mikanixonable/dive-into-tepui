// デバッグ用ステージ: 敵集団1つのみを配置し、勝敗を発生させずに検証を続けられる。
// 敵の射撃 ON/OFF をパネルから切り替えられる。タイトルの通常ボタン列には出ない。
import { Stage } from './stage';
import { generateCluster } from './spawner/enemy-spawner';
import { SegmentedControl } from '../hud/buttons';
import { ACCENT, EDGE, SURFACE, TEXT } from '../theme';
import * as C from '../const';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';

type FireToggle = 'on' | 'off';

const DEBUG_ENEMY_COUNT = 5;

export class StageDebug extends Stage {
  static readonly id = 'debug' as const;
  readonly selectLabel = 'DEBUG';
  readonly selectSub = '【デバッグ】敵集団1つ・撃破しても終了しない・敵の射撃を実行中に切替可能';
  readonly hiddenFromSelect = true;
  readonly selectKeys = ['KeyD'];
  readonly initialAmmo = { mags: 20, rounds: C.MAG_ROUNDS };

  private enemyFireEnabled = true;
  private panel!: HTMLElement;
  private fireToggle!: SegmentedControl<FireToggle>;

  // デバッグステージのブリーフィング文言を返す。
  briefingHtml(enemyCount: number): string {
    return `<b>デバッグステージ</b><br>敵集団 ${enemyCount} 機。撃破しても終了しない。パネルから敵の射撃を切替可能`;
  }

  // 敵集団を1つだけ生成し、射撃切替パネルを組み立てる。
  init(player: Player, entities: EntityManager): number {
    const enemies = generateCluster(player.state, this._hud, this._sfx, this._fx, this._scene, 1, DEBUG_ENEMY_COUNT);
    for (const enemy of enemies) this.addEnemy(enemy, entities);
    this.buildPanel();
    return enemies.length;
  }

  // 射撃切替パネルの DOM を組み立て、hud.root へ追加する。
  private buildPanel(): void {
    this.panel = document.createElement('div');
    this.panel.style.cssText =
      `position: absolute; top: 12px; right: 340px; width: 200px; box-sizing: border-box; ` +
      `background: ${SURFACE}; border: 1px solid ${EDGE}; border-radius: 4px; padding: 10px 14px; color: ${TEXT};`;
    const title = document.createElement('h3');
    title.style.cssText = `font-size: 11px; letter-spacing: 2.5px; color: ${ACCENT}; margin-bottom: 6px;`;
    title.textContent = 'DEBUG';
    this.panel.appendChild(title);

    // 選択は enemyFireEnabled へ入るだけで、敵への反映は update が毎フレーム行う
    this.fireToggle = new SegmentedControl<FireToggle>(
      '敵射撃',
      [
        ['on', 'ON'],
        ['off', 'OFF'],
      ],
      (value) => { this.enemyFireEnabled = value === 'on'; },
    );
    this.panel.appendChild(this.fireToggle.element);
    this.fireToggle.setSelected('on');

    this._hud.root.appendChild(this.panel);
  }

  // 敵の行動を進め、射撃許可を毎フレーム自ステージの敵全体へ反映する。
  update(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying) return;
    for (const e of entities.enemies) e.fireEnabled = this.enemyFireEnabled;
    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);
  }

  // 検証を継続できるよう、勝敗を発生させない。
  checkWin(): boolean {
    return false;
  }

  // 敵の射撃 ON/OFF の現在値を表示する。
  hudSubStatus(): string {
    return `敵射撃: ${this.enemyFireEnabled ? 'ON' : 'OFF'}`;
  }
}
