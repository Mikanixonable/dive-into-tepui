// シミュレーション状態が NaN / Infinity に汚染された瞬間を捕まえ、出来事として記録する見張り。
//
// なぜ必要か: 一度でも非有限値が混ざると、症状が「別のバグ」に化けて原因が追えなくなる。
//  - 描画: FloatingOrigin は自機状態から毎フレーム作り直されるため、自機が汚染されると
//    全メッシュの座標が NaN になり、3D 画面だけが真っ暗になる(HUD は DOM なので残る)。
//  - 喪失判定: checkLoss の大気密度の判定は NaN で false になるので、汚染されたエンティティは
//    死ぬべき条件でも死なず、症状が別の形(消えない)で表面化する。
//  - 剛体接触: 接触は伝播経路そのものなので、contact-participant.ts は参加者の段階で
//    位置・速度・半径・質量の**4つすべて**が有限であることを確かめ、欠けたものを候補にすら
//    入れない。4つ揃って見る必要があるのは、非有限値との比較が常に false になるからである
//    — 位置だけを見る距離判定は、速度だけが非有限な物体を素通りさせ、その先で法線方向
//    相対速度が NaN になり、離反判定も NaN に対して false になって撃力の分岐へ落ち、
//    接触した相手の速度まで NaN で上書きしてしまう。この4つのどれか1つでも見落とすと、
//    そこが伝播経路として残る。
// つまり NaN は静かに広がってから、まったく別の顔で表面化する。発生した「フェーズ」と
// 「最初に壊れた対象」をその場で記録することが、原因特定の唯一の近道になる。
//
// 一度検出したら以後は何もしない(告知の洪水と、汚染後の無意味な検査を避ける)。
import type { SimulationControlled, SimulationState } from './dynamic-simulation-participant';
import type { RunEventBody, RunEventSink } from '../run-events';
import type { Vec3 } from '../../math/vec3';

// 全成分が有限値かどうかを返す。
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export class NanWatchdog {
  // 壊れた値を一度報告したか(キャッシュ)。報告を1回に留めるためだけに持つ。
  private tripped = false;

  constructor(private readonly events: RunEventSink) { }

  // 操作対象と simTime だけを見る軽い検査。update の各フェーズ境界で呼ぶ。
  // phase には「直前に何が走ったか」を渡す(そこが発生源だと分かる)。操作対象がいなければ何もしない。
  checkControlled(
    phase: string, controlled: SimulationControlled | null, simTime: number, dt: number, simDt: number,
  ): void {
    if (this.tripped || !controlled) return;
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

  // 全エンティティを走査する重い検査。操作対象より先に汚染されるのは他のエンティティ
  // (薬莢・破片・弾)であることが多く、それが接触を通じて操作対象へ伝播する。
  // フレームにつき一度だけ呼ぶこと。
  checkAll(
    phase: string, controlled: SimulationControlled | null, entities: readonly SimulationState[],
    simTime: number, dt: number, simDt: number,
  ): void {
    if (this.tripped) return;
    this.checkControlled(phase, controlled, simTime, dt, simDt);
    if (this.tripped) return;
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
