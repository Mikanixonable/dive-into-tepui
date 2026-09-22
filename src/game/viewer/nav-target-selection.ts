// 航法ターゲットの選択。何をターゲットにしているかを id と表示名で持ち、遊ぶ人の命令と、
// 進行が記録した出来事で差し替わる。
import { combatTargetById, type CombatTarget } from '../dynamic/dynamic-entity/combat-target';
import type { EntityRoster } from '../dynamic/entity-roster';
import type { RunEvent, RunEventSink } from '../run-events';

// 航法ターゲットにしている対象。name は選んだ時点の表示名。
export interface NavTarget {
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

// id が、撃墜・破壊されて名簿に残っている敵・自艦・基地を指すか。天体・ラグランジュ点・役割のように
// 消滅しない対象と、名簿に無い id は false。id で対象を指す選択は、復元時にこれが真なら既定へ戻す。
export function isDestroyedTarget(id: string, roster: EntityRoster): boolean {
  return combatTargetById(roster.all(), id)?.motion.alive === false;
}

export class NavTargetSelection implements NavTargetSource {
  // 命令の結果は events へ記録する。
  public constructor(
    private readonly events: RunEventSink,
    private target: NavTarget | null = null,
  ) {}

  // 直列化したターゲットを、復元可能な場合は復元して初期化する。roster は復元時点のエンティティ一覧。
  public static deserialize(
    serialized: NavTarget | null, roster: EntityRoster, events: RunEventSink,
  ): NavTargetSelection {
    return new NavTargetSelection(events, serialized && !isDestroyedTarget(serialized.id, roster) ? serialized : null);
  }

  public get id(): string | null { return this.target?.id ?? null; }

  public get name(): string | null { return this.target?.name ?? null; }

  // 航法ターゲットを直列化した形。未設定なら null。
  public serialize(): NavTarget | null {
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
