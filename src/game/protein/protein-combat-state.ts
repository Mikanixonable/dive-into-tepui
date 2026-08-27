import type {
  ProteinActionDefinition, ProteinAssetDefinition, ProteinHudSnapshot, ProteinPhase, ProteinSaveData, ProteinSiteDefinition,
} from './protein-schema';

export interface ProteinDamageResult {
  readonly target: 'site' | 'integrity';
  readonly siteId: string | null;
  readonly damage: number;
  readonly siteDisabled: boolean;
  readonly phaseChanged: boolean;
  readonly previousPhase: ProteinPhase;
  readonly phase: ProteinPhase;
  readonly defeated: boolean;
}

interface SiteState {
  readonly definition: ProteinSiteDefinition;
  hp: number;
  disabled: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class ProteinCombatState {
  public readonly asset: ProteinAssetDefinition;
  public readonly integrityMaxHp: number;
  public integrityHp: number;
  public phase: ProteinPhase;
  private readonly siteStates: SiteState[];
  private readonly modifications = new Map<string, string>();
  private selectedSiteId: string | null = null;
  private attackSiteCursor = 0;

  public constructor(asset: ProteinAssetDefinition, saved?: ProteinSaveData, legacyHealth?: number) {
    this.asset = asset;
    this.integrityMaxHp = asset.integrity.maxHp;
    this.integrityHp = saved?.integrityHp ?? (legacyHealth === undefined
      ? this.integrityMaxHp
      : clamp(legacyHealth / 6, 0, 1) * this.integrityMaxHp);
    this.phase = saved?.phase ?? 'intact';
    this.siteStates = asset.sites.map((definition) => {
      const old = saved?.sites.find((site) => site.id === definition.id);
      return { definition, hp: old?.hp ?? definition.maxHp, disabled: old?.disabled ?? false };
    });
    for (const slot of asset.modificationSlots) {
      this.modifications.set(slot.id, saved?.modifications[slot.id] ?? slot.defaultState);
    }
    this.reselectSite();
  }

  private get defeated(): boolean { return this.integrityHp <= 0; }

  public get activeSite(): ProteinSiteDefinition | null {
    return this.attackSites[0] ?? null;
  }

  public get attackAction(): ProteinActionDefinition | null {
    return this.asset.actions.find((action) => action.kind === 'projectile') ?? null;
  }

  /** Functional regions that can independently originate the protein's attack. */
  private get attackSites(): readonly ProteinSiteDefinition[] {
    const actionId = this.attackAction?.id;
    if (!actionId) return [];
    return this.siteStates
      .filter((site) => !site.disabled && site.definition.actions.includes(actionId))
      .map((site) => site.definition);
  }

  /** Pick the next still-functional attack region for an ordinary enemy shot. */
  public nextAttackSite(): ProteinSiteDefinition | null {
    const sites = this.attackSites;
    if (sites.length === 0) return null;
    const site = sites[this.attackSiteCursor % sites.length] ?? sites[0]!;
    this.attackSiteCursor = (this.attackSiteCursor + 1) % sites.length;
    return site;
  }

  public site(id: string): ProteinSiteDefinition | null {
    return this.siteStates.find((site) => site.definition.id === id)?.definition ?? null;
  }

  private modificationState(id: string): string | null { return this.modifications.get(id) ?? null; }

  public setModification(id: string, state: string): boolean {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === id);
    if (!slot || !slot.states.includes(state)) return false;
    this.modifications.set(id, state);
    return true;
  }

  public setSelectedSite(id: string | null): void {
    this.selectedSiteId = this.siteStates.some((site) => site.definition.id === id) ? id : null;
  }

  public isActionEnabled(action: string, externalCondition = true): boolean {
    return externalCondition && this.siteStates.some((site) => !site.disabled && site.definition.actions.includes(action));
  }

  private effectMultiplier(slotId: string, effect: string, fallback = 1): number {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === slotId);
    const state = this.modificationState(slotId);
    return slot?.effects[state ?? '']?.[effect] ?? fallback;
  }

  public projectileDamage(baseDamage: number): number {
    let multiplier = 1;
    for (const slot of this.asset.modificationSlots) {
      multiplier *= this.effectMultiplier(slot.id, 'damageMultiplier');
    }
    return Math.max(0, baseDamage) * multiplier;
  }

  /** localPoint is in model-local units after the root display scale, not source Å. */
  public applyDamage(amount: number, localPoint: { x: number; y: number; z: number }): ProteinDamageResult {
    const previousPhase = this.phase;
    const candidate = this.closestSite(localPoint);
    let siteId: string | null = null;
    let siteDisabled = false;
    let damage = Math.max(0, amount);
    if (candidate) {
      siteId = candidate.definition.id;
      damage *= candidate.definition.damageMultiplier;
      candidate.hp = Math.max(0, candidate.hp - damage);
      candidate.disabled = candidate.hp <= 0;
      siteDisabled = candidate.disabled;
      // Damaging a functional site also destabilizes the whole complex, but only partially.
      this.integrityHp = Math.max(0, this.integrityHp - damage * 0.35);
    } else {
      this.integrityHp = Math.max(0, this.integrityHp - damage);
    }
    this.updateStructuralState();
    this.reselectSite();
    return {
      target: candidate ? 'site' : 'integrity', siteId, damage, siteDisabled,
      phaseChanged: previousPhase !== this.phase, previousPhase, phase: this.phase, defeated: this.defeated,
    };
  }

  public applyContactDamage(amount: number): ProteinDamageResult {
    const previousPhase = this.phase;
    const damage = Math.max(0, amount);
    this.integrityHp = Math.max(0, this.integrityHp - damage);
    this.updateStructuralState();
    return {
      target: 'integrity', siteId: null, damage, siteDisabled: false,
      phaseChanged: previousPhase !== this.phase, previousPhase, phase: this.phase, defeated: this.defeated,
    };
  }

  public serialize(): ProteinSaveData {
    const sites = this.siteStates.map((site) => ({ id: site.definition.id, hp: site.hp, disabled: site.disabled }));
    return {
      schemaVersion: 1,
      integrityHp: this.integrityHp,
      phase: this.phase,
      sites,
      modifications: Object.fromEntries(this.modifications),
    };
  }

  public hudSnapshot(): ProteinHudSnapshot {
    return {
      phase: this.phase,
      integrityHp: this.integrityHp,
      integrityMaxHp: this.integrityMaxHp,
      selectedSiteId: this.selectedSiteId,
      sites: this.siteStates.map((site) => {
        const attackActionId = this.attackAction?.id;
        const attackable = attackActionId !== undefined && site.definition.actions.includes(attackActionId);
        return {
          id: site.definition.id,
          abbreviation: site.definition.abbreviation,
          hp: site.hp,
          maxHp: site.definition.maxHp,
          disabled: site.disabled,
          attackable,
        };
      }),
    };
  }

  private closestSite(localPoint: { x: number; y: number; z: number }): SiteState | null {
    let closest: SiteState | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    const coordinateScale = this.asset.coordinateScale;
    for (const site of this.siteStates) {
      if (site.disabled) continue;
      const [x, y, z] = site.definition.position;
      const dx = localPoint.x - x * coordinateScale;
      const dy = localPoint.y - y * coordinateScale;
      const dz = localPoint.z - z * coordinateScale;
      const distance = Math.hypot(dx, dy, dz);
      const radius = site.definition.radius * coordinateScale;
      if (distance <= radius && distance < closestDistance) {
        closest = site;
        closestDistance = distance;
      }
    }
    return closest;
  }

  private reselectSite(): void {
    if (this.selectedSiteId && this.siteStates.some((site) => site.definition.id === this.selectedSiteId && !site.disabled)) return;
    this.selectedSiteId = this.activeSite?.id ?? this.siteStates.find((site) => !site.disabled)?.definition.id ?? null;
  }

  private updateStructuralState(): void {
    if (this.integrityHp < this.integrityMaxHp * 0.65) {
      for (const slot of this.asset.modificationSlots) this.setModification(slot.id, 'empty');
    }
    this.updatePhase();
  }

  private updatePhase(): void {
    const interfaceDisabled = this.siteStates.some((site) => site.definition.type === 'interface' && site.disabled);
    const activeSites = this.siteStates.filter((site) => site.definition.type === 'active');
    const activeDisabled = activeSites.length > 0 && activeSites.every((site) => site.disabled);
    const coreDisabled = this.siteStates.some((site) => site.definition.type === 'core' && site.disabled);
    const integrityRatio = this.integrityMaxHp > 0 ? this.integrityHp / this.integrityMaxHp : 0;
    if (coreDisabled || integrityRatio <= 0.25) this.phase = 'critical';
    else if (interfaceDisabled && activeDisabled) this.phase = 'dissociated';
    else if (interfaceDisabled) this.phase = 'exposed';
  }
}
