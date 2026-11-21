// ステージ解放の判定と、クリア回数の永続化を一元管理する。
import type { Notifier } from '../hud-kit/notifier';
import type { ClearCounts, StageId } from '../game/stages/stage';
import { findStageClass, STAGE_CLASSES } from '../game/stages/stage-dictionary';
import { loadStageKeyed, saveStageKeyed } from './stage-keyed-storage';

const STORAGE_KEY = 'tepui.clearCounts';

// localStorage からクリア回数を読み込む。取得できなければ空を返す。
function loadClearCounts(): Record<string, number> {
  return loadStageKeyed<number>(STORAGE_KEY);
}

// クリア回数を localStorage へ保存する。不可なら保存しない(解放状態は都度未解放判定に戻る)。
function saveClearCounts(counts: ClearCounts): void {
  saveStageKeyed(STORAGE_KEY, counts);
}

// stage の解放条件を counts から判定する。条件が定義されていなければ常に解放。
function isStageUnlocked(stage: StageId, counts: ClearCounts): boolean {
  const cls = findStageClass(stage);
  return cls ? cls.isUnlocked(counts) : true;
}

export class UnlockManager {
  private clearCounts = loadClearCounts();

  // stage が解放済みかどうかを返す。
  public isUnlocked(stage: StageId): boolean {
    return isStageUnlocked(stage, this.clearCounts);
  }

  // ステージクリアを記録し、それによって新たに解放条件を満たしたステージがあれば toast で知らせる。
  public reportClear(stage: StageId, notifier: Notifier): void {
    const newlyUnlocked = STAGE_CLASSES.filter((s) => !isStageUnlocked(s.id, this.clearCounts));

    this.clearCounts = { ...this.clearCounts, [stage]: (this.clearCounts[stage] ?? 0) + 1 };
    saveClearCounts(this.clearCounts);

    for (const s of newlyUnlocked) {
      if (isStageUnlocked(s.id, this.clearCounts)) {
        notifier.toast(`<span style="color:var(--color-primary)">${s.selectLabel} が解放された</span>`);
      }
    }
  }
}
