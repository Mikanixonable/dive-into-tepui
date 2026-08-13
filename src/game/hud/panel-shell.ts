// 見出し(h3)+折りたたみトグル+本文の共通パネル外枠。折りたたみ状態は localStorage
// (tepui.panelCollapsed)へパネル id ごとに永続する — 左右レールごと畳む現行の
// 2段目の収納(.hud-rail.collapsed)とは独立な、パネル単体の収納。
import { COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, buildCollapseToggle } from './widgets';

const STORAGE_KEY = 'tepui.panelCollapsed';

// 保存済みの折りたたみ状態を id ごとの真偽値として返す。読めなければ空で始める。
function loadCollapsedState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// 折りたたみ状態を id ごとの真偽値として保存する。
function saveCollapsedState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存先が使えない環境では、今回のセッション限りの状態として続行する。
  }
}

export class PanelShell {
  readonly el: HTMLElement;
  readonly titleEl: HTMLHeadingElement;
  readonly body: HTMLElement;

  // parent の子として id のパネルを組む。title は見出しの初期テキスト — 呼び出し側は
  // titleEl を直接書き換えて埋め込み要素(件数バッジ等)を足してよい。折りたたみ状態は
  // 直前にこの id で畳まれていれば引き継ぐ。
  constructor(parent: HTMLElement, id: string, title: string) {
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

    // 初期の折りたたみ状態を buildCollapseToggle へ渡す前に body 側へ反映しておく —
    // そうしないと最初の描画がボタンの初期グリフと食い違う。
    const collapsed = loadCollapsedState()[id] === true;
    this.body.classList.toggle('collapsed', collapsed);
    const toggle = buildCollapseToggle(head, `${id}-collapse`, 'panel-shell-collapse', this.body, {
      expandedGlyph: COLLAPSE_EXPANDED_GLYPH,
      collapsedGlyph: COLLAPSE_COLLAPSED_GLYPH,
      expandedTitle: `${title}を折りたたむ`,
      collapsedTitle: `${title}を開く`,
    });
    toggle.addEventListener('click', () => {
      const state = loadCollapsedState();
      state[id] = this.body.classList.contains('collapsed');
      saveCollapsedState(state);
    });

    parent.appendChild(this.el);
  }

  // ゲーム状態由来の表示/非表示を .hidden クラスで切り替える。折りたたみ(利用者の
  // 好み)とは別軸 — 隠れている間に畳み外ししても、再表示時にその状態のまま出てくる。
  setHidden(hidden: boolean): void {
    this.el.classList.toggle('hidden', hidden);
  }
}
