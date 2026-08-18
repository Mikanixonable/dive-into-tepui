// 設計のファイルへの出し入れ。形の検証は blueprint.ts の parseBlueprintFile が持つので、ここは
// File と Blob の扱いだけを担う — 既存のセーブスロットの入出力と同じ切り分けである。

import type { VesselBlueprint } from './blueprint';
import { buildBlueprintFile, parseBlueprintFile } from './blueprint';
import type { BlueprintLibrary } from './blueprint-library';

export type BlueprintImportResult =
  | { readonly ok: true; readonly blueprints: readonly VesselBlueprint[] }
  | { readonly ok: false; readonly reason: string };

export function exportBlueprintsToFile(blueprints: readonly VesselBlueprint[]): void {
  const file = buildBlueprintFile(blueprints, Date.now());
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFileName(blueprints);
  a.click();
  // click() の直後に同期で解放するとダウンロードが始まる前に URL が無効になる環境があるため、
  // 次のタスクへ回す。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildFileName(blueprints: readonly VesselBlueprint[]): string {
  const base = blueprints.length === 1 ? blueprints[0]!.name : `${blueprints.length}件`;
  const safe = base.replace(/[^0-9A-Za-z぀-ヿ一-鿿]/g, '_') || 'blueprint';
  return `tepui-blueprint-${safe}.json`;
}

// ファイルを読んで検証し、新しい設計として取り込む。検証に落ちた場合は保管庫に一切触れない。
export async function importBlueprintsFromFile(
  library: BlueprintLibrary,
  file: File,
): Promise<BlueprintImportResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, reason: '設計ファイルとして読めません' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: '設計ファイルとして読めません' };
  }

  const checked = parseBlueprintFile(parsed);
  if (!checked.ok) return checked;
  return { ok: true, blueprints: library.importBlueprints(checked.blueprints) };
}
