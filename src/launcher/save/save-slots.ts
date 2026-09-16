import type { GameSaveData } from '../../game/save/save-data';
import {
  type SaveIndex,
  type SaveSlotMeta,
  type StageHistoryMeta,
  type SnapshotMeta,
  type SlotExport,
  SLOT_EXPORT_FORMAT,
  SLOT_EXPORT_VERSION,
  newSaveId,
} from './slot-data';
import { SaveStore, SAVE_INDEX_VERSION } from './save-store';

// 履歴ごとに持てる手動セーブの件数の上限。
export const MANUAL_SAVE_LIMIT = 30;

// セーブ索引(SaveIndex)を持ち、スロット/手動セーブ/自動セーブのメタを操作する。メタの追加・削除に
// 合わせて、store 上の本体も書き・消す。
export class SaveSlots {
  private readonly index: SaveIndex;

  // store の索引を読む。索引が無ければ空の索引から始める。
  private constructor(private readonly store: SaveStore) {
    this.index = store.readIndex() ?? { version: SAVE_INDEX_VERSION, slots: [], activeSlotId: null };
  }

  // store から索引を開く。参照されない本体を掃除し、遊ぶ先のスロットが必ず1つある状態で返す。
  public static load(store: SaveStore): SaveSlots {
    const slots = new SaveSlots(store);
    slots.pruneOrphans();
    if (slots.activeSlotId === null) {
      slots.setActiveSlot((slots.slots[0] ?? slots.createSlot('セーブデータ 1')).id);
    }
    return slots;
  }

  // 全スロットのメタ。索引の並び順。
  public get slots(): readonly SaveSlotMeta[] {
    return this.index.slots;
  }

  // 遊ぶ先のスロットの id。load 後に null になるのは、スロットが1つも無くなったとき。
  public get activeSlotId(): string | null {
    return this.index.activeSlotId;
  }

  // 現在アクティブなスロットのメタを返す。無ければ null。
  public activeSlot(): SaveSlotMeta | null {
    return this.index.slots.find((s) => s.id === this.index.activeSlotId) ?? null;
  }

  // 遊ぶ先のスロットを切り替える。id は索引に存在するスロットであること。
  public setActiveSlot(id: string): void {
    this.index.activeSlotId = id;
    this.persist();
  }

  // 空のスロットを索引へ追加して返す。
  public createSlot(name: string): SaveSlotMeta {
    const now = Date.now();
    const slot: SaveSlotMeta = {
      id: newSaveId(),
      name,
      createdAtReal: now,
      lastPlayedAtReal: now,
      lastRun: null,
      stages: [],
    };
    this.index.slots.push(slot);
    this.persist();
    return slot;
  }

  // 遊び始めたステージを直近の周回としてスロットへ記録する。ゲーム開始時に一度だけ呼ぶ。
  public noteRunLaunched(slotId: string, stageId: string): void {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return;
    slot.lastRun = { stageId, ended: false };
    slot.lastPlayedAtReal = Date.now();
    this.persist();
  }

  // 直近の周回を締め、以降そこから再開しないようにする。一度も遊んでいないスロットでは何もしない。
  public noteRunEnded(slotId: string): void {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot || slot.lastRun === null) return;
    slot.lastRun = { stageId: slot.lastRun.stageId, ended: true };
    slot.lastPlayedAtReal = Date.now();
    this.persist();
  }

  // スロットの表示名を変える。無い id なら何もしない。
  public renameSlot(id: string, name: string): void {
    const slot = this.index.slots.find((s) => s.id === id);
    if (!slot) return;
    slot.name = name;
    this.persist();
  }

  // そのスロットが参照する全本体を先に消してから索引から外す。遊んでいたスロットを消した
  // 場合は、残っているスロットの1つをアクティブにする(遊ぶ先が無いと以降どの経路でも
  // 記録を残せなくなるため)。
  public deleteSlot(id: string): void {
    const slot = this.index.slots.find((s) => s.id === id);
    if (!slot) return;
    for (const history of slot.stages) {
      for (const meta of history.snapshots) this.store.deleteSnapshot(meta.id);
      if (history.autoSaveId) this.store.deleteSnapshot(history.autoSaveId);
    }
    this.index.slots = this.index.slots.filter((s) => s.id !== id);
    if (this.index.activeSlotId === id) this.index.activeSlotId = this.index.slots[0]?.id ?? null;
    this.persist();
  }

  // 元スロットの複製を新規スロットとして作る。upToSnapshotId を渡すとその時点(同時刻含む)
  // までを残し、複製先はその時点から再開する。渡さなければ自動セーブごと丸ごと複製する。
  // 無い id を指したとき・取り込みに失敗したときは null。
  public duplicateSlot(id: string, upToSnapshotId?: string): SaveSlotMeta | null {
    const source = this.index.slots.find((s) => s.id === id);
    if (!source) return null;

    // 分岐なら、残す範囲の締め切りと分岐先が再開する時点が決まる。
    let cutoff = Infinity;
    let branch: { stageId: string; snapshotId: string } | null = null;
    if (upToSnapshotId !== undefined) {
      const found = this.findSnapshot(upToSnapshotId);
      if (!found) return null;
      cutoff = found.meta.createdAtReal;
      branch = { stageId: found.history.stageId, snapshotId: upToSnapshotId };
    }

    // 書き出しと同じ形へ、本体が読めた手動セーブを詰めてから取り込む。
    const copied: SlotExport = {
      format: SLOT_EXPORT_FORMAT,
      formatVersion: SLOT_EXPORT_VERSION,
      exportedAtReal: Date.now(),
      slot: { ...source, name: `${source.name} のコピー`, stages: [] },
      snapshots: {},
    };
    // 複製先の自動セーブにする本体(ステージ履歴ごとに1つ)。分岐ならその時点、丸ごとなら複製元の自動セーブ。
    const autoSaveSources = new Map<string, string>();
    for (const history of source.stages) {
      const kept = history.snapshots.filter((m) => m.createdAtReal <= cutoff);
      const readable: SnapshotMeta[] = [];
      for (const meta of kept) {
        const data = this.store.readSnapshot(meta.id);
        if (!data) continue;
        copied.snapshots[meta.id] = data;
        readable.push(meta);
      }
      copied.slot.stages.push({ ...history, snapshots: readable, autoSaveId: null });
      const autoSaveSource = branch === null
        ? history.autoSaveId ?? null
        : branch.stageId === history.stageId ? branch.snapshotId : null;
      if (autoSaveSource !== null) autoSaveSources.set(history.stageId, autoSaveSource);
    }

    const copy = this.importSlot(copied);
    if (copy === null) return null;
    // 取り込みは再開できる周回を持たないので、複製では自動セーブと直近の周回をここで入れ直す。
    // 分岐点の本体が読めなければ再開先が無いので、直近の周回は締めたままにする。
    let resumesBranch = false;
    for (const [stageId, sourceId] of autoSaveSources) {
      const data = this.store.readSnapshot(sourceId);
      if (data === null || !this.writeAutoSave(copy.id, stageId, data)) continue;
      if (branch !== null && branch.stageId === stageId) resumesBranch = true;
    }
    copy.lastRun = branch !== null
      ? { stageId: branch.stageId, ended: !resumesBranch }
      : source.lastRun === null ? null : { ...source.lastRun };
    this.persist();
    return copy;
  }

  // slotId/stageId のステージ履歴を返す。無ければ作って索引に足す。
  private historyFor(slotId: string, stageId: string): StageHistoryMeta | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return null;
    let history = slot.stages.find((h) => h.stageId === stageId);
    if (!history) {
      history = { stageId, clearCount: 0, lastPlayedAtReal: Date.now(), snapshots: [], autoSaveId: null };
      slot.stages.push(history);
      this.persist();
    }
    return history;
  }

  // slotId/stageId の自動セーブの本体 id。まだ撮っていなければ null。
  public autoSaveId(slotId: string, stageId: string): string | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    const history = slot?.stages.find((h) => h.stageId === stageId);
    return history?.autoSaveId ?? null;
  }

  // 自動セーブを差し替える。書き込みに失敗したら false を返し、前の自動セーブをそのまま残す。
  public writeAutoSave(slotId: string, stageId: string, data: GameSaveData): boolean {
    const history = this.historyFor(slotId, stageId);
    if (!history) return false;

    // 新しい本体を書いてから索引を差し替え、前の本体は最後に消す。逆順にすると、
    // 書き込みに失敗した瞬間に自動セーブそのものが失われる。
    const id = newSaveId();
    try {
      this.store.writeSnapshot(id, data);
    } catch (e) {
      console.error('SaveSlots.writeAutoSave: 自動セーブを書き込めませんでした', e);
      return false;
    }
    const previous = history.autoSaveId ?? null;
    history.autoSaveId = id;

    const now = Date.now();
    history.lastPlayedAtReal = now;
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (slot) slot.lastPlayedAtReal = now;

    this.persist();
    if (previous !== null) this.store.deleteSnapshot(previous);
    return true;
  }

  // 本体を書き、メタを履歴の先頭へ入れる。履歴が MANUAL_SAVE_LIMIT 件に達しているときと、
  // 書き込みに失敗したときは false を返す。
  public addManualSave(slotId: string, stageId: string, meta: SnapshotMeta, data: GameSaveData): boolean {
    const history = this.historyFor(slotId, stageId);
    if (!history) return false;
    if (history.snapshots.length >= MANUAL_SAVE_LIMIT) return false;

    try {
      this.store.writeSnapshot(meta.id, data);
    } catch (e) {
      console.error('SaveSlots.addManualSave: 手動セーブを書き込めませんでした', e);
      return false;
    }

    // 本体が置けてから索引へ載せ、遊んだ時刻を履歴とスロットの両方へ反映する。
    history.snapshots.unshift(meta);
    history.lastPlayedAtReal = meta.createdAtReal;
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (slot) slot.lastPlayedAtReal = meta.createdAtReal;

    this.persist();
    return true;
  }

  // 全スロット・全履歴を横断してスナップショット id から所属を引く。
  private findSnapshot(snapshotId: string): { slot: SaveSlotMeta; history: StageHistoryMeta; meta: SnapshotMeta } | null {
    for (const slot of this.index.slots) {
      for (const history of slot.stages) {
        const meta = history.snapshots.find((m) => m.id === snapshotId);
        if (meta) return { slot, history, meta };
      }
    }
    return null;
  }

  // クリップの印を付け外しする。無い id なら何もしない。
  public setPinned(snapshotId: string, pinned: boolean): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    found.meta.pinned = pinned;
    this.persist();
  }

  // 手動セーブの表示名を変える。無い id なら何もしない。
  public renameSnapshot(snapshotId: string, name: string): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    found.meta.name = name;
    this.persist();
  }

  // 手動セーブを本体ごと消す。無い id なら何もしない。
  public deleteSnapshot(snapshotId: string): void {
    const found = this.findSnapshot(snapshotId);
    if (!found) return;
    this.removeSnapshotFrom(found.history, snapshotId);
    this.persist();
  }

  // スロットを書き出しの形にする。含めるのは手動セーブで、本体が読めなかった件は
  // メタからも落とす。無い slotId では null。
  public exportSlot(slotId: string): SlotExport | null {
    const slot = this.index.slots.find((s) => s.id === slotId);
    if (!slot) return null;

    // 履歴ごとに、書き出すメタと本体を組にして詰める。
    const exportedSlot: SaveSlotMeta = { ...slot, stages: [] };
    const snapshots: Record<string, GameSaveData> = {};
    for (const history of slot.stages) {
      const keptMetas: SnapshotMeta[] = [];
      for (const meta of history.snapshots) {
        const data = this.store.readSnapshot(meta.id);
        if (!data) continue;
        snapshots[meta.id] = data;
        keptMetas.push(meta);
      }
      exportedSlot.stages.push({ ...history, snapshots: keptMetas, autoSaveId: null });
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
  // もう一度読んだ時に既存スロットを壊さないため。取り込む形は自動セーブを持たないので、直近の
  // 周回は締めた状態で足す。書き込み途中で失敗したら書いた分を消して null。
  public importSlot(exp: SlotExport): SaveSlotMeta | null {
    const newSlot: SaveSlotMeta = {
      ...exp.slot,
      id: newSaveId(),
      name: this.uniqueName(exp.slot.name),
      lastRun: exp.slot.lastRun === null ? null : { stageId: exp.slot.lastRun.stageId, ended: true },
      stages: [],
    };

    // 手動セーブも id を振り直して本体を書く。途中で失敗したら書いた本体を消して取りやめる。
    const written: string[] = [];
    for (const history of exp.slot.stages) {
      const newHistory: StageHistoryMeta = { ...history, snapshots: [], autoSaveId: null };
      for (const meta of history.snapshots) {
        const data = exp.snapshots[meta.id];
        if (!data) continue;
        const newMeta: SnapshotMeta = { ...meta, id: newSaveId() };
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

    // 本体をすべて書けてから索引へ載せる。
    this.index.slots.push(newSlot);
    this.persist();
    return newSlot;
  }

  // 索引のどこからも参照されていない本体キーを消す。
  private pruneOrphans(): void {
    // 索引が指す本体(手動セーブと自動セーブ)を集めてから、それ以外のキーを消す。
    const referenced = new Set<string>();
    for (const slot of this.index.slots) {
      for (const history of slot.stages) {
        for (const meta of history.snapshots) referenced.add(meta.id);
        if (history.autoSaveId) referenced.add(history.autoSaveId);
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

  // 本体を消してから履歴のメタ配列からも外す。
  private removeSnapshotFrom(history: StageHistoryMeta, snapshotId: string): void {
    this.store.deleteSnapshot(snapshotId);
    history.snapshots = history.snapshots.filter((m) => m.id !== snapshotId);
  }

  // 索引を store へ書き戻す。書けなくても、この実行の中ではメモリ上の索引が生きる。
  private persist(): void {
    try {
      this.store.writeIndex(this.index);
    } catch (e) {
      console.error('SaveSlots: 索引の書き込みに失敗しました', e);
    }
  }
}
