export type PayloadKind = 'ammunition' | 'propellant' | 'part';

export interface PayloadItem { readonly id: string; readonly kind: PayloadKind; readonly typeId: string; readonly mass: number; readonly volume: number; readonly rounds?: number; }
export interface PayloadBay { readonly volume: number; readonly maxPayloadMass: number; readonly items: readonly PayloadItem[]; }
export interface PayloadBayStatus { readonly accepted: boolean; readonly reason?: 'volume' | 'mass'; }

export function canLoad(bay: PayloadBay, item: PayloadItem): PayloadBayStatus {
  const volume = bay.items.reduce((sum, current) => sum + current.volume, 0);
  const mass = bay.items.reduce((sum, current) => sum + current.mass, 0);
  if (volume + item.volume > bay.volume) return { accepted: false, reason: 'volume' };
  if (mass + item.mass > bay.maxPayloadMass) return { accepted: false, reason: 'mass' };
  return { accepted: true };
}

export function loadPayload(bay: PayloadBay, item: PayloadItem): PayloadBay {
  if (!canLoad(bay, item).accepted) throw new Error('payload bay capacity exceeded');
  return { ...bay, items: [...bay.items, item] };
}

export interface ReleasedPayload { readonly item: PayloadItem; readonly velocityDelta: { x: number; y: number; z: number }; }
export function releasePayload(bay: PayloadBay, itemId: string, velocityDelta = { x: 0, y: 0, z: 0 }): { bay: PayloadBay; released: ReleasedPayload } {
  const index = bay.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error(`unknown payload ${itemId}`);
  const item = bay.items[index]!;
  return { bay: { ...bay, items: bay.items.filter((_unused, i) => i !== index) }, released: { item, velocityDelta } };
}

export interface AmmoFeedState { readonly weaponType: string; readonly magazineStageId: string; readonly weaponStageId: string; readonly loadedRounds: number; readonly maxLoadedRounds: number; }
export function canFeedAmmo(state: AmmoFeedState): boolean {
  return state.weaponStageId === state.magazineStageId && state.loadedRounds < state.maxLoadedRounds;
}
export function consumeRound(state: AmmoFeedState): AmmoFeedState {
  if (state.loadedRounds <= 0) return state;
  return { ...state, loadedRounds: state.loadedRounds - 1 };
}
