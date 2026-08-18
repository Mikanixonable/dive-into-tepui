import { DEPOSITS, type DepositAccess } from './deposit';
import type { ResourceId } from './resource';
import type { ResourceLedger } from './resource-ledger';

export interface MiningSite { readonly bodyId: string; readonly access: DepositAccess; readonly latRad: number; readonly lonRad: number; }
export interface MiningResult { readonly mined: number; readonly resourceId: ResourceId; readonly remainingCapacity: number; }
export function depositAt(site: MiningSite, resourceId: ResourceId): number {
  return DEPOSITS.find((deposit) => deposit.bodyId === site.bodyId && deposit.resourceId === resourceId && deposit.access === site.access)?.abundance ?? 0;
}
export function mine(site: MiningSite, resourceId: ResourceId, facilityCount: number, dt: number, ledger: ResourceLedger, capacityKg: number): MiningResult {
  if (facilityCount < 0 || dt < 0 || capacityKg < 0) throw new RangeError('invalid mining input');
  const mined = Math.min(capacityKg, depositAt(site, resourceId) * facilityCount * dt);
  ledger.add(resourceId, mined);
  return { mined, resourceId, remainingCapacity: capacityKg - mined };
}

export interface TransferLink { readonly connected: boolean; readonly rateKgPerSecond: number; }
export function transferResources(from: ResourceLedger, to: ResourceLedger, resourceId: ResourceId, amountKg: number, link: TransferLink, dt: number): number {
  if (amountKg < 0 || dt < 0) throw new RangeError('invalid transfer input');
  if (!link.connected) return 0;
  const moved = Math.min(amountKg, link.rateKgPerSecond * dt, from.amountOf(resourceId));
  if (from.take(resourceId, moved)) { to.add(resourceId, moved); return moved; }
  return 0;
}

export function cargoPropellantMass(dryMass: number, cargoMass: number, deltaV: number, isp: number): number {
  if (dryMass <= 0 || cargoMass < 0 || deltaV < 0 || isp <= 0) throw new RangeError('invalid cargo inputs');
  const g0 = 9.80665;
  return (dryMass + cargoMass) * (Math.exp(deltaV / (g0 * isp)) - 1);
}
