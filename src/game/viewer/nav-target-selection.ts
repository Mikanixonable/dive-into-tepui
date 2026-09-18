// 航法ターゲットの選択。何をターゲットにしているかを id と表示名で持ち、遊ぶ人の命令と、
// 進行が記録した出来事で差し替わる。
import { combatTargetById, type CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEvent, RunEventSink } from '../run-events';

export interface SerializedNavTargetSelection {
  readonly id: string;
  readonly name: string;
}

// 航法ターゲットを読む口。
export interface NavTargetSource {
  // 現在のターゲットの id。未設定なら null。
  readonly id: string | null;
  // 現在のターゲットの表示名。未設定なら null。
  readonly name: string | null;
}

// saved が指す id をターゲットへ戻せるか。撃墜・破壊されて名簿に残っている敵・自艦・基地を指して
// いれば false。天体・ラグランジュ点のように消滅しない対象と、名簿に無い id は true。
function isRestorable(saved: SerializedNavTargetSelection, roster: EntityRoster): boolean {
  const combatTarget = combatTargetById(roster.all(), saved.id);
  return combatTarget === null || combatTarget.motion.alive;
}

export class NavTargetSelection implements NavTargetSource {
  // ターゲットの id と、選んだ時点の表示名。
  private target: SerializedNavTargetSelection | null;

  // saved を戻せるなら戻して始める。roster は復元した時点の顔ぶれ。命令の結果は events へ記録する。
  public constructor(
    saved: SerializedNavTargetSelection | null | undefined,
    roster: EntityRoster,
    private readonly events: RunEventSink,
  ) {
    this.target = saved && isRestorable(saved, roster) ? saved : null;
  }

  public get id(): string | null { return this.target?.id ?? null; }

  public get name(): string | null { return this.target?.name ?? null; }

  // 航法ターゲットを直列化した形。未設定なら null。
  public serialize(): SerializedNavTargetSelection | null {
    return this.target;
  }

  // id がいまのターゲットなら解除し、そうでなければ id を表示名 name でターゲットにする。
  public toggle(id: string, name: string): void {
    this.target = this.target?.id === id ? null : { id, name };
    this.events.record({ kind: 'navTargetToggled', name: this.name });
  }

  // 戦闘対象 entity を(切り替えでなく)ターゲットにする。null ならターゲットを解除する。
  public setCombatTarget(entity: CombatTarget | null): void {
    this.target = entity === null ? null : { id: entity.id, name: entity.name };
    this.events.record({ kind: 'navTargetLocked', name: this.name });
  }

  // ターゲットを黙って解除する。
  public clear(): void {
    this.target = null;
  }

  // 今ステップの出来事 events に合わせて、ターゲットを黙って解除する。解除するのは、操作対象が
  // 選び直された後にターゲットの命令が無いときと、ターゲットが操作対象候補から除かれたとき。
  public followProgress(events: readonly RunEvent[]): void {
    let selectedSeq: number | null = null;
    let commandedSeq: number | null = null;
    for (const { seq, body } of events) {
      if (body.kind === 'controlTargetSelected') selectedSeq = seq;
      if (body.kind === 'navTargetToggled' || body.kind === 'navTargetLocked') commandedSeq = seq;
      if (body.kind === 'controllableRemoved' && body.id === this.id) this.clear();
    }
    // 選択の後に設定したターゲットは残し、設定の後に選択が変わればターゲットを外す。
    if (selectedSeq !== null && (commandedSeq === null || selectedSeq > commandedSeq)) this.clear();
  }
}
