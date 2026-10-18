// 軌道標識: プレイヤーが配置する参照軌道(SPEC MAP.md「軌道標識」)。質量も当たり判定も持たず、
// 積分される物体でもない — 積み上げる状態は「どの参照軌道を指すか」の記述と名前だけで、
// 時刻 t の位置・速度は orbit-slot-state.ts が参照軌道の記述から決める。
import type { ReferenceOrbit } from '../../physics/reference-orbit';

// 族の1メンバーの指定(physics/reference-orbit.ts が正本 — 直列化の形でもあるので再輸出する)。
export type { OrbitFamilyDescriptor } from '../../physics/reference-orbit';

// 軌道標識が指す参照軌道の記述。JSON の素の値だけで組むので、直列化された形としても
// そのまま使う(ARCHITECTURE R12)。型の正本は physics/reference-orbit.ts の ReferenceOrbit。
// - elements: 基準天体まわりの元期の平均軌道要素。bodyId は基準天体の id、epoch は
//   要素が位相を持つ基準時刻 [simTime s]。a [m]、e、i/raan/argPeriapsis [rad]、
//   meanAnomaly0 は元期の平均近点角 [rad]。
// - family: 系(主星 primaryId・副星 secondaryId)と族の1メンバー。phase0 は simTime=0 での
//   位相点の位相(メンバーの周期に対する経過割合 [0,1))。
export type OrbitSlotOrbit = ReferenceOrbit;

// family 型だけを取り出す型(組み立て関数の返り値に使う)。
export type OrbitSlotFamilyOrbit = Extract<OrbitSlotOrbit, { readonly kind: 'family' }>;

// 軌道標識1件の直列化した形。
export interface SerializedOrbitSlot {
  readonly id: string;
  readonly name: string;
  readonly orbit: OrbitSlotOrbit;
}

// 軌道標識1件。実体ではない — 運動も接触も持たず、保持するのは参照軌道の記述と名前だけ。
export class OrbitSlot {
  private slotName: string;

  public constructor(
    public readonly id: string,
    name: string,
    public readonly orbit: OrbitSlotOrbit,
  ) {
    this.slotName = name;
  }

  public get name(): string { return this.slotName; }

  // 表示名を差し替える。空欄は受け付けない(既定名は配置時に付く)。
  public rename(name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') return;
    this.slotName = trimmed;
  }

  // 直列化した形へ畳む。
  public serialize(): SerializedOrbitSlot {
    return { id: this.id, name: this.slotName, orbit: this.orbit };
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedOrbitSlot): OrbitSlot {
    return new OrbitSlot(serialized.id, serialized.name, serialized.orbit);
  }
}
