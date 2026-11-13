// 授与された鹵獲のうち、まだ補給艇で届けていない積荷の待ち行列(SPEC GAME.md 2.3)。
// 授与の順に積み、次に補給艇が現れる波間に全部まとめて積む。
import { isSalvageKind, type SalvageKind } from '../../ship/salvage-blueprints';

export class SalvageCargo {
  private readonly kinds: SalvageKind[];

  // 授与の順に並んだ積荷で始める。省くと空の待ち行列になる。
  public constructor(kinds: readonly SalvageKind[] = []) {
    this.kinds = [...kinds];
  }

  // 直列化した積荷を復元する。知らない種類の記録は読み捨て、記録が無ければ空から始まる。
  public static deserialize(kinds: readonly unknown[] | null): SalvageCargo {
    return new SalvageCargo((kinds ?? []).filter(isSalvageKind));
  }

  // 待ち行列の中身(授与の順)。
  public get pending(): readonly SalvageKind[] {
    return this.kinds;
  }

  // 授与された鹵獲の積荷を、待ち行列の末尾へ積む。
  public add(kind: SalvageKind): void {
    this.kinds.push(kind);
  }

  // 待ち行列を空にし、取り出した積荷を授与の順で返す。
  public takeAll(): readonly SalvageKind[] {
    return this.kinds.splice(0);
  }

  // 直列化した形へ変換する。
  public serialize(): readonly SalvageKind[] {
    return [...this.kinds];
  }
}
