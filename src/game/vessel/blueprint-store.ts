// 設計の localStorage への永続化。既存のセーブ(tepui.saveIndex / tepui.snapshot.*)とは鍵を分けて
// あり、設計を消してもセーブは、セーブを消しても設計は残る。

import type { BlueprintArchive, BlueprintStore } from './blueprint-library';

const BLUEPRINTS_KEY = 'tepui.blueprints';

export class LocalStorageBlueprintStore implements BlueprintStore {
  // 未保存・JSON破損のいずれでも null を返す(例外は投げない)。版の判定は保管庫が行う。
  public read(): BlueprintArchive | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(BLUEPRINTS_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const archive = JSON.parse(raw) as BlueprintArchive;
      if (typeof archive !== 'object' || archive === null || !Array.isArray(archive.blueprints)) return null;
      return archive;
    } catch {
      return null;
    }
  }

  // 失敗(localStorage 不可・容量超過)時は例外を素通しする — 呼び出し側が容量を空けて再試行する。
  public write(archive: BlueprintArchive): void {
    localStorage.setItem(BLUEPRINTS_KEY, JSON.stringify(archive));
  }
}
