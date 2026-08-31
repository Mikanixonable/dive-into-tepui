import {
  SaveIndex,
  SaveSlotMeta,
  StageHistoryMeta,
  SnapshotMeta,
  SlotExport,
  GameSaveData,
  SLOT_EXPORT_FORMAT,
  SLOT_EXPORT_VERSION,
} from './save-data';
import { SaveStore, SAVE_INDEX_VERSION } from './save-store';

export const AUTO_SNAPSHOT_LIMIT = 12;
export const PINNED_SNAPSHOT_LIMIT = 30;

// 容量超過かどうか。ブラウザによって名前とコードが違うので両方を見る。
function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22)
  );
}

// セーブ索引(SaveIndex)の読み書き・スロット/スナップショットのメタ操作のみを担う。
// スナップショット本体の永続化は一切自分で持たず、常に SaveStore へ委譲する。
export class SaveSlots {
  private index: SaveIndex;

  constructor(private readonly store: SaveStore) {
    this.index = store.readIndex() ?? { version: SAVE_INDEX_VERSION, slots: [], activeSlotId: null };
  }

  get slots(): readonly SaveSlotMeta[] {
    return this.index.slots;
  }

  get activeSlotId(): string | null {
    return this.index.activeSlotId;
  }

  // 現在アクティブなスロットのメタを返す。無ければ null。
  activeSlot(): SaveSlotMeta | null {
    return this.index.slots.find((s) => s.id === this.index.activeSlotId) ?? null;
  }

  // id が索引に存在するスロットである前提で呼ぶ。
  setActiveSlot(id: string): void {
    this.index.activeSlotId = id;
    this.persist();
  }

  // 空のスロットを索引へ追加して返す。どのステージを遊ぶかはまだ決まっていないので、
  // それは実際に開始したときに noteLaunch が埋める。
  createSlot(name: string): SaveSlotMeta {
    const now = Date.now();
    const slot: SaveSlotMeta = {
      id: this.genId(),
      name,
      createdAtReal: now,
      lastPlayedAtReal: now,
      lastStageId: '',
      stages: [],
    };
    this.index.slots.push(slot);
    this.persist();
    return slot;
  }

  // 実際に遊び始めたステージをスロットへ記録する。ゲーム開始時に一度だけ呼ぶ。
  noteLaunch(slotId: string, stageId: string): void {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return;
    slot.lastStageId = stageId;
    slot.lastPlayedAtReal = Date.now();
    this.persist();
  }

  // 決着した周回を締める。lastStageId を空にし、同じステージの次回起動が
  // このスロットの最新スナップショットを進行中の周回と誤認して自動復元しないようにする。
  noteRunEnded(slotId: string): void {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return;
    slot.lastStageId = '';
    slot.lastPlayedAtReal = Date.now();
    this.persist();
  }

  // id のスロットが存在する前提で呼ぶ。
  renameSlot(id: string, name: string): void {
    const slot = this.index.slots.find((s) => s.id === id);
    if (!slot) return;
    slot.name = name;
    this.persist();
  }

  // そのスロットが参照する全スナップショット本体を先に消してから索引から外す。遊んでいた
  // スロットを消した場合は、残っているスロットの1つをアクティブにする(遊ぶ先が無いと
  // 以降どの経路でもスナップショットを撮れなくなるため)。
  deleteSlot(id: string): void {
    const slot = this.index.slots.find((s) => s.id === id);
    if (!slot) return;
    for (const history of slot.stages) {
      for (const meta of history.snapshots) this.store.deleteSnapshot(meta.id);
    }
    this.index.slots = this.index.slots.filter((s) => s.id !== id);
    if (this.index.activeSlotId === id) this.index.activeSlotId = this.index.slots[0]?.id ?? null;
    this.persist();
  }

  // 元スロットの複製を新規スロットとして作る。upToSnapshotId 以前(同時刻含む)だけを残す。
  duplicateSlot(id: string, upToSnapshotId?: string): SaveSlotMeta | null {
    const source = this.index.slots.find((s) => s.id === id);
    if (!source) return null;

    let cutoff = Infinity;
    if (upToSnapshotId !== undefined) {
      const found = this.findSnapshot(upToSnapshotId);
      if (!found) return null;
      cutoff = found.meta.createdAtReal;
    }

    const copied: SlotExport = {
      format: SLOT_EXPORT_FORMAT,
      formatVersion: SLOT_EXPORT_VERSION,
      exportedAtReal: Date.now(),
      slot: { ...source, name: `${source.name} のコピー`, stages: [] },
      snapshots: {},
    };
    for (const history of source.stages) {
      const kept = history.snapshots.filter((m) => m.createdAtReal <= cutoff);
      const readable: SnapshotMeta[] = [];
      for (const meta of kept) {
        const data = this.store.readSnapshot(meta.id);
        if (!data) continue;
        copied.snapshots[meta.id] = data;
        readable.push(meta);
      }
      copied.slot.stages.push({ ...history, snapshots: readable });
    }
    return this.importSlot(copied);
  }

  // slotId/stageId のステージ履歴を返す。無ければ作って索引に足す。
  historyFor(slotId: string, stageId: string): StageHistoryMeta | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return null;
    let history = slot.stages.find((h) => h.stageId === stageId);
    if (!history) {
      history = { stageId, clearCount: 0, lastPlayedAtReal: Date.now(), snapshots: [] };
      slot.stages.push(history);
      this.persist();
    }
    return history;
  }

  // 新しい順の先頭が最新スナップショット。
  latestSnapshot(slotId: string, stageId: string): SnapshotMeta | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    const history = slot?.stages.find((h) => h.stageId === stageId);
    return history?.snapshots[0] ?? null;
  }

  // 本体を書き、メタを履歴の先頭へ入れ、pinned:false の超過分を古い順に剪定する。
  // 容量超過で書き込みに失敗した場合は pinned:false を1件ずつ消しながら再試行する。
  // クリップ済みが上限に達している履歴へ pinned:true を足すことはできない(false を返す)。
  addSnapshot(slotId: string, stageId: string, meta: SnapshotMeta, data: GameSaveData): boolean {
    const history = this.historyFor(slotId, stageId);
    if (!history) return false;
    if (meta.pinned && history.snapshots.filter((m) => m.pinned).length >= PINNED_SNAPSHOT_LIMIT) return false;

    for (;;) {
      try {
        this.store.writeSnapshot(meta.id, data);
        break;
      } catch (e) {
        // 空き容量以外の失敗(localStorage 自体が使えない等)は剪定しても直らないので、
        // 消してから諦めることのないよう即座に降りる。
        const oldestAuto = isQuotaError(e) ? this.oldestAutoIn(history) : null;
        if (!oldestAuto) {
          console.error('SaveSlots.addSnapshot: スナップショットを書き込めませんでした', e);
          // 剪定でメタを消していれば索引が本体と食い違っているので、諦める前に書き戻す。
          this.persist();
          return false;
        }
        this.removeSnapshotFrom(history, oldestAuto.id);
      }
    }

    history.snapshots.unshift(meta);
    history.lastPlayedAtReal = meta.createdAtReal;
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (slot) slot.lastPlayedAtReal = meta.createdAtReal;

    this.pruneAutoOverflow(history);
    this.persist();
    return true;
  }

  // 全スロット・全履歴を横断してスナップショット id から所属を引く。
  findSnapshot(snapshotId: string): { slot: SaveSlotMeta; history: StageHistoryMeta; meta: SnapshotMeta } | null {
    for (const slot of this.index.slots) {
      for (const history of slot.stages) {
        const meta = history.snapshots.find((m) => m.id === snapshotId);
        if (meta) return { slot, history, meta };
      }
    }
    return null;
  }

  // pinned:true への昇格は履歴ごとの上限 PINNED_SNAPSHOT_LIMIT を超えない範囲でのみ許す。
  setPinned(snapshotId: string, pinned: boolean): boolean {
    const found = this.findSnapshot(snapshotId);
    if (!found) return false;
    if (pinned) {
      const pinnedCount = found.history.snapshots.filter((m) => m.pinned).length;
      if (pinnedCount >= PINNED_SNAPSHOT_LIMIT) return false;
    }
    found.meta.pinned = pinned;
    this.persist();
    return true;
  }

  renameSnapshot(snapshotId: string, name: string): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    found.meta.name = name;
    this.persist();
  }

  deleteSnapshot(snapshotId: string): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    this.removeSnapshotFrom(found.history, snapshotId);
    this.persist();
  }

  // ロード後に呼ぶ想定: 復元元より後(createdAtReal が新しい)の pinned:false を捨てる。
  discardAfter(snapshotId: string): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    const cutoff = found.meta.createdAtReal;
    const toRemove = found.history.snapshots.filter((m) => !m.pinned && m.createdAtReal > cutoff);
    for (const m of toRemove) this.removeSnapshotFrom(found.history, m.id);
    this.persist();
  }

  // pinnedOnly なら pinned:true のメタ・本体だけを含める。本体が読めなかった件はメタからも落とす。
  exportSlot(slotId: string, pinnedOnly: boolean): SlotExport | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return null;

    const exportedSlot: SaveSlotMeta = { ...slot, stages: [] };
    const snapshots: Record<string, GameSaveData> = {};
    for (const history of slot.stages) {
      const metas = pinnedOnly ? history.snapshots.filter((m) => m.pinned) : history.snapshots;
      const keptMetas: SnapshotMeta[] = [];
      for (const meta of metas) {
        const data = this.store.readSnapshot(meta.id);
        if (!data) continue;
        snapshots[meta.id] = data;
        keptMetas.push(meta);
      }
      exportedSlot.stages.push({ ...history, snapshots: keptMetas });
    }

    return {
      format: SLOT_EXPORT_FORMAT,
      formatVersion: SLOT_EXPORT_VERSION,
      exportedAtReal: Date.now(),
      slot: exportedSlot,
      snapshots,
    };
  }

  // 常に新規スロットとして追加する。id を振り直すのは、既に import 済みの同じファイルを
  // もう一度読んだ時に既存スロットを壊さないため。書き込み途中で失敗したら書いた分を消して null。
  importSlot(exp: SlotExport): SaveSlotMeta | null {
    const newSlot: SaveSlotMeta = {
      ...exp.slot,
      id: this.genId(),
      name: this.uniqueName(exp.slot.name),
      stages: [],
    };

    const written: string[] = [];
    for (const history of exp.slot.stages) {
      const newHistory: StageHistoryMeta = { ...history, snapshots: [] };
      for (const meta of history.snapshots) {
        const data = exp.snapshots[meta.id];
        if (!data) continue;
        const newMeta: SnapshotMeta = { ...meta, id: this.genId() };
        try {
          this.store.writeSnapshot(newMeta.id, data);
        } catch (e) {
          console.error('SaveSlots.importSlot: 書き込みに失敗しました', e);
          for (const id of written) this.store.deleteSnapshot(id);
          return null;
        }
        written.push(newMeta.id);
        newHistory.snapshots.push(newMeta);
      }
      newSlot.stages.push(newHistory);
    }

    this.index.slots.push(newSlot);
    this.persist();
    return newSlot;
  }

  // 索引のどこからも参照されていない本体キーを消す。起動時に1回だけ呼ぶ想定。
  pruneOrphans(): void {
    const referenced = new Set<string>();
    for (const slot of this.index.slots) {
      for (const history of slot.stages) {
        for (const meta of history.snapshots) referenced.add(meta.id);
      }
    }
    for (const id of this.store.snapshotIds()) {
      if (!referenced.has(id)) this.store.deleteSnapshot(id);
    }
  }

  // 名前が既存スロットと衝突したら " (2)", " (3)" … を付けて一意にする。
  private uniqueName(name: string): string {
    const existing = new Set(this.index.slots.map((s) => s.name));
    if (!existing.has(name)) return name;
    let n = 2;
    while (existing.has(`${name} (${n})`)) n++;
    return `${name} (${n})`;
  }

  // pinned:false が AUTO_SNAPSHOT_LIMIT を超えていれば、古い順に超過分を本体ごと消す。
  private pruneAutoOverflow(history: StageHistoryMeta): void {
    const autos = history.snapshots.filter((m) => !m.pinned);
    if (autos.length <= AUTO_SNAPSHOT_LIMIT) return;
    const overflow = autos.slice(AUTO_SNAPSHOT_LIMIT).sort((a, b) => a.createdAtReal - b.createdAtReal);
    for (const m of overflow) this.removeSnapshotFrom(history, m.id);
  }

  // 履歴内で最も古い pinned:false のメタ(容量超過リトライ用)。無ければ null。
  private oldestAutoIn(history: StageHistoryMeta): SnapshotMeta | null {
    const autos = history.snapshots.filter((m) => !m.pinned);
    if (autos.length === 0) return null;
    return autos.reduce((oldest, m) => (m.createdAtReal < oldest.createdAtReal ? m : oldest));
  }

  // 本体を消してから履歴のメタ配列からも外す。
  private removeSnapshotFrom(history: StageHistoryMeta, snapshotId: string): void {
    this.store.deleteSnapshot(snapshotId);
    history.snapshots = history.snapshots.filter((m) => m.id !== snapshotId);
  }

  // 同一ミリ秒内の連続生成でも衝突しないよう、時刻に加えてランダム部を足す。
  private genId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private persist(): void {
    try {
      this.store.writeIndex(this.index);
    } catch (e) {
      console.error('SaveSlots: 索引の書き込みに失敗しました', e);
    }
  }
}
