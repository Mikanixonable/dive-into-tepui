// サブステップを区切るべき次の絶対時刻。ステージ側(マニューバの点火・燃焼終了)と個体側
// (弾の寿命・接触猶予・自動操縦の燃焼)の締切のうち、最も早いものを算出・返却する。
import type { DynamicSimulationRoster } from './dynamic-simulation-participant';
import type { StageSimulationEvents } from '../stages/stage-simulation-events';

export class NextEventTime {
  // simTime 以降で最も早い締切。無ければ null。個体側の時刻は計画・燃焼予定のような
  // 実行中に変わりうる生きた値なので、毎回引き直す。
  public at(simTime: number, activeStage: StageSimulationEvents, roster: DynamicSimulationRoster): number | null {
    const stage = activeStage.nextSimulationEventTime(simTime);
    const entity = this.entityEventTime(simTime, roster);
    if (stage === null) return entity;
    if (entity === null) return stage;
    return Math.min(stage, entity);
  }

  // 生存中の全個体が持つ締切のうち最も早いもの。
  private entityEventTime(simTime: number, roster: DynamicSimulationRoster): number | null {
    let next: number | null = null;
    for (const e of roster.allMotions()) {
      if (!e.alive) continue;
      const t = e.nextSimulationEventTime(simTime);
      if (t !== null && (next === null || t < next)) next = t;
    }
    return next;
  }
}
