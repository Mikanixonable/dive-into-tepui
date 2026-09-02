// [H] で開閉する操作説明パネル。操作項目・キーボード配列のデータは help-content.ts を参照し、
// 検索・フィルタ・選択ハイライトの状態遷移と DOM 描画を担当する。
import type { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import {
  ARROW_KEYS, AUXILIARY_KEYS, BEHAVIOR_LABELS, HELP_CATEGORIES, helpEntries, INPUT_LABELS, KEYBOARD_ROWS,
  entryCodes, entryMatchesCode, normalize, scopeMatches,
  type HelpCategory, type HelpEntry, type HelpInput, type KeyboardKeyDefinition,
} from './help-content';
import type { WorldView } from '../../world-view';

// HTML 属性値へ差し込む文字列をエスケープする。ラベル・説明文はユーザー操作の結果ではないが、
// `<`/`&` を含む語(不等号表記など)が構造を壊さないようにする。
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

export class HelpPanel implements OverlayHandle {
  private readonly el: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly body: HTMLElement;
  private readonly keyboardSection: HTMLElement;
  private readonly keyboard: HTMLElement;
  private readonly quickstart: HTMLElement;
  private readonly content: HTMLElement;
  private readonly liveStatus: HTMLElement;
  private _isOpen = false;
  private mode: WorldView = 'combat';
  private inputFilter: HelpInput | 'all' = 'all';
  private categoryFilter: HelpCategory | 'all' = 'all';
  private selectedCode: string | null = null;
  private selectedEntryId: string | null = null;
  private previousFocus: HTMLElement | null = null;

  // 操作説明パネルの DOM 一式を組み立てて root へ追加し、クリック・検索入力の購読を開始する。
  // 開閉状態は閉じたまま(open を呼ぶまで非表示)で始まる。
  public constructor(root: HTMLElement, private readonly overlayManager: OverlayManager) {
    this.el = document.createElement('div');
    this.el.id = 'hud-help';
    this.el.className = 'panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-labelledby', 'hud-help-title');
    // ヘッダー・トグル群(表示モード/入力方式/カテゴリ)・本文(クイックスタート/キーボード図/
    // 一覧)・スクリーンリーダー向け live region の順に、静的な骨格を一括で描画する。
    this.el.innerHTML = `
      <div class="help-header">
        <div>
          <h3 id="hud-help-title">操作説明 <span class="help-close-hint">[H / ESC で閉じる]</span></h3>
          <div class="help-mode-status" data-help-mode-status></div>
        </div>
        <button type="button" class="help-close-button" data-help-action="close" aria-label="操作説明を閉じる">×</button>
      </div>
      <div class="help-toolbar">
        <div class="help-toolbar-row">
          <div class="help-tab-group" role="tablist" aria-label="表示モード">
            <span class="help-toolbar-label">表示対象</span>
            <button type="button" class="help-tab" role="tab" data-help-mode="combat">戦闘ビュー</button>
            <button type="button" class="help-tab" role="tab" data-help-mode="map">マップモード</button>
          </div>
          <label class="help-search">
            <span class="help-visually-hidden">操作を検索</span>
            <span aria-hidden="true">⌕</span>
            <input class="w-input" type="search" placeholder="操作名・キー・説明を検索" autocomplete="off" />
          </label>
        </div>
        <div class="help-toolbar-row help-input-tabs" role="tablist" aria-label="入力方式">
          <span class="help-toolbar-label">入力方式</span>
          <button type="button" class="help-tab" role="tab" data-help-input="all">すべて</button>
          <button type="button" class="help-tab" role="tab" data-help-input="keyboard">キーボード</button>
          <button type="button" class="help-tab" role="tab" data-help-input="mouse">マウス</button>
          <button type="button" class="help-tab" role="tab" data-help-input="touch">タッチ</button>
        </div>
        <div class="help-category-tabs" role="tablist" aria-label="操作カテゴリ">
          <button type="button" class="help-tab" role="tab" data-help-category="all">すべて</button>
          ${HELP_CATEGORIES.map((category) => `<button type="button" class="help-tab" role="tab" data-help-category="${category.id}">${category.glyph} ${category.label}</button>`).join('')}
        </div>
      </div>
      <div class="help-body">
        <section class="help-quickstart" data-help-quickstart aria-labelledby="hud-help-quickstart-title"></section>
        <section class="help-keyboard-section" data-help-keyboard-section aria-labelledby="hud-help-keyboard-title">
          <div class="help-section-heading">
            <h4 id="hud-help-keyboard-title">キーボード</h4>
            <span>色だけでなく、キー上のカテゴリ記号でも判別できます</span>
          </div>
          <div class="help-legend" data-help-legend></div>
          <div class="help-keyboard" data-help-keyboard></div>
          <div class="help-keyboard-aux" data-help-keyboard-aux></div>
        </section>
        <div class="help-content" data-help-content></div>
        <div class="help-no-results" data-help-no-results hidden>該当する操作がありません。検索語やカテゴリを変更してください。</div>
      </div>
      <div class="help-live-status help-visually-hidden" aria-live="polite" data-help-live-status></div>
    `;
    root.appendChild(this.el);

    // 描画のたびに書き換える要素への参照を保持しておき、以降の render はこれらの
    // innerHTML/表示状態だけを差し替える。
    this.searchInput = this.el.querySelector<HTMLInputElement>('.help-search input')!;
    this.body = this.el.querySelector<HTMLElement>('.help-body')!;
    this.keyboardSection = this.el.querySelector<HTMLElement>('[data-help-keyboard-section]')!;
    this.keyboard = this.el.querySelector<HTMLElement>('[data-help-keyboard]')!;
    this.quickstart = this.el.querySelector<HTMLElement>('[data-help-quickstart]')!;
    this.content = this.el.querySelector<HTMLElement>('[data-help-content]')!;
    this.liveStatus = this.el.querySelector<HTMLElement>('[data-help-live-status]')!;
    this.el.addEventListener('click', this.handleClick);
    this.searchInput.addEventListener('input', this.handleSearchInput);
    this.render();
  }

  public get isOpen(): boolean { return this._isOpen; }

  // ビュー切り替え時はヘルプの既定表示も同期する。タブから手動で選んだ場合でも、
  // 次にビューを切り替えた時点で現在の操作へ戻るため、常に迷子にならない。
  public setWorldView(view: WorldView): void {
    if (this.mode === view) return;
    this.mode = view;
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
  }

  // [H] キー押下を受け取ってヘルプの開閉を切り替える。毎フレーム呼び出す前提。
  public handleInput(input: Input): void {
    if (!input.takeKey(K.help)) return;
    // 検索欄へ文字を入力している最中の H は、ヘルプの開閉に使わない。
    if (document.activeElement === this.searchInput) return;
    this.toggle();
  }

  // パネルを開く。開く直前のフォーカス要素を退避し、閉じたときに戻せるようにしたうえで
  // OverlayManager へ登録し、検索欄へフォーカスを移す。既に開いていれば何もしない。
  public open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
    this.el.style.display = 'block';
    // 系のモーダル(ヘルプ・一時停止など)は同じ排他グループに属し、同時に1つしか開かない。
    this.overlayManager.open('help', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
    window.addEventListener('keydown', this.handleWindowKeyDown);
    requestAnimationFrame(() => {
      if (this._isOpen) this.searchInput.focus({ preventScroll: true });
    });
  }

  // パネルを閉じ、OverlayManager から登録を外して、開く前にフォーカスされていた要素へ
  // フォーカスを戻す。既に閉じていれば何もしない。
  public close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.el.style.display = 'none';
    window.removeEventListener('keydown', this.handleWindowKeyDown);
    this.overlayManager.close('help');
    this.previousFocus?.focus({ preventScroll: true });
    this.previousFocus = null;
  }

  // 指定したノードがこのパネルの DOM 内にあるかを判定する。外側クリック判定に使う。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }

  // 開閉状態を反転する。
  private toggle(): void {
    if (this._isOpen) this.close();
    else this.open();
  }

  // パネルを開いている間だけ有効な、キーボード図と一覧をハイライトするためのグローバル
  // キー監視。テキスト入力中と、ヘルプ自身の開閉キー([H]/一時停止)は対象から除く。
  private readonly handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this._isOpen || event.isComposing) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    if (event.code === K.help.code || event.code === K.pauseMenu.code) return;
    this.selectCode(event.code, false);
  };

  // 検索語の変更を受けて選択状態を解除し、一覧を再描画する。
  private readonly handleSearchInput = (): void => {
    this.selectedCode = null;
    this.selectedEntryId = null;
    this.render();
  };

  // パネル内のクリックを、押された要素の data 属性に応じて分岐させる唯一の入口。
  // 閉じるボタン・各種フィルタタブ・キーボード上のキー・一覧の操作行のいずれかを処理する。
  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-help-action], [data-help-code], [data-help-entry], [data-help-mode], [data-help-input], [data-help-category]') : null;
    if (!target || !this.el.contains(target)) return;
    const action = target.dataset['helpAction'];
    if (action === 'close') {
      this.close();
      return;
    }
    // 表示モード / 入力方式 / カテゴリのタブは、選択を切り替えて再描画するだけの同じ形。
    const mode = target.dataset['helpMode'] as WorldView | undefined;
    if (mode) {
      this.mode = mode;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    const inputFilter = target.dataset['helpInput'] as HelpInput | 'all' | undefined;
    if (inputFilter) {
      this.inputFilter = inputFilter;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    const category = target.dataset['helpCategory'] as HelpCategory | 'all' | undefined;
    if (category) {
      this.categoryFilter = category;
      this.selectedCode = null;
      this.selectedEntryId = null;
      this.render();
      return;
    }
    // キーボード図のキー、または一覧の操作行そのものをクリックした場合はハイライトのみ行う。
    const code = target.dataset['helpCode'];
    if (code) {
      this.selectCode(code);
      return;
    }
    const entryId = target.dataset['helpEntry'];
    if (entryId) this.selectEntry(entryId);
  };

  // 現在の検索語・入力方式・カテゴリ・表示モードのすべてに合致する操作項目を返す。
  private filteredEntries(): HelpEntry[] {
    const query = normalize(this.searchInput.value);
    return helpEntries().filter((entry) => {
      if (!scopeMatches(entry, this.mode)) return false;
      if (this.categoryFilter !== 'all' && entry.category !== this.categoryFilter) return false;
      if (this.inputFilter !== 'all' && !entry.inputs.includes(this.inputFilter)) return false;
      if (!query) return true;
      // キー名・コード・代替コードも検索対象に含めることで、"W" や "KeyW" からも探せる。
      const values = [
        entry.label, entry.description, entry.example ?? '', entry.category,
        ...(entry.keys ?? []).flatMap((key) => [key.label, key.altLabel ?? '', key.code, ...(key.altCodes ?? [])]),
      ];
      return normalize(values.join(' ')).includes(query);
    });
  }

  // 現在の表示モードでキーボード図に描画すべき、キー割り当てを持つ操作項目を返す。
  // 検索語・入力方式・カテゴリのフィルタは反映しない — キーボード図自体は常に全体を示す。
  private activeKeyboardEntries(): HelpEntry[] {
    return helpEntries().filter((entry) => scopeMatches(entry, this.mode) && entry.inputs.includes('keyboard') && Boolean(entry.keys?.length));
  }

  // 現在の状態(モード・フィルタ・検索語・選択)に合わせて、パネル全体を再描画する。
  // モード/フィルタ/検索語/選択のいずれかを変更した箇所は、必ず最後にこれを呼ぶ。
  private render(): void {
    this.syncToolbar();
    const visibleEntries = this.filteredEntries();
    this.quickstart.innerHTML = this.renderQuickstart();
    this.keyboardSection.hidden = this.inputFilter === 'mouse' || this.inputFilter === 'touch';
    this.keyboard.innerHTML = this.renderKeyboard();
    this.el.querySelector<HTMLElement>('[data-help-keyboard-aux]')!.innerHTML = this.renderAuxiliaryKeys();
    this.el.querySelector<HTMLElement>('[data-help-legend]')!.innerHTML = this.renderLegend();
    this.content.innerHTML = this.renderEntryGroups(visibleEntries);
    // 一覧が空になった場合の案内文は、非表示の要素として常設しておき hidden で切り替える。
    const noResults = this.el.querySelector<HTMLElement>('[data-help-no-results]')!;
    noResults.hidden = visibleEntries.length > 0;
    this.body.classList.toggle('has-no-results', visibleEntries.length === 0);
    this.applySelection();
  }

  // 表示モード / 入力方式 / カテゴリの各タブに、現在選択されているものの点灯状態を反映する。
  private syncToolbar(): void {
    const modeStatus = this.el.querySelector<HTMLElement>('[data-help-mode-status]')!;
    modeStatus.textContent = `現在の表示: ${this.mode === 'combat' ? '戦闘ビュー' : 'マップモード'} — 共通操作も表示中`;
    // 表示モードのタブ。
    for (const button of Array.from(this.el.querySelectorAll<HTMLElement>('[data-help-mode]'))) {
      const selected = button.dataset['helpMode'] === this.mode;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    // 入力方式のタブ。
    for (const button of Array.from(this.el.querySelectorAll<HTMLElement>('[data-help-input]'))) {
      const selected = button.dataset['helpInput'] === this.inputFilter;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    }
    // カテゴリのタブ。
    for (const button of Array.from(this.el.querySelectorAll<HTMLElement>('[data-help-category]'))) {
      const selected = button.dataset['helpCategory'] === this.categoryFilter;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-selected', String(selected));
    }
  }

  // 現在の表示モードに応じた「まず覚える操作」の4手順を組み立てる。
  private renderQuickstart(): string {
    const isMap = this.mode === 'map';
    // マップモードと戦闘ビューで別の4手順を持つ。
    return `
      <div class="help-section-heading">
        <h4 id="hud-help-quickstart-title">まず覚える操作</h4>
        <span>${isMap ? 'マップモードの流れ' : '戦闘ビューの基本'}</span>
      </div>
      <div class="help-quickstart-grid">
        ${isMap ? `
          <div class="help-recipe"><span class="help-recipe-number">01</span><span><kbd>M</kbd> でマップモード</span></div>
          <div class="help-recipe"><span class="help-recipe-number">02</span><span>軌道をクリックしてノード配置</span></div>
          <div class="help-recipe"><span class="help-recipe-number">03</span><span><kbd>W/S</kbd> などで Δv 調整</span></div>
          <div class="help-recipe"><span class="help-recipe-number">04</span><span><kbd>M</kbd> で確定、<kbd>N</kbd> で接近</span></div>
        ` : `
          <div class="help-recipe"><span class="help-recipe-number">01</span><span><kbd>WASDQE</kbd> で移動</span></div>
          <div class="help-recipe"><span class="help-recipe-number">02</span><span><kbd>IJKLUO</kbd> で姿勢変更</span></div>
          <div class="help-recipe"><span class="help-recipe-number">03</span><span><kbd>T</kbd> で敵を選択、<kbd>SPACE</kbd> で射撃</span></div>
          <div class="help-recipe"><span class="help-recipe-number">04</span><span><kbd>H</kbd> でこの説明を開く</span></div>
        `}
      </div>`;
  }

  // カテゴリ記号の凡例を、キーボード図の上に横並びで表示するために組み立てる。
  private renderLegend(): string {
    return HELP_CATEGORIES.map((category) => `<span class="help-legend-item cat-${category.id}"><i aria-hidden="true">${category.glyph}</i>${category.label}</span>`).join('');
  }

  // メインのキーボード配列図を行ごとに描画する。検索語・カテゴリ絞り込みが有効なときは、
  // 絞り込みに合致しないキーだけを見た目上ミュートする。
  private renderKeyboard(): string {
    const entries = this.activeKeyboardEntries();
    const query = normalize(this.searchInput.value);
    const matchingEntries = this.filteredEntries();
    const dimUnmatched = Boolean(query) || this.categoryFilter !== 'all';
    const entryMap = new Map<string, HelpEntry[]>();
    for (const entry of entries) {
      for (const code of entryCodes(entry)) entryMap.set(code, [...(entryMap.get(code) ?? []), entry]);
    }
    return KEYBOARD_ROWS.map((row) => `<div class="help-keyboard-row">${row.map((key) => this.renderKeyboardKey(key, entryMap, dimUnmatched, matchingEntries)).join('')}</div>`).join('');
  }

  // 矢印キーと補助キー(Numpad0/1、_)をメイン配列とは別の行として描画する。
  private renderAuxiliaryKeys(): string {
    const entries = this.activeKeyboardEntries();
    const entryMap = new Map<string, HelpEntry[]>();
    for (const entry of entries) {
      for (const code of entryCodes(entry)) entryMap.set(code, [...(entryMap.get(code) ?? []), entry]);
    }
    const dimUnmatched = Boolean(normalize(this.searchInput.value)) || this.categoryFilter !== 'all';
    return `<span class="help-keyboard-aux-label">補助キー</span>${[...AUXILIARY_KEYS, ...ARROW_KEYS].map((key) => this.renderKeyboardKey(key, entryMap, dimUnmatched, this.filteredEntries())).join('')}`;
  }

  // 1つのキーをボタンとして描画する。割り当てられた操作のカテゴリ色・割り当ての有無・
  // 絞り込みへの合致状況をクラス名へ反映する。
  private renderKeyboardKey(
    key: KeyboardKeyDefinition,
    entryMap: Map<string, HelpEntry[]>,
    dimUnmatched: boolean,
    matchingEntries: readonly HelpEntry[],
  ): string {
    const entries = entryMap.get(key.code) ?? [];
    const matching = entries.filter((entry) => matchingEntries.includes(entry));
    const categories = [...new Set(entries.map((entry) => entry.category))];
    const classes = [
      'help-key', key.className ?? '', ...categories.map((category) => `cat-${category}`),
      entries.length ? 'mapped' : 'unmapped', dimUnmatched && matching.length === 0 ? 'search-muted' : '',
    ].filter(Boolean).join(' ');
    const title = entries.length ? entries.map((entry) => entry.label).join(' / ') : '割り当てなし';
    return `<button type="button" class="${classes}" data-help-code="${escapeHtml(key.code)}" aria-label="${escapeHtml(key.label)}: ${escapeHtml(title)}" title="${escapeHtml(title)}">${escapeHtml(key.label)}</button>`;
  }

  // 渡された操作項目をカテゴリごとの折りたたみ(details)へまとめる。検索語・カテゴリ
  // 絞り込みが有効なとき、または基本操作のグループは初期状態で開く。
  private renderEntryGroups(entries: readonly HelpEntry[]): string {
    return HELP_CATEGORIES.map((category) => {
      // 該当エントリが無いカテゴリは、空の details を残さず丸ごと省く。
      const groupEntries = entries.filter((entry) => entry.category === category.id);
      if (groupEntries.length === 0) return '';
      const query = normalize(this.searchInput.value);
      const open = Boolean(query) || this.categoryFilter !== 'all' || category.id === 'basic';
      return `
        <details class="help-group cat-${category.id}" ${open ? 'open' : ''}>
          <summary><span><i aria-hidden="true">${category.glyph}</i>${category.label}</span><em>${groupEntries.length}</em></summary>
          <div class="help-group-body">${groupEntries.map((entry) => this.renderEntry(entry)).join('')}</div>
        </details>`;
    }).join('');
  }

  // 1つの操作項目をキー表示・行動タグ・入力方式タグ・説明文を持つカードとして描画する。
  // キー割り当てが無い項目は「ジェスチャ」と表示する。
  private renderEntry(entry: HelpEntry): string {
    const codes = entryCodes(entry);
    // 主キーと代替キー(altCodes)を「/」区切りで並べる。キー割り当てが無ければジェスチャ表記。
    const keyMarkup = entry.keys?.length
      ? entry.keys.flatMap((key) => [
        this.renderEntryKey(key.code, key.label, entry),
        ...(key.altCodes ?? []).map((code) => this.renderEntryKey(code, key.altLabel ?? code, entry, true)),
      ]).join('<span class="help-key-separator">/</span>')
      : '<span class="help-gesture">ジェスチャ</span>';
    const behavior = entry.behavior ? `<span class="help-behavior">${BEHAVIOR_LABELS[entry.behavior]}</span>` : '';
    const inputs = entry.inputs.map((input) => `<span class="help-input-tag input-${input}">${INPUT_LABELS[input]}</span>`).join('');
    return `
      <article class="help-entry cat-${entry.category}" id="help-entry-${entry.id}" data-help-entry="${entry.id}" data-help-codes="${escapeHtml(codes.join(' '))}">
        <div class="help-entry-keyset">${keyMarkup}</div>
        <div class="help-entry-copy">
          <div class="help-entry-title"><strong>${escapeHtml(entry.label)}</strong><span class="help-entry-tags">${behavior}${inputs}</span></div>
          <p>${escapeHtml(entry.description)}</p>
          ${entry.example ? `<div class="help-example">例: ${escapeHtml(entry.example)}</div>` : ''}
        </div>
      </article>`;
  }

  // キーボード図・一覧の両方で使う、1つのキーコードに対応するクリック可能なボタンを描画する。
  // muted は代替コード側の表示を主コードより控えめにするためのもの。
  private renderEntryKey(code: string, label: string, entry: HelpEntry, muted = false): string {
    return `<button type="button" class="help-entry-key ${muted ? 'muted' : ''}" data-help-code="${escapeHtml(code)}" data-help-entry="${entry.id}">${escapeHtml(label)}</button>`;
  }

  // 指定コードに割り当てられた操作をハイライト対象として選択する。該当する操作が
  // 現在の表示モードに無ければ何もしない。announce が真のときだけ読み上げ用テキストを流す。
  private selectCode(code: string, announce = true): void {
    const matches = this.activeKeyboardEntries().filter((entry) => entryMatchesCode(entry, code));
    if (matches.length === 0) return;
    this.selectedCode = code;
    this.selectedEntryId = null;
    this.applySelection();
    const labels = matches.map((entry) => entry.label).join(' / ');
    if (announce) this.liveStatus.textContent = `${code}：${labels}`;
  }

  // 指定 id の操作項目をハイライト対象として選択し、一覧内の該当カードまでスクロールする。
  // 該当項目が存在しなければ何もしない。
  private selectEntry(entryId: string): void {
    const entry = helpEntries().find((item) => item.id === entryId);
    if (!entry) return;
    this.selectedEntryId = entryId;
    this.selectedCode = null;
    this.applySelection();
    this.el.querySelector<HTMLElement>(`#help-entry-${entryId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    this.liveStatus.textContent = `${entry.label}：${entry.description}`;
  }

  // 現在の selectedCode / selectedEntryId を、キーボード図・一覧のハイライトクラスへ反映する。
  // 描画のたびに一度全消灯してから、該当する要素だけへ点灯クラスを付け直す。
  private applySelection(): void {
    for (const element of Array.from(this.el.querySelectorAll<HTMLElement>('.help-key.is-selected, .help-entry.is-selected'))) {
      element.classList.remove('is-selected');
    }
    if (this.selectedCode) {
      // キーボード図側のボタンと、そのコードを含む一覧カードの両方を点灯させる。
      for (const element of Array.from(this.el.querySelectorAll<HTMLElement>('[data-help-code]'))) {
        if (element.dataset['helpCode'] === this.selectedCode) element.classList.add('is-selected');
      }
      for (const element of Array.from(this.el.querySelectorAll<HTMLElement>('.help-entry[data-help-codes]'))) {
        const codes = element.dataset['helpCodes']?.split(' ') ?? [];
        if (codes.includes(this.selectedCode!)) element.classList.add('is-selected');
      }
    }
    if (this.selectedEntryId) {
      this.el.querySelector<HTMLElement>(`[data-help-entry="${this.selectedEntryId}"]`)?.classList.add('is-selected');
    }
  }
}
