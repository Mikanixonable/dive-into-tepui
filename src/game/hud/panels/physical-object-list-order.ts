import { isLagrangeId, lagrangePointOf } from '../../celestial/lagrange-id';
import type { CelestialClass } from '../../celestial/celestial-entity/celestial-entity-def';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { MapPickable, MapPickKind } from '../../pickable/map-pickable';
import type { Player } from '../../player/player';
import { len, sub } from '../../../math/vec3';

// 1区画ぶんの表示順と親子構造を id で持つ。表示値(距離・詳細)は毎フレーム
// 引き渡される MapPickable から読み直すため、ここには id しか置かない。
export interface SectionOrder {
  readonly ids: string[];
  readonly rootIds: string[];
  readonly childIds: Map<string, string[]>;
}

export type PhysicalObjectListFilter = 'artifact' | 'enemy' | 'lagrange' | Exclude<CelestialClass, 'star'>;

export const FILTERS: readonly (readonly [PhysicalObjectListFilter, string])[] = [
  ['planet', '惑星'],
  ['satellite', '衛星'],
  ['dwarf', '準惑星'],
  ['smallBody', '小天体'],
  ['lagrange', 'ラグランジュ点'],
  ['artifact', '人工物'],
  ['enemy', '敵'],
];

export type PhysicalObjectListSort = 'solar' | 'distance' | 'name';

export const SORTS: readonly (readonly [PhysicalObjectListSort, string])[] = [
  ['solar', '太陽系順'],
  ['distance', '近さ'],
  ['name', '名前'],
];

type LagrangeSortKey = ReturnType<typeof lagrangePointOf>;

// refreshInputs() が変化検知に使う、前フレームの候補1件ぶんの記録。id をキーにした別配列で
// 対応付けると増減のたびに整合性が崩れるので、1件を1レコードにまとめて保持する。
interface PrevInput {
  id: string;
  name: string;
  kind: MapPickKind;
  parent: string | undefined;
  matched: boolean;
}

// 一覧の1行が今フレームどこに並ぶかを決める値。候補そのものは MapPickable が持つ。
interface ListSortKey {
  readonly priority: number;         // 小さいほど先に出る
  readonly distance: number;         // 自艦から [m]。自艦がいなければ 0
  readonly distanceFromStar: number; // 恒星から [m]。恒星が無ければ distance と同値
  readonly inFocusedSystem: boolean;
}

// 候補列に載っていない行が持つ並び順。絞り込みは通し、距離は最前に置く。
const ABSENT_SORT_KEY: ListSortKey = {
  priority: 0, distance: 0, distanceFromStar: 0, inFocusedSystem: true,
};

// 使い捨ての id(撃破された敵艦・回収された弾薬)がキャッシュに残り続けないよう、候補数の
// 何倍まで溜めてよいかの係数。掃除はフレームに1度だけ行う — 取りこぼしのたびに掃除すると、
// 候補が上限を超えたフレームで毎回全消しを踏み、キャッシュが無いときより遅くなる。
const ID_KEYED_CACHE_SLACK = 4;

// 軌道物体一覧の絞り込み・並べ替え・親子構造を、DOM 要素に一切触れず決める。
export class PhysicalObjectListOrder {
  public query = '';
  public filter: PhysicalObjectListFilter | null = null;
  public sort: PhysicalObjectListSort = 'solar';
  // 並べ替え・親子構造の入力を前フレームぶん保持し、変化した時だけ組み直す。
  private readonly prevInputs: PrevInput[] = [];
  private prevSort: PhysicalObjectListSort | null = null;
  private prevFilter: PhysicalObjectListFilter | null | undefined = undefined;
  // id は不変なので、id ごとの導出結果はフレームを跨いでキャッシュしてよい。
  private readonly lagrangeSortKeyCache = new Map<string, LagrangeSortKey>();
  // 今フレームの並べ替え・絞り込みの基準。refreshInputs が候補列から導き直す。
  private readonly sortKeys = new Map<string, ListSortKey>();
  private activePlayer: Player | null = null;
  private displayTime = 0;
  // rebuildOrder() は毎フレーム呼ばれうるが、これらは組み直し中だけ使う scratch であり、
  // 呼び出し元へ参照を渡さない。Map/Set/配列の器だけを保持して GC を抑える。
  private readonly matchedScratch: MapPickable[] = [];
  private readonly displayIdsScratch: string[] = [];
  private readonly newClusterParentsScratch: string[] = [];
  private readonly idsInSectionScratch = new Set<string>();
  private readonly clusterParentSeenScratch = new Set<string>();

  public constructor(private readonly celestialSystem: CelestialSystem) {}

  public get filteringActive(): boolean {
    return this.query !== '' || this.filter !== null;
  }

  // item が現在の検索語・フィルタの両方を通過するか。
  public matches(item: MapPickable): boolean {
    if (this.query && !this.matchText(item).includes(this.query)) return false;
    if (this.filter === null) return true;
    const inFocusedSystem = this.sortKeyOf(item).inFocusedSystem;
    if (this.filter === 'artifact') {
      return (item.kind === 'player' || item.kind === 'ammo' || item.kind === 'fuel' || item.kind === 'base') && inFocusedSystem;
    }
    if (this.filter === 'enemy') return item.kind === 'enemy' && inFocusedSystem;
    if (this.filter === 'lagrange') return item.kind === 'body' && isLagrangeId(item.id);
    return item.kind === 'body' && !isLagrangeId(item.id)
      && this.celestialSystem.entityOf(item.id).bodyClass === this.filter;
  }

  // 並べ替え・親子構造を決める入力(候補の顔ぶれ・表示名・種別・親・絞り込みの通過可否と
  // 絞り込み/並び順の選択)を前フレームと突き合わせ、変化していれば真を返して記録を更新する。
  // 距離・所属系・優先度も候補列から導き直すので、他のメソッドより先に呼ぶこと。
  public refreshInputs(
    items: readonly MapPickable[], parentOf: ReadonlyMap<string, string>,
    activePlayer: Player | null, displayTime: number, focusId: string | undefined,
  ): boolean {
    this.dropStaleCaches(items.length);
    this.rebuildSortKeys(items, activePlayer, displayTime, focusId);
    let changed = this.prevInputs.length !== items.length || this.prevSort !== this.sort || this.prevFilter !== this.filter;
    let i = 0;
    for (const item of items) {
      const parent = parentOf.get(item.id);
      const matched = this.matches(item);
      const prev = this.prevInputs[i];
      if (!changed && (!prev || prev.id !== item.id || prev.name !== item.name
        || prev.kind !== item.kind || prev.parent !== parent || prev.matched !== matched)) changed = true;
      if (prev) { prev.id = item.id; prev.name = item.name; prev.kind = item.kind; prev.parent = parent; prev.matched = matched; }
      else this.prevInputs.push({ id: item.id, name: item.name, kind: item.kind, parent, matched });
      i++;
    }
    // 候補が減ったフレームでは末尾に前フレームの記録が残るので、長さも合わせておく。
    this.prevInputs.length = items.length;
    this.prevSort = this.sort;
    this.prevFilter = this.filter;
    return changed;
  }

  // 今フレームの自艦・表示時刻から、候補ごとの並べ替え基準を導き直す。恒星からの距離は
  // 太陽系順、自艦からの距離は近さ順、所属系は人工物と敵の絞り込みが読む。
  private rebuildSortKeys(
    items: readonly MapPickable[], activePlayer: Player | null, displayTime: number,
    focusId: string | undefined,
  ): void {
    this.activePlayer = activePlayer;
    this.displayTime = displayTime;
    this.sortKeys.clear();
    const viewer = activePlayer?.state ?? null;
    const star = this.celestialSystem.star;
    const starPos = star === null ? null : star.stateAt(displayTime).r;
    for (const item of items) {
      const pos = item.mapPosAt(displayTime);
      if (pos === null) continue;
      const distance = viewer === null ? 0 : len(sub(pos, viewer.r));
      // 所属系の判定は最強天体から親を辿るぶん高価なので、系そのものを表す天体では省く。
      const inFocusedSystem = item.kind === 'body'
        || this.celestialSystem.isPositionInFocusedSystem(focusId, pos, displayTime);
      this.sortKeys.set(item.id, {
        priority: item.listPriority(activePlayer),
        distance,
        distanceFromStar: starPos === null ? distance : len(sub(pos, starPos)),
        inFocusedSystem,
      });
    }
  }

  private sortKeyOf(item: MapPickable): ListSortKey {
    return this.sortKeys.get(item.id) ?? ABSENT_SORT_KEY;
  }

  // 保持している並び ids が、今フレームの値でも比較関数の順序を満たしているか。
  public orderStillSorted(ids: readonly string[], itemsById: ReadonlyMap<string, MapPickable>): boolean {
    let prev: MapPickable | null = null;
    for (const id of ids) {
      const item = itemsById.get(id);
      if (!item) return false;
      if (prev !== null && this.compare(prev, item) > 0) return false;
      prev = item;
    }
    return true;
  }

  // kind の区画に出す行を選び直し、表示順・根・親ごとの子を order へ書き直す。
  public rebuildOrder(
    kind: MapPickKind, order: SectionOrder, items: readonly MapPickable[],
    parentOf: ReadonlyMap<string, string>, itemsById: ReadonlyMap<string, MapPickable>,
  ): void {
    const matched = this.matchedScratch;
    matched.length = 0;
    for (const item of items) if (item.kind === kind && this.matches(item)) matched.push(item);
    matched.sort((a, b) => this.compare(a, b));
    order.ids.length = 0;
    for (const item of matched) order.ids.push(item.id);
    // 衛星フィルタでは、衛星自身はフィルタを通っても親の惑星は通らない(親の bodyClass が
    // 'planet' のため)。親を惑星ごとのクラスタ見出しとして拾い出す — フィルタの一致件数
    // (ヘッダーの (N))には含めないので、order.ids は素通しのまま、木を組む先だけ displayIds へ分ける。
    const displayIds = this.displayIdsScratch;
    displayIds.length = 0;
    for (const id of order.ids) displayIds.push(id);
    if (kind === 'body' && this.filter === 'satellite') this.appendClusterParents(displayIds, parentOf, itemsById);

    const idsInSection = this.idsInSectionScratch;
    idsInSection.clear();
    for (const id of displayIds) idsInSection.add(id);
    for (const list of order.childIds.values()) list.length = 0;
    order.rootIds.length = 0;
    for (const id of displayIds) {
      const parent = parentOf.get(id);
      // 親が今フレーム同じ区画に見当たらない(遮蔽等で一時的に消えた等)行は根として扱う —
      // 親が現れないせいで子ごと画面から消えてしまうより、ひとまず出す方に倒す。
      if (parent === undefined || !idsInSection.has(parent)) { order.rootIds.push(id); continue; }
      const list = order.childIds.get(parent);
      if (list) list.push(id); else order.childIds.set(parent, [id]);
    }
  }

  // 現在の並び順での a と b の前後関係。負なら a が先。
  private compare(a: MapPickable, b: MapPickable): number {
    if (this.sort === 'name') return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    const aKey = this.sortKeyOf(a);
    const bKey = this.sortKeyOf(b);
    const priority = aKey.priority - bKey.priority;
    if (priority !== 0) return priority;

    // 同じ親天体の L4/L5 は理論上同じ太陽距離にある。浮動小数点誤差で距離の大小を
    // 比較すると毎フレーム順序が反転するため、ラグランジュ点同士は点番号を正本にする。
    const aLagrange = this.lagrangeSortKeyOf(a);
    const bLagrange = this.lagrangeSortKeyOf(b);
    if (aLagrange !== null && bLagrange !== null && aLagrange.parentId === bLagrange.parentId) {
      return aLagrange.point - bLagrange.point;
    }

    // 太陽系順は恒星からの距離。恒星の無いレジストリでは距離が自機基準になるので、
    // 近さ順へ自然に委譲される。
    const aDistance = this.sort === 'solar' ? aKey.distanceFromStar : aKey.distance;
    const bDistance = this.sort === 'solar' ? bKey.distanceFromStar : bKey.distance;
    const dist = aDistance - bDistance;
    const scale = Math.max(1, Math.abs(aDistance), Math.abs(bDistance));
    const distanceTie = Math.abs(dist) <= scale * 1e-12;
    return (distanceTie ? 0 : dist) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }

  // lagrangePointOf() は正規表現 exec とオブジェクト割り当てを伴うが、id は不変なので結果は
  // 変わらない。orderStillSorted() が毎フレーム全 ids ぶん compare() を呼ぶので、id ごとに
  // 一度だけ計算して使い回す。ラグランジュ点は天体だけが持つので、他の種別はキャッシュへ
  // 載せずに弾く — 使い捨ての id で器が膨らむのを防ぐ。
  private lagrangeSortKeyOf(item: MapPickable): LagrangeSortKey {
    if (item.kind !== 'body') return null;
    const cached = this.lagrangeSortKeyCache.get(item.id);
    if (cached !== undefined) return cached;
    const key = lagrangePointOf(item.id);
    this.lagrangeSortKeyCache.set(item.id, key);
    return key;
  }

  // id をキーにしたキャッシュが、候補として現れなくなった id を溜め込み続けないようにする。
  // 個別に消すには今フレームの id 集合と突き合わせる必要があり、それ自体が毎フレームの走査に
  // なるので、候補数から離れすぎたときだけ捨てて作り直す。
  private dropStaleCaches(itemCount: number): void {
    const limit = (itemCount + 1) * ID_KEYED_CACHE_SLACK;
    if (this.lagrangeSortKeyCache.size > limit) this.lagrangeSortKeyCache.clear();
  }

  // 検索語と照合する文字列。表示名と、対象が検索向けに出す補助表示を小文字で連ねる。
  private matchText(item: MapPickable): string {
    const searchText = item.listSearchText(this.celestialSystem, this.activePlayer, this.displayTime);
    return `${item.name} ${searchText}`.toLocaleLowerCase();
  }

  // ids の末尾へ、まだ登場していない親を追記する — 親自身はフィルタを通っていなくても、
  // 親子ツリーにそのままクラスタ見出しとして乗せる。呼び出し元が渡した配列へ直接書き込むことで、
  // 返り値の所有者が条件によって変わる(scratch のことも呼び出し元の配列のこともある)のを避ける。
  // 追加分は選んだ並び順で意味を持つ見出しなので、ids への push 順ではなく compare() で整列する。
  private appendClusterParents(
    ids: string[], parentOf: ReadonlyMap<string, string>, itemsById: ReadonlyMap<string, MapPickable>,
  ): void {
    const seenIds = this.clusterParentSeenScratch;
    seenIds.clear();
    for (const id of ids) seenIds.add(id);
    const newParents = this.newClusterParentsScratch;
    newParents.length = 0;
    for (const id of ids) {
      const parentId = parentOf.get(id);
      if (parentId === undefined || seenIds.has(parentId) || !itemsById.has(parentId)) continue;
      seenIds.add(parentId);
      newParents.push(parentId);
    }
    newParents.sort((a, b) => this.compare(itemsById.get(a)!, itemsById.get(b)!));
    for (const id of newParents) ids.push(id);
  }
}
