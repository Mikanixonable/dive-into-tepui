// エンティティ id の採番。

// `${prefix}${連番}` で発番し、id を渡された場合はそれをそのまま採用しつつ、
// 以後の新規発番と衝突しないようカウンタをその番号の次まで進める。
export class EntityIdAllocator {
  // counter は次に発番する連番で、省けば連番の初めから発番する。
  public constructor(private readonly prefix: string, private counter = 0) {}

  // id を渡せばそれを採用し、省略時は新規に発番する。
  public next(id?: string): string {
    if (id !== undefined) {
      this.reserve(id);
      return id;
    }
    return `${this.prefix}${this.counter++}`;
  }

  // id がこのカウンタの採番済み連番を追い越していれば、次の発番と衝突しないよう
  // カウンタをその次まで進める。接頭辞が違う id は自分のものではないので何もしない。
  public reserve(id: string): void {
    if (!id.startsWith(this.prefix)) return;
    const n = Number(id.slice(this.prefix.length));
    if (Number.isFinite(n) && n >= this.counter) this.counter = n + 1;
  }

  // 次に発番する連番。直列化した形を兼ね、復元ではコンストラクタの counter へ渡す。
  public serialize(): number {
    return this.counter;
  }
}

// 種別ごとの採番器の、次に発番する連番。
export interface SerializedEntityIdAllocators {
  readonly entity: number;
  readonly base: number;
  readonly ammoPickup: number;
  readonly rcsFuelPickup: number;
  readonly booster: number;
}

// 種別ごとに独立した連番を持つ、ラン1つぶんの採番器。ランの寿命を持つオブジェクトが1つ持ち、
// 生成する側へ配る。
export class EntityIdAllocators {
  public readonly entity: EntityIdAllocator;
  public readonly base: EntityIdAllocator;
  public readonly ammoPickup: EntityIdAllocator;
  public readonly rcsFuelPickup: EntityIdAllocator;
  public readonly booster: EntityIdAllocator;

  // 種別ごとの次に発番する連番から組む。省いた種別は連番の初めから発番する。
  public constructor(entity = 0, base = 0, ammoPickup = 0, rcsFuelPickup = 0, booster = 0) {
    this.entity = new EntityIdAllocator('entity-', entity);
    this.base = new EntityIdAllocator('base-', base);
    this.ammoPickup = new EntityIdAllocator('ammo-', ammoPickup);
    this.rcsFuelPickup = new EntityIdAllocator('rcs-fuel-', rcsFuelPickup);
    this.booster = new EntityIdAllocator('booster-', booster);
  }

  // 直列化した連番から復元する。
  public static deserialize(serialized: SerializedEntityIdAllocators): EntityIdAllocators {
    const { entity, base, ammoPickup, rcsFuelPickup, booster } = serialized;
    return new EntityIdAllocators(entity, base, ammoPickup, rcsFuelPickup, booster);
  }

  // 種別ごとの次に発番する連番を直列化した形へ畳む。
  public serialize(): SerializedEntityIdAllocators {
    return {
      entity: this.entity.serialize(),
      base: this.base.serialize(),
      ammoPickup: this.ammoPickup.serialize(),
      rcsFuelPickup: this.rcsFuelPickup.serialize(),
      booster: this.booster.serialize(),
    };
  }

  // 復元する id を、実体を組む前に押さえる。素材待ちでゲートに掛かった個体の id を、
  // その間の新規発番が追い越さないようにする。持ち主は接頭辞で決まるので種別を知らなくてよい。
  public reserve(id: string): void {
    for (const allocator of [this.entity, this.base, this.ammoPickup, this.rcsFuelPickup, this.booster]) {
      allocator.reserve(id);
    }
  }
}
