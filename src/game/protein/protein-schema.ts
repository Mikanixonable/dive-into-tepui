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
  /** Biological name (residue/domain-based) shown in HUD/markers, distinct from the internal id. */
  readonly label: string;
  readonly componentId: string;
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

export interface ProteinActionDefinition {
  readonly id: string;
  readonly kind: 'projectile';
}

export interface ProteinBondDefinition {
  readonly from: string;
  readonly to: string;
}

export interface ProteinLigandDefinition {
  readonly id: string;
  readonly label: string;
  /** Three-letter residue name used by the structure asset (for example HEM). */
  readonly residue: string;
  /** Functional site located at the ligand's reaction/metal center. */
  readonly centerSite: string;
  readonly metalElement?: string;
}

export interface ProteinModificationDefinition {
  readonly id: string;
  readonly componentId: string;
  readonly label: string;
  readonly source: ProteinSource;
  readonly anchor: string;
  /** Optional structure residue descriptors used to average a moving marker anchor. */
  readonly residues?: readonly string[];
  readonly position: ProteinVec3;
  readonly states: readonly string[];
  readonly defaultState: string;
  readonly effects: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface ProteinMotionAsset {
  readonly schemaVersion: 1;
  readonly model: 'c-alpha-anm-overdamped';
  readonly source: {
    readonly pdbId: string;
    readonly structureHash: string;
    readonly backboneHash: string;
    readonly generatorVersion: number;
    readonly cutoffAngstrom: number;
  };
  readonly residueCount: number;
  readonly residues: {
    readonly chains: readonly string[];
    readonly residueNumbers: readonly number[];
    readonly centers: readonly number[];
    readonly bFactors: readonly number[];
  };
  readonly bindings: {
    readonly atomResidues: readonly number[];
    readonly backboneResidues: readonly number[];
    readonly surfaceResidues: readonly number[];
    readonly ribbonResidues: readonly number[];
    readonly siteResidues: readonly number[];
    readonly modificationResidues: readonly number[];
  };
  readonly modes: readonly {
    readonly id: string;
    readonly band: 'collective' | 'local';
    readonly eigenvalue: number;
    readonly displayRelaxationRate: number;
    readonly physicalRmsAngstrom?: number;
    readonly displayRmsAngstrom?: number;
    readonly displacements: readonly number[];
  }[];
  readonly display: {
    readonly sampleHz: number;
    readonly collectiveGain: number;
    readonly localGain: number;
  };
  readonly amplitudeCalibration: 'b-factor-relative' | 'uncalibrated-display';
}

export interface ProteinMotionExpectedCounts {
  readonly atomResidues: number;
  readonly backboneResidues: number;
  readonly surfaceResidues: number;
  readonly ribbonResidues: number;
  readonly siteResidues: number;
  readonly modificationResidues: number;
}

export interface ProteinAssetDefinition {
  readonly schemaVersion: number;
  readonly id: string;
  /** The protein's own name (e.g. "ルビスコ"), prefixed onto the enemy's display name. */
  readonly displayName: string;
  readonly source: {
    readonly pdbId: string;
    readonly structureFile: string;
    readonly citation?: string;
  };
  readonly coordinateScale: number;
  readonly integrity: { readonly maxHp: number };
  readonly actions: readonly ProteinActionDefinition[];
  readonly bonds: readonly ProteinBondDefinition[];
  readonly ligands: readonly ProteinLigandDefinition[];
  readonly components: readonly ProteinComponentDefinition[];
  readonly sites: readonly ProteinSiteDefinition[];
  readonly modificationSlots: readonly ProteinModificationDefinition[];
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

export function validateProteinAsset(asset: ProteinAssetDefinition): string[] {
  const issues: string[] = [];
  if (asset.schemaVersion !== 1) issues.push(`unsupported schemaVersion: ${asset.schemaVersion}`);
  if (!asset.id) issues.push('id is empty');
  if (!asset.displayName) issues.push('displayName is empty');
  if (!Number.isFinite(asset.coordinateScale) || asset.coordinateScale <= 0) issues.push('coordinateScale must be positive');
  if (!Number.isFinite(asset.integrity.maxHp) || asset.integrity.maxHp <= 0) issues.push('integrity.maxHp must be positive');
  const componentIds = new Set<string>();
  for (const component of asset.components) {
    if (!component.id) issues.push('component id is empty');
    if (componentIds.has(component.id)) issues.push(`duplicate component id: ${component.id}`);
    componentIds.add(component.id);
  }
  const actionIds = new Set<string>();
  for (const action of asset.actions) {
    if (!action.id) issues.push('action id is empty');
    if (actionIds.has(action.id)) issues.push(`duplicate action id: ${action.id}`);
    actionIds.add(action.id);
  }
  const ids = new Set<string>();
  for (const site of asset.sites) {
    if (ids.has(site.id)) issues.push(`duplicate site id: ${site.id}`);
    ids.add(site.id);
    if (!site.label) issues.push(`site ${site.id} label is empty`);
    if (!componentIds.has(site.componentId)) issues.push(`site ${site.id} references unknown component: ${site.componentId}`);
    if (!Number.isFinite(site.radius) || site.radius <= 0) issues.push(`site ${site.id} radius must be positive`);
    if (!Number.isFinite(site.maxHp) || site.maxHp <= 0) issues.push(`site ${site.id} maxHp must be positive`);
    if (site.position.length !== 3 || site.forward.length !== 3 || site.position.some((value) => !Number.isFinite(value)) || site.forward.some((value) => !Number.isFinite(value))) issues.push(`site ${site.id} vector must be a finite 3-vector`);
    for (const action of site.actions) {
      if (!actionIds.has(action)) issues.push(`site ${site.id} references unknown action: ${action}`);
    }
  }
  for (const bond of asset.bonds) {
    if (!ids.has(bond.from)) issues.push(`bond references unknown site: ${bond.from}`);
    if (!ids.has(bond.to)) issues.push(`bond references unknown site: ${bond.to}`);
  }
  const ligandIds = new Set<string>();
  for (const ligand of asset.ligands) {
    if (!ligand.id) issues.push('ligand id is empty');
    if (ligandIds.has(ligand.id)) issues.push(`duplicate ligand id: ${ligand.id}`);
    ligandIds.add(ligand.id);
    if (!ligand.residue) issues.push(`ligand ${ligand.id} residue is empty`);
    if (!ids.has(ligand.centerSite)) issues.push(`ligand ${ligand.id} references unknown center site: ${ligand.centerSite}`);
  }
  const modificationIds = new Set<string>();
  for (const slot of asset.modificationSlots) {
    if (modificationIds.has(slot.id)) issues.push(`duplicate modification id: ${slot.id}`);
    modificationIds.add(slot.id);
    if (!componentIds.has(slot.componentId)) issues.push(`modification ${slot.id} references unknown component: ${slot.componentId}`);
    if (slot.position.length !== 3 || slot.position.some((value) => !Number.isFinite(value))) issues.push(`modification ${slot.id} position must be a finite 3-vector`);
    if (!slot.states.includes(slot.defaultState)) issues.push(`modification ${slot.id} defaultState is not listed`);
  }
  return issues;
}

export function validateProteinMotionAsset(asset: ProteinMotionAsset, expectedPdbId?: string, expectedCounts?: ProteinMotionExpectedCounts): string[] {
  const issues: string[] = [];
  if (asset.schemaVersion !== 1) issues.push(`unsupported motion schemaVersion: ${asset.schemaVersion}`);
  if (asset.model !== 'c-alpha-anm-overdamped') issues.push(`unsupported motion asset model: ${asset.model}`);
  if (expectedPdbId && asset.source?.pdbId !== expectedPdbId) issues.push(`motion source pdbId must be ${expectedPdbId}`);
  if (!asset.source?.structureHash || !asset.source?.backboneHash) issues.push('motion source hashes are required');
  if (!Number.isInteger(asset.residueCount) || asset.residueCount <= 0) issues.push('motion residueCount must be positive');
  const residueCount = asset.residueCount;
  for (const [name, length] of [
    ['chains', residueCount], ['residueNumbers', residueCount], ['bFactors', residueCount], ['centers', residueCount * 3],
  ] as const) {
    if (!Array.isArray(asset.residues?.[name]) || asset.residues[name].length !== length) issues.push(`motion residues.${name} must have length ${length}`);
  }
  const bindings = asset.bindings;
  const bindingNames = ['atomResidues', 'backboneResidues', 'surfaceResidues', 'ribbonResidues', 'siteResidues', 'modificationResidues'] as const;
  for (const name of bindingNames) {
    const values = bindings?.[name];
    if (!Array.isArray(values)) issues.push(`motion bindings.${name} must be an array`);
    else {
      if (expectedCounts && values.length !== expectedCounts[name]) issues.push(`motion bindings.${name} must have length ${expectedCounts[name]}`);
      for (const index of values) if (!Number.isInteger(index) || index < 0 || index >= residueCount) issues.push(`motion bindings.${name} index out of range: ${index}`);
    }
  }
  if (!Array.isArray(asset.modes) || asset.modes.length !== 24) issues.push('motion modes must contain 24 modes');
  const modeIds = new Set<string>();
  for (const [index, mode] of (asset.modes ?? []).entries()) {
    if (!mode.id || modeIds.has(mode.id)) issues.push(`duplicate motion asset mode id: ${mode.id}`);
    modeIds.add(mode.id);
    if (mode.band !== (index < 4 ? 'collective' : 'local')) issues.push(`motion mode ${mode.id} has incorrect band`);
    if (!Number.isFinite(mode.eigenvalue) || mode.eigenvalue <= 0) issues.push(`motion mode ${mode.id} eigenvalue must be positive`);
    if (!Number.isFinite(mode.displayRelaxationRate) || mode.displayRelaxationRate <= 0) issues.push(`motion mode ${mode.id} displayRelaxationRate must be positive`);
    const amplitude = asset.amplitudeCalibration === 'b-factor-relative' ? mode.physicalRmsAngstrom : mode.displayRmsAngstrom;
    if (!Number.isFinite(amplitude) || (amplitude ?? 0) <= 0 || (amplitude ?? 0) > 50) issues.push(`motion mode ${mode.id} amplitude must be in (0, 50] Å`);
    if (asset.amplitudeCalibration === 'b-factor-relative' && mode.displayRmsAngstrom !== undefined) issues.push(`motion mode ${mode.id} must not have display RMS`);
    if (asset.amplitudeCalibration === 'uncalibrated-display' && mode.physicalRmsAngstrom !== undefined) issues.push(`motion mode ${mode.id} must not claim physical RMS`);
    if (!Array.isArray(mode.displacements) || mode.displacements.length !== residueCount * 3) issues.push(`motion mode ${mode.id} displacement length mismatch`);
    else if (mode.displacements.some((value) => !Number.isFinite(value))) issues.push(`motion mode ${mode.id} contains non-finite displacement`);
    if (index > 0 && mode.eigenvalue < asset.modes[index - 1]!.eigenvalue) issues.push('motion eigenvalues must be sorted');
  }
  if (!Number.isFinite(asset.display?.sampleHz) || asset.display.sampleHz <= 0) issues.push('motion display.sampleHz must be positive');
  if (!Number.isFinite(asset.display?.collectiveGain) || asset.display.collectiveGain <= 0 || asset.display.collectiveGain > 1) issues.push('motion display.collectiveGain must be in (0, 1]');
  if (!Number.isFinite(asset.display?.localGain) || asset.display.localGain <= 0 || asset.display.localGain > 1) issues.push('motion display.localGain must be in (0, 1]');
  if (!['b-factor-relative', 'uncalibrated-display'].includes(asset.amplitudeCalibration)) issues.push('motion amplitudeCalibration is invalid');
  for (const name of ['centers', 'bFactors'] as const) if (asset.residues?.[name]?.some((value) => !Number.isFinite(value))) issues.push(`motion residues.${name} must be finite`);
  return issues;
}
