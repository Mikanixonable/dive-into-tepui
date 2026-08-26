import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  hudRail,
  type CollapseToggleLabels,
} from '../hud-root';
import { Button, SegmentedControl, ValueInput } from '../widgets';
import { injectOnce } from '../widgets/inject-style';
import { wirePanelCollapse } from '../panel-shell';
import { PhysicalObjectListTree } from './physical-object-list-tree';
import { FILTERS, PhysicalObjectListOrder, SORTS } from './physical-object-list-order';
import type { CelestialRegistry } from '../../../physics/solar-system';
import type { MapPickable, MapPickKind } from '../../map-pickable';
import type { RowNode } from './physical-object-list-tree';
import type { PhysicalObjectListFilter, PhysicalObjectListSort, SectionOrder } from './physical-object-list-order';

const SECTIONS: readonly { kind: MapPickKind; label: string }[] = [
  { kind: 'body', label: '天体' },
  { kind: 'player', label: '自艦' },
  { kind: 'ship', label: '敵' },
  { kind: 'ammo', label: '弾薬' },
  { kind: 'fuel', label: 'RCS燃料' },
  { kind: 'base', label: '基地' },
];

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
};

// このパネル自身の折りたたみトグルの見た目。
const COLLAPSE_LABELS: CollapseToggleLabels = {
  expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
  collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
  expandedTitle: '軌道物体一覧を閉じる',
  collapsedTitle: '軌道物体一覧を開く',
};

const STYLE = `
#hud-physical-object-list { max-height: 544px; max-height: min(544px, 60dvh); display: flex; flex-direction: column; overflow: hidden; }
/* 上半分(検索・フィルタ)は要素数ぶんの高さに縮め、下半分(項目一覧)が残りを占有する。互いに重ならないよう独立してスクロールさせる */
#hud-physical-object-list .physical-object-list-head { flex: 0 0 auto; max-height: 50%; overflow-y: auto; }
#hud-physical-object-list .physical-object-list-body { flex: 1 1 auto; overflow-y: auto; }
#hud-physical-object-list .physical-object-list-search { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-search .w-input { width: 100%; }
#hud-physical-object-list .physical-object-list-head .w-group { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-head .w-group-title { flex: 1 0 100%; }
#hud-physical-object-list .physical-object-list-head .w-btn { font-size: var(--font-xxs); }
#hud-physical-object-list .physical-object-list-collapse {
  margin-left: auto; background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud-physical-object-list .physical-object-list-title { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
#hud-physical-object-list .physical-object-list-body.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-breadcrumb { padding: var(--space-1) var(--space-3); font-size: var(--font-xxs); color:var(--text-dim); border-bottom:1px solid var(--edge); }
#hud-physical-object-list .physical-object-list-section-header {
  display: block; width: 100%; text-align: left; margin: var(--space-2) 0 var(--space-1);
  padding: var(--space-2) var(--space-4); font-size: var(--font-xs); letter-spacing: 1px;
}
#hud-physical-object-list .physical-object-list-section-body { padding-left: var(--space-2); }
#hud-physical-object-list .physical-object-list-section-body.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-tree-controls { display: flex; gap: var(--space-2); padding: 0 var(--space-4) var(--space-1); }
#hud-physical-object-list .erow { padding: var(--space-2) var(--space-2); color: var(--text-dim); cursor: pointer; display: flex; align-items: center; gap: var(--space-2); }
#hud-physical-object-list .physical-object-list-detail { margin-left: auto; font-size: var(--font-xxs); color: var(--text-dim); white-space: nowrap; }
#hud-physical-object-list .erow:hover { color: var(--text); }
#hud-physical-object-list .erow.tgt {
  color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
#hud-physical-object-list .erow.cluster { opacity: .55; }
#hud-physical-object-list .physical-object-list-toggle { width: 10px; text-align: center; flex: none; }
#hud-physical-object-list .physical-object-list-children { padding-left: var(--space-5); }
#hud-physical-object-list .physical-object-list-children.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-empty { padding: var(--space-6); text-align: center; color: var(--text-dim); }
`;

// マップビュー右部に常設の軌道物体一覧ウィンドウ。種別ごとの区画にタブ見出しで
// 開閉し、ダブルクリックでフォーカスを移動する。天体区画は衛星・ラグランジュ点を親の下の
// トグル子メニューへ格納する(衛星自身のラグランジュ点はさらにその衛星の子メニューへ)。
export class PhysicalObjectListPanel {
  public onFocus: ((id: string) => void) | null = null;
  public onNavTarget: ((id: string) => void) | null = null;
  public onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly sections = new Map<MapPickKind, Section>();
  private readonly order: PhysicalObjectListOrder;
  private readonly rowTree: PhysicalObjectListTree;
  private lastFocusId: string | undefined = undefined;
  // sync() は毎フレーム呼ばれるが、これらは同期中だけ使う scratch であり、呼び出し元へ
  // 参照を渡さない。Map/Set/配列の器だけを保持して GC を抑える。
  private readonly namesScratch = new Map<string, string>();
  private readonly itemsByIdScratch = new Map<string, MapPickable>();
  private readonly crumbsScratch: string[] = [];
  private readonly focusAncestorsScratch = new Set<string>();
  private readonly matchAncestorsScratch = new Set<string>();
  private readonly seenScratch = new Set<string>();
  // 絞り込み条件(検索語・クラスフィルタ)の直前フレーム値。変化を検知した回だけ
  // 一致行の祖先を強制的に開く — 毎フレーム開き直すとプレイヤーの手動での畳み操作と競合する。
  private prevAutoExpandQuery = '';
  private prevAutoExpandFilter: PhysicalObjectListFilter | null = null;
  private wasFilteringActive = false;
  private readonly breadcrumb: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  public constructor(root: HTMLElement, registry: CelestialRegistry) {
    injectOnce('physical-object-list-panel', STYLE);
    this.order = new PhysicalObjectListOrder(registry);
    this.rowTree = new PhysicalObjectListTree(registry, this.order, this.itemsByIdScratch, this);
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
    const updateQuery = (value: string) => { this.order.query = value.trim().toLocaleLowerCase(); };
    const search = new ValueInput(
      { type: 'search', placeholder: '検索', escapeBehavior: 'clear' },
      updateQuery,
      () => { this.order.query = ''; },
    );
    search.element.setAttribute('aria-label', '軌道物体を検索');
    // 確定を待たず、打鍵のたびに絞り込みへ反映する。
    search.element.addEventListener('input', () => updateQuery(search.element.value));
    searchWrap.appendChild(search.element);
    head.appendChild(searchWrap);

    const filterControl = new SegmentedControl<PhysicalObjectListFilter | null>('分類', FILTERS, (key) => {
      this.order.filter = this.order.filter === key ? null : key;
      filterControl.setSelected(this.order.filter);
    });
    filterControl.setSelected(this.order.filter);
    head.appendChild(filterControl.element);

    // 並び順はフィルタとは別行 — 絞り込みと並べ替えは独立な操作であることを見た目でも分ける。
    const sortControl = new SegmentedControl<PhysicalObjectListSort>('並び順', SORTS, (key) => {
      this.order.sort = key;
      sortControl.setSelected(key);
    });
    sortControl.setSelected(this.order.sort);
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
      // 入れ子を持つのは天体区画だけなので、一括開閉ボタンもここにだけ添える。
      if (kind === 'body') body.appendChild(this.buildTreeControls(section));
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
    const inputsChanged = this.order.refreshInputs(items, parentOf);

    // フォーカスが切り替わった瞬間だけ、そこへ至る枝を自動展開する対象として渡す
    // (毎フレーム渡すとユーザーが畳んだ直後に開き直ってしまう)。
    const focusAncestors = this.focusAncestorsScratch;
    focusAncestors.clear();
    if (focusChanged) for (let cur = focusId; cur !== undefined; cur = parentOf.get(cur)) focusAncestors.add(cur);

    // 検索語・クラスフィルタが変わった瞬間だけ、その回に一致した行の祖先を自動展開する
    // 対象として渡す(focusAncestors と同じ「変化した回だけ」の考え方)。絞り込みが解除された
    // 瞬間は逆に、その自動展開で開いた分だけをプレイヤーの元の畳み状態へ戻す。
    const filteringActive = this.order.filteringActive;
    const filterChanged = this.order.query !== this.prevAutoExpandQuery || this.order.filter !== this.prevAutoExpandFilter;
    this.prevAutoExpandQuery = this.order.query;
    this.prevAutoExpandFilter = this.order.filter;
    const filteringJustDeactivated = !filteringActive && this.wasFilteringActive;
    this.wasFilteringActive = filteringActive;

    const matchAncestors = this.matchAncestorsScratch;
    matchAncestors.clear();
    if (filteringActive && filterChanged) {
      for (const item of items) {
        if (!this.order.matches(item)) continue;
        for (let cur: string | undefined = item.id; cur !== undefined; cur = parentOf.get(cur)) matchAncestors.add(cur);
      }
    }
    if (filteringJustDeactivated) {
      for (const section of this.sections.values()) {
        if (section.savedExpanded !== null) { section.expanded = section.savedExpanded; section.savedExpanded = null; this.applyExpanded(section); }
        this.rowTree.restoreSavedExpanded(section.rows);
      }
    }

    let totalMatched = 0;
    for (const { kind, label } of SECTIONS) {
      const section = this.sections.get(kind)!;
      // 距離順では距離が動くだけで正しい並びが変わりうるので、保持している順序が
      // 今フレームの値でも整列条件を満たすかを確かめ、崩れた時だけ組み直す。
      const reordered = inputsChanged || !this.order.orderStillSorted(section.order.ids, this.itemsByIdScratch);
      if (reordered) this.order.rebuildOrder(kind, section.order, items, parentOf, this.itemsByIdScratch);
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
        this.rowTree.syncRow(section.rows, id, section.order.childIds, focusId, section.body, focusAncestors, matchAncestors, reordered);
      }
      this.rowTree.pruneRows(section.rows, seen);
    }
    this.emptyState.classList.toggle('hidden', !(filteringActive && totalMatched === 0));

    // 対象行の展開が全区画へ反映された後でないと、祖先が畳まれたままの位置へスクロール
    // してしまう。
    if (focusChanged && focusId !== undefined) this.findRowElement(focusId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // id に対応する行要素を全区画から再帰的に探す。見当たらなければ null。
  private findRowElement(id: string): HTMLElement | null {
    for (const section of this.sections.values()) {
      const found = this.rowTree.findRowElementIn(section.rows, id);
      if (found) return found;
    }
    return null;
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

  // 天体区画の見出しに添える「全展開」「全折りたたむ」ボタンの組。
  private buildTreeControls(section: Section): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'physical-object-list-tree-controls';
    const expandAll = new Button('全展開', () => this.rowTree.setAllRowsExpanded(section.rows, true));
    const collapseAll = new Button('全折りたたむ', () => this.rowTree.setAllRowsExpanded(section.rows, false));
    controls.appendChild(expandAll.element);
    controls.appendChild(collapseAll.element);
    return controls;
  }

  private applyExpanded(section: Section): void {
    section.body.classList.toggle('collapsed', !section.expanded);
    section.header.setAttribute('aria-expanded', String(section.expanded));
  }
}
