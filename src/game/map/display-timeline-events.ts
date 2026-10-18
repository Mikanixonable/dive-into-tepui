// 時間軸へ載せる事象(操作対象の近点・遠点・赤道交点・ターゲットへの再接近点・計画のノード)を、
// 求まっているマーカーと計画から時刻順に集める。
import type { EquatorNodeManager } from '../marker/equator-node-manager';
import type { NavTargetPresenter } from '../nav-target-presenter';
import type { PlanDisplay } from '../plan/plan-display';
import type { ControlSelection } from '../control-selection';
import type { TimelineEvent } from './timeline-event';

export class DisplayTimelineEvents {
  private readonly events: TimelineEvent[] = [];

  public constructor(
    private readonly planDisplay: PlanDisplay,
    private readonly equatorNodes: EquatorNodeManager,
    private readonly navTargetPresenter: NavTargetPresenter,
    private readonly controlSelection: ControlSelection,
  ) {}

  // 今フレームの事象を時刻の昇順で返す。返した配列は次の呼び出しまで有効。
  public current(): readonly TimelineEvent[] {
    const events = this.events;
    events.length = 0;
    this.planDisplay.pushTimelineEvents(events);
    const controlled = this.controlSelection.current;
    if (controlled !== null) this.equatorNodes.pushTimelineEvents(events, controlled.id);
    this.navTargetPresenter.pushTimelineEvents(events);
    return events.sort((a, b) => a.time - b.time);
  }
}
