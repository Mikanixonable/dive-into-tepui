// シミュレーション状態が NaN / Infinity に汚染された瞬間を捕まえて報告する見張り。
//
// なぜ必要か: 一度でも非有限値が混ざると、症状が「別のバグ」に化けて原因が追えなくなる。
//  - 描画: FloatingOrigin は自機状態から毎フレーム作り直されるため、自機が汚染されると
//    全メッシュの座標が NaN になり、3D 画面だけが真っ暗になる(HUD は DOM なので残る)。
//  - 敵の喪失: Enemy.checkLoss が使う `hitCelestialBody` は NaN で false になるので、
//    汚染された敵は「再突入により喪失」と誤って表示される。
//  - 剛体接触: collision.ts の距離判定は NaN を弾けず、常に「接触中」と見なして毎フレーム
//    反発と衝突音を発生させる。加えて、汚染された相手と接触した側も汚染される(伝播する)。
// つまり NaN は静かに広がってから、まったく別の顔で表面化する。発生した「フェーズ」と
// 「最初に壊れた対象」をその場で記録することが、原因特定の唯一の近道になる。
//
// 一度検出したら以後は何もしない(ログの洪水と、汚染後の無意味な検査を避ける)。
import { Hud } from './hud/hud';
import { Player } from './player/player';
import { GameEntity } from './game-entity/game-entity';
import { EntityManager } from './simulation/entity-manager';
import { Vec3 } from '../physics/vec3';

// 全成分が有限値かどうかを返す。
function finiteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// エンティティの位置・速度を報告文言用の文字列にする。
function describe(entity: GameEntity): string {
  const { r, v } = entity.state;
  return `r=(${r.x},${r.y},${r.z}) v=(${v.x},${v.y},${v.z})`;
}

export class NanWatchdog {
  private tripped = false;

  constructor(private readonly _hud: Hud) { }

  get hasTripped(): boolean { return this.tripped; }

  // 自機と simTime だけを見る軽い検査。update の各フェーズ境界で呼ぶ。
  // phase には「直前に何が走ったか」を渡す(そこが発生源だと分かる)。
  checkPlayer(phase: string, player: Player, simTime: number, dt: number, simDt: number): void {
    if (this.tripped) return;
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
  checkAll(phase: string, player: Player, entities: EntityManager, simTime: number, dt: number, simDt: number): void {
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
