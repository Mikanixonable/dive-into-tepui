// ステージ id をキーにした JSON の読み書き。localStorage が使えない環境では読みは空、
// 書きは何もしない。キーのステージ id は、番号の付け替え以前に保存された旧番号も
// 新番号へ読み替える。
import { normalizeStageId } from '../game/stages/stage-dictionary';

export function loadStageKeyed<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return Object.fromEntries(
      Object.entries(parsed).map(([id, value]) => [normalizeStageId(id), value]),
    );
  } catch {
    return {};
  }
}

export function saveStageKeyed<T>(key: string, values: Record<string, T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(values));
  } catch {
    /* localStorage 不可なら保存しない */
  }
}
