// 結節体1体の被弾モデル(SPEC/KNOT.md「戦闘状態」)。索の区間(セグメント)ごと・
// 結節ノードごと・駆動中核の HP と、索全体の耐久(integrity)を持ち、ほどけの
// 状態(フェーズ)と撃破をそこから導く。断裂の反映(判定と表示からの除外)は
// 戦闘スライスの仕事で、ここは HP の正本だけを持つ。
import { ENEMY_MAX_HP } from '../dynamic/dynamic-entity/enemy';
import type { KnotHitTarget, KnotShape } from './knot-shape';

// セグメント1区間の HP。
export const KNOT_SEGMENT_HP = 3;
// 結節ノード1個の HP。
export const KNOT_NODE_HP = 2;
// 駆動中核の HP。
export const KNOT_CORE_HP = 6;

// ほどけの状態。断裂したセグメントの割合で 緩解・解体 へ進む(KNOT.md)。
export type KnotPhase = 'bound' | 'loosening' | 'unraveling' | 'collapsed';
const PHASE_LOOSENING_FRACTION = 0.3;
const PHASE_UNRAVELING_FRACTION = 0.6;

export interface SerializedKnotCombatState {
  readonly segmentHp: readonly number[]; // segment.index 順
  readonly nodeHp: readonly number[]; // node.index 順
  readonly coreHp: number;
  readonly integrity: number;
}

export class KnotCombatState {
  private readonly segmentHp: number[]; // segment.index 順の残り HP
  private readonly nodeHp: number[]; // node.index 順の残り HP
  private readonly shooterNode: readonly boolean[]; // node.index 順、射撃を担う役か
  private _coreHp: number;
  private _integrity: number;

  // 無傷の状態を組む。segmentHp・nodeHp は復元時にだけ渡す index 順の残り HP
  // (記録の無い部位は初期値)。coreHp と integrity は上限へ収める。
  public constructor(
    shape: KnotShape,
    segmentHp?: readonly number[],
    nodeHp?: readonly number[],
    coreHp: number = KNOT_CORE_HP,
    integrity: number = ENEMY_MAX_HP,
  ) {
    this.segmentHp = shape.segments.map((segment) => {
      const hp = segmentHp?.[segment.index] ?? KNOT_SEGMENT_HP;
      return Math.min(KNOT_SEGMENT_HP, Math.max(0, hp));
    });
    this.nodeHp = shape.nodes.map((node) => {
      const hp = nodeHp?.[node.index] ?? KNOT_NODE_HP;
      return Math.min(KNOT_NODE_HP, Math.max(0, hp));
    });
    this.shooterNode = shape.nodes.map((node) => node.role === 'shooter');
    this._coreHp = Math.min(KNOT_CORE_HP, Math.max(0, coreHp));
    this._integrity = Math.min(ENEMY_MAX_HP, Math.max(0, integrity));
  }

  // 直列化した HP を shape の部位列へ当てて復元する。数が合わない記録は対応付け
  // られないので、無傷として組む。
  public static deserialize(
    serialized: SerializedKnotCombatState, shape: KnotShape,
  ): KnotCombatState {
    const segmentHp = serialized.segmentHp?.length === shape.segments.length
      ? serialized.segmentHp : undefined;
    const nodeHp = serialized.nodeHp?.length === shape.nodes.length
      ? serialized.nodeHp : undefined;
    return new KnotCombatState(
      shape, segmentHp, nodeHp,
      serialized.coreHp ?? KNOT_CORE_HP, serialized.integrity ?? ENEMY_MAX_HP,
    );
  }

  // 部位ごとの残り HP と中核・耐久を直列化した形にする。ほどけの状態は HP から
  // 導けるので記録しない。
  public serialize(): SerializedKnotCombatState {
    return {
      segmentHp: [...this.segmentHp],
      nodeHp: [...this.nodeHp],
      coreHp: this._coreHp,
      integrity: this._integrity,
    };
  }

  // 残りの索全体の耐久。
  public get integrity(): number { return this._integrity; }

  // 耐久の初期値。
  public get maxIntegrity(): number { return ENEMY_MAX_HP; }

  // 駆動中核の残り HP。
  public get coreHp(): number { return this._coreHp; }

  // 撃破したか。中核の破壊か、索全体の耐久の枯渇で真(KNOT.md)。
  public get destroyed(): boolean {
    return this._integrity <= 0 || this._coreHp <= 0;
  }

  // HP の尽きたセグメントの割合。ほどけの進み具合の正本。
  public get severedFraction(): number {
    if (this.segmentHp.length === 0) return 0;
    const severed = this.segmentHp.filter((hp) => hp <= 0).length;
    return severed / this.segmentHp.length;
  }

  // ほどけの状態。崩壊は撃破と一致し、解体は断裂6割か射撃ノードの全損で入る。
  public get phase(): KnotPhase {
    if (this.destroyed) return 'collapsed';
    if (this.severedFraction >= PHASE_UNRAVELING_FRACTION || !this.shooterNodesAlive) {
      return 'unraveling';
    }
    if (this.severedFraction >= PHASE_LOOSENING_FRACTION) return 'loosening';
    return 'bound';
  }

  // index のセグメントが残っているか。
  public segmentAlive(index: number): boolean {
    return (this.segmentHp[index] ?? 0) > 0;
  }

  // index の結節ノードが残っているか。
  public nodeAlive(index: number): boolean {
    return (this.nodeHp[index] ?? 0) > 0;
  }

  // 射撃を担うノードが1つでも残っているか。
  public get shooterNodesAlive(): boolean {
    return this.nodeHp.some((hp, index) => hp > 0 && this.shooterNode[index] === true);
  }

  // 弾の被弾。命中先の部位の HP だけへ入り、索全体の耐久へは入らない(KNOT.md)。
  // 命中先を特定できない損傷は耐久へ入る。この被弾で部位が尽きたときだけ、その
  // 命中先を返す(断裂・喪失の反映は呼び手がこれを見て行う)。既に尽きた部位への
  // 被弾では null を返す。
  public applyBulletDamage(damage: number, target: KnotHitTarget | null): KnotHitTarget | null {
    const amount = Math.max(0, damage);
    if (target === null) {
      this.applyIntegrityDamage(amount);
      return null;
    }
    if (target.part === 'core') {
      if (this._coreHp <= 0) return null;
      this._coreHp = Math.max(0, this._coreHp - amount);
      return this._coreHp === 0 ? target : null;
    }
    const table = target.part === 'segment' ? this.segmentHp : this.nodeHp;
    const hp = table[target.index];
    if (hp === undefined || hp <= 0) return null;
    table[target.index] = Math.max(0, hp - amount);
    return table[target.index] === 0 ? target : null;
  }

  // 接触など位置を特定しない損傷を、索全体の耐久へ入れる。
  public applyIntegrityDamage(damage: number): void {
    this._integrity = Math.max(0, this._integrity - Math.max(0, damage));
  }
}
