import { bodyClassOf } from '../../celestial/body-class';
import { LAGRANGE_ID } from '../object-groups';
import type { CelestialRegistry } from '../../../physics/solar-system';
import type { BodyClass } from '../../celestial/body-class';
import type { MapPickable, MapPickKind } from '../../map-pickable';
import type { SectionOrder } from './physical-object-list-panel';

export type PhysicalObjectListFilter = 'artifact' | 'enemy' | 'lagrange' | Exclude<BodyClass, 'star'>;

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

type LagrangeSortKey = { readonly parentId: string; readonly point: number };

function lagrangeSortKey(id: string): LagrangeSortKey | null {
  const match = /^(.+)-l([1-5])$/.exec(id);
  return match ? { parentId: match[1]!, point: Number(match[2]) } : null;
}

// 軌道物体一覧の絞り込み・並べ替え・親子構造を、DOM 要素に一切触れず決める。
export class PhysicalObjectListOrder {
  public query = '';
  public filter: PhysicalObjectListFilter | null = null;
  public sort: PhysicalObjectListSort = 'solar';
  // 並べ替え・親子構造の入力を前フレームぶん保持し、変化した時だけ組み直す。
  private readonly prevIds: string[] = [];
  private readonly prevNames: string[] = [];
  private readonly prevKinds: MapPickKind[] = [];
  private readonly prevParents: (string | undefined)[] = [];
  private readonly prevMatches: boolean[] = [];
  private prevSort: PhysicalObjectListSort | null = null;
  private prevFilter: PhysicalObjectListFilter | null | undefined = undefined;
  // rebuildOrder() は毎フレーム呼ばれうるが、これらは組み直し中だけ使う scratch であり、
  // 呼び出し元へ参照を渡さない。Map/Set/配列の器だけを保持して GC を抑える。
  private readonly matchedScratch: MapPickable[] = [];
  private readonly displayIdsScratch: string[] = [];
  private readonly idsInSectionScratch = new Set<string>();
  private readonly clusterParentSeenScratch = new Set<string>();

  public constructor(private readonly registry: CelestialRegistry) {}

  public get filteringActive(): boolean {
    return this.query !== '' || this.filter !== null;
  }

  public matches(item: MapPickable): boolean {
    if (this.query && !`${item.name} ${item.detail ?? ''}`.toLocaleLowerCase().includes(this.query)) return false;
    if (this.filter === null) return true;
    if (this.filter === 'artifact') {
      return (item.kind === 'player' || item.kind === 'ammo' || item.kind === 'fuel' || item.kind === 'base') && item.inFocusedSystem !== false;
    }
    if (this.filter === 'enemy') return item.kind === 'ship' && item.inFocusedSystem !== false;
    if (this.filter === 'lagrange') return item.kind === 'body' && LAGRANGE_ID.test(item.id);
    return item.kind === 'body' && !LAGRANGE_ID.test(item.id) && bodyClassOf(this.registry, item.id) === this.filter;
  }

  // 並べ替え・親子構造を決める入力(候補の顔ぶれ・表示名・種別・親・絞り込みの通過可否と
  // 絞り込み/並び順の選択)を前フレームと突き合わせ、変化していれば真を返して記録を更新する。
  public refreshInputs(items: readonly MapPickable[], parentOf: ReadonlyMap<string, string>): boolean {
    let changed = this.prevIds.length !== items.length || this.prevSort !== this.sort || this.prevFilter !== this.filter;
    let i = 0;
    for (const item of items) {
      const parent = parentOf.get(item.id);
      const matched = this.matches(item);
      if (!changed && (this.prevIds[i] !== item.id || this.prevNames[i] !== item.name
        || this.prevKinds[i] !== item.kind || this.prevParents[i] !== parent || this.prevMatches[i] !== matched)) changed = true;
      this.prevIds[i] = item.id;
      this.prevNames[i] = item.name;
      this.prevKinds[i] = item.kind;
      this.prevParents[i] = parent;
      this.prevMatches[i] = matched;
      i++;
    }
    // 候補が減ったフレームでは末尾に前フレームの記録が残るので、長さも合わせておく。
    this.prevIds.length = items.length;
    this.prevNames.length = items.length;
    this.prevKinds.length = items.length;
    this.prevParents.length = items.length;
    this.prevMatches.length = items.length;
    this.prevSort = this.sort;
    this.prevFilter = this.filter;
    return changed;
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
    // 衛星フィルタでは、衛星自身はフィルタを通っても親の惑星は通らない(bodyClassOf が
    // 'planet' のため)。親を惑星ごとのクラスタ見出しとして拾い出す — フィルタの一致件数
    // (ヘッダーの (N))には含めないので、ids へ積んだ後に足す。
    const displayIds = kind === 'body' && this.filter === 'satellite'
      ? this.withClusterParents(order.ids, parentOf, itemsById) : order.ids;

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
    const priority = (a.priority ?? 0) - (b.priority ?? 0);
    if (priority !== 0) return priority;

    // 同じ親天体の L4/L5 は理論上同じ太陽距離にある。浮動小数点誤差で距離の大小を
    // 比較すると毎フレーム順序が反転するため、ラグランジュ点同士は点番号を正本にする。
    const aLagrange = lagrangeSortKey(a.id);
    const bLagrange = lagrangeSortKey(b.id);
    if (aLagrange !== null && bLagrange !== null && aLagrange.parentId === bLagrange.parentId) {
      return aLagrange.point - bLagrange.point;
    }

    // 太陽系順は恒星からの距離。恒星の無いレジストリでは distanceFromStar が undefined の
    // ままなので、自機からの距離(近さ順)へ自然に委譲される。
    const aDistance = this.sort === 'solar' ? (a.distanceFromStar ?? a.distance ?? 0) : (a.distance ?? 0);
    const bDistance = this.sort === 'solar' ? (b.distanceFromStar ?? b.distance ?? 0) : (b.distance ?? 0);
    const dist = aDistance - bDistance;
    const scale = Math.max(1, Math.abs(aDistance), Math.abs(bDistance));
    const distanceTie = Math.abs(dist) <= scale * 1e-12;
    return (distanceTie ? 0 : dist) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }

  // ids の各要素の親(未登場なら)を補った並びを返す — 親自身はフィルタを通っていなくても、
  // 親子ツリーにそのままクラスタ見出しとして乗せる。
  private withClusterParents(
    ids: readonly string[], parentOf: ReadonlyMap<string, string>, itemsById: ReadonlyMap<string, MapPickable>,
  ): string[] {
    const seenIds = this.clusterParentSeenScratch;
    seenIds.clear();
    for (const id of ids) seenIds.add(id);
    const result = this.displayIdsScratch;
    result.length = 0;
    for (const id of ids) result.push(id);
    for (const id of ids) {
      const parentId = parentOf.get(id);
      if (parentId === undefined || seenIds.has(parentId) || !itemsById.has(parentId)) continue;
      seenIds.add(parentId);
      result.push(parentId);
    }
    return result;
  }
}
