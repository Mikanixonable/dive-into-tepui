// タンパク質の敵1体の被弾モデル。機能部位ごとの HP と、構造全体の integrity・修飾の状態を持ち、
// 部位の機能停止とフェーズはそこから導く。
import type {
  ProteinActionDefinition, ProteinAssetDefinition, ProteinCombatReadout, ProteinSiteDefinition,
} from './protein-schema';
import type { ProteinPhase } from '../../render/protein/protein-display';

interface SerializedProteinSite {
  id: string;
  hp: number;
}

export interface SerializedProteinCombatState {
  integrityHp: number;
  sites: SerializedProteinSite[];
  modifications: Record<string, string>;
  attackSiteCursor: number;
}

type ProteinModelPoint = { readonly x: number; readonly y: number; readonly z: number };

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
}

// 部位は HP が尽きると機能を停止する。
function isDisabled(site: SiteState): boolean { return site.hp <= 0; }

export class ProteinCombatState {
  public readonly integrityMaxHp: number;
  private readonly siteStates: SiteState[];
  private readonly modifications = new Map<string, string>();

  // asset の定義から戦闘状態を組む。_integrityHp は構造全体の残り HP、siteHps・modificationStates は
  // 部位 id ごとの HP と修飾スロット id ごとの状態で、値の無い部位と修飾は定義の初期値から始める。
  // attackSiteCursor は次に撃つ部位を、機能している攻撃部位の並びの何番目から選ぶか。
  public constructor(
    public readonly asset: ProteinAssetDefinition,
    private _integrityHp = asset.integrity.maxHp,
    siteHps: ReadonlyMap<string, number | undefined> = new Map(),
    modificationStates: ReadonlyMap<string, string | undefined> = new Map(),
    private attackSiteCursor = 0,
  ) {
    this.integrityMaxHp = asset.integrity.maxHp;
    // 部位と修飾は定義の並びで組む
    this.siteStates = asset.sites.map((definition) => ({
      definition, hp: siteHps.get(definition.id) ?? definition.maxHp,
    }));
    for (const slot of asset.modificationSlots) {
      this.modifications.set(slot.id, modificationStates.get(slot.id) ?? slot.defaultState);
    }
  }

  // 直列化した integrity・部位 HP・修飾の状態と撃つ部位の巡回を、asset の定義の部位と修飾スロットに
  // ついて読んで復元する。
  public static deserialize(
    serialized: SerializedProteinCombatState, asset: ProteinAssetDefinition,
  ): ProteinCombatState {
    return new ProteinCombatState(
      asset,
      // null も欠けと同じく既定へ落とす(既定引数は undefined でしか働かない)。
      serialized.integrityHp ?? undefined,
      new Map(asset.sites.map((definition) => [
        definition.id, serialized.sites.find((site) => site.id === definition.id)?.hp,
      ])),
      new Map(asset.modificationSlots.map((slot) => [slot.id, serialized.modifications[slot.id]])),
      serialized.attackSiteCursor,
    );
  }

  public get integrityHp(): number { return this._integrityHp; }

  // 機能停止した部位の種別と integrity の残りから決まる、いまのフェーズ。
  public get phase(): ProteinPhase {
    const interfaceDisabled = this.siteStates.some((site) => site.definition.type === 'interface' && isDisabled(site));
    const activeSites = this.siteStates.filter((site) => site.definition.type === 'active');
    const activeDisabled = activeSites.length > 0 && activeSites.every(isDisabled);
    const coreDisabled = this.siteStates.some((site) => site.definition.type === 'core' && isDisabled(site));
    const integrityRatio = this.integrityMaxHp > 0 ? this._integrityHp / this.integrityMaxHp : 0;
    if (coreDisabled || integrityRatio <= 0.25) return 'critical';
    if (interfaceDisabled && activeDisabled) return 'dissociated';
    if (interfaceDisabled) return 'exposed';
    return 'intact';
  }

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
      .filter((site) => !isDisabled(site) && site.definition.actions.includes(actionId))
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

  private modificationState(id: string): string | null { return this.modifications.get(id) ?? null; }

  // 修飾スロット id を state にする。スロットか状態が定義に無ければ false を返し、状態を保つ。
  public setModification(id: string, state: string): boolean {
    const slot = this.asset.modificationSlots.find((entry) => entry.id === id);
    if (!slot || !slot.states.includes(state)) return false;
    this.modifications.set(id, state);
    return true;
  }

  // action を持つ部位が1つでも機能していれば true。
  public isActionEnabled(action: string): boolean {
    return this.siteStates.some((site) => !isDisabled(site) && site.definition.actions.includes(action));
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
  public applyDamage(
    amount: number, localPoint: ProteinModelPoint,
    sitePositions?: ReadonlyMap<string, ProteinModelPoint>,
  ): ProteinDamageResult {
    const previousPhase = this.phase;
    const candidate = this.closestSite(localPoint, sitePositions);
    let siteId: string | null = null;
    let siteDisabled = false;
    let damage = Math.max(0, amount);
    if (candidate) {
      siteId = candidate.definition.id;
      damage *= candidate.definition.damageMultiplier;
      candidate.hp = Math.max(0, candidate.hp - damage);
      siteDisabled = isDisabled(candidate);
      // 部位への被弾は、構造全体も部分的に不安定にする。
      this._integrityHp = Math.max(0, this._integrityHp - damage * 0.35);
    } else {
      this._integrityHp = Math.max(0, this._integrityHp - damage);
    }
    this.releaseModificationsIfUnstable();
    const phase = this.phase;
    return {
      target: candidate ? 'site' : 'integrity', siteId, damage, siteDisabled,
      phaseChanged: previousPhase !== phase, previousPhase, phase, defeated: this.defeated,
    };
  }

  // 部位を選ばず、integrity を amount 削る。
  public applyContactDamage(amount: number): ProteinDamageResult {
    const previousPhase = this.phase;
    const damage = Math.max(0, amount);
    this._integrityHp = Math.max(0, this._integrityHp - damage);
    this.releaseModificationsIfUnstable();
    const phase = this.phase;
    return {
      target: 'integrity', siteId: null, damage, siteDisabled: false,
      phaseChanged: previousPhase !== phase, previousPhase, phase, defeated: this.defeated,
    };
  }

  // いまの integrity・部位 HP・修飾の状態と撃つ部位の巡回を直列化した形にする。
  public serialize(): SerializedProteinCombatState {
    const sites = this.siteStates.map((site) => ({ id: site.definition.id, hp: site.hp }));
    return {
      integrityHp: this._integrityHp,
      sites,
      modifications: Object.fromEntries(this.modifications),
      attackSiteCursor: this.attackSiteCursor,
    };
  }

  // フェーズ・integrity・部位ごとの HP と攻撃可否の、いまの読み取り値を返す。
  public combatReadout(): ProteinCombatReadout {
    return {
      phase: this.phase,
      integrityHp: this._integrityHp,
      integrityMaxHp: this.integrityMaxHp,
      sites: this.siteStates.map((site) => {
        // 攻撃可否は部位が攻撃 action を持つかで決まり、機能停止とは独立に答える。
        const attackActionId = this.attackAction?.id;
        const attackable = attackActionId !== undefined && site.definition.actions.includes(attackActionId);
        return {
          id: site.definition.id,
          abbreviation: site.definition.abbreviation,
          hp: site.hp,
          maxHp: site.definition.maxHp,
          disabled: isDisabled(site),
          attackable,
        };
      }),
    };
  }

  // localPoint を半径の内に含む機能部位のうち、中心が最も近いもの。無ければ null。
  private closestSite(
    localPoint: ProteinModelPoint, sitePositions?: ReadonlyMap<string, ProteinModelPoint>,
  ): SiteState | null {
    let closest: SiteState | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    // 部位の位置と半径は原子の座標なので、モデル座標へ直して比べる。
    const coordinateScale = this.asset.coordinateScale;
    for (const site of this.siteStates) {
      if (isDisabled(site)) continue;
      const position = sitePositions?.get(site.definition.id);
      const [x, y, z] = site.definition.position;
      const anchor = position ?? { x: x * coordinateScale, y: y * coordinateScale, z: z * coordinateScale };
      const dx = localPoint.x - anchor.x;
      const dy = localPoint.y - anchor.y;
      const dz = localPoint.z - anchor.z;
      const distance = Math.hypot(dx, dy, dz);
      const radius = site.definition.radius * coordinateScale;
      if (distance <= radius && distance < closestDistance) {
        closest = site;
        closestDistance = distance;
      }
    }
    return closest;
  }

  // integrity が大きく減った構造は修飾を保てず、全スロットが空になる。
  private releaseModificationsIfUnstable(): void {
    if (this._integrityHp < this.integrityMaxHp * 0.65) {
      for (const slot of this.asset.modificationSlots) this.setModification(slot.id, 'empty');
    }
  }
}
