import type { GameSaveData } from '../../game/save/save-data';
import type { SaveIndex } from './slot-data';

// セーブの永続化。索引と記録本体の読み書きを JSON I/O として提供する。

// 索引の形式バージョン。上げると、それ以前に書かれた索引は読めなくなる。
export const SAVE_INDEX_VERSION = 2;

const INDEX_KEY = 'tepui.saveIndex';
const SNAPSHOT_KEY_PREFIX = 'tepui.snapshot.';

// 索引とスナップショット本体の読み書き。実装は差し替え可能(将来 IndexedDB へ移す)。
export interface SaveStore {
  readIndex(): SaveIndex | null;
  writeIndex(index: SaveIndex): void;
  readSnapshot(id: string): GameSaveData | null;
  writeSnapshot(id: string, data: GameSaveData): void;
  deleteSnapshot(id: string): void;
  snapshotIds(): readonly string[];
}

export class LocalStorageSaveStore implements SaveStore {
  // 未保存/JSON破損/version 不一致のいずれでも null を返す(例外は投げない)。
  public readIndex(): SaveIndex | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(INDEX_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const index = JSON.parse(raw) as SaveIndex;
      if (index.version !== SAVE_INDEX_VERSION) return null;
      return index;
    } catch {
      return null;
    }
  }

  // localStorage が使えない・容量を超えたときは、その例外を素通しする。
  public writeIndex(index: SaveIndex): void {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  }

  // JSON破損なら null を返す(例外は投げない)。
  public readSnapshot(id: string): GameSaveData | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY_PREFIX + id);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as GameSaveData;
    } catch {
      return null;
    }
  }

  // localStorage が使えない・容量を超えたときは、その例外を素通しする。
  public writeSnapshot(id: string, data: GameSaveData): void {
    localStorage.setItem(SNAPSHOT_KEY_PREFIX + id, JSON.stringify(data));
  }

  // 対象キーが無くても何もしない。
  public deleteSnapshot(id: string): void {
    try {
      localStorage.removeItem(SNAPSHOT_KEY_PREFIX + id);
    } catch {
      // no-op
    }
  }

  // 現存する本体のキーを、索引に依らず直接走査して返す。
  public snapshotIds(): readonly string[] {
    const ids: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null && key.startsWith(SNAPSHOT_KEY_PREFIX)) {
          ids.push(key.slice(SNAPSHOT_KEY_PREFIX.length));
        }
      }
    } catch {
      return [];
    }
    return ids;
  }
}
