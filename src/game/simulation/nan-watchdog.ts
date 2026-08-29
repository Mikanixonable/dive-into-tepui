// シミュレーション状態が NaN / Infinity に汚染された瞬間を捕まえて報告する見張り。
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
// 一度検出したら以後は何もしない(ログの洪水と、汚染後の無意味な検査を避ける)。
import { Hud } from '../hud/hud';
import { Player } from '../player/player';
import { DynamicEntity } from '../dynamic/dynamic-entity/dynamic-entity';
import { EntityManager } from './entity-manager';
import { Vec3 } from '../../math/vec3';

// 全成分が有限値かどうかを返す。
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// エンティティの位置・速度を報告文言用の文字列にする。
function describe(entity: DynamicEntity): string {
  const { r, v } = entity.state;
  return `r=(${r.x},${r.y},${r.z}) v=(${v.x},${v.y},${v.z})`;
}

export class NanWatchdog {
  private tripped = false;

  constructor(private readonly _hud: Hud) { }

  get hasTripped(): boolean { return this.tripped; }

  // 自機と simTime だけを見る軽い検査。update の各フェーズ境界で呼ぶ。
  // phase には「直前に何が走ったか」を渡す(そこが発生源だと分かる)。艦がいなければ何もしない。
  checkPlayer(phase: string, player: Player | null, simTime: number, dt: number, simDt: number): void {
    if (this.tripped || !player) return;
    const { q, w } = player.att;
    const ok = finiteVec(player.state.r) && finiteVec(player.state.v)
      && Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
      && finiteVec(w)
      && Number.isFinite(simTime);
    if (ok) return;
    this.trip(phase, `player ${describe(player)} q=(${q.x},${q.y},${q.z},${q.w}) w=(${w.x},${w.y},${w.z}) simTime=${simTime}`, dt, simDt);
  }

  // 全エンティティを走査する重い検査。自機より先に汚染されるのは他のエンティティ
  // (薬莢・破片・弾)であることが多く、それが接触を通じて自機へ伝播する。
  // フレームにつき一度だけ呼ぶこと。
  checkAll(phase: string, player: Player | null, entities: EntityManager, simTime: number, dt: number, simDt: number): void {
    if (this.tripped) return;
    this.checkPlayer(phase, player, simTime, dt, simDt);
    if (this.tripped) return;
    for (const e of entities.all()) {
      if (finiteVec(e.state.r) && finiteVec(e.state.v)) continue;
      this.trip(phase, `${e.constructor.name} ${describe(e)}`, dt, simDt);
      return;
    }
  }

  // 検出結果をコンソールと HUD トーストへ報告し、以後の検査を止める。
  private trip(phase: string, detail: string, dt: number, simDt: number): void {
    this.tripped = true;
    const message = `シミュレーション状態が壊れました(NaN/Infinity)。phase=${phase} dt=${dt} simDt=${simDt} — ${detail}`;
    console.error('[NanWatchdog]', message);
    this._hud.toast(`<b>内部エラー: ${message}</b>`, 60000);
  }
}
