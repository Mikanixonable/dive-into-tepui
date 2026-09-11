// LEAD(見越し)マーカー: 自機の弾がその敵に命中する未来位置を示す。
import { leadPoint } from '../../physics/intercept';
import type { ViewMode } from '../../render/view-mode';
import type { MarkerSlots } from './marker-slots';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { Player } from '../player/player';
import { COLOR_MARKER_ALLY } from './marker-identity';
import type { ProjectFn } from '../../math/projection';

const LEAD_MAX_TIME = 25; // 表示する見越し解の、命中までの最長時間 [s]

const markerKey = (target: CombatTarget): string => `lead-${target.id}`;

export class LeadMarkers {
  private shownKeys: readonly string[] = [];

  public constructor(private readonly markers: MarkerSlots) { }

  // target の LEAD マーカーを置き、それ以外を片付ける。マップビューでは全て片付ける。
  public sync(
    player: Player,
    targetsArray: readonly CombatTarget[],
    target: CombatTarget | null,
    _simTime: number,
    view: ViewMode,
    project: ProjectFn,
  ): void {
    if (view === 'map') {
      this.retire([]);
      return;
    }

    // 現在のターゲットだけリード点を求める。ターゲットから外れた
    // 敵はこのフレームの retire で直ちにマーカーを除去する。
    const shownKeys: string[] = [];
    const targets: CombatTarget[] = [];
    if (target && targetsArray.includes(target)) targets.push(target);
    for (const tgt of targets) {
      const lead = leadPoint(
        tgt.motion.state, player.motion.state, player.averageMuzzleVelocity, LEAD_MAX_TIME,
      );
      if (lead === null) continue;
      // 主照準とは反対向き（逆三角形方向）の三尖星。線だけで描き、中央に
      // 小さな切り欠きを残すことで、敵マーカーや照準と識別しやすくする。
      const star = '<svg viewBox="0 0 24 24" width="24" height="24" aria-label="LEAD"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 14.3V22"/><path d="M12 14.3V22" transform="rotate(120 12 12)"/><path d="M12 14.3V22" transform="rotate(240 12 12)"/></g></svg>';
      const color = 'accentColor' in tgt ? (tgt as { accentColor: string }).accentColor : COLOR_MARKER_ALLY;
      this.markers.setPosition(markerKey(tgt), 'mk-lead', star, lead, project, '', 1, color, undefined, true);
      shownKeys.push(markerKey(tgt));
    }
    this.retire(shownKeys);
  }

  // 前フレームに出して keys に無いマーカーを DOM ごと片付ける。key は敵ごとに一意で増え続けるので、
  // 隠さずに消す。
  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (!kept.has(key)) this.markers.remove(key);
    }
    this.shownKeys = keys;
  }
}
