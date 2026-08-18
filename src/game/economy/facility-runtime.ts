import type { FacilityDef } from './facility';
import type { ResourceId } from './resource';
import type { ResourceLedger } from './resource-ledger';

export interface FacilityRuntime { readonly id: string; enabled: boolean; priority: number; }
export interface FacilityStep { readonly running: readonly string[]; readonly stopped: readonly string[]; readonly produced: ReadonlyMap<ResourceId, number>; readonly consumed: ReadonlyMap<ResourceId, number>; }

export function stepFacilities(defs: readonly FacilityDef[], facilities: readonly FacilityRuntime[], ledger: ResourceLedger, availablePowerW: number, dt: number): FacilityStep {
  if (dt < 0 || availablePowerW < 0) throw new RangeError('invalid facility step');
  const byId = new Map(defs.map((def) => [def.id, def]));
  const running: string[] = []; const stopped: string[] = [];
  const produced = new Map<ResourceId, number>(); const consumed = new Map<ResourceId, number>();
  let power = availablePowerW;
  for (const runtime of [...facilities].sort((a, b) => a.priority - b.priority)) {
    const def = byId.get(runtime.id);
    if (!runtime.enabled || !def || def.powerDraw > power || def.inputs.some((input) => input.anyOf.every((id) => ledger.amountOf(id) < input.rate * dt))) { stopped.push(runtime.id); continue; }
    power -= def.powerDraw; running.push(runtime.id);
    for (const input of def.inputs) { const id = input.anyOf.find((candidate) => ledger.amountOf(candidate) >= input.rate * dt); if (id) { ledger.take(id, input.rate * dt); consumed.set(id, (consumed.get(id) ?? 0) + input.rate * dt); } }
    for (const output of def.outputs) { const amount = output.rate * dt; ledger.add(output.resourceId, amount); produced.set(output.resourceId, (produced.get(output.resourceId) ?? 0) + amount); }
  }
  return { running, stopped, produced, consumed };
}
