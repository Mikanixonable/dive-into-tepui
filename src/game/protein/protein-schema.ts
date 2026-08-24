export type ProteinVec3 = readonly [number, number, number];
export type ProteinSource = 'author' | 'computed' | 'game';
export type ProteinSiteType = 'active' | 'interface' | 'core' | 'modification';
export type ProteinPhase = 'intact' | 'exposed' | 'dissociated' | 'critical';

export interface ProteinComponentDefinition {
  readonly id: string;
  readonly chains: readonly string[];
  readonly entities: readonly number[];
  readonly role: string;
  readonly source: ProteinSource;
}

export interface ProteinSiteDefinition {
  readonly id: string;
  readonly type: ProteinSiteType;
  readonly source: ProteinSource;
  readonly residues: readonly string[];
  readonly anchor: string;
  /** Coordinates are in the source structure's Å coordinate system. */
  readonly position: ProteinVec3;
  readonly forward: ProteinVec3;
  readonly radius: number;
  readonly maxHp: number;
  readonly damageMultiplier: number;
  readonly actions: readonly string[];
}

export interface ProteinModificationDefinition {
  readonly id: string;
  readonly label: string;
  readonly source: ProteinSource;
  readonly anchor: string;
  readonly position: ProteinVec3;
  readonly states: readonly string[];
  readonly defaultState: string;
  readonly effects: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ProteinMotionDefinition {
  readonly morphTargets: number;
  readonly ouTheta: number;
  readonly ouSigma: number;
  readonly amplitude: number;
}

export interface ProteinAssetDefinition {
  readonly schemaVersion: number;
  readonly id: string;
  readonly source: {
    readonly pdbId: string;
    readonly structureFile: string;
    readonly citation?: string;
  };
  readonly coordinateScale: number;
  readonly integrity: { readonly maxHp: number };
  readonly components: readonly ProteinComponentDefinition[];
  readonly sites: readonly ProteinSiteDefinition[];
  readonly modificationSlots: readonly ProteinModificationDefinition[];
  readonly motion: ProteinMotionDefinition;
}

export interface ProteinSiteSaveData {
  id: string;
  hp: number;
  disabled: boolean;
}

export interface ProteinSaveData {
  schemaVersion: number;
  integrityHp: number;
  phase: ProteinPhase;
  sites: ProteinSiteSaveData[];
  modifications: Record<string, string>;
}

export interface ProteinHudSnapshot {
  readonly phase: ProteinPhase;
  readonly integrityHp: number;
  readonly integrityMaxHp: number;
  readonly selectedSiteId: string | null;
  readonly sites: readonly {
    readonly id: string;
    readonly label: string;
    readonly hp: number;
    readonly maxHp: number;
    readonly disabled: boolean;
    readonly attackable: boolean;
  }[];
}

export interface ProteinLegacyState {
  readonly health?: number;
  readonly protein?: ProteinSaveData;
}

export function validateProteinAsset(asset: ProteinAssetDefinition): string[] {
  const issues: string[] = [];
  if (asset.schemaVersion !== 1) issues.push(`unsupported schemaVersion: ${asset.schemaVersion}`);
  if (!asset.id) issues.push('id is empty');
  if (!Number.isFinite(asset.coordinateScale) || asset.coordinateScale <= 0) issues.push('coordinateScale must be positive');
  if (!Number.isFinite(asset.integrity.maxHp) || asset.integrity.maxHp <= 0) issues.push('integrity.maxHp must be positive');
  const ids = new Set<string>();
  for (const site of asset.sites) {
    if (ids.has(site.id)) issues.push(`duplicate site id: ${site.id}`);
    ids.add(site.id);
    if (!Number.isFinite(site.radius) || site.radius <= 0) issues.push(`site ${site.id} radius must be positive`);
    if (!Number.isFinite(site.maxHp) || site.maxHp <= 0) issues.push(`site ${site.id} maxHp must be positive`);
    if (site.position.length !== 3 || site.forward.length !== 3) issues.push(`site ${site.id} vector must have 3 components`);
  }
  const modificationIds = new Set<string>();
  for (const slot of asset.modificationSlots) {
    if (modificationIds.has(slot.id)) issues.push(`duplicate modification id: ${slot.id}`);
    modificationIds.add(slot.id);
    if (!slot.states.includes(slot.defaultState)) issues.push(`modification ${slot.id} defaultState is not listed`);
  }
  return issues;
}
