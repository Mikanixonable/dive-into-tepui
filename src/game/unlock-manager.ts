// ステージ解放の判定・記録を一元管理する。stage-data.ts の StageDefinition は
// isUnlocked(clearCounts) という条件式を持つだけで、localStorage には一切触れない。
import { ACCENT } from './theme';
import { Hud } from '../hud/hud';
import { STAGE_DEFINITIONS } from './stages/stage-data';

// ステージ index → クリア回数。将来の拡張(周回数によるアンロック等)を見越して、
// 「クリアしたか否か」ではなく回数を記録する。
export type ClearCounts = Readonly<Record<number, number>>;

const STORAGE_KEY = 'tepui.clearCounts';

function loadClearCounts(): Record<number, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveClearCounts(counts: ClearCounts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    /* localStorage 不可なら保存しない(解放状態は都度未解放判定に戻る) */
  }
}

function isStageUnlocked(stage: number, counts: ClearCounts): boolean {
  const def = STAGE_DEFINITIONS.find((s) => s.index === stage);
  return def?.isUnlocked ? def.isUnlocked(counts) : true;
}

export class UnlockManager {
  private clearCounts = loadClearCounts();

  isUnlocked(stage: number): boolean {
    return isStageUnlocked(stage, this.clearCounts);
  }

  // ステージクリアを記録し、それによって新たに解放条件を満たしたステージがあれば toast で知らせる。
  reportClear(stage: number, hud: Hud): void {
    const newlyUnlocked = STAGE_DEFINITIONS.filter((s) => !isStageUnlocked(s.index, this.clearCounts));

    this.clearCounts = { ...this.clearCounts, [stage]: (this.clearCounts[stage] ?? 0) + 1 };
    saveClearCounts(this.clearCounts);

    for (const s of newlyUnlocked) {
      if (isStageUnlocked(s.index, this.clearCounts)) {
        hud.toast(`<span style="color:${ACCENT}">${s.selectLabel} が解放された</span>`);
      }
    }
  }
}
