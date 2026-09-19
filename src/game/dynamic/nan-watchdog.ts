// シミュレーション状態が NaN / Infinity に汚染された瞬間を捕まえ、出来事として記録する見張り。
// 非有限値は接触などを通じて静かに広がり、別の症状(3D 画面が真っ暗になる・消えるべき個体が残る)で
// 表面化するので、最初に壊れたフェーズと対象をその場で記録する。一度検出したら以後の検査を止める。
import type { SimulationControlled, SimulationState } from './dynamic-simulation-participant';
import type { RunEventBody, RunEventSink } from '../run-events';
import type { Vec3 } from '../../math/vec3';

// 全成分が有限値かどうかを返す。
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export class NanWatchdog {
  // 壊れた値を報告済みか。
  private tripped = false;

  constructor(private readonly events: RunEventSink) { }

  // 操作対象と simTime を見る軽い検査。phase には直前に走ったフェーズの名を渡す(そこが発生源と
  // 分かる)。controlled が null なら何もしない。
  checkControlled(
    phase: string, controlled: SimulationControlled | null, simTime: number, dt: number, simDt: number,
  ): void {
    if (this.tripped || !controlled) return;
    // 位置・速度・姿勢・角速度と時刻がすべて有限か
    const { q, w } = controlled.att;
    const ok = finiteVec(controlled.state.r) && finiteVec(controlled.state.v)
      && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
      && finiteVec(w)
      && Number.isFinite(simTime);
    if (ok) return;
    this.report({
      kind: 'controlledStateCorrupted',
      phase, state: controlled.state, attitude: controlled.att, simTime, dt, simDt,
    });
  }

  // 操作対象に加えて全エンティティの位置・速度を見る重い検査。操作対象の汚染は、先に壊れた他の
  // エンティティ(薬莢・破片・弾)から接触で伝わることが多い。フレームにつき一度だけ呼ぶこと。
  checkAll(
    phase: string, controlled: SimulationControlled | null, entities: readonly SimulationState[],
    simTime: number, dt: number, simDt: number,
  ): void {
    if (this.tripped) return;
    this.checkControlled(phase, controlled, simTime, dt, simDt);
    if (this.tripped) return;
    // 最初に見つかった1体だけを報告する
    for (const e of entities) {
      if (finiteVec(e.state.r) && finiteVec(e.state.v)) continue;
      this.report({
        kind: 'entityStateCorrupted',
        phase, subject: e.constructor.name, state: e.state, dt, simDt,
      });
      return;
    }
  }

  // 壊れた値を原因追跡のためのコンソールと出来事の記録へ流し、以後の検査を止める。
  private report(body: RunEventBody): void {
    this.tripped = true;
    console.error('[NanWatchdog]', body);
    this.events.record(body);
  }
}
