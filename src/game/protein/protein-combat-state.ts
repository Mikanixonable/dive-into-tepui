import type {
  ProteinActionDefinition, ProteinAssetDefinition, ProteinHudSnapshot, ProteinPhase, ProteinSaveData, ProteinSiteDefinition,
} from './protein-schema';

export type FormationRole = 'attacker' | 'shield' | 'energy';

type FormationEnemyStatus = {
  readonly alive: boolean;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
};

// 陣形の攻撃担当だけが必要とする、同じ陣形内の生存エネルギー役を都度集計する。
// formationId が無い敵は単体敵として、従来どおり供給条件を満たすものとする。
export function isFormationEnergyAvailable(
  formationRole: FormationRole | undefined,
  formationId: string | undefined,
  enemies: readonly FormationEnemyStatus[],
): boolean {
  if (formationRole !== 'attacker' || formationId === undefined) return true;
  return enemies.some((enemy) => (
    enemy.alive && enemy.formationId === formationId && enemy.formationRole === 'energy'
  ));
}

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
  readonly asset: ProteinAssetDefinition;
  readonly integrityMaxHp: number;
  integrityHp: number;
  phase: ProteinPhase;
  private readonly siteStates: SiteState[];
  private readonly modifications = new Map<string, string>();
  private selectedSiteId: string | null = null;
  private attackSiteCursor = 0;

  constructor(asset: ProteinAssetDefinition, saved?: ProteinSaveData, legacyHealth?: number) {
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

  get defeated(): boolean { return this.integrityHp <= 0; }

  get activeSite(): ProteinSiteDefinition | null {
    return this.attackSites[0] ?? null;
  }

  get attackAction(): ProteinActionDefinition | null {
    return this.asset.actions.find((action) => action.kind === 'projectile') ?? null;
  }

  /** Functional regions that can independently originate the protein's attack. */
  get attackSites(): readonly ProteinSiteDefinition[] {
    const actionId = this.attackAction?.id;
    if (!actionId) return [];
    return this.siteStates
      .filter((site) => !site.disabled && site.definition.actions.includes(actionId))
      .map((site) => site.definition);
  }

  hasAttackSite(): boolean { return this.attackSites.length > 0; }

  /** Pick the next still-functional attack region for an ordinary enemy shot. */
  nextAttackSite(): ProteinSiteDefinition | null {
    const sites = this.attackSites;
    if (sites.length === 0) return null;
    const site = sites[this.attackSiteCursor % sites.length] ?? sites[0]!;
    this.attackSiteCursor = (this.attackSiteCursor + 1) % sites.length;
    return site;
  }

  site(id: string): ProteinSiteDefinition | null {
    return this.siteStates.find((site) => site.definition.id === id)?.definition ?? null;
  }

  siteState(id: string): { readonly hp: number; readonly maxHp: number; readonly disabled: boolean } | null {
    const site = this.siteStates.find((entry) => entry.definition.id === id);
    return site ? { hp: site.hp, maxHp: site.definition.maxHp, disabled: site.disabled } : null;
  }

  modificationState(id: string): string | null { return this.modifications.get(id) ?? null; }

  setModification(id: string, state: string): boolean {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === id);
    if (!slot || !slot.states.includes(state)) return false;
    this.modifications.set(id, state);
    return true;
  }

  setSelectedSite(id: string | null): void {
    this.selectedSiteId = this.siteStates.some((site) => site.definition.id === id) ? id : null;
  }

  isActionEnabled(action: string, externalCondition = true): boolean {
    return externalCondition && this.siteStates.some((site) => !site.disabled && site.definition.actions.includes(action));
  }

  effectMultiplier(slotId: string, effect: string, fallback = 1): number {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === slotId);
    const state = this.modificationState(slotId);
    return slot?.effects[state ?? '']?.[effect] ?? fallback;
  }

  projectileDamage(baseDamage: number): number {
    let multiplier = 1;
    for (const slot of this.asset.modificationSlots) {
      multiplier *= this.effectMultiplier(slot.id, 'damageMultiplier');
    }
    return Math.max(0, baseDamage) * multiplier;
  }

  /** localPoint is in model-local units after the root display scale, not source Å. */
  applyDamage(amount: number, localPoint: { x: number; y: number; z: number }): ProteinDamageResult {
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

  applyContactDamage(amount: number): ProteinDamageResult {
    const previousPhase = this.phase;
    const damage = Math.max(0, amount);
    this.integrityHp = Math.max(0, this.integrityHp - damage);
    this.updateStructuralState();
    return {
      target: 'integrity', siteId: null, damage, siteDisabled: false,
      phaseChanged: previousPhase !== this.phase, previousPhase, phase: this.phase, defeated: this.defeated,
    };
  }

  serialize(): ProteinSaveData {
    const sites = this.siteStates.map((site) => ({ id: site.definition.id, hp: site.hp, disabled: site.disabled }));
    return {
      schemaVersion: 1,
      integrityHp: this.integrityHp,
      phase: this.phase,
      sites,
      modifications: Object.fromEntries(this.modifications),
    };
  }

  hudSnapshot(): ProteinHudSnapshot {
    let attackOrdinal = 0;
    return {
      phase: this.phase,
      integrityHp: this.integrityHp,
      integrityMaxHp: this.integrityMaxHp,
      selectedSiteId: this.selectedSiteId,
      sites: this.siteStates.map((site) => {
        const attackActionId = this.attackAction?.id;
        const attackable = attackActionId !== undefined && site.definition.actions.includes(attackActionId);
        const label = attackable
          ? `攻撃部位${++attackOrdinal}`
          : site.definition.type === 'interface' ? '結合界面' : site.definition.type === 'core' ? '核心部' : '修飾部位';
        return {
        id: site.definition.id,
        label,
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
