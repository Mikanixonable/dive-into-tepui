// 見出し(h3)+折りたたみトグル+本文の共通パネル外枠。折りたたみ状態はビューごとに
// localStorageへ永続する — 左右レールごと畳む現行の2段目の収納(.hud-rail.collapsed)とは
// 独立な、パネル単体の収納。
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  syncCollapseToggle,
} from './widgets';

export type HudWorldView = 'combat' | 'map';

const STORAGE_KEY = 'tepui.panelCollapsed.v2';
const LEGACY_STORAGE_KEY = 'tepui.panelCollapsed';

type PanelCollapsedBucket = Record<string, boolean>;

interface PanelCollapsedState {
  combat: PanelCollapsedBucket;
  map: PanelCollapsedBucket;
}

type PanelCollapsedViewListener = (view: HudWorldView) => void;

let currentView: HudWorldView = 'combat';
let cachedState: PanelCollapsedState | null = null;
const viewListeners = new Set<PanelCollapsedViewListener>();

function parseBucketValue(parsed: unknown): PanelCollapsedBucket | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const bucket: PanelCollapsedBucket = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') bucket[id] = value;
  }
  return bucket;
}

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
export function setPanelCollapsedView(view: HudWorldView): void {
  if (currentView === view) return;
  currentView = view;
  for (const listener of viewListeners) listener(view);
}

// 折りたたみUIがビュー切り替えを購読する。戻り値は将来の破棄時に使える解除関数。
export function onPanelCollapsedViewChange(listener: PanelCollapsedViewListener): () => void {
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

export class PanelShell {
  readonly el: HTMLElement;
  readonly titleEl: HTMLHeadingElement;
  readonly body: HTMLElement;
  private readonly unsubscribeCollapsedView: () => void;

  // parent の子として id のパネルを組む。title は見出しの初期テキスト — 呼び出し側は
  // titleEl を直接書き換えて埋め込み要素(件数バッジ等)を足してよい。折りたたみ状態は
  // 現在のビューで直前にこの id で畳まれていれば引き継ぎ、一度も操作されていなければ
  // defaultCollapsed に従う。
  public constructor(parent: HTMLElement, id: string, title: string, defaultCollapsed = false) {
    this.el = document.createElement('div');
    this.el.id = id;
    this.el.className = 'panel panel-shell';

    const head = document.createElement('div');
    head.className = 'panel-shell-head';
    this.titleEl = document.createElement('h3');
    this.titleEl.textContent = title;
    head.appendChild(this.titleEl);
    this.el.appendChild(head);

    this.body = document.createElement('div');
    this.body.className = 'panel-shell-body';
    this.el.appendChild(this.body);

    const labels = {
      expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
      collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
      expandedTitle: `${title}を折りたたむ`,
      collapsedTitle: `${title}を開く`,
    };
    const toggle = buildCollapseToggle(head, `${id}-collapse`, 'panel-shell-collapse', this.body, labels);
    const applyCollapsedState = (): void => {
      const collapsed = loadPanelCollapsed(id) ?? defaultCollapsed;
      this.body.classList.toggle('collapsed', collapsed);
      syncCollapseToggle(toggle, this.body, labels);
    };
    applyCollapsedState();
    this.unsubscribeCollapsedView = onPanelCollapsedViewChange(applyCollapsedState);
    toggle.addEventListener('click', () => {
      savePanelCollapsed(id, this.body.classList.contains('collapsed'));
    });

    parent.appendChild(this.el);
  }

  // ゲーム状態由来の表示/非表示を .hidden クラスで切り替える。折りたたみ(利用者の
  // 好み)とは別軸 — 隠れている間に畳み外ししても、再表示時にその状態のまま出てくる。
  setHidden(hidden: boolean): void {
    this.el.classList.toggle('hidden', hidden);
  }

  // 折りたたみ状態変化の購読を解いてから DOM を取り除く。セッションを通して生き続ける
  // 常設パネル(VESSEL/ORBIT/TARGET/CONTACTS)は呼ばなくてよいが、Game の再構築ごとに
  // 作り直されるパネルは呼ばないと購読が積み上がる。
  dispose(): void {
    this.unsubscribeCollapsedView();
    this.el.remove();
  }
}
