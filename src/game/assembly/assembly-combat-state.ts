// 組み立て型の敵1体の被弾モデル(SPEC/ASSEMBLY.md「戦闘状態」)。各部品の HP と構造全体の
// integrity を持ち、部品の喪失・発射部の停止・撃破をそこから導く。
import { ENEMY_MAX_HP } from '../dynamic/dynamic-entity/enemy';
import type { AssemblyPartDef, AssemblyShape } from '../../render/assembly/assembly-shape';

// 部品1個の HP。部品の種別や大きさでは変えない。
export const ASSEMBLY_PART_HP = 2;

export interface SerializedAssemblyCombatState {
  readonly partHp: readonly number[]; // part.index 順
  readonly integrity: number;
}

export class AssemblyCombatState {
  private readonly parts: readonly AssemblyPartDef[];
  private readonly partHp: number[]; // part.index 順の残り HP
  private readonly coreIndex: number | null;
  private readonly emitterIndex: number | null;
  private _integrity: number;

  // 無傷の状態を組む。partHp は復元時にだけ渡す part.index 順の残り HP(記録の無い部品は
  // 初期値)。integrity は残りの構造 HP で、[0, ENEMY_MAX_HP] に収める。
  public constructor(
    shape: AssemblyShape,
    partHp?: readonly number[],
    integrity: number = ENEMY_MAX_HP,
  ) {
    this.parts = shape.parts;
    this.partHp = [];
    for (const part of shape.parts) {
      const hp = partHp?.[part.index] ?? ASSEMBLY_PART_HP;
      this.partHp[part.index] = Math.min(ASSEMBLY_PART_HP, Math.max(0, hp));
    }
    this.coreIndex = shape.parts.find((part) => part.role === 'core')?.index ?? null;
    this.emitterIndex = shape.parts.find((part) => part.role === 'emitter')?.index ?? null;
    this._integrity = Math.min(ENEMY_MAX_HP, Math.max(0, integrity));
  }

  // 直列化した部品 HP と integrity を shape の部品列へ当てて復元する。部品数が合わない記録は
  // 各部品の値を対応付けられないので、無傷として組む。
  public static deserialize(
    serialized: SerializedAssemblyCombatState, shape: AssemblyShape,
  ): AssemblyCombatState {
    const partHp = serialized.partHp?.length === shape.parts.length ? serialized.partHp : undefined;
    return new AssemblyCombatState(shape, partHp, serialized.integrity ?? ENEMY_MAX_HP);
  }

  // 部品ごとの残り HP と integrity を直列化した形にする。
  public serialize(): SerializedAssemblyCombatState {
    return {
      partHp: this.parts.map((part) => this.partHp[part.index] ?? 0),
      integrity: this._integrity,
    };
  }

  // 残りの構造 HP。
  public get integrity(): number { return this._integrity; }

  // 構造 HP の初期値。
  public get maxIntegrity(): number { return ENEMY_MAX_HP; }

  // 撃破したか。integrity が尽きた・中核を失った・全部品を失ったのいずれかで真。
  public get destroyed(): boolean {
    return this._integrity <= 0
      || (this.coreIndex !== null && !this.partAlive(this.coreIndex))
      || this.parts.every((part) => !this.partAlive(part.index));
  }

  // 発射部が残っているか。失った個体は射撃できない。
  public get emitterAlive(): boolean {
    return this.emitterIndex !== null && this.partAlive(this.emitterIndex);
  }

  // index の部品が残っているか。
  public partAlive(index: number): boolean {
    return (this.partHp[index] ?? 0) > 0;
  }

  // 弾の被弾。命中した部品が特定できればその HP と integrity の双方へ、できなければ integrity
  // だけへ damage を入れる。部品 HP がこの被弾で尽きたときだけその index を返し、それ以外と
  // 既に失われた部品への被弾では null を返す。
  public applyBulletDamage(damage: number, partIndex: number | null): number | null {
    const amount = Math.max(0, damage);
    this._integrity = Math.max(0, this._integrity - amount);
    if (partIndex === null) return null;
    const hp = this.partHp[partIndex];
    if (hp === undefined || hp <= 0) return null;
    this.partHp[partIndex] = Math.max(0, hp - amount);
    return this.partHp[partIndex] === 0 ? partIndex : null;
  }

  // 接触など部品を特定しない損傷を integrity へ入れる。
  public applyIntegrityDamage(damage: number): void {
    this._integrity = Math.max(0, this._integrity - Math.max(0, damage));
  }
}
