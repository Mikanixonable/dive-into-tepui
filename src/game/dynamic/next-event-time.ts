// サブステップを区切るべき次の絶対時刻。ステージ側(マニューバの点火・燃焼終了)と個体側
// (弾の寿命など)の締切のうち、最も早いものを答える。
import type { DynamicSystem } from './dynamic-system';
import type { Stage } from '../stages/stage';

export class NextEventTime {
  // 個体側の最小イベント時刻の控えと、それを求めたときの顔ぶれの世代。
  private cached: number | null = null;
  private valid = false;
  private revision = -1;

  // simTime 以降で最も早い締切。無ければ null。ステージ側の時刻は艦の現在の Δv と加速度から
  // 毎回決まる生きた値なので、毎回引き直す。
  at(simTime: number, activeStage: Stage, entities: DynamicSystem): number | null {
    const stage = activeStage.nextSimulationEventTime(simTime);
    const entity = this.entityEventTime(simTime, entities);
    if (stage === null) return entity;
    if (entity === null) return stage;
    return Math.min(stage, entity);
  }

  // 個体側の締切は固定の絶対時刻なので、控えた時刻を simTime が越えたときと、顔ぶれの世代が
  // 変わったときにだけ全走査で引き直す。
  private entityEventTime(simTime: number, entities: DynamicSystem): number | null {
    const revision = entities.collectionRevision;
    const stale = !this.valid
      || this.revision !== revision
      || (this.cached !== null && this.cached <= simTime);
    if (!stale) return this.cached;

    let next: number | null = null;
    for (const e of entities.all()) {
      if (!e.alive) continue;
      const t = e.nextSimulationEventTime(simTime);
      if (t !== null && (next === null || t < next)) next = t;
    }
    this.cached = next;
    this.valid = true;
    this.revision = revision;
    return next;
  }
}
