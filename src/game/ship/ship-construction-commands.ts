// 建造の命令列と取り消し履歴の操作: 編集を命令として列へ積み、適用の成否を
// 履歴・操作記録・拒否記録へ反映する。船体を戻す操作(取り消し・やり直し・任意の時点・
// 全取り消し)も命令として積み、成功のあとで履歴の位置を確定する。
import { CommandCompletion } from '../command-queue';
import { serializeShipAssembly, type SerializedShipAssembly } from './ship-assembly-serialization';
import type { CommandQueue } from '../command-queue';
import type { Notifier } from '../../hud-kit/notifier';
import type { ShipAssembly } from './ship-assembly';
import type { ShipConstructionEdits } from './ship-construction-edits';
import type { ConstructionHistory } from './ship-construction-history';
import type {
  ConstructionConfirmationPort, ConstructionDeniedRecord, ConstructionOperationRecord,
} from './ship-construction-types';

// 命令の種別。'restore' は取り消し系で、成功時に履歴位置を動かす。
// 'blueprint' は船体を変えない記録系で、成功時に履歴も操作記録も積まない。
export type ConstructionAction =
  'place' | 'move' | 'remove' | 'reorient' | 'restore' | 'blueprint';

// 命令の管理が読み書きする建造セッションの面。適用後の写しを取る船体・
// 戻す先を適用する編集口・取り消し履歴を使う。
export interface ConstructionCommandSession {
  readonly ship: { readonly assembly: ShipAssembly };
  readonly edits: ShipConstructionEdits;
  readonly history: ConstructionHistory;
}

// 命令の管理が呼び戻す建造セッションの面。
export interface ConstructionCommandHost {
  // 船体を戻す命令を積んだあとに呼び、変わる船体への試し置きを捨てさせる。
  discardTrial(): void;
  // 確定した閉じる操作(健全なコックピットを失う撤去など)のあと、建造を閉じる。
  close(): void;
}

// 適用待ちの命令。成功時に履歴へ積む材料を持つ。
interface PendingConstructionCommand {
  readonly session: ConstructionCommandSession;
  readonly action: ConstructionAction;
  readonly completion: CommandCompletion;
  // 成功時に履歴へ積む操作名。restore は代わりに履歴の位置をここへ動かす。
  readonly historyName: string;
  readonly historyIndex: number | null;
  // 成功時の操作記録へ載せる、動いたモジュールの識別子。
  readonly moduleIds: readonly string[];
  // 健全なコックピットを失う確定済みの操作は、成功したら閉じる。
  readonly closeOnSuccess: boolean;
  // 適用の中で捕捉した、その操作直後の船体の写し。
  snapshot: SerializedShipAssembly | null;
}

export class ShipConstructionCommands {
  private pending: PendingConstructionCommand[] = [];
  private operationSequence = 0;
  private operation: ConstructionOperationRecord | null = null;
  private denied: ConstructionDeniedRecord | null = null;

  public constructor(
    private readonly queue: CommandQueue,
    private readonly notifier: Notifier,
    private readonly confirmation: ConstructionConfirmationPort,
    private readonly host: ConstructionCommandHost,
  ) {}

  // 直近に成功した編集の記録。
  public get lastOperation(): ConstructionOperationRecord | null { return this.operation; }
  // 直近に拒まれた操作の記録。
  public get lastDenied(): ConstructionDeniedRecord | null { return this.denied; }
  // 適用待ちの命令があるか。この間は履歴を動かせない。
  public get hasPending(): boolean { return this.pending.length > 0; }

  // 操作の拒否を記録し、理由をヒントへ出す。
  public deny(reason: string): void {
    this.denied = { reason, sequence: ++this.operationSequence };
    this.notifier.hint(reason, undefined, 'warn');
  }

  // 命令を列へ積み、成功時の履歴への記録材料を操作の中で捕捉する。
  public submit(
    session: ConstructionCommandSession, action: ConstructionAction, historyName: string,
    moduleIds: readonly string[], closeOnSuccess: boolean, historyIndex: number | null,
    apply: () => void,
  ): void {
    const completion = new CommandCompletion();
    const pending: PendingConstructionCommand = {
      session, action, completion, historyName, historyIndex, moduleIds,
      closeOnSuccess, snapshot: null,
    };
    // 適用のあとで船体の写しを取る命令を積み、完了を待つ保留へ載せる。
    this.pending.push(pending);
    this.queue.submitWithCompletion(() => {
      apply();
      pending.snapshot = serializeShipAssembly(session.ship.assembly);
    }, completion);
  }

  // 適用済みの応答を表示へ反映する。成功は履歴と操作記録へ、失敗は拒否記録へ。
  public syncResults(session: ConstructionCommandSession | null): void {
    for (const command of this.pending) {
      const state = command.completion.state;
      if (state.kind === 'pending') continue;
      if (state.kind === 'failed') {
        const reason = state.error instanceof Error ? state.error.message : '建造操作に失敗しました';
        this.deny(reason);
      } else if (session === command.session) {
        // 'blueprint' は船体を変えない記録系なので、履歴にも操作記録にも積まない。
        if (command.action !== 'blueprint') {
          if (command.action === 'restore' && command.historyIndex !== null) {
            command.session.history.moveTo(command.historyIndex);
          } else if (command.snapshot !== null) {
            command.session.history.record(command.historyName, command.snapshot);
          }
          this.operation = {
            kind: command.action === 'reorient' ? 'rotate'
              : command.action === 'restore' ? 'restore' : command.action,
            moduleIds: command.moduleIds,
            sequence: ++this.operationSequence,
          };
        }
        if (command.closeOnSuccess) this.host.close();
      }
    }
    this.pending = this.pending.filter(command => command.completion.state.kind === 'pending');
  }

  // ---- 履歴(適用待ちがある間は受け付けない) ----

  private revertTo(session: ConstructionCommandSession, index: number): void {
    if (this.pending.length > 0) { this.deny('適用待ちの編集があります'); return; }
    const target = session.history.target(index);
    if (target === null) { this.deny('その時点へは戻れません'); return; }
    this.submit(session, 'restore', '履歴の時点へ戻す', [], false, index,
      () => session.edits.replaceAssembly(target));
    this.host.discardTrial();
  }

  // 直前の操作を取り消して1つ前の船体へ戻す。
  public undo(session: ConstructionCommandSession | null): void {
    if (session === null) return;
    this.revertTo(session, session.history.position - 1);
  }

  // 取り消した操作をやり直す。
  public redo(session: ConstructionCommandSession | null): void {
    if (session === null) return;
    this.revertTo(session, session.history.position + 1);
  }

  public jumpToHistory(session: ConstructionCommandSession | null, index: number): void {
    if (session === null) return;
    this.revertTo(session, index);
  }

  // 建造を始めてからの変更をすべて取り消し、開始時の船体へ戻す。確認したときだけ行う。
  public revertAll(session: ConstructionCommandSession | null): void {
    if (session === null) return;
    if (session.history.entriesView.length <= 1) return;
    this.confirmation.open({
      title: '変更をすべて取り消す',
      message: '建造を始めてからの変更をすべて取り消し、開始時の船体へ戻します。続けますか？',
      confirmLabel: 'すべて取り消す', destructive: true,
    }, (confirmed) => { if (confirmed) this.revertTo(session, 0); });
  }
}
