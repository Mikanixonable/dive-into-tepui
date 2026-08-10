import { hudDock } from './hud/dom';
import { MapPickable, MapPickKind } from './map-pick';

const SECTIONS: readonly { kind: MapPickKind; label: string }[] = [
  { kind: 'body', label: '天体' },
  { kind: 'player', label: '自艦' },
  { kind: 'ship', label: '敵' },
  { kind: 'ammo', label: '弾薬' },
  { kind: 'base', label: '基地' },
];

interface Section {
  readonly header: HTMLElement;
  readonly body: HTMLElement;
  readonly rows: Map<string, RowNode>;
  expanded: boolean;
}

// 1件ぶんの行 + その子を畳めるトグル区画。子を持たない行(自艦/敵/弾薬/基地、および
// 子のない天体)でも toggle/childrenContainer 自体は生成しておき、可視性だけ切り替える
// (子の有無はフレームごとに変わりうるため、生成を後から差し込むより組み替えが少ない)。
interface RowNode {
  readonly row: HTMLElement;
  readonly toggle: HTMLElement;
  readonly label: HTMLElement;
  readonly detail: HTMLElement;
  readonly actions: HTMLElement;
  readonly childrenContainer: HTMLElement;
  readonly children: Map<string, RowNode>;
  expanded: boolean;
}

// parentOf の親子関係から、items を「直下の子」id 別に束ねる。
function childrenOfMap(items: readonly MapPickable[], parentOf: ReadonlyMap<string, string>): Map<string, MapPickable[]> {
  const map = new Map<string, MapPickable[]>();
  for (const item of items) {
    const parent = parentOf.get(item.id);
    if (parent === undefined) continue;
    const list = map.get(parent);
    if (list) list.push(item); else map.set(parent, [item]);
  }
  return map;
}

// マップビュー右部に常設の軌道オブジェクト一覧ウィンドウ。種別ごとの区画にタブ見出しで
// 開閉し、行クリックで onSelect に id を渡す。天体区画は衛星・ラグランジュ点を親の下の
// トグル子メニューへ格納する(衛星自身のラグランジュ点はさらにその衛星の子メニューへ)。
export class ObjectListPanel {
  onSelect: ((id: string) => void) | null = null;
  onFocus: ((id: string) => void) | null = null;
  onNavTarget: ((id: string) => void) | null = null;
  onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly sections = new Map<MapPickKind, Section>();
  private selectedId: string | null = null;
  private query = '';
  private filter: 'all' | 'near' | 'important' | 'bodies' = 'all';
  private readonly breadcrumb: HTMLElement;

  constructor(root: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.id = 'hud-object-list';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());

    const title = document.createElement('h3');
    title.textContent = '軌道オブジェクト';
    this.panel.appendChild(title);
    const tools = document.createElement('div');
    tools.className = 'object-list-tools';
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '検索'; search.setAttribute('aria-label', '軌道オブジェクトを検索');
    search.addEventListener('input', () => { this.query = search.value.trim().toLocaleLowerCase(); });
    tools.appendChild(search);
    for (const [key, label] of [['all', '全て'], ['near', '近く'], ['important', '重要'], ['bodies', '天体']] as const) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', key === 'all' ? 'true' : 'false');
      b.addEventListener('click', () => { this.filter = key; for (const x of Array.from(tools.querySelectorAll('button'))) x.setAttribute('aria-pressed', String(x === b)); });
      tools.appendChild(b);
    }
    this.panel.appendChild(tools);
    this.breadcrumb = document.createElement('div');
    this.breadcrumb.className = 'object-list-breadcrumb';
    this.panel.appendChild(this.breadcrumb);

    for (const { kind } of SECTIONS) {
      const header = document.createElement('div');
      header.className = 'dock-tab-btn object-list-section-header';
      const body = document.createElement('div');
      body.className = 'object-list-section-body';
      const section: Section = { header, body, rows: new Map(), expanded: true };
      header.addEventListener('click', () => {
        section.expanded = !section.expanded;
        this.applyExpanded(section);
      });
      this.sections.set(kind, section);
      this.panel.appendChild(header);
      this.panel.appendChild(body);
      this.applyExpanded(section);
    }

    hudDock(root, 'right').appendChild(this.panel);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  select(id: string | null): void { this.selectedId = id; }

  // 種別ごとの区画へ、既存行は使い回しつつ id 差分だけ足し引きする。行のクリックリスナーは
  // 生成時の1回だけ張るので、ここで毎フレーム innerHTML を書き換えてはいけない
  // (張り直しになり、クリック中に要素が消えてイベントが発火しなくなる)。
  // parentOf は id → 親 id(天体の親子関係のみ、他種別は載らない)。focusId が undefined
  // (フォーカス中の天体が無い)なら、どの行も強調しない。
  sync(items: readonly MapPickable[], focusId: string | undefined, parentOf: ReadonlyMap<string, string>): void {
    this.breadcrumb.textContent = focusId === undefined ? 'フォーカス: なし' : `フォーカス: ${items.find((i) => i.id === focusId)?.name ?? focusId}`;
    const byKind = new Map<MapPickKind, MapPickable[]>();
    for (const item of items) {
      if (!this.matches(item)) continue;
      const list = byKind.get(item.kind);
      if (list) list.push(item); else byKind.set(item.kind, [item]);
    }

    for (const { kind, label } of SECTIONS) {
      const section = this.sections.get(kind)!;
      const list = (byKind.get(kind) ?? []).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.name.localeCompare(b.name));
      section.header.style.display = list.length === 0 ? 'none' : '';
      section.header.textContent = `${label} (${list.length}) ${section.expanded ? '▾' : '▸'}`;

      const childrenOf = childrenOfMap(list, parentOf);
      const idsInSection = new Set(list.map((i) => i.id));
      // 親が今フレーム同じ区画に見当たらない(遮蔽等で一時的に消えた等)行は根として扱う —
      // 親が現れないせいで子ごと画面から消えてしまうより、ひとまず出す方に倒す。
      const roots = list.filter((i) => {
        const parent = parentOf.get(i.id);
        return parent === undefined || !idsInSection.has(parent);
      });
      // 現在フォーカス中の天体へ至る枝は自動展開し、別系は初期状態の畳みを保つ。
      const focusAncestors = new Set<string>();
      for (let cur = focusId; cur !== undefined; cur = parentOf.get(cur)) focusAncestors.add(cur);

      const seen = new Set<string>();
      for (const item of roots) {
        seen.add(item.id);
        this.syncRow(section.rows, item, childrenOf, focusId, section.body, focusAncestors);
      }
      this.pruneRows(section.rows, seen);
    }
  }

  private matches(item: MapPickable): boolean {
    if (this.query && !`${item.name} ${item.detail ?? ''}`.toLocaleLowerCase().includes(this.query)) return false;
    if (this.filter === 'bodies') return item.kind === 'body';
    if (this.filter === 'important') return /接近|回収可能|ドック/.test(item.detail ?? '');
    // priority は MapPicker が距離[m]として提供する。未指定(天体等)は残す。
    if (this.filter === 'near') return item.priority === undefined || item.priority < 1e6;
    return true;
  }

  // id に対応する RowNode を(無ければ生成して)最新化し、続けてその子を再帰的に同期する。
  private syncRow(
    rows: Map<string, RowNode>, item: MapPickable,
    childrenOf: ReadonlyMap<string, MapPickable[]>, focusId: string | undefined, container: HTMLElement, focusAncestors: ReadonlySet<string>,
  ): void {
    let node = rows.get(item.id);
    if (!node) {
      node = this.createRowNode(item.id);
      rows.set(item.id, node);
      container.appendChild(node.row);
      container.appendChild(node.childrenContainer);
    }
    if (node.label.textContent !== item.name) node.label.textContent = item.name;
    if (node.detail.textContent !== (item.detail ?? '')) node.detail.textContent = item.detail ?? '';
    node.row.classList.toggle('tgt', item.id === focusId);
    node.row.classList.toggle('selected', item.id === this.selectedId);

    const children = childrenOf.get(item.id) ?? [];
    if (focusAncestors.has(item.id)) node.expanded = true;
    node.toggle.style.visibility = children.length > 0 ? 'visible' : 'hidden';
    this.applyRowExpanded(node);

    const seen = new Set<string>();
    for (const child of children) {
      seen.add(child.id);
      this.syncRow(node.children, child, childrenOf, focusId, node.childrenContainer, focusAncestors);
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
    toggle.className = 'object-list-toggle';
    const label = document.createElement('span');
    label.className = 'object-list-name';
    const detail = document.createElement('small');
    detail.className = 'object-list-detail';
    row.appendChild(toggle);
    row.appendChild(label);
    row.appendChild(detail);
    const actions = document.createElement('span'); actions.className = 'object-list-actions';
    const action = (text: string, title: string, fn: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); actions.appendChild(b); };
    action('F', 'フォーカス (Enter / ダブルクリック)', () => this.onFocus?.(id));
    action('T', '航法ターゲット (T)', () => this.onNavTarget?.(id));
    action('…', '詳細 (右クリック)', () => this.onSelectRight?.(id, row.getBoundingClientRect().right, row.getBoundingClientRect().bottom));
    row.appendChild(actions);
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'object-list-children';

    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.addEventListener('click', () => this.onSelect?.(id));
    row.addEventListener('dblclick', () => this.onFocus?.(id));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.onFocus?.(id); }
      if (e.key.toLowerCase() === 't' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); this.onNavTarget?.(id); }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onSelectRight?.(id, e.clientX, e.clientY);
    });

    const node: RowNode = { row, toggle, label, detail, actions, childrenContainer, children: new Map(), expanded: false };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      this.applyRowExpanded(node);
    });
    return node;
  }

  private applyRowExpanded(node: RowNode): void {
    node.toggle.textContent = node.expanded ? '▾' : '▸';
    node.childrenContainer.style.display = node.expanded ? '' : 'none';
  }

  private applyExpanded(section: Section): void {
    section.body.style.display = section.expanded ? '' : 'none';
    section.header.classList.toggle('active', section.expanded);
  }
}
