// 建造の設計図の操作: 棚の設計図を写しの手持ちにする・名前を変える・消す。
// 名前の変更と削除は船体を変えない記録系の命令として列へ積む。
// 手持ちが設計図の写しのあいだ、写し元の設計図の id を持つ。
import { deserializeShipAssembly } from './ship-assembly-serialization';
import type { ShipAssembly } from './ship-assembly';
import type { ShipBlueprintShelf } from './ship-blueprint';
import type { RunEventSink } from '../run-events';
import type {
  ConstructionCommandSession, ShipConstructionCommands,
} from './ship-construction-commands';
import type { ConstructionConfirmationPort, ConstructionHeld } from './ship-construction-types';

// 設計図の操作が呼び戻す建造セッションの面。写しを手持ちへ取り込む操作と、
// 消した設計図を持っていたときの手放しに使う。
export interface ConstructionBlueprintHost {
  hold(held: ConstructionHeld): void;
  release(): void;
}

export class ShipConstructionBlueprints {
  // 手持ちが設計図の写しのとき、その設計図の id。
  private heldId: string | null = null;

  public constructor(
    private readonly shelf: ShipBlueprintShelf,
    private readonly events: RunEventSink,
    private readonly confirmation: ConstructionConfirmationPort,
    private readonly commands: ShipConstructionCommands,
    private readonly host: ConstructionBlueprintHost,
  ) {}

  // 手持ちが設計図の写しのとき、その設計図の id。それ以外は null。
  public get heldBlueprintId(): string | null { return this.heldId; }

  // 手持ちの変わる操作が記録する、写し元の設計図の id。設計図由来でなければ null。
  public noteHeldBlueprint(id: string | null): void { this.heldId = id; }

  // id の設計図の先端部を写しの手持ちにする。棚に無い id では何もしない。
  public hold(id: string): void {
    const blueprint = this.shelf.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) { this.commands.deny('その設計図はありません'); return; }
    try {
      this.host.hold({ kind: 'copy', piece: deserializeShipAssembly(blueprint.piece) });
      this.heldId = id;
    } catch (error) {
      this.commands.deny(error instanceof Error ? error.message : 'その設計図は読み込めません');
    }
  }

  // id の設計図の名前を変える記録を積む。
  public rename(session: ConstructionCommandSession | null, id: string, name: string): void {
    if (session === null) return;
    const trimmed = name.trim();
    if (trimmed === '' || !this.shelf.blueprints.some(entry => entry.id === id)) return;
    this.commands.submit(session, 'blueprint', '', [], false, null,
      () => this.events.record({ kind: 'blueprintRenamed', id, name: trimmed }));
  }

  // id の設計図を消す記録を積む。確認を挟み、手に持っていれば手放す。
  public remove(session: ConstructionCommandSession | null, id: string): void {
    if (session === null) return;
    const blueprint = this.shelf.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) return;
    // 確認のうえで削除の記録を積み、手に持っていれば手放す。
    this.confirmation.open({
      title: '設計図を削除',
      message: `設計図「${blueprint.name}」を削除します。続けますか？`,
      confirmLabel: '削除する', destructive: true,
    }, (confirmed) => {
      if (!confirmed) return;
      this.commands.submit(session, 'blueprint', '', [], false, null,
        () => this.events.record({ kind: 'blueprintDeleted', id }));
      if (this.heldId === id) this.host.release();
    });
  }

  // id の設計図の先端部を復元する。棚に無い・読めないときは例外にする。
  public piece(id: string): ShipAssembly {
    const blueprint = this.shelf.blueprints.find(entry => entry.id === id) ?? null;
    if (blueprint === null) throw new Error(`unknown blueprint: ${id}`);
    return deserializeShipAssembly(blueprint.piece);
  }
}
