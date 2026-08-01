// Stage Practice: 軌道計画モード([M])の操作練習に特化したステージ。敵は出現せず、勝敗判定もない。
import * as C from '../const';
import { Stage } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';

export class StagePractice extends Stage {
  static readonly id = 'practice' as const;
  readonly selectLabel = 'stage practice';
  readonly selectSub = '【軌道操作練習】 常時選択可。敵は出現しない。軌道計画モードでのノード配置・Δv調整にじっくり集中できる';
  readonly selectKeys = ['KeyP'];
  readonly initialAmmo = { mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS };

  // 練習ステージの案内文言を返す。
  briefingHtml(): string {
    return (
      '<b>練習ステージ: 敵は出現しない</b><br>' +
      `[${K.toggleMapMode.label}] キーで軌道計画モードに入り、ノード配置やΔv調整を練習せよ<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 敵を配置せず、初期敵数 0 を返す。
  init(): number {
    return 0;
  }

  // 補給ロジスティクスのみを1フレーム分進める。
  update(_dt: number, player: Player, _entities: EntityManager, simTime: number, _simSpeed: SimSpeedManager): void {
    if (!this.isPlaying) return;
    this.logistics.updateLogistics(simTime, player);
  }

  checkWin(): boolean { return false; }
  onWin(): void { }
}
