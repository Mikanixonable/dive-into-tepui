import { type GameSaveData, SAVE_VERSION } from '../../game/save/save-data';
import type { SaveSlotMeta, SnapshotMeta } from './slot-data';
import type { SaveSlots } from './save-slots';

// 単一スロット時代の固定キー(tepui.save)に残っているセーブを、スロット/スナップショット
// 構造へ1回だけ引き取る。
const LEGACY_KEY = 'tepui.save';

// 旧セーブがあれば新しいスロットとして取り込み、旧キーを消す。取り込んだスロットを返す
// (旧セーブが無い・読めない場合は null)。
export function migrateLegacySave(slots: SaveSlots): SaveSlotMeta | null {
  const data = readLegacy();
  if (!data) return null;

  const slot = slots.createSlot('移行データ');
  const meta = metaFromSaveData(data);
  const added = slots.addSnapshot(slot.id, data.stageId, meta, data);
  if (!added) {
    slots.deleteSlot(slot.id);
    return null;
  }
  slots.noteLaunch(slot.id, data.stageId);
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 消せなくても取り込みは済んでいる */
  }
  return slot;
}

// 旧キーに残っているセーブ。無い・localStorage が使えない・現行の版で読めないときは null。
function readLegacy(): GameSaveData | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  // 現行の版で書かれたものを取り込む。
  try {
    const data = JSON.parse(raw) as GameSaveData;
    return data.version === SAVE_VERSION ? data : null;
  } catch {
    return null;
  }
}

// 旧セーブの本体から一覧用のメタを起こす。自動剪定で消えないよう、クリップ済みで取り込む。
function metaFromSaveData(data: GameSaveData): SnapshotMeta {
  return {
    id: `legacy-${Date.now().toString(36)}`,
    kind: 'manual',
    pinned: true,
    name: '移行前のセーブ',
    createdAtReal: Date.now(),
    simTime: data.simTime,
    // 旧形式のセーブは常に現実の太陽系・地球原点。
    centerBodyId: 'earth',
    // 導くのに Game の実行状態が要る値は 0。
    altitude: 0,
    speed: 0,
    hpRatio: 0,
    maxHp: 0,
    magazines: 0,
    // 本体の実体一覧から数えられる値。
    money: data.entities.reduce((sum, e) => sum + (e.kind === 'base' ? e.money : 0), 0),
    playerCount: data.entities.filter((e) => e.kind === 'player').length,
    enemyAliveCount: data.entities.filter(
      (e) => (e.kind === 'metal-enemy' || e.kind === 'protein-enemy') && e.alive).length,
    phase: data.stage.phase,
  };
}
