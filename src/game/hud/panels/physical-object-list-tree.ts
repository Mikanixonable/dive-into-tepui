// 軌道物体一覧パネルの行ツリー: 種別ごとの一覧行を、既存 DOM を使い回しながら id 差分だけで
// 同期・剪定する。見出し・検索欄・フィルタ UI の組み立てはパネル本体が持つ。
import { bodyClassOf } from '../../celestial/body-class';
import { bodyEntityGlyph, ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../../marker/marker-glyphs';
import { baseMarkerSvg, shipMarkerSvg } from '../../marker/marker-shapes';
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../hud-root';
import { LAGRANGE_ID } from '../object-groups';
import type { CelestialRegistry } from '../../../physics/solar-system';
import type { MapPickable, MapPickKind } from '../../map-pickable';
import type { PhysicalObjectListOrder } from './physical-object-list-order';

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

const EMPTY_IDS: readonly string[] = [];

// 行のダブルクリック/F/T/右クリックの通知先。呼び出し側が随時差し替えるため、生成時に
// コピーせずフィールドそのものを読む。
export interface RowTreeActions {
  onFocus: ((id: string) => void) | null;
  onNavTarget: ((id: string) => void) | null;
  onSelectRight: ((id: string, clientX: number, clientY: number) => void) | null;
}

// 1件ぶんの行 + その子を畳めるトグル区画。子を持たない行(自艦/敵/弾薬/基地、および
// 子のない天体)でも toggle/childrenContainer 自体は生成しておき、可視性だけ切り替える
// (子の有無はフレームごとに変わりうるため、生成を後から差し込むより組み替えが少ない)。
export interface RowNode {
  readonly row: HTMLElement;
  readonly toggle: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
  readonly detail: HTMLElement;
  readonly childrenContainer: HTMLElement;
  readonly children: Map<string, RowNode>;
  expanded: boolean;
  // 絞り込みが一致行を見せるために強制的に開いた場合の、直前のプレイヤー操作による
  // 畳み状態。null は「絞り込みによる強制展開はしていない」。絞り込み解除時にここへ戻す。
  savedExpanded: boolean | null;
  // syncRow が今フレーム生存確認済みの子 id を集めるスクラッチ。フレームごとに使い回す。
  readonly childSeenScratch: Set<string>;
}

// 軌道物体一覧の入れ子行ツリーを、既存 DOM を使い回しながら id 差分だけで同期・剪定する。
export class PhysicalObjectListTree {
  public constructor(
    private readonly registry: CelestialRegistry,
    private readonly order: PhysicalObjectListOrder,
    private readonly itemsById: ReadonlyMap<string, MapPickable>,
    private readonly actions: RowTreeActions,
  ) {}

  // 天体の字形。マップ実マーカーと同じ選び方(ラグランジュ点は専用字形、それ以外は
  // 恒星/衛星/その他で bodyEntityGlyph())をする。
  private bodyGlyph(id: string): string {
    return LAGRANGE_ID.test(id) ? ENTITY_GLYPH.lagrange : bodyEntityGlyph(bodyClassOf(this.registry, id));
  }

  // id に対応する RowNode を(無ければ生成して)最新化し、続けてその子を再帰的に同期する。
  // id が今フレームの候補に無ければ何もしない。reorder は呼び出し元の区画の並びがこのフレームで
  // 組み直されたか — 真なら既存行も並び順どおりの位置へ移す。
  public syncRow(
    rows: Map<string, RowNode>, id: string,
    childrenOf: ReadonlyMap<string, string[]>, focusId: string | undefined, container: HTMLElement,
    focusAncestors: ReadonlySet<string>, matchAncestors: ReadonlySet<string>, reorder: boolean,
  ): void {
    const item = this.itemsById.get(id);
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
    node.row.classList.toggle('cluster', !this.order.matches(item));
    node.row.setAttribute('aria-label', [item.name, detailText].filter(Boolean).join('、'));

    const children = childrenOf.get(item.id) ?? EMPTY_IDS;
    if (focusAncestors.has(item.id)) node.expanded = true;
    if (matchAncestors.has(item.id)) {
      if (node.savedExpanded === null) node.savedExpanded = node.expanded;
      node.expanded = true;
    }
    node.toggle.style.visibility = children.length > 0 ? 'visible' : 'hidden';
    this.applyRowExpanded(node);

    node.childSeenScratch.clear();
    for (const childId of children) {
      node.childSeenScratch.add(childId);
      this.syncRow(node.children, childId, childrenOf, focusId, node.childrenContainer, focusAncestors, matchAncestors, reorder);
    }
    this.pruneRows(node.children, node.childSeenScratch);
  }

  public pruneRows(rows: Map<string, RowNode>, seen: ReadonlySet<string>): void {
    for (const [id, node] of rows) {
      if (seen.has(id)) continue;
      node.row.remove();
      node.childrenContainer.remove();
      rows.delete(id);
    }
  }

  // id に対応する行要素を rows 以下から再帰的に探す。見当たらなければ null。
  public findRowElementIn(rows: ReadonlyMap<string, RowNode>, id: string): HTMLElement | null {
    const node = rows.get(id);
    if (node) return node.row;
    for (const child of rows.values()) {
      const found = this.findRowElementIn(child.children, id);
      if (found) return found;
    }
    return null;
  }

  // 絞り込みが強制的に開いた分の畳み状態を、記録してあるプレイヤーの元の値へ戻す。
  public restoreSavedExpanded(rows: ReadonlyMap<string, RowNode>): void {
    for (const node of rows.values()) {
      if (node.savedExpanded !== null) { node.expanded = node.savedExpanded; node.savedExpanded = null; }
      this.restoreSavedExpanded(node.children);
    }
  }

  // rows 以下の全ての入れ子を一括で展開/折りたたむ。手動での開閉と同じ状態として
  // 扱うので savedExpanded には触れない。
  public setAllRowsExpanded(rows: ReadonlyMap<string, RowNode>, expanded: boolean): void {
    for (const node of rows.values()) {
      node.expanded = expanded;
      this.applyRowExpanded(node);
      this.setAllRowsExpanded(node.children, expanded);
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
      this.actions.onFocus?.(id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); this.actions.onFocus?.(id); }
      if (e.key.toLowerCase() === 't') { e.preventDefault(); this.actions.onNavTarget?.(id); }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.actions.onSelectRight?.(id, e.clientX, e.clientY);
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
      childSeenScratch: new Set(),
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
}
