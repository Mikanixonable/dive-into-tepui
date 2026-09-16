import { SAVE_VERSION } from '../../game/save/save-data';
import type { RunSummary } from '../../game/run-summary';
import { fmtDist, fmtTime } from '../../hud/utils';
import { SaveStore } from './save-store';
import { SaveSlots } from './save-slots';
import { isEphemerisContextRestorable } from '../../physics/ephemeris/ephemeris-context';
import { newSaveId } from './slot-data';
import type { GameSaveData } from '../../game/save/save-data';
import type { SnapshotMeta } from './slot-data';

export interface SnapshotCaptureSource {
  readonly isPaused: boolean;
  readonly isPlaying: boolean;
  runSummary(): RunSummary;
  serialize(): GameSaveData;
}

// 記録の出し入れを担う。手動セーブは索引のメタを組んでスロットへ収め、自動セーブは上書きし、
// 読むときは保存形式を検証する。
export class SnapshotService {
  public constructor(private readonly store: SaveStore, private readonly slots: SaveSlots) {}

  // 要約と保存本体を1件の手動セーブとして残し、そのメタを返す。同じ瞬間で自動セーブも更新する。
  // アクティブスロットが無い、またはストア書き込みに失敗した場合は null。
  public addManualSave(summary: RunSummary, save: GameSaveData, name: string | null): SnapshotMeta | null {
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

    if (!this.slots.addManualSave(slotId, save.stageId, meta, save)) return null;
    this.slots.writeAutoSave(slotId, save.stageId, save);
    return meta;
  }

  // 自動セーブをこの瞬間へ差し替える。アクティブスロットが無ければ何も残さない。
  public writeAutoSave(save: GameSaveData): void {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return;
    this.slots.writeAutoSave(slotId, save.stageId, save);
  }

  // snapshotId の本体を取得する。本体欠損・バージョン不一致・
  // 起動先ステージとの不一致のいずれかなら null。
  public load(snapshotId: string, expectedStageId: string): GameSaveData | null {
    const data = this.store.readSnapshot(snapshotId);
    if (data === null) return null;
    if (data.version !== SAVE_VERSION) return null;
    if (expectedStageId !== data.stageId) return null;
    // 元期は継承するので照合しないが、その元期が選ぶ暦データがいま手元にあるものと違うなら、
    // 絶対天体状態が曖昧になるので拒否する。
    if (!isEphemerisContextRestorable(data.ephemerisContext)) return null;
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
