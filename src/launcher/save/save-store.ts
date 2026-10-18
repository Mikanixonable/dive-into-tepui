import { isShipBlueprint } from '../../game/ship/ship-blueprint';
import type { SerializedGame } from '../../game/game';
import type { ShipBlueprint } from '../../game/ship/ship-blueprint';
import type { SaveIndex } from './slot-data';

// セーブの永続化。索引・記録本体・設計図一覧の読み書きを JSON I/O として提供する。

// 索引の形式バージョン。上げると、それ以前に書かれた索引は読めなくなる。
export const SAVE_INDEX_VERSION = 2;

// 記録本体の形式バージョン。上げるのは構造が変わって互換を切るときで、上げた時点で
// それ以前に書かれた記録は読めなくなる。項目を増やすだけなら版は据え置き、省略可能にして
// 欠けた項目は復元で新しく作ったときの初期値で補う(SAVE.md「形式の版」)。
export const SAVED_GAME_VERSION = 4;

// 設計図一覧の本体の形式バージョン。記録本体と同じく、互換を切る構造の変更でだけ上げる。
export const BLUEPRINT_LIST_VERSION = 1;

// 保存した設計図一覧の本体の形。
interface StoredBlueprintList {
  readonly version: number;
  readonly blueprints: readonly ShipBlueprint[];
}

// 設計図一覧の本体の文字列を読み戻す。未保存・破損・版の違う本体は空として、
// 壊れた要素は1件ずつ外す。
export function parseBlueprintList(raw: string | null): readonly ShipBlueprint[] {
  if (raw === null) return [];
  try {
    const stored = JSON.parse(raw) as StoredBlueprintList;
    if (stored?.version !== BLUEPRINT_LIST_VERSION || !Array.isArray(stored.blueprints)) return [];
    return stored.blueprints.filter(isShipBlueprint);
  } catch {
    return [];
  }
}

// 記録本体。ランを直列化した形に、書いたときの形式バージョンを添える。
// 例外(ARCHITECTURE R12): 形式バージョン(launcher の値)を、ランの記録(モデル層の値)の最上位へ平らに
// 並べる。版を包む記録へ分けると保存の形式が変わり、版 4 の記録が読めなくなる。形式は版を上げるときに
// まとめて直す。
export interface SavedGame extends SerializedGame {
  readonly version: number;
}

const INDEX_KEY = 'tepui.saveIndex';
const SNAPSHOT_KEY_PREFIX = 'tepui.snapshot.';
const BLUEPRINTS_KEY_PREFIX = 'tepui.blueprints.';

// 索引・スナップショット本体・設計図一覧の読み書き。
export interface SaveStore {
  readIndex(): SaveIndex | null;
  writeIndex(index: SaveIndex): void;
  readSnapshot(id: string): SavedGame | null;
  writeSnapshot(id: string, data: SavedGame): void;
  deleteSnapshot(id: string): void;
  snapshotIds(): readonly string[];
  readBlueprints(slotId: string): readonly ShipBlueprint[];
  writeBlueprints(slotId: string, blueprints: readonly ShipBlueprint[]): void;
  deleteBlueprints(slotId: string): void;
}

export class LocalStorageSaveStore implements SaveStore {
  // 未保存・JSON 破損・version 不一致・localStorage が使えないときは、どれも null を返す。
  public readIndex(): SaveIndex | null {
    // localStorage が使えない環境では getItem も投げる。
    let raw: string | null;
    try {
      raw = localStorage.getItem(INDEX_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    // 壊れた JSON と、形式の版が違う索引は、未保存と同じ扱い。
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

  // 未保存・JSON 破損・localStorage が使えないときは null を返す。形式の版を問わず返す。
  public readSnapshot(id: string): SavedGame | null {
    // localStorage が使えない環境では getItem も投げる。
    let raw: string | null;
    try {
      raw = localStorage.getItem(SNAPSHOT_KEY_PREFIX + id);
    } catch {
      return null;
    }
    if (raw === null) return null;
    // 壊れた JSON は未保存と同じ扱い。
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

  // 現存する本体の id を、索引に依らずストアを走査して返す。localStorage が使えなければ空。
  public snapshotIds(): readonly string[] {
    const ids: string[] = [];
    try {
      // 本体のキーは接頭辞で見分け、接頭辞を除いた残りが id。
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

  // slotId の設計図一覧。読めない本体は空として扱う。
  public readBlueprints(slotId: string): readonly ShipBlueprint[] {
    let raw: string | null;
    try {
      raw = localStorage.getItem(BLUEPRINTS_KEY_PREFIX + slotId);
    } catch {
      return [];
    }
    return parseBlueprintList(raw);
  }

  // slotId の設計図一覧を本体ごと書き換える。localStorage が使えない・容量を超えたときは、
  // その例外を素通しする。
  public writeBlueprints(slotId: string, blueprints: readonly ShipBlueprint[]): void {
    const stored: StoredBlueprintList = { version: BLUEPRINT_LIST_VERSION, blueprints };
    localStorage.setItem(BLUEPRINTS_KEY_PREFIX + slotId, JSON.stringify(stored));
  }

  // slotId の設計図一覧を消す。対象キーが無くても何もしない。
  public deleteBlueprints(slotId: string): void {
    try {
      localStorage.removeItem(BLUEPRINTS_KEY_PREFIX + slotId);
    } catch {
      // 消せなくても、参照されない本体が残るだけ。
    }
  }
}
