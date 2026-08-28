// 軌道物体一覧パネルの行ツリー: 種別ごとの一覧行を、既存 DOM を使い回しながら id 差分だけで
// 同期・剪定する。見出し・検索欄・フィルタ UI の組み立てはパネル本体が持つ。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH } from '../hud-root';
import { pickGlyphSvg, pickGlyphText } from '../../marker/pick-glyphs';
import type { CelestialSystem } from '../../celestial/celestial-system';
import type { MapPickable } from '../../pickable/map-pickable';
import type { PhysicalObjectListOrder } from './physical-object-list-order';

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
// 子への参照は持たない — 行は区画ごとの平坦な台帳(id → RowNode)が所有し、木の形は
// 毎フレーム渡される childIds が決める。木の形が変わっても行そのものは作り直さない。
export interface RowNode {
  readonly row: HTMLElement;
  readonly toggle: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
  readonly detail: HTMLElement;
  readonly childrenContainer: HTMLElement;
  expanded: boolean;
  // 子を持つか。開閉トグルを出すかと aria-expanded を付けるかの正本で、毎フレーム更新する
  // (DOM の見た目から読み取らない)。
  hasChildren: boolean;
  // 絞り込みが一致行を見せるために強制的に開いた場合の、直前のプレイヤー操作による
  // 畳み状態。null は「絞り込みによる強制展開はしていない」。絞り込み解除時にここへ戻す。
  savedExpanded: boolean | null;
}

// 軌道物体一覧の入れ子行ツリーを、既存 DOM を使い回しながら id 差分だけで同期・剪定する。
export class PhysicalObjectListTree {
  public constructor(
    private readonly celestialSystem: CelestialSystem,
    private readonly order: PhysicalObjectListOrder,
    private readonly itemsById: ReadonlyMap<string, MapPickable>,
    private readonly actions: RowTreeActions,
  ) {}

  // id に対応する RowNode を(無ければ生成して)最新化し、続けてその子を再帰的に同期する。
  // rows はその区画の全行を持つ平坦な台帳で、木の形が変わっても行は作り直さず DOM を付け替える
  // だけにする — 作り直すとプレイヤーが開いた枝と savedExpanded が毎回失われる。
  // id が今フレームの候補に無ければ何もしない。今フレーム生存していた id は seen へ積み、
  // 呼び出し元が区画ごとに一度だけ pruneRows() へ渡す。reorder は呼び出し元の区画の並びが
  // このフレームで組み直されたか — 真なら既存行も並び順どおりの位置へ移す。
  public syncRow(
    rows: Map<string, RowNode>, id: string,
    childrenOf: ReadonlyMap<string, string[]>, focusId: string | undefined, container: HTMLElement,
    focusAncestors: ReadonlySet<string>, matchAncestors: ReadonlySet<string>, reorder: boolean,
    seen: Set<string>,
  ): void {
    const item = this.itemsById.get(id);
    if (!item) return;
    let node = rows.get(item.id);
    if (!node) {
      node = this.createRowNode(item.id);
      rows.set(item.id, node);
    }
    seen.add(item.id);
    // 動かす必要が無いフレームでは DOM に触らない — appendChild は既存要素でも移動になるので、
    // 毎フレーム呼ぶとクリックの最中に行が動き、dblclick が成立しなくなる。
    if (node.row.parentElement !== container || reorder) {
      container.appendChild(node.row);
      container.appendChild(node.childrenContainer);
    }
    const svgGlyph = pickGlyphSvg(item.kind);
    if (svgGlyph !== null) {
      if (node.glyph.dataset.svgGlyph !== svgGlyph) {
        node.glyph.innerHTML = svgGlyph;
        node.glyph.dataset.svgGlyph = svgGlyph;
      }
    } else {
      const glyph = pickGlyphText(item.kind, item.id, this.celestialSystem);
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
    // 衛星フィルタで添えたクラスタ見出し(親惑星自身はフィルタを通っていない)を淡色化する。
    node.row.classList.toggle('cluster', !this.order.matches(item));
    node.row.setAttribute('aria-label', [item.name, detailText].filter(Boolean).join('、'));

    const children = childrenOf.get(item.id) ?? EMPTY_IDS;
    if (focusAncestors.has(item.id)) node.expanded = true;
    if (matchAncestors.has(item.id)) {
      if (node.savedExpanded === null) node.savedExpanded = node.expanded;
      node.expanded = true;
    }
    node.hasChildren = children.length > 0;
    this.applyRowExpanded(node);

    for (const childId of children) {
      this.syncRow(rows, childId, childrenOf, focusId, node.childrenContainer, focusAncestors, matchAncestors, reorder, seen);
    }
  }

  // 今フレーム現れなかった行を台帳と DOM から取り除く。区画ごとに、根から辿り終えた後で
  // 一度だけ呼ぶ。
  public pruneRows(rows: Map<string, RowNode>, seen: ReadonlySet<string>): void {
    for (const [id, node] of rows) {
      if (seen.has(id)) continue;
      node.row.remove();
      node.childrenContainer.remove();
      rows.delete(id);
    }
  }

  // id に対応する行要素を台帳から引く。見当たらなければ null。
  public findRowElementIn(rows: ReadonlyMap<string, RowNode>, id: string): HTMLElement | null {
    return rows.get(id)?.row ?? null;
  }

  // 絞り込みが強制的に開いた分の畳み状態を、記録してあるプレイヤーの元の値へ戻す。DOM への
  // 反映は、この後の syncRow() が applyRowExpanded() を通して行う。
  public restoreSavedExpanded(rows: ReadonlyMap<string, RowNode>): void {
    for (const node of rows.values()) {
      if (node.savedExpanded === null) continue;
      node.expanded = node.savedExpanded;
      node.savedExpanded = null;
    }
  }

  // 区画の全ての入れ子を一括で展開/折りたたむ。手動での開閉と同じ状態として扱うので
  // savedExpanded には触れない。
  public setAllRowsExpanded(rows: ReadonlyMap<string, RowNode>, expanded: boolean): void {
    for (const node of rows.values()) {
      node.expanded = expanded;
      this.applyRowExpanded(node);
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
      // ゲーム側は window の keydown を全打鍵について走査するので、行にフォーカスがある間の
      // 打鍵は先に消費してゲーム操作へ流れないようにする。ただし修飾キー付きとIME確定中は
      // ブラウザ/IME 自身の処理(Cmd+F の検索など)に譲る。
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (key === 'f') { e.preventDefault(); this.actions.onFocus?.(id); return; }
      if (key === 't') { e.preventDefault(); this.actions.onNavTarget?.(id); return; }
      if ((e.key === 'Enter' || e.key === ' ') && node.hasChildren) {
        e.preventDefault();
        node.expanded = !node.expanded;
        this.applyRowExpanded(node);
      }
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
      expanded: false,
      hasChildren: false,
      savedExpanded: null,
    };
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      this.applyRowExpanded(node);
    });
    return node;
  }

  // node.expanded を、トグル記号・子コンテナの表示・行の aria-expanded へ反映する。
  private applyRowExpanded(node: RowNode): void {
    node.toggle.textContent = node.expanded ? COLLAPSE_EXPANDED_GLYPH : COLLAPSE_COLLAPSED_GLYPH;
    node.childrenContainer.classList.toggle('collapsed', !node.expanded);
    node.toggle.classList.toggle('no-children', !node.hasChildren);
    // 子を持たない行にまで aria-expanded を付けると、本来無い開閉可能性を支援技術へ示唆する。
    if (node.hasChildren) node.row.setAttribute('aria-expanded', String(node.expanded));
    else node.row.removeAttribute('aria-expanded');
  }
}
