// LEAD(見越し)マーカー: 自機の弾がその敵に命中する未来位置を示す。自機と敵の双方の
// 状態に依存するため、Enemy にも Targeter にも属さない独立責務として切り出してある。
import * as C from '../const';
import { leadPoint } from '../../physics/intercept';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from './marker-manager';
import type { CombatTarget } from '../targeter';
import { Player } from '../player/player';

const markerKey = (target: CombatTarget): string => target instanceof Player ? `lead-p-${target.id}` : `lead-e-${target.name}`;

export class LeadMarkers {
  private shownKeys: readonly string[] = [];

  constructor(private readonly markerManager: MarkerManager) { }

  // 射撃できない状況(マップモード・自機喪失)では表示せず、保持していたロック履歴も捨てる。
  sync(
    player: Player,
    targetsArray: readonly CombatTarget[],
    target: CombatTarget | null,
    secondaryTarget: CombatTarget | null,
    _simTime: number,
    overviewMode: boolean,
    project: ProjectFn,
  ): void {
    if (overviewMode || !player.alive) {
      this.retire([]);
      return;
    }

    // 現在の主/第二ターゲットだけリード点を求める。ターゲットから外れた
    // 敵はこのフレームの retire で直ちにマーカーを除去する。
    const shownKeys: string[] = [];
    const targets: CombatTarget[] = [];
    if (target && targetsArray.includes(target)) targets.push(target);
    if (secondaryTarget && secondaryTarget !== target && targetsArray.includes(secondaryTarget)) targets.push(secondaryTarget);
    for (const tgt of targets) {
      const lead = leadPoint(tgt.state, player.state, player.averageMuzzleVelocity, C.LEAD_MAX_TIME);
      if (lead === null) continue;
      // 主照準とは反対向き（逆三角形方向）の三尖星。線だけで描き、中央に
      // 小さな切り欠きを残すことで、敵マーカーや照準と識別しやすくする。
      const star = '<svg viewBox="0 0 24 24" width="24" height="24" aria-label="LEAD"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 14.3V22"/><path d="M12 14.3V22" transform="rotate(120 12 12)"/><path d="M12 14.3V22" transform="rotate(240 12 12)"/></g></svg>';
      const color = tgt instanceof Player ? '#00ffff' : tgt.accentColor;
      this.markerManager.setPosition(markerKey(tgt), 'mk-lead', star, lead, project, '', 1, color, undefined, true);
      shownKeys.push(markerKey(tgt));
    }
    this.retire(shownKeys);
  }

  // key は敵ごとに一意で増え続けるため hide ではなく remove で DOM ごと片付ける。
  // マップモード突入・自機喪失のたびに sync が retire([]) を呼んで全消去するが、
  // マーカーの生成自体はマップの開閉ごとに一度きりで毎フレームではないため、
  // 戦闘ビューへ戻った際の再生成コストは無視できる。
  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (!kept.has(key)) this.markerManager.remove(key);
    }
    this.shownKeys = keys;
  }
}
