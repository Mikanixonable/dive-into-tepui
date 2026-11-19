// 撃墜・自機喪失の瞬間にゲーム世界の時計を短く遅らせる止め。表示側が進行の記録した出来事を
// 読んで倍率を立て、進行へは worldTimeScale として掛け算で渡す。物理の規則は変わらず時計が
// 遅れるだけの演出(SPEC COMBAT.md「撃墜の止め」)。
import type { RunEvent } from './run-events';

// 敵機の撃破(弾・剛体接触)。
const KILL_STOP_SECONDS = 0.25;
const KILL_STOP_SCALE = 0.2;
// 自機の喪失。
const LOSS_STOP_SECONDS = 0.6;
const LOSS_STOP_SCALE = 0.1;
// 終わりへ向かって等倍へ戻す区間の、全体に対する割合。
const RECOVER_FRACTION = 0.3;

export class KillStop {
  private duration = 0;
  private remaining = 0;
  private floor = 1;

  // このフレームに進行が記録した出来事から止めを立てる。時間加速 ×1 のときだけ働き、ポーズ中・
  // 建造中は立たない。最中に重なる出来事は残りの長い方へ揃え、足し合わせて延ばすことはしない。
  public observe(
    events: readonly RunEvent[], simSpeed: number, paused: boolean, constructing: boolean,
  ): void {
    if (simSpeed !== 1 || paused || constructing) return;
    for (const event of events) {
      const body = event.body;
      if (body.kind === 'shipExploded' && body.owner === 'player') {
        this.begin(LOSS_STOP_SECONDS, LOSS_STOP_SCALE);
      } else if (
        body.kind === 'enemyDied' && (body.cause === 'killed' || body.cause === 'collision')
      ) {
        this.begin(KILL_STOP_SECONDS, KILL_STOP_SCALE);
      }
    }
  }

  // 実時間の経過 dt [s] で残りを減らす。
  public advance(dt: number): void {
    this.remaining = Math.max(0, this.remaining - dt);
  }

  // 進行へ掛ける時計の倍率。止めの最中は floor、終わりの区間で線形に 1 へ戻す。
  public get worldTimeScale(): number {
    if (this.remaining <= 0) return 1;
    const edge = this.duration * RECOVER_FRACTION;
    if (this.remaining > edge) return this.floor;
    return this.floor + (1 - this.floor) * (1 - this.remaining / edge);
  }

  private begin(duration: number, scale: number): void {
    if (duration <= this.remaining) return;
    this.duration = duration;
    this.remaining = duration;
    this.floor = scale;
  }
}
