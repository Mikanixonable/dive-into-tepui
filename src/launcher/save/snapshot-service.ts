import type { SerializedGame } from '../../game/game';
import type { RunSummary } from '../../game/run-summary';
import { fmtDist, fmtTime } from '../../hud/utils';
import { SAVED_GAME_VERSION, type SavedGame, type SaveStore } from './save-store';
import { SaveSlots } from './save-slots';
import { isEphemerisContextRestorable } from '../../physics/ephemeris/ephemeris-context';
import { newSaveId } from './slot-data';
import type { SnapshotMeta } from './slot-data';

// 周回を直列化した形 serialized に、いまの形式バージョンを添えた記録本体。
function savedGame(serialized: SerializedGame): SavedGame {
  return { version: SAVED_GAME_VERSION, ...serialized };
}

// 記録を1件残すときに、その瞬間の周回から読む口。
export interface SnapshotSource {
  readonly isPaused: boolean;
  readonly isPlaying: boolean;
  runSummary(): RunSummary;
  serialize(): SerializedGame;
}

// 記録の出し入れを担う。手動セーブは索引のメタを組んでスロットへ収め、自動セーブは上書きし、
// 読むときは保存形式を検証する。
export class SnapshotService {
  public constructor(private readonly store: SaveStore, private readonly slots: SaveSlots) {}

  // 要約と保存本体を1件の手動セーブとして残し、そのメタを返す。同じ瞬間で自動セーブも更新する。
  // アクティブスロットが無い、またはストア書き込みに失敗した場合は null。
  public addManualSave(summary: RunSummary, serialized: SerializedGame, name: string | null): SnapshotMeta | null {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return null;

    // 一覧が本体を読まずに描けるよう、その瞬間の要約をメタへ写す。
    const meta: SnapshotMeta = {
      id: newSaveId(),
      pinned: false,
      name: name && name.length > 0 ? name : autoName(summary),
      createdAtReal: Date.now(),
      simTime: summary.simTime,
      centerBodyId: summary.centerBodyId,
      altitude: summary.altitude,
      speed: summary.speed,
      hpRatio: summary.hpRatio,
      maxHp: summary.maxHp,
      magazines: summary.magazines,
      money: summary.money,
      playerCount: summary.playerCount,
      enemyAliveCount: summary.enemyAliveCount,
      phase: summary.phase,
    };

    const save = savedGame(serialized);
    if (!this.slots.addManualSave(slotId, save.progress.stageId, meta, save)) return null;
    this.slots.writeAutoSave(slotId, save.progress.stageId, save);
    return meta;
  }

  // 自動セーブをこの瞬間へ差し替える。アクティブスロットが無ければ何も残さない。
  public writeAutoSave(serialized: SerializedGame): void {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return;
    this.slots.writeAutoSave(slotId, serialized.progress.stageId, savedGame(serialized));
  }

  // snapshotId の本体を取得する。本体欠損・バージョン不一致・
  // 起動先ステージとの不一致のいずれかなら null。
  public load(snapshotId: string, expectedStageId: string): SavedGame | null {
    const data = this.store.readSnapshot(snapshotId);
    if (data === null) return null;
    // 版を先に照合する — 版の違う記録は形が違うので、ほかの項目を読まない。
    if (data.version !== SAVED_GAME_VERSION) return null;
    if (expectedStageId !== data.progress.stageId) return null;
    // 元期は継承するので照合しないが、その元期が選ぶ暦データがいま手元にあるものと違うなら、
    // 絶対天体状態が曖昧になるので拒否する。
    if (!isEphemerisContextRestorable(data.progress.ephemerisContext)) return null;
    return data;
  }
}

// 名前を付けずに残した手動セーブの表示名。自機が居ない周回では経過時間だけを出す。
function autoName(summary: RunSummary): string {
  const timeLabel = `MET ${fmtTime(summary.simTime)}`;
  return summary.playerCount > 0
    ? `${timeLabel} ・ ${summary.centerBodyName} 高度 ${fmtDist(summary.altitude)}`
    : timeLabel;
}
