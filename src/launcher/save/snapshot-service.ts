import { Game } from '../../game/game';
import { SAVE_VERSION } from '../../game/save/save-data';
import { type RunSummary, summarizeRun } from '../../game/run-summary';
import { serializeRun } from '../../game/save/serialize-run';
import { fmtDist, fmtTime } from '../../hud/utils';
import { SaveStore } from './save-store';
import { SaveSlots } from './save-slots';
import { isEphemerisContextRestorable } from '../../physics/ephemeris/ephemeris-context';
import type { AmmoPickupSaveData, GameSaveData, RcsFuelPickupSaveData } from '../../game/save/save-data';
import type { SnapshotKind, SnapshotMeta } from './slot-data';

// Game の実行状態と GameSaveData の相互変換、およびストア/スロットへの出し入れを担う。
export class SnapshotService {
  constructor(private readonly store: SaveStore, private readonly slots: SaveSlots) {}

  // 現在の game 状態を1件のスナップショットとして永続化し、そのメタを返す。
  // アクティブスロットが無い、またはストア書き込みに失敗した場合は null。
  capture(game: Game, kind: SnapshotKind, name: string | null, pinned: boolean): SnapshotMeta | null {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return null;

    const summary = summarizeRun(game);
    const meta: SnapshotMeta = {
      id: generateSnapshotId(),
      kind,
      pinned,
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

    const save = serializeRun(game);
    return this.slots.addSnapshot(slotId, save.stageId, meta, save) ? meta : null;
  }

  // snapshotId のスナップショット本体を取得する。本体欠損・バージョン不一致・
  // 起動先ステージとの不一致のいずれかなら null。
  load(snapshotId: string, expectedStageId: string): GameSaveData | null {
    const data = this.store.readSnapshot(snapshotId);
    if (data === null) return null;
    if (data.version !== SAVE_VERSION) return null;
    const normalizedData = normalizePickupKeys(data);
    if (normalizedData === null) return null;
    if (expectedStageId !== normalizedData.stageId) return null;
    // 暦情報が無いスナップショットは互換復元で読む。元期は継承するので照合しないが、
    // その元期が選ぶ暦データがいま手元にあるものと違うなら、絶対天体状態が曖昧になるので拒否する。
    if (!isEphemerisContextRestorable(
      (normalizedData as { ephemerisContext?: unknown }).ephemerisContext,
    )) return null;
    return normalizedData;
  }
}

// 旧形式の補給キーと、RCS燃料追加前の欠落フィールドを読み込み境界で正規化する。
function normalizePickupKeys(data: GameSaveData): GameSaveData | null {
  const storedData = data as Omit<GameSaveData, 'ammoPickups'> & {
    ammoPickups?: AmmoPickupSaveData[];
    ammos?: AmmoPickupSaveData[];
    rcsFuelPickups?: RcsFuelPickupSaveData[];
  };
  const ammoPickups = storedData.ammoPickups ?? storedData.ammos;
  if (!Array.isArray(ammoPickups)) return null;

  const normalizedData = {
    ...storedData,
    ammoPickups,
    rcsFuelPickups: storedData.rcsFuelPickups ?? [],
    detachedBoosters: storedData.detachedBoosters ?? [],
  };
  delete normalizedData.ammos;
  return normalizedData;
}

// 名前を付けずに撮ったスナップショットの表示名。自機が居ない周回では経過時間だけを出す。
function autoName(summary: RunSummary): string {
  const timeLabel = `MET ${fmtTime(summary.simTime)}`;
  return summary.playerCount > 0
    ? `${timeLabel} ・ ${summary.centerBodyName} 高度 ${fmtDist(summary.altitude)}`
    : timeLabel;
}

// 同一ミリ秒の連続呼び出しでも衝突しないよう、時刻にランダムな尾部を付ける。
function generateSnapshotId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
