// ステージ解放の判定・記録を一元管理する。ステージクラスの静的 isUnlocked(clearCounts) は
// 条件式を持つだけで、localStorage には触れない。
import { Hud } from './hud/hud';
import { StageId } from './stages/stage';
import { findStageClass, STAGE_CLASSES } from './stages/stage-dictionary';

// ステージ ID → クリア回数。将来の拡張(周回数によるアンロック等)を見越して、
// 「クリアしたか否か」ではなく回数を記録する。
export type ClearCounts = Readonly<Record<string, number>>;

const STORAGE_KEY = 'tepui.clearCounts';

// localStorage からクリア回数を読み込む。取得できなければ空を返す。
function loadClearCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// クリア回数を localStorage へ保存する。
function saveClearCounts(counts: ClearCounts): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counts));
  } catch {
    /* localStorage 不可なら保存しない(解放状態は都度未解放判定に戻る) */
  }
}

// stage の解放条件を counts から判定する。条件が定義されていなければ常に解放。
function isStageUnlocked(stage: StageId, counts: ClearCounts): boolean {
  const cls = findStageClass(stage);
  return cls ? cls.isUnlocked(counts) : true;
}

export class UnlockManager {
  private clearCounts = loadClearCounts();

  // stage が解放済みかどうかを返す。
  isUnlocked(stage: StageId): boolean {
    return isStageUnlocked(stage, this.clearCounts);
  }

  // ステージクリアを記録し、それによって新たに解放条件を満たしたステージがあれば toast で知らせる。
  reportClear(stage: StageId, hud: Hud): void {
    const newlyUnlocked = STAGE_CLASSES.filter((s) => !isStageUnlocked(s.id, this.clearCounts));

    this.clearCounts = { ...this.clearCounts, [stage]: (this.clearCounts[stage] ?? 0) + 1 };
    saveClearCounts(this.clearCounts);

    for (const s of newlyUnlocked) {
      if (isStageUnlocked(s.id, this.clearCounts)) {
        hud.toast(`<span style="color:var(--color-primary)">${s.selectLabel} が解放された</span>`);
      }
    }
  }
}
