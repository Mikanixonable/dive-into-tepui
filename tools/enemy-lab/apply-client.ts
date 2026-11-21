// 調整値を開発サーバの窓口(tools/enemy-lab-apply-tuning.cjs)へ送る。
import { ASSEMBLY_TUNING_DEFAULTS, type AssemblyTuning, type AssemblyTuningId } from '../../src/physics/assembly-tuning';

export type ApplyTarget = 'defaults' | 'overrides';

interface ApplyResult {
  readonly changed: readonly { readonly key: string; readonly from: string; readonly to: string }[];
}

// 既定値と違う項目の id。
export function changedIds(values: AssemblyTuning): AssemblyTuningId[] {
  return (Object.keys(ASSEMBLY_TUNING_DEFAULTS) as AssemblyTuningId[])
    .filter((id) => values[id] !== ASSEMBLY_TUNING_DEFAULTS[id]);
}

// target が 'overrides' なら実行中のゲームへ試しに送る(git 管理外。空の表で解除)。'defaults' なら
// assembly-tuning.ts の既定値を書き換える(git に差分が出る)。失敗は投げる。
export async function sendTuning(
  target: ApplyTarget, values: Readonly<Partial<Record<AssemblyTuningId, number>>>,
): Promise<ApplyResult> {
  const response = await fetch('/__enemy-lab/apply-tuning', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, values }),
  });
  const body = await response.json() as ApplyResult & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

// values のうち既定値と違う項目だけを取り出す。
export function onlyChanged(values: AssemblyTuning): Partial<Record<AssemblyTuningId, number>> {
  const out: Partial<Record<AssemblyTuningId, number>> = {};
  for (const id of changedIds(values)) out[id] = values[id];
  return out;
}
