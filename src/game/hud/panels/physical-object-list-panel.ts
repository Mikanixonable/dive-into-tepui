// マップビュー右部に常設の軌道物体一覧ウィンドウ。種別ごとの区画に見出しで開閉し、
// ダブルクリックでフォーカスを移動する。天体区画は衛星・ラグランジュ点を親の下のトグル子
// メニューへ格納する(衛星自身のラグランジュ点はさらにその衛星の子メニューへ)。
import { hudRail } from '../hud-root';
import {
  Button, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, Pulldown, SegmentedControl, type PulldownColumn,
} from '../../../hud/widgets';
import { bindActivation, expandHitTarget, stopDragPropagation } from '../../../hud/widgets/widget-base';
import { createKeyCap } from '../../../hud/key-cap';
import { injectOnce } from '../../../hud/inject-style';
import { PanelShell, type PanelCollapse } from '../panel-shell';
import { MQ_COARSE } from '../../../hud/breakpoints';
import { PhysicalObjectListRowTree } from './physical-object-list-row-tree';
import { FILTERS, PhysicalObjectListOrder, SORTS } from './physical-object-list-order';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { RowNode } from './physical-object-list-row-tree';
import type { PhysicalObjectListFilter, PhysicalObjectListSort, SectionOrder } from './physical-object-list-order';
import type { MapListSection } from '../../pickable/pickable-listing';
import type { ListedObject } from '../../pickable/listed-object';
import type { OrbitingObject } from '../../dynamic/dynamic-entity/orbiting-object';

const SECTIONS: readonly { section: MapListSection; label: string }[] = [
  { section: 'body', label: '天体' },
  { section: 'player', label: '自艦' },
  { section: 'enemy', label: '敵' },
  { section: 'ammo', label: '弾薬' },
  { section: 'fuel', label: 'RCS燃料' },
  { section: 'base', label: '基地' },
];

interface Section {
  readonly header: HTMLElement;
  readonly labelEl: HTMLElement;
  readonly glyphEl: HTMLElement;
  readonly countEl: HTMLElement;
  readonly summaryEl: HTMLElement;
  readonly body: HTMLElement;
  // この区画の全行の台帳(id → 行)。木のどこに居るかに依らず1件1エントリで、絞り込みで
  // 木の形が変わっても作り直さない — 作り直すとプレイヤーが開いた枝が毎回失われる。
  readonly rows: Map<string, RowNode>;
  readonly order: SectionOrder;
  expanded: boolean;
  // 絞り込みが一致行を見せるために強制的に開いた場合の、直前のプレイヤー操作による
  // 畳み状態。null は「絞り込みによる強制展開はしていない」。絞り込み解除時にここへ戻す。
  savedExpanded: boolean | null;
}

// 区画見出しに添える内訳の見出し語。集計対象であるかは候補自身(listCounted)が判定する。
const HEADER_SUMMARY: Partial<Record<MapListSection, string>> = {
  enemy: '接近', ammo: '回収可', fuel: '回収可',
};

// 分類のプルダウン。先頭の「すべて」を選ぶと絞り込みを解除する。
const FILTER_COLUMNS: readonly [PulldownColumn<PhysicalObjectListFilter | null>] = [{
  description: '分類',
  items: [[null, '分類: すべて'], ...FILTERS],
}];

const STYLE = `
/* パネルはレールの残り高さまで縮み、操作部と見出しは固定のまま木だけがスクロールする。 */
#hud .hud-rail > #hud-physical-object-list {
  display: flex; flex-direction: column; flex: 0 1 auto; min-height: calc(var(--row-min-h-s) * 6); overflow: hidden;
  max-height: calc(100vh - var(--hud-chrome-h) - var(--hud-map-scale-bottom) - var(--hud-map-scale-h) - var(--space-4));
  max-height: calc(100dvh - var(--hud-chrome-h) - var(--hud-map-scale-bottom) - var(--hud-map-scale-h) - var(--space-4));
}
#hud-physical-object-list > .panel-shell-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
#hud-physical-object-list .physical-object-list-tools { display: flex; align-items: center; gap: var(--space-3); }
#hud-physical-object-list .physical-object-list-tools .w-input { flex: 1 1 auto; min-width: 0; }
#hud-physical-object-list .physical-object-list-tools .w-group { flex: 0 0 auto; margin: 0; }
#hud-physical-object-list .physical-object-list-tools .w-select { width: 9em; }
#hud-physical-object-list .physical-object-list-sort { margin-top: var(--space-3); }
#hud-physical-object-list .physical-object-list-sort .w-group { gap: var(--space-3); margin: 0; }
#hud-physical-object-list .physical-object-list-sort .w-group-title {
  min-width: 0; margin-right: var(--space-2); color: var(--role-meta); font-size: var(--font-xxs);
}
#hud-physical-object-list .physical-object-list-sort .w-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
#hud-physical-object-list .physical-object-list-list {
  font-size: var(--font-xs); line-height: 1.35; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin-inline: calc(-1 * var(--space-2)); padding-inline: var(--space-2);
}
#hud-physical-object-list .physical-object-list-list.collapsed { display: none !important; }
#hud-physical-object-list .physical-object-list-breadcrumb {
  display: flex; align-items: baseline; gap: var(--space-3); margin-top: var(--space-3); padding: 0 var(--space-2);
  color: var(--role-meta); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-physical-object-list .physical-object-list-breadcrumb > :last-child {
  color: var(--role-label); font-size: var(--font-xs); letter-spacing: 0;
}
/* 全展開して数百行をスクロールしても今どの区画かを見失わないよう、見出しを内側スクロール
   領域の先頭へ貼り付ける。 */
#hud-physical-object-list .physical-object-list-section-header {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: var(--space-4);
  min-height: var(--row-min-h-s); margin-top: var(--space-3); padding: 0 var(--space-2);
  border-radius: var(--radius-micro); background: var(--surface-opaque); cursor: pointer;
  color: var(--role-meta); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-physical-object-list .physical-object-list-section-header:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud-physical-object-list .physical-object-list-section-header-label {
  color: var(--text); font-size: var(--font-xs); letter-spacing: 0;
}
#hud-physical-object-list .physical-object-list-section-header-count { font-variant-numeric: tabular-nums; }
#hud-physical-object-list .physical-object-list-section-header-summary { margin-left: auto; }
#hud-physical-object-list .physical-object-list-section-header-tools {
  display: inline-flex; gap: var(--space-2); margin-left: auto;
}
#hud-physical-object-list .physical-object-list-section-header-summary + .physical-object-list-section-header-tools {
  margin-left: 0;
}
#hud-physical-object-list .physical-object-list-section-body.collapsed,
#hud-physical-object-list .physical-object-list-section-body.hidden { display: none !important; }
#hud-physical-object-list .physical-object-list-children.collapsed { display: none !important; }
/* 木の行: [開閉記号(深さぶん字下げ)] [記号] [名前] [区分]。 */
#hud-physical-object-list .erow { grid-template-columns: auto auto minmax(0, 1fr) auto; column-gap: var(--space-3); cursor: pointer; }
#hud-physical-object-list .erow:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
#hud-physical-object-list .erow.cluster { opacity: .55; }
#hud-physical-object-list .physical-object-list-toggle {
  box-sizing: content-box; width: calc(var(--space-6) * (var(--d, 0) + 1)); text-align: right;
  color: var(--role-meta); font-size: var(--font-xxs);
}
#hud-physical-object-list .physical-object-list-toggle.no-children { visibility: hidden; }
#hud-physical-object-list .erow.is-focus .physical-object-list-toggle { color: var(--role-own); }
#hud-physical-object-list .erow.is-tgt .physical-object-list-toggle { color: var(--role-target); }
#hud-physical-object-list .physical-object-list-glyph svg { display: block; width: 1em; height: 1em; margin: auto; }
#hud-physical-object-list .physical-object-list-empty { padding: var(--space-6); text-align: center; color: var(--role-label); }
#hud-physical-object-list .physical-object-list-help {
  padding: var(--space-3) var(--space-2); color: var(--role-meta); font-size: var(--font-xxs); line-height: 1.8;
}
#hud-physical-object-list .physical-object-list-help .ui-key { margin: 0 var(--space-1); }
@media ${MQ_COARSE} {
  /* 子を開閉する記号は天体行にしかない小さな記号だが、タッチでは他の行と同じ最小寸法を要る。 */
  #hud-physical-object-list .erow { min-height: var(--hit-target-min); }
  #hud-physical-object-list .physical-object-list-toggle { align-self: stretch; display: inline-flex; align-items: center; justify-content: flex-end; }
}
`;

export class PhysicalObjectListPanel {
  public onFocus: ((id: string) => void) | null = null;
  public onNavTarget: ((id: string) => void) | null = null;
  public onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly shell: PanelShell;
  private readonly list: HTMLElement;
  private readonly sections = new Map<MapListSection, Section>();
  private readonly order: PhysicalObjectListOrder;
  private readonly rowTree: PhysicalObjectListRowTree;
  private readonly filterControl: Pulldown<typeof FILTER_COLUMNS>;
  private lastFocusId: string | undefined = undefined;
  // sync() は毎フレーム呼ばれるが、これらは同期中だけ使う scratch であり、呼び出し元へ
  // 参照を渡さない。Map/Set/配列の器だけを保持して GC を抑える。
  private readonly namesScratch = new Map<string, string>();
  private readonly itemsByIdScratch = new Map<string, ListedObject>();
  private readonly crumbsScratch: string[] = [];
  private readonly focusAncestorsScratch = new Set<string>();
  private readonly matchAncestorsScratch = new Set<string>();
  private readonly seenScratch = new Set<string>();
  // 絞り込み条件(検索語・クラスフィルタ)の直前フレーム値。変化を検知した回だけ
  // 一致行の祖先を強制的に開く — 毎フレーム開き直すとプレイヤーの手動での畳み操作と競合する。
  private prevAutoExpandQuery = '';
  private prevAutoExpandFilter: PhysicalObjectListFilter | null = null;
  private wasFilteringActive = false;
  private readonly breadcrumbPath: HTMLElement;
  private readonly trackedCount: readonly HTMLElement[];
  private readonly emptyState: HTMLElement;

  // 検索・分類・並び順の操作部と、種別ごとの区画を組んで root の右レールへ置く。隠した状態で
  // 始まるので、出すかどうかは setVisible で決める。
  public constructor(root: HTMLElement, collapse: PanelCollapse, celestialBodies: CelestialBodies) {
    injectOnce('physical-object-list-panel', STYLE);
    this.order = new PhysicalObjectListOrder(celestialBodies);
    this.rowTree = new PhysicalObjectListRowTree(celestialBodies, this.order, this.itemsByIdScratch, {
      onFocus: (id) => this.onFocus?.(id),
      onNavTarget: (id) => this.onNavTarget?.(id),
      onSelectRight: (id, clientX, clientY) => this.onSelectRight?.(id, clientX, clientY),
    });
    this.shell = new PanelShell(hudRail(root, 'right'), collapse, 'hud-physical-object-list', 'OBJ', '軌道物体');
    this.shell.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.trackedCount = ['hud-physical-object-list-meta', 'hud-physical-object-list-summary']
      .map((id) => this.shell.el.querySelector<HTMLElement>(`[data-id="${id}"]`)!);
    const body = this.shell.body;

    // 操作部の1段目: 検索と分類。
    const tools = document.createElement('div');
    tools.className = 'physical-object-list-tools';
    // 絞り込み入力は打鍵ごとに一覧を再描画する必要があり、確定でしか通知しない ValueInput の
    // 契約に合わない唯一の例外(UI-DESIGN §3)。対話要素の共通の下地(ドラッグ伝播の抑止・
    // タッチでのタップ領域確保)だけは他の部品と同じ形で踏襲する。
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'w-input';
    search.placeholder = '検索';
    search.setAttribute('aria-label', '軌道物体を検索');
    stopDragPropagation(search);
    expandHitTarget(search);
    search.addEventListener('keydown', (e) => {
      // Input の window keydown 購読へ打鍵が漏れて機体操作と誤認されないよう止める。
      e.stopPropagation();
      if (e.key !== 'Escape') return;
      // Escape は「破棄」ではなく「絞り込み解除」に読めるので、確定済みの値へ戻すのではなく
      // 空にする(検索欄限定の挙動)。フォーカスは外さず、続けて打鍵できるようにする。
      e.preventDefault();
      search.value = '';
      this.order.query = '';
    });
    search.addEventListener('input', () => { this.order.query = search.value.trim().toLocaleLowerCase(); });
    this.filterControl = new Pulldown('', FILTER_COLUMNS, null, ([filter]) => { this.order.filter = filter; });
    tools.append(search, this.filterControl.element);
    body.appendChild(tools);

    // 2段目: 並び順。絞り込みと並べ替えは独立な操作であることを段でも分ける。
    const sortRow = document.createElement('div');
    sortRow.className = 'physical-object-list-sort';
    const sortControl = new SegmentedControl<PhysicalObjectListSort>('並び', SORTS, (key) => {
      this.order.sort = key;
      sortControl.setSelected(key);
    });
    sortControl.setSelected(this.order.sort);
    sortRow.appendChild(sortControl.element);
    body.appendChild(sortRow);

    // 木の本体。操作部と違って、ここだけがスクロールする。
    this.list = document.createElement('div');
    this.list.className = 'physical-object-list-list';
    body.appendChild(this.list);
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'physical-object-list-breadcrumb';
    const crumbCaption = document.createElement('span');
    crumbCaption.textContent = 'FOCUS';
    this.breadcrumbPath = document.createElement('span');
    breadcrumb.append(crumbCaption, this.breadcrumbPath);
    this.list.appendChild(breadcrumb);

    for (const { section: sectionKey } of SECTIONS) {
      const section = this.buildSection(collapse, sectionKey);
      this.sections.set(sectionKey, section);
      this.list.append(section.header, section.body);
      this.applyExpanded(section);
    }

    this.emptyState = document.createElement('div');
    this.emptyState.className = 'physical-object-list-empty hidden';
    this.emptyState.textContent = '該当する物体がありません';
    this.list.appendChild(this.emptyState);

    // 行の操作はホバーの説明文だけに置かず、常時表示の案内として一覧の末尾へ出す。
    this.list.appendChild(this.buildHelp());
    this.setVisible(false);
  }

  // 区画1つぶんの見出しと本体を組む。開閉状態はビューごとに引き継ぐ(未操作なら既定で開く)。
  private buildSection(collapse: PanelCollapse, sectionKey: MapListSection): Section {
    const sectionId = `hud-physical-object-list-section-${sectionKey}`;
    const header = document.createElement('div');
    header.className = 'physical-object-list-section-header ui-selectable';
    header.tabIndex = 0;
    header.setAttribute('role', 'button');
    header.setAttribute('aria-controls', sectionId);
    stopDragPropagation(header);
    expandHitTarget(header);
    const glyphEl = document.createElement('span');
    glyphEl.className = 'physical-object-list-section-header-glyph';
    glyphEl.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('b');
    labelEl.className = 'physical-object-list-section-header-label';
    const countEl = document.createElement('span');
    countEl.className = 'physical-object-list-section-header-count';
    const summaryEl = document.createElement('span');
    summaryEl.className = 'physical-object-list-section-header-summary';
    header.append(glyphEl, labelEl, countEl, summaryEl);

    const sectionBody = document.createElement('div');
    sectionBody.id = sectionId;
    sectionBody.className = 'physical-object-list-section-body';
    const section: Section = {
      header, labelEl, glyphEl, countEl, summaryEl, body: sectionBody, rows: new Map(),
      order: { ids: [], rootIds: [], childIds: new Map() } satisfies SectionOrder,
      expanded: !(collapse.collapsed(sectionId) ?? false), savedExpanded: null,
    };
    // クリック/Enter/Space 共通のユーザー操作による開閉。絞り込みによる一時的な自動展開
    // (savedExpanded 経由)はここを通らないため、ここでの保存は常にプレイヤーの意思を表す。
    bindActivation(header, () => {
      section.expanded = !section.expanded;
      this.applyExpanded(section);
      collapse.setCollapsed(sectionId, !section.expanded);
    });
    // 入れ子を持つのは天体区画だけなので、一括開閉も見出しの右へそこにだけ添える。
    if (sectionKey === 'body') header.appendChild(this.buildTreeControls(section));
    return section;
  }

  // 行の操作を、キーキャップを添えた1行の案内にする。
  private buildHelp(): HTMLElement {
    const help = document.createElement('div');
    help.className = 'physical-object-list-help';
    help.append(
      'ダブルクリック /', createKeyCap('F'), 'フォーカス · ', createKeyCap('T'), 'ターゲット · 右クリックでメニュー',
    );
    return help;
  }

  // パネルを出し入れする。
  public setVisible(visible: boolean): void {
    this.shell.setHidden(!visible);
  }

  // パネルを取り除き、折りたたみ状態変化の購読を解除する。
  public dispose(): void {
    this.shell.dispose();
  }

  // 種別ごとの区画へ、既存行は使い回しつつ id 差分だけ足し引きする。parentOf は id → 親 id
  // (天体の親子関係だけが載る)。focusId が undefined なら、どの行も強調しない。targetId はターゲットの
  // 色を帯びる行の id。
  public sync(
    items: readonly ListedObject[],
    focusId: string | undefined,
    targetId: string | null,
    parentOf: ReadonlyMap<string, string>,
    viewer: OrbitingObject | null,
    displayTime: number,
  ): void {
    const total = items.length.toLocaleString();
    for (const el of this.trackedCount) if (el.textContent !== total) el.textContent = total;
    // 本体が畳まれている間は完全に不可視なので、行ツリーの差分同期を止める。次に開いたときは
    // items/focusId の現在値から組み直されるため、この間の変化を取りこぼしても壊れない。
    if (this.shell.body.classList.contains('collapsed')) return;
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
    this.breadcrumbPath.textContent = crumbs.length ? crumbs.reverse().join(' › ') : 'なし';
    this.filterControl.setSelected(0, this.order.filter);
    const focusChanged = focusId !== this.lastFocusId;
    this.lastFocusId = focusId;
    const inputsChanged = this.order.refreshInputs(items, parentOf, viewer, displayTime, focusId);
    this.rowTree.setFrame(viewer, displayTime, targetId);

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
    for (const { section: sectionKey, label } of SECTIONS) {
      const section = this.sections.get(sectionKey)!;
      // 距離順では距離が動くだけで正しい並びが変わりうるので、保持している順序が
      // 今フレームの値でも整列条件を満たすかを確かめ、崩れた時だけ組み直す。
      const reordered = inputsChanged || !this.order.orderStillSorted(section.order.ids, this.itemsByIdScratch);
      if (reordered) this.order.rebuildOrder(sectionKey, section.order, items, parentOf, this.itemsByIdScratch);
      // 一致行を持つ区画自体が畳まれていれば、絞り込みの変化に合わせて開く。
      if (filteringActive && filterChanged && section.order.ids.length > 0 && !section.expanded) {
        if (section.savedExpanded === null) section.savedExpanded = section.expanded;
        section.expanded = true;
        this.applyExpanded(section);
      }
      this.syncHeader(section, sectionKey, label, viewer, displayTime);
      totalMatched += section.order.ids.length;

      // 行は区画ごとの平坦な台帳が持つ。根から辿って今フレーム現れた id を集め、最後に
      // 一度だけ剪定する — 木の形(誰が根か)が絞り込みで変わっても、行そのものは残る。
      // クリックリスナーは行の生成時に1回だけ張るので、一覧をまとめて組み直すとクリック中に
      // 要素が消えてイベントが発火しなくなる。
      const seen = this.seenScratch;
      seen.clear();
      for (const id of section.order.rootIds) {
        this.rowTree.syncRow(
          section.rows, id, section.order.childIds, focusId, section.body,
          focusAncestors, matchAncestors, reordered, seen, 0,
        );
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

  // 区画見出しへ件数と状況の内訳を書き出す。表示行が無い区画は、見出しと本体をまとめて隠す
  // (本体に常設要素があるので、見出しだけ消すと浮いて残る)。
  private syncHeader(
    section: Section, sectionKey: MapListSection, label: string, viewer: OrbitingObject | null,
    displayTime: number,
  ): void {
    const ids = section.order.ids;
    const hasItems = ids.length > 0;
    section.header.classList.toggle('hidden', !hasItems);
    section.body.classList.toggle('hidden', !hasItems);
    const summaryLabel = HEADER_SUMMARY[sectionKey];
    let summary = '';
    if (summaryLabel !== undefined) {
      let count = 0;
      for (const id of ids) if (this.itemsByIdScratch.get(id)?.listCounted(viewer, displayTime)) count++;
      summary = `${summaryLabel} ${count}`;
    }
    // 毎フレームの再代入はレイアウト再計算を招くので、変わったときだけ書く。
    if (section.labelEl.textContent !== label) section.labelEl.textContent = label;
    const countText = String(ids.length);
    if (section.countEl.textContent !== countText) section.countEl.textContent = countText;
    if (section.summaryEl.textContent !== summary) section.summaryEl.textContent = summary;
    const glyph = section.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH;
    if (section.glyphEl.textContent !== glyph) section.glyphEl.textContent = glyph;
  }

  // 天体区画の見出しに添える「全展開」「畳む」ボタンの組。
  private buildTreeControls(section: Section): HTMLElement {
    const controls = document.createElement('span');
    controls.className = 'physical-object-list-section-header-tools';
    const expandAll = new Button('全展開', () => this.rowTree.setAllRowsExpanded(section.rows, true), undefined, ['dense', 'secondary']);
    const collapseAll = new Button('畳む', () => this.rowTree.setAllRowsExpanded(section.rows, false), undefined, ['dense', 'secondary']);
    controls.appendChild(expandAll.element);
    controls.appendChild(collapseAll.element);
    return controls;
  }

  // 区画の開閉状態を、本体の表示と見出しの aria へ当てる。
  private applyExpanded(section: Section): void {
    section.body.classList.toggle('collapsed', !section.expanded);
    section.header.setAttribute('aria-expanded', String(section.expanded));
  }
}
