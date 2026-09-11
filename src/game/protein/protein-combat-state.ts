// タンパク質の敵1体の被弾モデル。機能部位ごとの HP・機能停止と、構造全体の integrity・
// フェーズ・修飾の状態を持つ。
import type {
  ProteinActionDefinition, ProteinAssetDefinition, ProteinCombatReadout, ProteinSaveData, ProteinSiteDefinition,
} from './protein-schema';
import type { ProteinPhase } from '../../render/protein/protein-display';

// 1回のダメージの結果。
interface ProteinDamageResult {
  readonly target: 'site' | 'integrity';
  readonly siteId: string | null;
  readonly damage: number;
  readonly siteDisabled: boolean;
  readonly phaseChanged: boolean;
  readonly previousPhase: ProteinPhase;
  readonly phase: ProteinPhase;
  readonly defeated: boolean;
}

// 機能部位1つの戦闘中の状態。
interface SiteState {
  readonly definition: ProteinSiteDefinition;
  hp: number;
  disabled: boolean;
}

export class ProteinCombatState {
  public readonly integrityMaxHp: number;
  private _integrityHp: number;
  private _phase: ProteinPhase;
  private readonly siteStates: SiteState[];
  private readonly modifications = new Map<string, string>();
  private selectedSiteId: string | null = null;
  private attackSiteCursor = 0;

  // asset の定義から戦闘状態を組む。saved があれば、その HP・フェーズ・部位・修飾の状態から戻す。
  public constructor(public readonly asset: ProteinAssetDefinition, saved?: ProteinSaveData) {
    this.integrityMaxHp = asset.integrity.maxHp;
    this._integrityHp = saved?.integrityHp ?? this.integrityMaxHp;
    this._phase = saved?.phase ?? 'intact';
    // 部位と修飾は定義の並びで組み、保存に無い項目は定義の初期値にする。
    this.siteStates = asset.sites.map((definition) => {
      const old = saved?.sites.find((site) => site.id === definition.id);
      return { definition, hp: old?.hp ?? definition.maxHp, disabled: old?.disabled ?? false };
    });
    for (const slot of asset.modificationSlots) {
      this.modifications.set(slot.id, saved?.modifications[slot.id] ?? slot.defaultState);
    }
    this.reselectSite();
  }

  public get integrityHp(): number { return this._integrityHp; }
  public get phase(): ProteinPhase { return this._phase; }

  private get defeated(): boolean { return this._integrityHp <= 0; }

  // 攻撃を撃ち出せる部位のうち先頭。1つも無ければ null。
  public get activeSite(): ProteinSiteDefinition | null {
    return this.attackSites[0] ?? null;
  }

  // 弾を撃つ action。持たないタンパク質では null。
  public get attackAction(): ProteinActionDefinition | null {
    return this.asset.actions.find((action) => action.kind === 'projectile') ?? null;
  }

  // 攻撃 action を持ち、機能している部位。
  private get attackSites(): readonly ProteinSiteDefinition[] {
    const actionId = this.attackAction?.id;
    if (!actionId) return [];
    return this.siteStates
      .filter((site) => !site.disabled && site.definition.actions.includes(actionId))
      .map((site) => site.definition);
  }

  // 次に撃つ部位を、機能している攻撃部位から順繰りに選ぶ。1つも無ければ null。
  public nextAttackSite(): ProteinSiteDefinition | null {
    const sites = this.attackSites;
    if (sites.length === 0) return null;
    const site = sites[this.attackSiteCursor % sites.length] ?? sites[0]!;
    this.attackSiteCursor = (this.attackSiteCursor + 1) % sites.length;
    return site;
  }

  // id の部位定義。無ければ null。
  public site(id: string): ProteinSiteDefinition | null {
    return this.siteStates.find((site) => site.definition.id === id)?.definition ?? null;
  }

  private modificationState(id: string): string | null { return this.modifications.get(id) ?? null; }

  // 修飾スロット id を state にする。スロットか状態が定義に無ければ false を返し、状態を保つ。
  public setModification(id: string, state: string): boolean {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === id);
    if (!slot || !slot.states.includes(state)) return false;
    this.modifications.set(id, state);
    return true;
  }

  // 選択中の部位を id にする。定義に無い id なら選択を外す。
  public setSelectedSite(id: string | null): void {
    this.selectedSiteId = this.siteStates.some((site) => site.definition.id === id) ? id : null;
  }

  // action を持つ部位が1つでも機能していれば true。
  public isActionEnabled(action: string): boolean {
    return this.siteStates.some((site) => !site.disabled && site.definition.actions.includes(action));
  }

  // 修飾スロット slotId のいまの状態が effect に与える倍率。定義に無ければ fallback。
  private effectMultiplier(slotId: string, effect: string, fallback = 1): number {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === slotId);
    const state = this.modificationState(slotId);
    return slot?.effects[state ?? '']?.[effect] ?? fallback;
  }

  // 全修飾スロットの damageMultiplier を baseDamage に掛けた、弾1発のダメージ。
  public projectileDamage(baseDamage: number): number {
    let multiplier = 1;
    for (const slot of this.asset.modificationSlots) {
      multiplier *= this.effectMultiplier(slot.id, 'damageMultiplier');
    }
    return Math.max(0, baseDamage) * multiplier;
  }

  // amount を、localPoint を含む機能部位のうち最も近いものへ当てる。含む部位が無ければ integrity を
  // 直接削る。localPoint は原子の座標 [Å] ではなく、表示の基準倍率を掛けたモデル座標。
  public applyDamage(amount: number, localPoint: { x: number; y: number; z: number }): ProteinDamageResult {
    const previousPhase = this._phase;
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
      // 部位への被弾は、構造全体も部分的に不安定にする。
      this._integrityHp = Math.max(0, this._integrityHp - damage * 0.35);
    } else {
      this._integrityHp = Math.max(0, this._integrityHp - damage);
    }
    this.updateStructuralState();
    this.reselectSite();
    return {
      target: candidate ? 'site' : 'integrity', siteId, damage, siteDisabled,
      phaseChanged: previousPhase !== this._phase, previousPhase, phase: this._phase, defeated: this.defeated,
    };
  }

  // 部位を選ばず、integrity を amount 削る。
  public applyContactDamage(amount: number): ProteinDamageResult {
    const previousPhase = this._phase;
    const damage = Math.max(0, amount);
    this._integrityHp = Math.max(0, this._integrityHp - damage);
    this.updateStructuralState();
    return {
      target: 'integrity', siteId: null, damage, siteDisabled: false,
      phaseChanged: previousPhase !== this._phase, previousPhase, phase: this._phase, defeated: this.defeated,
    };
  }

  // いまの HP・フェーズ・部位・修飾の状態を保存形にする。
  public serialize(): ProteinSaveData {
    const sites = this.siteStates.map((site) => ({ id: site.definition.id, hp: site.hp, disabled: site.disabled }));
    return {
      schemaVersion: 1,
      integrityHp: this._integrityHp,
      phase: this._phase,
      sites,
      modifications: Object.fromEntries(this.modifications),
    };
  }

  // フェーズ・integrity・部位ごとの HP と攻撃可否の、いまの読み取り値を返す。
  public combatReadout(): ProteinCombatReadout {
    return {
      phase: this._phase,
      integrityHp: this._integrityHp,
      integrityMaxHp: this.integrityMaxHp,
      selectedSiteId: this.selectedSiteId,
      sites: this.siteStates.map((site) => {
        // 攻撃可否は部位が攻撃 action を持つかで決まり、機能停止とは独立に答える。
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

  // localPoint を半径の内に含む機能部位のうち、中心が最も近いもの。無ければ null。
  private closestSite(localPoint: { x: number; y: number; z: number }): SiteState | null {
    let closest: SiteState | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    // 部位の位置と半径は原子の座標なので、モデル座標へ直して比べる。
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

  // 選択中の部位が機能停止していれば、先頭の攻撃部位か、機能している最初の部位へ移す。
  private reselectSite(): void {
    if (this.selectedSiteId && this.siteStates.some((site) => site.definition.id === this.selectedSiteId && !site.disabled)) return;
    this.selectedSiteId = this.activeSite?.id ?? this.siteStates.find((site) => !site.disabled)?.definition.id ?? null;
  }

  // integrity の減りに応じて修飾を外し、フェーズを更新する。
  private updateStructuralState(): void {
    if (this._integrityHp < this.integrityMaxHp * 0.65) {
      for (const slot of this.asset.modificationSlots) this.setModification(slot.id, 'empty');
    }
    this.updatePhase();
  }

  // 機能停止した部位の種類と integrity の残りから、フェーズを決める。
  private updatePhase(): void {
    const interfaceDisabled = this.siteStates.some((site) => site.definition.type === 'interface' && site.disabled);
    const activeSites = this.siteStates.filter((site) => site.definition.type === 'active');
    const activeDisabled = activeSites.length > 0 && activeSites.every((site) => site.disabled);
    const coreDisabled = this.siteStates.some((site) => site.definition.type === 'core' && site.disabled);
    const integrityRatio = this.integrityMaxHp > 0 ? this._integrityHp / this.integrityMaxHp : 0;
    if (coreDisabled || integrityRatio <= 0.25) this._phase = 'critical';
    else if (interfaceDisabled && activeDisabled) this._phase = 'dissociated';
    else if (interfaceDisabled) this._phase = 'exposed';
  }
}
