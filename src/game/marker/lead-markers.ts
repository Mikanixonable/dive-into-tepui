// LEAD(見越し)マーカー: 自機の弾がその敵に命中する未来位置を示す。
import { leadPoint } from '../../physics/intercept';
import type { Vec3 } from '../../math/vec3';
import type { ViewMode } from '../../render/view-mode';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import { MARKER_PRIORITY } from './marker-priority';
import { pointPlacement } from './marker-placement';
import type { CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import { Player } from '../player/player';
import { COLOR_MARKER_ALLY } from './marker-identity';
import type { ProjectFn } from '../../math/projection';

const LEAD_MAX_TIME = 25; // 表示する見越し解の、命中までの最長時間 [s]

const markerKey = (target: CombatTarget): string => `lead-${target.id}`;

export class LeadMarkers {
  private readonly declarations: MarkerDeclaration[] = [];

  public constructor(private readonly group: MarkerSink) { }

  // 所有するマーカー群を取り除く。
  public dispose(): void { this.group.dispose(); }

  // target の LEAD マーカーを置き、それ以外を片付ける。マップビューでは全て片付ける。
  public sync(
    player: Player | null,
    targetsArray: readonly CombatTarget[],
    target: CombatTarget | null,
    view: ViewMode,
    project: ProjectFn,
    nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    // 現在のターゲットだけリード点を求める。ターゲットから外れた敵の宣言はこのフレームで消える。
    if (player !== null && view !== 'map' && target !== null && targetsArray.includes(target)) {
      const lead = leadPoint(
        target.motion.state, player.motion.state, player.averageMuzzleVelocity, LEAD_MAX_TIME,
      );
      if (lead !== null) declarations.push(this.declaration(target, lead, project));
    }
    this.group.sync(declarations, nowMs);
  }

  // 見越し点1件の宣言。主照準とは反対向き(逆三角形方向)の三尖星を、線だけで描く。
  private declaration(
    target: CombatTarget, lead: Vec3, project: ProjectFn,
  ): MarkerDeclaration {
    // 中央に小さな切り欠きを残すことで、敵マーカーや照準と識別しやすくする。
    const star = '<svg viewBox="0 0 24 24" width="24" height="24" aria-label="LEAD"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="butt"><path d="M12 14.3V22"/><path d="M12 14.3V22" transform="rotate(120 12 12)"/><path d="M12 14.3V22" transform="rotate(240 12 12)"/></g></svg>';
    const color = 'accentColor' in target ? (target as { accentColor: string }).accentColor : COLOR_MARKER_ALLY;
    const { x, y, front } = pointPlacement(lead, project);
    return {
      id: markerKey(target), cls: 'mk-lead', sym: star, markup: true,
      x, y, front, color, priority: MARKER_PRIORITY.NONE, iconHidable: false,
    };
  }
}
