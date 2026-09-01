import {
  SaveSlotMeta,
  SlotExport,
  StageHistoryMeta,
  SAVE_VERSION,
  SLOT_EXPORT_FORMAT,
  SLOT_EXPORT_VERSION,
} from './save-data';
import { SaveSlots } from './save-slots';

// セーブスロットのファイルへの出し入れと、外部から読み込んだ JSON が SlotExport
// として妥当かどうかの検証だけを担う。索引の操作(SaveSlots)にも永続化
// (SaveStore)にも属さない責務なので、ここに独立させる。

type ImportResult =
  | { ok: true; slot: SaveSlotMeta }
  | { ok: false; reason: string };

// slots.exportSlot() の結果をファイルとしてダウンロードさせる。対象スロットが無ければ false。
export function exportSlotToFile(slots: SaveSlots, slotId: string, pinnedOnly: boolean): boolean {
  const exp = slots.exportSlot(slotId, pinnedOnly);
  if (!exp) return false;

  const blob = new Blob([JSON.stringify(exp)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFileName(exp.slot.name);
  a.click();
  // click() の直後に同期で解放するとダウンロードが始まる前に URL が無効になる環境があるため、
  // 次のタスクへ回す。
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

// スロット名からダウンロードファイル名を作る。
function buildFileName(slotName: string): string {
  const safeName = slotName.replace(/[^0-9A-Za-z぀-ヿ一-鿿]/g, '_') || 'slot';
  return `tepui-${safeName}-${formatTimestamp(new Date())}.json`;
}

// ローカル時刻を yyyymmdd-hhmmss へ0埋めで組み立てる。
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${date}-${time}`;
}

// ファイルを読んで検証し、新しいスロットとして取り込む。検証に落ちた場合は
// slots.importSlot を一切呼ばない。
export async function importSlotFromFile(slots: SaveSlots, file: File): Promise<ImportResult> {
  // パース → 形式検証 → 取り込みの順で、途中で落ちたら以降を実行しない。
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, reason: 'セーブファイルとして読めません' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'セーブファイルとして読めません' };
  }

  const checked = checkSlotExportShape(parsed);
  if (!checked.ok) return checked;

  const slot = slots.importSlot(checked.exp);
  if (!slot) return { ok: false, reason: '保存領域が不足しているため取り込めませんでした' };
  return { ok: true, slot };
}

// ファイル選択ダイアログを開き、選ばれたファイルを importSlotFromFile に渡す。
export function pickAndImportSlot(slots: SaveSlots): Promise<ImportResult> {
  // input はダイアログの開閉に必要な間だけ DOM に置き、決着したら取り除く。ダイアログを
  // 閉じただけでは change が来ない環境があるので、ウィンドウへ戻った時点も終端として扱う
  // — これが無いと Promise が永久に解決せず、input も残り続ける。
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';

    let settled = false;
    const settle = (result: ImportResult | Promise<ImportResult>) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus);
      input.remove();
      resolve(result);
    };
    const onWindowFocus = () => {
      // focus はダイアログを閉じた直後に来るが、選択時は change がその後に続く。
      setTimeout(() => {
        if (!input.files || input.files.length === 0) settle({ ok: false, reason: '取り込みを中止しました' });
      }, 300);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      settle(file ? importSlotFromFile(slots, file) : { ok: false, reason: '取り込みを中止しました' });
    });
    input.addEventListener('cancel', () => settle({ ok: false, reason: '取り込みを中止しました' }));
    window.addEventListener('focus', onWindowFocus);

    document.body.appendChild(input);
    input.click();
  });
}

// unknown から段階的に SlotExport の形を確かめる。参照切れ・バージョン不一致の
// スナップショットは中止せずメタ側から取り除き、結果として空になった場合のみ落とす。
function checkSlotExportShape(parsed: unknown): { ok: false; reason: string } | { ok: true; exp: SlotExport } {
  // 形式・バージョン・構造・参照整合性の順に狭めていく。
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'セーブファイルとして読めません' };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.format !== SLOT_EXPORT_FORMAT) {
    return { ok: false, reason: 'これは Dive into Tepui のセーブファイルではありません' };
  }

  const formatVersion = obj.formatVersion;
  if (typeof formatVersion !== 'number' || formatVersion < 1 || formatVersion > SLOT_EXPORT_VERSION) {
    return { ok: false, reason: `対応していない形式のバージョンです (v${String(formatVersion)})` };
  }

  const slot = obj.slot;
  const snapshots = obj.snapshots;
  if (
    typeof slot !== 'object' || slot === null ||
    typeof snapshots !== 'object' || snapshots === null ||
    !Array.isArray((slot as Record<string, unknown>).stages)
  ) {
    return { ok: false, reason: 'セーブファイルが壊れています' };
  }

  const snapshotsRecord = snapshots as Record<string, unknown>;
  const stages = (slot as Record<string, unknown>).stages as unknown[];
  const filteredStages: StageHistoryMeta[] = [];
  for (const stage of stages) {
    if (typeof stage !== 'object' || stage === null || !Array.isArray((stage as Record<string, unknown>).snapshots)) {
      return { ok: false, reason: 'セーブファイルが壊れています' };
    }
    const stageObj = stage as unknown as StageHistoryMeta;
    const keptSnapshots = stageObj.snapshots.filter((meta) => {
      const data = snapshotsRecord[meta.id] as { version?: unknown } | undefined;
      return data !== undefined && data.version === SAVE_VERSION;
    });
    filteredStages.push({ ...stageObj, snapshots: keptSnapshots });
  }

  const totalKept = filteredStages.reduce((sum, s) => sum + s.snapshots.length, 0);
  if (totalKept === 0) {
    return { ok: false, reason: '復元できるスナップショットがありません' };
  }

  const keptIds = new Set(filteredStages.flatMap((s) => s.snapshots.map((m) => m.id)));
  const filteredSnapshots: Record<string, unknown> = {};
  for (const id of keptIds) filteredSnapshots[id] = snapshotsRecord[id];

  const exp: SlotExport = {
    format: SLOT_EXPORT_FORMAT,
    formatVersion,
    exportedAtReal: typeof obj.exportedAtReal === 'number' ? obj.exportedAtReal : Date.now(),
    slot: { ...(slot as SaveSlotMeta), stages: filteredStages },
    snapshots: filteredSnapshots as SlotExport['snapshots'],
  };
  return { ok: true, exp };
}
