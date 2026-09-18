// エンティティ id の採番。

// `${prefix}${連番}` で発番し、id を渡された場合はそれをそのまま採用しつつ、
// 以後の新規発番と衝突しないようカウンタをその番号の次まで進める。
export class EntityIdAllocator {
  private counter = 0;

  public constructor(private readonly prefix: string) {}

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
}

// 種別ごとに独立した連番を持つ、ラン1つぶんの採番器。ランの寿命を持つオブジェクトが1つ持ち、
// 生成する側へ配る。
export class EntityIdAllocators {
  public readonly entity = new EntityIdAllocator('entity-');
  public readonly base = new EntityIdAllocator('base-');
  public readonly ammoPickup = new EntityIdAllocator('ammo-');
  public readonly rcsFuelPickup = new EntityIdAllocator('rcs-fuel-');
  public readonly booster = new EntityIdAllocator('booster-');

  // 復元する id を、実体を組む前に押さえる。素材待ちでゲートに掛かった個体の id を、
  // その間の新規発番が追い越さないようにする。持ち主は接頭辞で決まるので種別を知らなくてよい。
  public reserve(id: string): void {
    for (const allocator of [this.entity, this.base, this.ammoPickup, this.rcsFuelPickup, this.booster]) {
      allocator.reserve(id);
    }
  }
}
