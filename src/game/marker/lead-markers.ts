// LEAD(見越し)マーカー: 自機の弾がその敵に命中する未来位置を示す。自機と敵の双方の
// 状態に依存するため、Enemy にも Targeter にも属さない独立責務として切り出してある。
// 一度ターゲットにした敵は、ターゲットを外した後も LEAD_HOLD_SEC の間だけ表示を続ける
// (乱戦中に狙いを移しながら撃つため)。
import * as C from '../const';
import { leadPoint } from '../../physics/intercept';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from './marker-manager';
import type { Enemy } from '../game-entity/enemy';
import type { Player } from '../player/player';

const markerKey = (enemy: Enemy): string => `lead-${enemy.name}`;

export class LeadMarkers {
  // 敵ごとの最終ロック時刻。毎フレーム生存中の敵一覧から作り直すので、撃破された敵の
  // エントリが溜まることはない。
  private lastTargeted = new Map<Enemy, number>();
  private shownKeys: readonly string[] = [];

  constructor(private readonly markerManager: MarkerManager) { }

  // 射撃できない状況(マップモード・自機喪失)では表示せず、保持していたロック履歴も捨てる。
  sync(
    player: Player,
    enemies: readonly Enemy[],
    target: Enemy | null,
    simTime: number,
    overviewMode: boolean,
    project: ProjectFn,
  ): void {
    if (overviewMode || !player.alive) {
      this.lastTargeted.clear();
      this.retire([]);
      return;
    }
    this.lastTargeted = this.trackTargeted(enemies, target, simTime);

    const shownKeys: string[] = [];
    for (const enemy of enemies) {
      const lockedAt = this.lastTargeted.get(enemy);
      if (lockedAt === undefined || simTime - lockedAt >= C.LEAD_HOLD_SEC) continue;
      const lead = leadPoint(enemy.state, player.state, C.MUZZLE_SPEED, C.LEAD_MAX_TIME);
      if (lead === null) continue;
      this.markerManager.setPosition(markerKey(enemy), 'mk-lead', '✛', lead, project, '', 1, enemy.accentColor);
      shownKeys.push(markerKey(enemy));
    }
    this.retire(shownKeys);
  }

  private trackTargeted(enemies: readonly Enemy[], target: Enemy | null, simTime: number): Map<Enemy, number> {
    const tracked = new Map<Enemy, number>();
    for (const enemy of enemies) {
      const lockedAt = enemy === target ? simTime : this.lastTargeted.get(enemy);
      if (lockedAt !== undefined) tracked.set(enemy, lockedAt);
    }
    return tracked;
  }

  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (!kept.has(key)) this.markerManager.hide(key);
    }
    this.shownKeys = keys;
  }
}
