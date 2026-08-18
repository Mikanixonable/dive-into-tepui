// 設計の保管庫(§4-1)。保存・読み込み・複製・削除・改名を、永続化の実装から切り離して扱う。
// 実際にどこへ書くかは BlueprintStore が決めるので、この層は DOM に依存しない。

import type { VesselBlueprint } from './blueprint';
import { BLUEPRINT_VERSION, checkBlueprintShape, duplicateBlueprint, renameBlueprint } from './blueprint';

// 保管庫の中身そのもの。版が読み替えられないときは中身を捨てて空から始める。
export interface BlueprintArchive {
  readonly version: number;
  readonly blueprints: readonly VesselBlueprint[];
}

// 設計の永続化。実装は差し替え可能で、テストは記憶上の実装を渡す。
export interface BlueprintStore {
  read(): BlueprintArchive | null;
  write(archive: BlueprintArchive): void;
}

export class BlueprintLibrary {
  private readonly store: BlueprintStore;
  private readonly clock: () => number;
  private readonly byId: Map<string, VesselBlueprint>;

  public constructor(store: BlueprintStore, clock: () => number = () => Date.now()) {
    this.store = store;
    this.clock = clock;
    const archive = store.read();
    // 版が合わない・形として読めない設計は取り込まない。破損した機体を作らないためである。
    const kept = archive !== null && archive.version === BLUEPRINT_VERSION ? archive.blueprints : [];
    this.byId = new Map();
    for (const raw of kept) {
      const blueprint = checkBlueprintShape(raw);
      if (blueprint !== null) this.byId.set(blueprint.id, blueprint);
    }
  }

  public list(): readonly VesselBlueprint[] {
    return [...this.byId.values()];
  }

  public get(id: string): VesselBlueprint | null {
    return this.byId.get(id) ?? null;
  }

  // 同じ id の設計があれば置き換える。更新時刻はここで進める。
  public save(blueprint: VesselBlueprint): VesselBlueprint {
    const stored: VesselBlueprint = { ...blueprint, updatedAt: this.clock() };
    this.byId.set(stored.id, stored);
    this.flush();
    return stored;
  }

  public rename(id: string, name: string): VesselBlueprint | null {
    const current = this.byId.get(id);
    if (current === undefined) return null;
    const renamed = renameBlueprint(current, name, this.clock());
    this.byId.set(id, renamed);
    this.flush();
    return renamed;
  }

  // 新しい id を持つ複製を保管庫へ加える。元の設計は変わらない。
  public duplicate(id: string, name?: string): VesselBlueprint | null {
    const current = this.byId.get(id);
    if (current === undefined) return null;
    const copy = duplicateBlueprint(current, this.newId(), name ?? `${current.name} のコピー`, this.clock());
    this.byId.set(copy.id, copy);
    this.flush();
    return copy;
  }

  public remove(id: string): boolean {
    if (!this.byId.delete(id)) return false;
    this.flush();
    return true;
  }

  // 外から来た設計を、必ず新しい id で取り込む。同じファイルを2度読んでも既存を上書きしない。
  public importBlueprints(blueprints: readonly VesselBlueprint[]): readonly VesselBlueprint[] {
    const added: VesselBlueprint[] = [];
    for (const blueprint of blueprints) {
      const copy = duplicateBlueprint(blueprint, this.newId(), blueprint.name, this.clock());
      this.byId.set(copy.id, copy);
      added.push(copy);
    }
    this.flush();
    return added;
  }

  // 保管庫の中で一意な id。時刻だけでは同じミリ秒の連続した採番が衝突するので、連番を足す。
  private newId(): string {
    const stamp = this.clock();
    for (let serial = 0; ; serial++) {
      const id = `bp-${stamp}-${serial}`;
      if (!this.byId.has(id)) return id;
    }
  }

  private flush(): void {
    this.store.write({ version: BLUEPRINT_VERSION, blueprints: this.list() });
  }
}
