import type { SerializedGame } from '../../game/game';
import type { SaveIndex } from './slot-data';

// セーブの永続化。索引と記録本体の読み書きを JSON I/O として提供する。

// 索引の形式バージョン。上げると、それ以前に書かれた索引は読めなくなる。
export const SAVE_INDEX_VERSION = 2;

// 記録本体の形式バージョン。上げるのは構造が変わって互換を切るときで、上げた時点で
// それ以前に書かれた記録は読めなくなる。項目を増やすだけなら版は据え置き、省略可能にして
// 欠けた項目は復元で新しく作ったときの初期値で補う(SAVE.md「形式の版」)。
export const SAVED_GAME_VERSION = 4;

// 記録本体。ランを直列化した形に、書いたときの形式バージョンを添える。
export interface SavedGame extends SerializedGame {
  readonly version: number;
}

const INDEX_KEY = 'tepui.saveIndex';
const SNAPSHOT_KEY_PREFIX = 'tepui.snapshot.';

// 索引とスナップショット本体の読み書き。
export interface SaveStore {
  readIndex(): SaveIndex | null;
  writeIndex(index: SaveIndex): void;
  readSnapshot(id: string): SavedGame | null;
  writeSnapshot(id: string, data: SavedGame): void;
  deleteSnapshot(id: string): void;
  snapshotIds(): readonly string[];
}

export class LocalStorageSaveStore implements SaveStore {
  // 未保存・JSON 破損・version 不一致は、どれも null を返す。
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

  // 未保存・JSON 破損は、どちらも null を返す。
  public readSnapshot(id: string): SavedGame | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY_PREFIX + id);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SavedGame;
    } catch {
      return null;
    }
  }

  // localStorage が使えない・容量を超えたときは、その例外を素通しする。
  public writeSnapshot(id: string, data: SavedGame): void {
    localStorage.setItem(SNAPSHOT_KEY_PREFIX + id, JSON.stringify(data));
  }

  // 対象キーが無くても何もしない。
  public deleteSnapshot(id: string): void {
    try {
      localStorage.removeItem(SNAPSHOT_KEY_PREFIX + id);
    } catch {
      // 消せなくても、参照されない本体が残るだけ。
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
