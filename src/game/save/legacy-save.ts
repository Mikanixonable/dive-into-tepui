import { GameSaveData, SaveSlotMeta, SnapshotMeta, SAVE_VERSION } from './save-data';
import { SaveSlots } from './save-slots';

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

function readLegacy(): GameSaveData | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as GameSaveData;
    return data.version === SAVE_VERSION ? data : null;
  } catch {
    return null;
  }
}

// 旧セーブには一覧用のメタが無いので、本体から読める範囲だけで組み立てる。位置・速度は
// 導出に Game 実行状態が要るため 0 のままにし、消えないようクリップ済みで取り込む。
// centerBodyId は 'earth' 固定 — この移行はレジストリ導入前(常に現実の太陽系・地球原点)の
// セーブ形式だけを対象にしており、起動中の CelestialSystem をまだ持てない(main.ts の起動処理の中で
// Game 構築より前に走る)ため、動的なレジストリの原点を引く経路が無い。
function metaFromSaveData(data: GameSaveData): SnapshotMeta {
  return {
    id: `legacy-${Date.now().toString(36)}`,
    kind: 'manual',
    pinned: true,
    name: '移行前のセーブ',
    createdAtReal: Date.now(),
    simTime: data.simTime,
    centerBodyId: 'earth',
    altitude: 0,
    speed: 0,
    hpRatio: 0,
    maxHp: 0,
    magazines: 0,
    money: data.bases.reduce((sum, b) => sum + b.money, 0),
    playerCount: data.players.length,
    enemyAliveCount: data.enemies.filter((e) => e.alive).length,
    phase: data.stage.phase,
  };
}
