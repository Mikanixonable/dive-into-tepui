import { bodyClassOf } from '../../celestial/body-class';
import { bodyEntityGlyph, ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../../marker/marker-glyphs';
import { baseMarkerSvg, shipMarkerSvg } from '../../marker/marker-shapes';
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  hudRail,
  type CollapseToggleLabels,
} from '../hud-root';
import { LAGRANGE_ID } from '../object-groups';
import { SegmentedControl, ValueInput } from '../widgets';
import { wirePanelCollapse } from '../panel-shell';
import type { CelestialRegistry } from '../../../physics/solar-system';
import type { BodyClass } from '../../celestial/body-class';
import type { MapPickable, MapPickKind } from '../../map-pickable';

const SECTIONS: readonly { kind: MapPickKind; label: string }[] = [
  { kind: 'body', label: '天体' },
  { kind: 'player', label: '自艦' },
  { kind: 'ship', label: '敵' },
  { kind: 'ammo', label: '弾薬' },
  { kind: 'fuel', label: 'RCS燃料' },
  { kind: 'base', label: '基地' },
];

// 1区画ぶんの表示順と親子構造を id で持つ。表示値(距離・詳細)は毎フレーム
// 引き渡される MapPickable から読み直すため、ここには id しか置かない。
interface SectionOrder {
  readonly ids: string[];
  readonly rootIds: string[];
  readonly childIds: Map<string, string[]>;
}

interface Section {
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly rows: Map<string, RowNode>;
  readonly order: SectionOrder;
  expanded: boolean;
  // 絞り込みが一致行を見せるために強制的に開いた場合の、直前のプレイヤー操作による
  // 畳み状態。null は「絞り込みによる強制展開はしていない」。絞り込み解除時にここへ戻す。
  savedExpanded: boolean | null;
}

// 区画見出しに添える内訳 — detail に needle を含む行を数え、label 付きで示す。
const HEADER_SUMMARY: Partial<Record<MapPickKind, { readonly needle: string; readonly label: string }>> = {
  ship: { needle: '接近', label: '接近' },
  ammo: { needle: '回収可能', label: '回収可' },
  fuel: { needle: '回収可能', label: '回収可' },
  base: { needle: 'ドック', label: 'ドック候補' },
};

const EMPTY_IDS: readonly string[] = [];

type PhysicalObjectListFilter = 'artifact' | 'enemy' | 'lagrange' | Exclude<BodyClass, 'star'>;

const FILTERS: readonly (readonly [PhysicalObjectListFilter, string])[] = [
  ['planet', '惑星'],
  ['satellite', '衛星'],
  ['dwarf', '準惑星'],
  ['smallBody', '小天体'],
  ['lagrange', 'ラグランジュ点'],
  ['artifact', '人工物'],
  ['enemy', '敵'],
];

// このパネル自身の折りたたみトグルの見た目。
const COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '軌道物体一覧を閉じる',
  collapsedTitle: '軌道物体一覧を開く',
};

type PhysicalObjectListSort = 'solar' | 'distance' | 'name';

const SORTS: readonly (readonly [PhysicalObjectListSort, string])[] = [
  ['solar', '太陽系順'],
  ['distance', '近さ'],
  ['name', '名前'],
];

type LagrangeSortKey = { readonly parentId: string; readonly point: number };

function lagrangeSortKey(id: string): LagrangeSortKey | null {
  const match = /^(.+)-l([1-5])$/.exec(id);
  return match ? { parentId: match[1]!, point: Number(match[2]) } : null;
}

// 色が消えても種別を判別できる、マップ用の小さな形態記号。名称と常に並べて表示する。
// body は恒星・衛星・ラグランジュ点で字形が変わるため、この表ではなく bodyGlyph() で選ぶ。
const OBJECT_GLYPHS: Readonly<Record<Exclude<MapPickKind, 'body'>, string>> = {
  player: ENTITY_GLYPH.ship,
  ship: ENTITY_GLYPH.enemyShip,
  ammo: ENTITY_GLYPH.ammo,
  fuel: ENTITY_GLYPH.fuel,
  base: ENTITY_GLYPH.base,
  apsis: ORBIT_POINT_GLYPH.apsis,
  relnode: ORBIT_POINT_GLYPH.ascendingNode,
  eqnode: ORBIT_POINT_GLYPH.descendingNode,
  'empty-space': '·',
};

// player/ship/base はマップ実マーカーと同じ SVG 形状を凡例にも使う。それ以外は Unicode 文字のまま。
const OBJECT_GLYPH_SVGS: Partial<Readonly<Record<MapPickKind, string>>> = {
  player: shipMarkerSvg(true),
  ship: shipMarkerSvg(false),
  base: baseMarkerSvg(),
};

// 1件ぶんの行 + その子を畳めるトグル区画。子を持たない行(自艦/敵/弾薬/基地、および
// 子のない天体)でも toggle/childrenContainer 自体は生成しておき、可視性だけ切り替える
// (子の有無はフレームごとに変わりうるため、生成を後から差し込むより組み替えが少ない)。
interface RowNode {
  readonly row: HTMLElement;
  readonly toggle: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
  readonly detail: HTMLElement;
  readonly childrenContainer: HTMLElement;
  readonly children: Map<string, RowNode>;
  expanded: boolean;
  // Section.savedExpanded と同じ役割 — この行の子リストを絞り込みが強制的に開いた際の
  // 直前の畳み状態。
  savedExpanded: boolean | null;
}

// マップビュー右部に常設の軌道物体一覧ウィンドウ。種別ごとの区画にタブ見出しで
// 開閉し、ダブルクリックでフォーカスを移動する。天体区画は衛星・ラグランジュ点を親の下の
// トグル子メニューへ格納する(衛星自身のラグランジュ点はさらにその衛星の子メニューへ)。
export class PhysicalObjectListPanel {
  public onFocus: ((id: string) => void) | null = null;
  public onNavTarget: ((id: string) => void) | null = null;
  public onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly sections = new Map<MapPickKind, Section>();
  private readonly registry: CelestialRegistry;
  private query = '';
  private filter: PhysicalObjectListFilter | null = null;
  private sort: PhysicalObjectListSort = 'solar';
  private lastFocusId: string | undefined = undefined;
  // sync() は毎フレーム呼ばれるが、これらは同期中だけ使う scratch であり、呼び出し元へ
  // 参照を渡さない。Map/Set/配列の器だけを保持して GC を抑える。
  private readonly namesScratch = new Map<string, string>();
  private readonly itemsByIdScratch = new Map<string, MapPickable>();
  private readonly crumbsScratch: string[] = [];
  private readonly matchedScratch: MapPickable[] = [];
  private readonly displayIdsScratch: string[] = [];
  private readonly idsInSectionScratch = new Set<string>();
  private readonly clusterParentSeenScratch = new Set<string>();
  private readonly focusAncestorsScratch = new Set<string>();
  private readonly matchAncestorsScratch = new Set<string>();
  private readonly seenScratch = new Set<string>();
  // 絞り込み条件(検索語・クラスフィルタ)の直前フレーム値。変化を検知した回だけ
  // 一致行の祖先を強制的に開く — 毎フレーム開き直すとプレイヤーの手動での畳み操作と競合する。
  private prevAutoExpandQuery = '';
  private prevAutoExpandFilter: PhysicalObjectListFilter | null = null;
  private wasFilteringActive = false;
  // 並べ替え・親子構造の入力を前フレームぶん保持し、変化した時だけ組み直す。
  private readonly prevIds: string[] = [];
  private readonly prevNames: string[] = [];
  private readonly prevKinds: MapPickKind[] = [];
  private readonly prevParents: (string | undefined)[] = [];
  private readonly prevMatches: boolean[] = [];
  private prevSort: PhysicalObjectListSort | null = null;
  private prevFilter: PhysicalObjectListFilter | null | undefined = undefined;
  private readonly breadcrumb: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  public constructor(root: HTMLElement, registry: CelestialRegistry) {
    this.registry = registry;
    this.panel = document.createElement('div');
    this.panel.id = 'hud-physical-object-list';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'physical-object-list-head';

    const titleRow = document.createElement('div');
    titleRow.className = 'physical-object-list-title';
    const title = document.createElement('h3');
    title.textContent = '物体';
    titleRow.appendChild(title);
    head.appendChild(titleRow);
    const searchWrap = document.createElement('div');
    searchWrap.className = 'physical-object-list-search';
    // Escape は「破棄」ではなく「絞り込み解除」に読めるので、検索欄だけは 'clear' を渡す(§7-9)。
    const updateQuery = (value: string) => { this.query = value.trim().toLocaleLowerCase(); };
    const search = new ValueInput(
      { type: 'search', placeholder: '検索', escapeBehavior: 'clear' },
      updateQuery,
      () => { this.query = ''; },
    );
    search.element.setAttribute('aria-label', '軌道物体を検索');
    // 確定を待たず、打鍵のたびに絞り込みへ反映する。
    search.element.addEventListener('input', () => updateQuery(search.element.value));
    searchWrap.appendChild(search.element);
    head.appendChild(searchWrap);

    const filterControl = new SegmentedControl<PhysicalObjectListFilter | null>('分類', FILTERS, (key) => {
      this.filter = this.filter === key ? null : key;
      filterControl.setSelected(this.filter);
    });
    filterControl.setSelected(this.filter);
    head.appendChild(filterControl.element);

    // 並び順はフィルタとは別行 — 絞り込みと並べ替えは独立な操作であることを見た目でも分ける。
    const sortControl = new SegmentedControl<PhysicalObjectListSort>('並び順', SORTS, (key) => {
      this.sort = key;
      sortControl.setSelected(key);
    });
    sortControl.setSelected(this.sort);
    head.appendChild(sortControl.element);
    this.panel.appendChild(head);
    // 見出し以外をまとめて畳める区画にする — 一覧は常時表示で画面右を大きく占有するため。
    const body = document.createElement('div');
    body.className = 'physical-object-list-body';
    this.panel.appendChild(body);
    this.unsubscribeCollapsedView = wirePanelCollapse({
      toggleRoot: titleRow,
      toggleId: 'hud-physical-object-list-toggle',
      toggleClassName: 'physical-object-list-collapse',
      target: body,
      labels: COLLAPSE_LABELS,
      storageId: 'hud-physical-object-list',
      extraHitEls: [title],
    });
    this.breadcrumb = document.createElement('div');
    this.breadcrumb.className = 'physical-object-list-breadcrumb';
    body.appendChild(this.breadcrumb);

    for (const { kind } of SECTIONS) {
      const header = document.createElement('div');
      header.className = 'physical-object-list-section-header';
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      const sectionBody = document.createElement('div');
      sectionBody.className = 'physical-object-list-section-body';
      const order: SectionOrder = { ids: [], rootIds: [], childIds: new Map() };
      const section: Section = { header, body: sectionBody, rows: new Map(), order, expanded: true, savedExpanded: null };
      header.addEventListener('click', () => {
        section.expanded = !section.expanded;
        this.applyExpanded(section);
      });
      header.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        section.expanded = !section.expanded;
        this.applyExpanded(section);
      });
      this.sections.set(kind, section);
      body.appendChild(header);
      body.appendChild(sectionBody);
      this.applyExpanded(section);
    }

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'physical-object-list-empty hidden';
    this.emptyState.textContent = '該当する物体がありません';
    body.appendChild(this.emptyState);

    hudRail(root, 'right').appendChild(this.panel);
    this.setVisible(false);
  }

  public setVisible(visible: boolean): void {
    this.panel.classList.toggle('hidden', !visible);
  }

  // プロパティウィンドウが自身の対象の行帯び色(.tgt)を揃えるための問い合わせ。
  public isTarget(id: string): boolean { return id === this.lastFocusId; }

  // パネルを取り除き、折りたたみ状態変化の購読を解く。
  public dispose(): void {
    this.unsubscribeCollapsedView();
    this.panel.remove();
  }

  // 種別ごとの区画へ、既存行は使い回しつつ id 差分だけ足し引きする。行のクリックリスナーは
  // 生成時の1回だけ張るので、ここで毎フレーム innerHTML を書き換えてはいけない
  // (張り直しになり、クリック中に要素が消えてイベントが発火しなくなる)。
  // parentOf は id → 親 id(天体の親子関係のみ、他種別は載らない)。focusId が undefined
  // (フォーカス中の天体が無い)なら、どの行も強調しない。
  public sync(
    items: readonly MapPickable[],
    focusId: string | undefined,
    parentOf: ReadonlyMap<string, string>,
  ): void {
    this.namesScratch.clear();
    this.itemsByIdScratch.clear();
    for (const item of items) {
      this.namesScratch.set(item.id, item.name);
      this.itemsByIdScratch.set(item.id, item);
    }
    const names = this.namesScratch;
    const crumbs = this.crumbsScratch;
    crumbs.length = 0;
    for (let cur = focusId; cur !== undefined; cur = parentOf.get(cur)) crumbs.push(names.get(cur) ?? cur);
    this.breadcrumb.textContent = crumbs.length ? crumbs.reverse().join(' › ') : 'フォーカス: なし';
    const focusChanged = focusId !== this.lastFocusId;
    this.lastFocusId = focusId;
    const inputsChanged = this.refreshInputs(items, parentOf);

    // フォーカスが切り替わった瞬間だけ、そこへ至る枝を自動展開する対象として渡す
    // (毎フレーム渡すとユーザーが畳んだ直後に開き直ってしまう)。
    const focusAncestors = this.focusAncestorsScratch;
    focusAncestors.clear();
    if (focusChanged) for (let cur = focusId; cur !== undefined; cur = parentOf.get(cur)) focusAncestors.add(cur);

    // 検索語・クラスフィルタが変わった瞬間だけ、その回に一致した行の祖先を自動展開する
    // 対象として渡す(focusAncestors と同じ「変化した回だけ」の考え方)。絞り込みが解除された
    // 瞬間は逆に、その自動展開で開いた分だけをプレイヤーの元の畳み状態へ戻す。
    const filteringActive = this.query !== '' || this.filter !== null;
    const filterChanged = this.query !== this.prevAutoExpandQuery || this.filter !== this.prevAutoExpandFilter;
    this.prevAutoExpandQuery = this.query;
    this.prevAutoExpandFilter = this.filter;
    const filteringJustDeactivated = !filteringActive && this.wasFilteringActive;
    this.wasFilteringActive = filteringActive;

    const matchAncestors = this.matchAncestorsScratch;
    matchAncestors.clear();
    if (filteringActive && filterChanged) {
      for (const item of items) {
        if (!this.matches(item)) continue;
        for (let cur: string | undefined = item.id; cur !== undefined; cur = parentOf.get(cur)) matchAncestors.add(cur);
      }
    }
    if (filteringJustDeactivated) {
      for (const section of this.sections.values()) {
        if (section.savedExpanded !== null) { section.expanded = section.savedExpanded; section.savedExpanded = null; this.applyExpanded(section); }
        this.restoreSavedExpanded(section.rows);
      }
    }

    let totalMatched = 0;
    for (const { kind, label } of SECTIONS) {
      const section = this.sections.get(kind)!;
      // 距離順では距離が動くだけで正しい並びが変わりうるので、保持している順序が
      // 今フレームの値でも整列条件を満たすかを確かめ、崩れた時だけ組み直す。
      const reordered = inputsChanged || !this.orderStillSorted(section.order.ids);
      if (reordered) this.rebuildOrder(kind, section.order, items, parentOf);
      // 一致行を持つ区画自体が畳まれていれば、絞り込みの変化に合わせて開く。
      if (filteringActive && filterChanged && section.order.ids.length > 0 && !section.expanded) {
        if (section.savedExpanded === null) section.savedExpanded = section.expanded;
        section.expanded = true;
        this.applyExpanded(section);
      }
      this.syncHeader(section, kind, label);
      totalMatched += section.order.ids.length;

      const seen = this.seenScratch;
      seen.clear();
      for (const id of section.order.rootIds) {
        seen.add(id);
        this.syncRow(section.rows, id, section.order.childIds, focusId, section.body, focusAncestors, matchAncestors, reordered);
      }
      this.pruneRows(section.rows, seen);
    }
    this.emptyState.classList.toggle('hidden', !(filteringActive && totalMatched === 0));
  }

  // 絞り込みが強制的に開いた分の畳み状態を、記録してあるプレイヤーの元の値へ戻す。
  private restoreSavedExpanded(rows: ReadonlyMap<string, RowNode>): void {
    for (const node of rows.values()) {
      if (node.savedExpanded !== null) { node.expanded = node.savedExpanded; node.savedExpanded = null; }
      this.restoreSavedExpanded(node.children);
    }
  }

  // 区画見出しへ件数と状況の内訳を書き出す。表示行が無い区画は見出しごと隠す。
  private syncHeader(section: Section, kind: MapPickKind, label: string): void {
    const ids = section.order.ids;
    section.header.classList.toggle('hidden', ids.length === 0);
    const summary = HEADER_SUMMARY[kind];
    let state = '';
    if (summary) {
      let count = 0;
      for (const id of ids) if (this.itemsByIdScratch.get(id)?.detail?.includes(summary.needle)) count++;
      state = ` · ${summary.label} ${count}`;
    }
    section.header.textContent = `${label} (${ids.length})${state} ${section.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH}`;
  }

  // 並べ替え・親子構造を決める入力(候補の顔ぶれ・表示名・種別・親・絞り込みの通過可否と
  // 絞り込み/並び順の選択)を前フレームと突き合わせ、変化していれば真を返して記録を更新する。
  private refreshInputs(items: readonly MapPickable[], parentOf: ReadonlyMap<string, string>): boolean {
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
  private orderStillSorted(ids: readonly string[]): boolean {
    let prev: MapPickable | null = null;
    for (const id of ids) {
      const item = this.itemsByIdScratch.get(id);
      if (!item) return false;
      if (prev !== null && this.compare(prev, item) > 0) return false;
      prev = item;
    }
    return true;
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

  // kind の区画に出す行を選び直し、表示順・根・親ごとの子を order へ書き直す。
  private rebuildOrder(
    kind: MapPickKind, order: SectionOrder, items: readonly MapPickable[], parentOf: ReadonlyMap<string, string>,
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
      ? this.withClusterParents(order.ids, parentOf) : order.ids;

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

  // ids の各要素の親(未登場なら)を補った並びを返す — 親自身はフィルタを通っていなくても、
  // 親子ツリーにそのままクラスタ見出しとして乗せる。
  private withClusterParents(ids: readonly string[], parentOf: ReadonlyMap<string, string>): string[] {
    const seenIds = this.clusterParentSeenScratch;
    seenIds.clear();
    for (const id of ids) seenIds.add(id);
    const result = this.displayIdsScratch;
    result.length = 0;
    for (const id of ids) result.push(id);
    for (const id of ids) {
      const parentId = parentOf.get(id);
      if (parentId === undefined || seenIds.has(parentId) || !this.itemsByIdScratch.has(parentId)) continue;
      seenIds.add(parentId);
      result.push(parentId);
    }
    return result;
  }

  // 天体の字形。マップ実マーカーと同じ選び方(ラグランジュ点は専用字形、それ以外は
  // 恒星/衛星/その他で bodyEntityGlyph())をする。
  private bodyGlyph(id: string): string {
    return LAGRANGE_ID.test(id) ? ENTITY_GLYPH.lagrange : bodyEntityGlyph(bodyClassOf(this.registry, id));
  }

  private matches(item: MapPickable): boolean {
    if (this.query && !`${item.name} ${item.detail ?? ''}`.toLocaleLowerCase().includes(this.query)) return false;
    if (this.filter === null) return true;
    if (this.filter === 'artifact') {
      return (item.kind === 'player' || item.kind === 'ammo' || item.kind === 'fuel' || item.kind === 'base') && item.inFocusedSystem !== false;
    }
    if (this.filter === 'enemy') return item.kind === 'ship' && item.inFocusedSystem !== false;
    if (this.filter === 'lagrange') return item.kind === 'body' && LAGRANGE_ID.test(item.id);
    return item.kind === 'body' && !LAGRANGE_ID.test(item.id) && bodyClassOf(this.registry, item.id) === this.filter;
  }

  // id に対応する RowNode を(無ければ生成して)最新化し、続けてその子を再帰的に同期する。
  // id が今フレームの候補に無ければ何もしない。reorder は呼び出し元の区画の並びがこのフレームで
  // 組み直されたか — 真なら既存行も並び順どおりの位置へ移す。
  private syncRow(
    rows: Map<string, RowNode>, id: string,
    childrenOf: ReadonlyMap<string, string[]>, focusId: string | undefined, container: HTMLElement,
    focusAncestors: ReadonlySet<string>, matchAncestors: ReadonlySet<string>, reorder: boolean,
  ): void {
    const item = this.itemsByIdScratch.get(id);
    if (!item) return;
    let node = rows.get(item.id);
    const isNew = !node;
    if (!node) {
      node = this.createRowNode(item.id);
      rows.set(item.id, node);
    }
    if (isNew || reorder) {
      container.appendChild(node.row);
      container.appendChild(node.childrenContainer);
    }
    const svgGlyph = OBJECT_GLYPH_SVGS[item.kind];
    if (svgGlyph !== undefined) {
      if (node.glyph.dataset.svgGlyph !== svgGlyph) {
        node.glyph.innerHTML = svgGlyph;
        node.glyph.dataset.svgGlyph = svgGlyph;
      }
    } else {
      const glyph = item.kind === 'body' ? this.bodyGlyph(item.id) : OBJECT_GLYPHS[item.kind];
      if (node.glyph.textContent !== glyph) {
        node.glyph.textContent = glyph;
        delete node.glyph.dataset.svgGlyph;
      }
    }
    if (node.label.textContent !== item.name) node.label.textContent = item.name;
    const detailText = item.kind === 'body' ? '' : (item.detail ?? '');
    if (node.detail.textContent !== detailText) node.detail.textContent = detailText;
    node.detail.classList.toggle('hidden', item.kind === 'body');
    node.row.classList.toggle('tgt', item.id === focusId);
    node.row.classList.toggle('related-orbit', item.id === focusId);
    // 衛星フィルタで添えたクラスタ見出し(親惑星自身はフィルタを通っていない)を淡色化する。
    node.row.classList.toggle('cluster', !this.matches(item));
    node.row.setAttribute('aria-label', [item.name, detailText].filter(Boolean).join('、'));

    const children = childrenOf.get(item.id) ?? EMPTY_IDS;
    if (focusAncestors.has(item.id)) node.expanded = true;
    if (matchAncestors.has(item.id)) {
      if (node.savedExpanded === null) node.savedExpanded = node.expanded;
      node.expanded = true;
    }
    node.toggle.style.visibility = children.length > 0 ? 'visible' : 'hidden';
    this.applyRowExpanded(node);

    const seen = new Set<string>();
    for (const childId of children) {
      seen.add(childId);
      this.syncRow(node.children, childId, childrenOf, focusId, node.childrenContainer, focusAncestors, matchAncestors, reorder);
    }
    this.pruneRows(node.children, seen);
  }

  private pruneRows(rows: Map<string, RowNode>, seen: ReadonlySet<string>): void {
    for (const [id, node] of rows) {
      if (seen.has(id)) continue;
      node.row.remove();
      node.childrenContainer.remove();
      rows.delete(id);
    }
  }

  // 行 + トグルボタン + 子コンテナを1組生成する。子を持つかどうかはフレームごとに
  // 変わりうるので、トグルボタンと子コンテナは常に作っておき可視性だけ切り替える。
  // 既定は畳んだ状態 — 衛星・ラグランジュ点は候補数が多く、常に見る必要は薄いため。
  private createRowNode(id: string): RowNode {
    const row = document.createElement('div');
    row.className = 'erow';
    const toggle = document.createElement('span');
    toggle.className = 'physical-object-list-toggle';
    const glyph = document.createElement('span');
    glyph.className = 'physical-object-list-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'physical-object-list-name';
    const detail = document.createElement('small');
    detail.className = 'physical-object-list-detail';
    row.appendChild(toggle);
    row.appendChild(glyph);
    row.appendChild(label);
    row.appendChild(detail);
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'physical-object-list-children';

    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-keyshortcuts', 'F T');
    row.title = 'ダブルクリック / F: フォーカス · T: ナビ対象';
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.onFocus?.(id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); this.onFocus?.(id); }
      if (e.key.toLowerCase() === 't') { e.preventDefault(); this.onNavTarget?.(id); }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onSelectRight?.(id, e.clientX, e.clientY);
    });

    const node: RowNode = {
      row,
      toggle,
      glyph,
      label,
      detail,
      childrenContainer,
      children: new Map(),
      expanded: false,
      savedExpanded: null,
    };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      this.applyRowExpanded(node);
    });
    return node;
  }

  private applyRowExpanded(node: RowNode): void {
    node.toggle.textContent = node.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH;
    node.childrenContainer.classList.toggle('collapsed', !node.expanded);
  }

  private applyExpanded(section: Section): void {
    section.body.classList.toggle('collapsed', !section.expanded);
    section.header.setAttribute('aria-expanded', String(section.expanded));
  }
}
