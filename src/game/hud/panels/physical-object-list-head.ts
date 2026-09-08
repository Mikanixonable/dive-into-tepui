// 軌道物体一覧の検索・分類・並び順とタイトル行を組み立てる。
// 検索条件と並び順は PhysicalObjectListOrder へ反映し、一覧本体とは独立して操作できる。
import { SegmentedControl } from '../../../hud/widgets';
import { expandHitTarget, stopDragPropagation } from '../../../hud/widgets/widget-base';
import { injectOnce } from '../../../hud/widgets/inject-style';
import { FILTERS, SORTS } from './physical-object-list-order';
import type {
  PhysicalObjectListFilter,
  PhysicalObjectListOrder,
  PhysicalObjectListSort,
} from './physical-object-list-order';

const HEAD_STYLE = `
#hud-physical-object-list .physical-object-list-head { flex: 0 0 auto; max-height: 50%; overflow-y: auto; overscroll-behavior: contain; }
#hud-physical-object-list .physical-object-list-search { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-search .w-input { width: 100%; }
#hud-physical-object-list .physical-object-list-head .w-group { padding: var(--space-1) var(--space-2); }
#hud-physical-object-list .physical-object-list-head .w-group-title { flex: 1 0 100%; }
#hud-physical-object-list .physical-object-list-head .w-btn { font-size: var(--font-xxs); }
#hud-physical-object-list .physical-object-list-title { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
`;

// 軌道物体一覧のタイトル・検索欄・分類・並び順を組み立てる。
export class PhysicalObjectListHead {
  // パネルへ追加する見出し全体。
  public readonly element: HTMLElement;
  // パネル全体の開閉トグルを追加するタイトル行。
  public readonly collapseToggleRoot: HTMLElement;
  // パネル全体の開閉を受け付けるタイトル見出し。
  public readonly collapseToggleLabel: HTMLElement;

  // 見出しを組み立て、検索・分類・並び順の操作を order へ接続する。
  public constructor(order: PhysicalObjectListOrder) {
    injectOnce('physical-object-list-head', HEAD_STYLE);

    this.element = document.createElement('div');
    this.element.className = 'physical-object-list-head';

    const titleRow = document.createElement('div');
    titleRow.className = 'physical-object-list-title';
    const title = document.createElement('h3');
    title.textContent = '軌道物体';
    titleRow.appendChild(title);
    this.element.appendChild(titleRow);
    this.collapseToggleRoot = titleRow;
    this.collapseToggleLabel = title;

    const searchWrap = document.createElement('div');
    searchWrap.className = 'physical-object-list-search';
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
    search.addEventListener('keydown', (event) => {
      // Input の window keydown 購読へ打鍵が漏れて機体操作と誤認されないよう止める。
      event.stopPropagation();
      if (event.key !== 'Escape') return;
      // Escape は「破棄」ではなく「絞り込み解除」に読めるので、確定済みの値へ戻すのではなく
      // 空にする(検索欄限定の挙動)。フォーカスは外さず、続けて打鍵できるようにする。
      event.preventDefault();
      search.value = '';
      order.query = '';
    });
    search.addEventListener('input', () => { order.query = search.value.trim().toLocaleLowerCase(); });
    searchWrap.appendChild(search);
    this.element.appendChild(searchWrap);

    const filterControl = new SegmentedControl<PhysicalObjectListFilter | null>('分類', FILTERS, (key) => {
      order.filter = order.filter === key ? null : key;
      filterControl.setSelected(order.filter);
    });
    filterControl.setSelected(order.filter);
    this.element.appendChild(filterControl.element);

    // 並び順はフィルタとは別行 — 絞り込みと並べ替えは独立な操作であることを見た目でも分ける。
    const sortControl = new SegmentedControl<PhysicalObjectListSort>('並び順', SORTS, (key) => {
      order.sort = key;
      sortControl.setSelected(key);
    });
    sortControl.setSelected(order.sort);
    this.element.appendChild(sortControl.element);
  }
}
