// 見出し(h3)+折りたたみトグル+本文の共通パネル外枠と、折りたたみトグルの配線役。
import {
  COLLAPSE_COLLAPSED_GLYPH,
  COLLAPSE_EXPANDED_GLYPH,
  buildCollapseToggle,
  syncCollapseToggle,
  type CollapseToggleLabels,
} from '../../hud/widgets';
import type { PanelCollapsedState } from './hud-selection';
import type { SettingValue } from '../../settings/setting-value';
import type { ViewMode } from '../view/view-mode';

// 一度も操作されていないときの畳み状態。ビューや画面幅で変えるなら関数で渡す。
type PanelDefaultCollapsed = boolean | ((view: ViewMode) => boolean);

// 折りたたみトグル1つぶんの配線内容。
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

// 折りたたみトグルの配線役。畳み状態はビューごとに分かれるので、いま表に出ているビューを
// sync で受ける。
export class PanelCollapse {
  // 配線済みトグルの当て直し。
  private readonly appliers = new Set<() => void>();
  // 直近に当てたビュー。DOM を当て直す差分の鍵。
  private view: ViewMode = 'combat';

  // state は保存されている畳み状態、onChange は畳み状態を書き換えるときに呼ぶ口。
  public constructor(
    private readonly state: SettingValue<PanelCollapsedState>,
    private readonly onChange: (state: PanelCollapsedState) => void,
  ) {}

  // 表に出ているビューを受け、切り替わっていれば配線済みのトグルへ保存値を当て直す。
  public sync(view: ViewMode): void {
    if (this.view === view) return;
    this.view = view;
    for (const apply of this.appliers) apply();
  }

  // id の保存済み折りたたみ状態。一度も操作されていなければ undefined。
  public collapsed(id: string): boolean | undefined {
    return this.state.current[this.view][id];
  }

  // id の折りたたみ状態を、いま表に出ているビューの分として書き換える。
  public setCollapsed(id: string, collapsed: boolean): void {
    const current = this.state.current;
    this.onChange({ ...current, [this.view]: { ...current[this.view], [id]: collapsed } });
  }

  // 折りたたみトグルの配線一式(生成・保存状態の復元・ビュー切替への追随・クリック時の保存)を
  // 1回で行う。defaultCollapsed に関数を渡すと、ビューが切り替わるたびに現在のビューで再評価する。
  // 戻り値はビュー切替への追随をやめる解除関数。
  public wire(params: PanelCollapseWiring): () => void {
    const {
      toggleRoot, toggleId, toggleClassName, target, labels, storageId,
      defaultCollapsed = false, extraHitEls = [],
    } = params;
    const toggle = buildCollapseToggle(
      toggleRoot, toggleId, toggleClassName, target, labels, extraHitEls,
      (collapsed) => this.setCollapsed(storageId, collapsed),
    );
    // 現在ビューの保存値、無ければ既定値を畳み状態として当て直す。
    const apply = (): void => {
      const fallback = typeof defaultCollapsed === 'function' ? defaultCollapsed(this.view) : defaultCollapsed;
      target.classList.toggle('collapsed', this.collapsed(storageId) ?? fallback);
      syncCollapseToggle(toggle, target, labels);
    };
    apply();
    this.appliers.add(apply);
    return () => this.appliers.delete(apply);
  }
}

export class PanelShell {
  public readonly el: HTMLElement;
  public readonly titleEl: HTMLHeadingElement;
  public readonly body: HTMLElement;

  // parent の子として id のパネルを組む。title は見出しの初期テキストで、titleEl へ要素(件数
  // バッジ等)を足してよい。折りたたみ状態は現在のビューでのこの id の保存値、無ければ defaultCollapsed。
  public constructor(
    parent: HTMLElement, collapse: PanelCollapse, id: string, title: string,
    defaultCollapsed: PanelDefaultCollapsed = false,
  ) {
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
    collapse.wire({
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
