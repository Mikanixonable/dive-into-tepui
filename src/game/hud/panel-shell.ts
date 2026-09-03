// 見出し(h3)+折りたたみトグル+本文の共通パネル外枠。折りたたみ状態はビューごとに
// localStorageへ永続する — 左右レールごと畳む現行の2段目の収納(.hud-rail.collapsed)とは
// 独立な、パネル単体の収納。
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  syncCollapseToggle,
  type CollapseToggleLabels,
} from '../../hud/widgets';
import type { View } from '../view/view';

const STORAGE_KEY = 'tepui.panelCollapsed.v2';
const LEGACY_STORAGE_KEY = 'tepui.panelCollapsed';

type PanelCollapsedBucket = Record<string, boolean>;

interface PanelCollapsedState {
  combat: PanelCollapsedBucket;
  map: PanelCollapsedBucket;
}

type PanelCollapsedViewListener = (view: View) => void;
type PanelDefaultCollapsed = boolean | ((view: View) => boolean);

let currentView: View = 'combat';
let cachedState: PanelCollapsedState | null = null;
const viewListeners = new Set<PanelCollapsedViewListener>();

// localStorage から読んだ値のうち、真偽値だけを畳み状態として採る。
function parseBucketValue(parsed: unknown): PanelCollapsedBucket | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const bucket: PanelCollapsedBucket = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') bucket[id] = value;
  }
  return bucket;
}

// ビュー1つぶんの畳み状態表を、未知の形なら空として読み出す。
function parseBucket(raw: string | null): PanelCollapsedBucket | null {
  if (!raw) return null;
  try {
    return parseBucketValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

// 保存済みのビュー別折りたたみ状態を返す。新キーが無い既存環境では旧状態を両ビューへ移行する。
function loadCollapsedState(): PanelCollapsedState {
  if (cachedState) return cachedState;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const source = parsed as Record<string, unknown>;
        const combat = parseBucketValue(source['combat']) ?? {};
        const map = parseBucketValue(source['map']) ?? {};
        cachedState = { combat, map };
        return cachedState;
      }
    }
  } catch {
    // 保存先が壊れていても既定値で続行する。
  }
  let legacy: PanelCollapsedBucket | null = null;
  try {
    legacy = parseBucket(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    // localStorage が利用できない環境では空の状態から始める。
  }
  cachedState = { combat: { ...(legacy ?? {}) }, map: { ...(legacy ?? {}) } };
  return cachedState;
}

// ビュー別の折りたたみ状態を保存する。
function saveCollapsedState(state: PanelCollapsedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存先が使えない環境では、今回のセッション限りの状態として続行する。
  }
}

// 現在のビューを切り替え、登録済みの折りたたみUIへ保存状態を再適用する。
export function setPanelCollapsedView(view: View): void {
  if (currentView === view) return;
  currentView = view;
  for (const listener of viewListeners) listener(view);
}

// 折りたたみUIがビュー切り替えを購読する。戻り値は将来の破棄時に使える解除関数。
function onPanelCollapsedViewChange(listener: PanelCollapsedViewListener): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

// id の保存済み折りたたみ状態を現在のビューから返す。一度も操作されていなければ undefined。
// PanelShell 以外の折りたたみ可能な置き場(左右レール)も同じビュー別状態を共有する。
export function loadPanelCollapsed(id: string): boolean | undefined {
  return loadCollapsedState()[currentView][id];
}

// id の折りたたみ状態を現在のビューへ保存する。
export function savePanelCollapsed(id: string, collapsed: boolean): void {
  const state = loadCollapsedState();
  state[currentView][id] = collapsed;
  saveCollapsedState(state);
}

interface PanelCollapseWiring {
  readonly toggleRoot: HTMLElement;
  readonly toggleId: string;
  readonly toggleClassName: string;
  readonly target: HTMLElement;
  readonly labels: CollapseToggleLabels;
  readonly storageId: string;
  readonly defaultCollapsed?: PanelDefaultCollapsed;
  readonly extraHitEls?: readonly HTMLElement[];
}

// 折りたたみトグルの配線一式(生成・保存状態の復元・ビュー切替の購読・クリック時の保存)を
// 1回で行う。対象要素・ラベル・保存 id を引数で受けるので、外枠の形が違うパネルからも使える。
// defaultCollapsed に関数を渡すと、ビューが切り替わるたびに現在のビューで再評価する。
// 戻り値は onPanelCollapsedViewChange の購読解除関数。
export function wirePanelCollapse(params: PanelCollapseWiring): () => void {
  const { toggleRoot, toggleId, toggleClassName, target, labels, storageId, defaultCollapsed = false, extraHitEls = [] } = params;
  const toggle = buildCollapseToggle(toggleRoot, toggleId, toggleClassName, target, labels, extraHitEls);
  // 現在ビューの保存値、無ければ既定値を畳み状態として当て直す。
  const applyCollapsedState = (): void => {
    const fallback = typeof defaultCollapsed === 'function' ? defaultCollapsed(currentView) : defaultCollapsed;
    const collapsed = loadPanelCollapsed(storageId) ?? fallback;
    target.classList.toggle('collapsed', collapsed);
    syncCollapseToggle(toggle, target, labels);
  };
  applyCollapsedState();
  const unsubscribe = onPanelCollapsedViewChange(applyCollapsedState);
  toggle.addEventListener('click', () => savePanelCollapsed(storageId, target.classList.contains('collapsed')));
  return unsubscribe;
}

export class PanelShell {
  public readonly el: HTMLElement;
  public readonly titleEl: HTMLHeadingElement;
  public readonly body: HTMLElement;

  // parent の子として id のパネルを組む。title は見出しの初期テキスト — 呼び出し側は
  // titleEl を直接書き換えて埋め込み要素(件数バッジ等)を足してよい。折りたたみ状態は
  // 現在のビューで直前にこの id で畳まれていれば引き継ぎ、一度も操作されていなければ
  // defaultCollapsed に従う。
  public constructor(parent: HTMLElement, id: string, title: string, defaultCollapsed: PanelDefaultCollapsed = false) {
    this.el = document.createElement('div');
    this.el.id = id;
    this.el.dataset['id'] = id;
    this.el.className = 'panel panel-shell';

    // 見出し行と本文を組む。
    const head = document.createElement('div');
    head.className = 'panel-shell-head';
    this.titleEl = document.createElement('h3');
    this.titleEl.textContent = title;
    head.appendChild(this.titleEl);
    this.el.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'panel-shell-body';
    this.el.appendChild(this.body);

    // 見出しクリックとトグルの両方から畳めるようにする。
    wirePanelCollapse({
      toggleRoot: head,
      toggleId: `${id}-collapse`,
      toggleClassName: 'panel-shell-collapse',
      target: this.body,
      labels: {
        expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
        collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
        expandedTitle: `${title}を折りたたむ`,
        collapsedTitle: `${title}を開く`,
      },
      storageId: id,
      defaultCollapsed,
      extraHitEls: [this.titleEl],
    });

    parent.appendChild(this.el);
  }

  // ゲーム状態由来の表示/非表示を .hidden クラスで切り替える。折りたたみ(利用者の
  // 好み)とは別軸 — 隠れている間に畳み外ししても、再表示時にその状態のまま出てくる。
  public setHidden(hidden: boolean): void {
    this.el.classList.toggle('hidden', hidden);
  }
}
