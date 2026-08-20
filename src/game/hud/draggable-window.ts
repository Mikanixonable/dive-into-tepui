// ドラッグで動かせ、📌でクリップでき、✕で閉じられる HUD ウィンドウの外枠。持つのは見出し
// (タイトル・サブタイトル・任意の改名ボタン)と、中身を差し込む body 要素だけで、body の
// 中に何を組むか(プロパティ行と操作項目、タブ付きの自由な DOM 等)は呼び出し側の責務。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import { CLICK_MOVE_THRESHOLD } from '../const';
import { clampOverlayPosition, Point2 } from './layout';
import { bringToFront as bringOverlayToFront } from './overlay-layer';
import { onViewportChange } from './viewport';
import { isCompactViewport, MQ_COMPACT } from './breakpoints';
import { Button, CloseButton, ValueInput } from './widgets';
import type { OverlayHandle, OverlayManager, OverlaySpec } from './overlay-manager';

const STYLE = `
#hud .dw-window {
  position: fixed; display: block; min-width: 200px; max-width: 280px;
  pointer-events: auto; background: var(--glass-focus); border: 0;
  border-radius: var(--radius-window); overflow: hidden; font-size: var(--font-m);
  font-family: var(--font-family); user-select: none;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  -webkit-user-select: none;
}
/* compact: ドラッグで動かす小窓ではなく、画面下 40% のボトムシートとして開く
   (クリップ概念は維持 — 📌 で複数枚並べられる点はそのまま)。 */
@media ${MQ_COMPACT} {
  #hud .dw-window {
    right: 0; bottom: 0; width: 100%; min-width: 0; max-width: 100%;
    max-height: 40vh; max-height: 40dvh; overflow-y: auto;
    border-radius: var(--radius-window) var(--radius-window) 0 0;
  }
}
#hud .dw-header {
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-5) var(--space-4) var(--space-4) var(--space-5);
  border: 0; background: transparent;
  cursor: move;
}
@media ${MQ_COMPACT} {
  #hud .dw-header { cursor: default; }
}
#hud .dw-title { flex: 1; min-width: 0; }
#hud .dw-title-main { color: var(--text); font-weight: bold; overflow-wrap: break-word; }
#hud .dw-title-sub { color: var(--text); opacity: 0.7; font-size: var(--font-s); margin-top: var(--space-1); }
#hud .dw-title-input {
  width: 100%; background: var(--surface-2); border: 1px solid transparent; border-radius: var(--radius-control);
  color: var(--text); font: inherit; font-weight: bold; padding: var(--space-1) var(--space-2); box-sizing: border-box;
}
#hud .dw-btn {
  flex: none; width: 18px; height: 18px; line-height: 18px; text-align: center;
  border: 0; border-radius: var(--radius-micro); background: var(--surface-2); color: var(--text);
  cursor: pointer; font-size: var(--font-s); padding: 0;
}
#hud .dw-btn:hover { background: var(--surface-3); color: var(--accent-near); }
#hud .dw-btn.clipped { background: var(--accent-fill); color: var(--accent); }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export interface DraggableWindowOptions {
  readonly title: string;
  readonly subtitle?: string;
  // 指定すると、タイトル横に改名ボタンが現れる。呼び出し側は確定した新しい名前を
  // 実体へ書き戻すところまでを行う — このクラスは編集 UI の開閉のみを持つ。
  readonly onRename?: (name: string) => void;
}

export class DraggableWindow implements OverlayHandle {
  private static readonly UNSET = Symbol('unset');
  private static nextId = 0;
  private readonly overlayId: string;
  private readonly el: HTMLDivElement;
  private readonly titleMainEl: HTMLDivElement;
  private readonly titleSubEl: HTMLDivElement;
  private readonly clipBtn: Button;
  public readonly body: HTMLDivElement;
  // 前回描画したタイトル・サブタイトル。同じ値なら DOM に触れない差分更新のための記録。
  // サブタイトルは「まだ一度も描画していない」を表す専用の初期値を持つ — `undefined`(サブタイトル
  // 無し)と区別できないと、最初の syncHeader 呼び出しが「変化なし」と判定され titleSubEl の
  // display が一度も設定されないままになる。
  private lastTitle = '';
  private lastSubtitle: string | undefined | typeof DraggableWindow.UNSET = DraggableWindow.UNSET;
  private _clipped = false;
  private disposed = false;
  private readonly renameCallback: ((name: string) => void) | null;
  private renaming = false;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };
  private dragging = false;

  private readonly onResize: () => void;
  private readonly unsubscribeViewport: () => void;

  // OverlayManager から配送される項目ショートカットの実処理。中身(プロパティ行の操作項目、
  // タブの中身等)を持つ側がここへ差し込む — クリップ中はこの呼び出し自体が届かない。
  public onHandleShortcut: ((code: string) => boolean) | null = null;
  // 閉じられた(dispose 済み)ことを呼び出し側へ知らせる。ESC・外側クリック・✕ ボタンの
  // どの経路で閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。呼び出し側が状態に応じた見た目の
  // 追従(一覧の表示等)を行うためだけの通知で、排他は overlayManager 自身が持つ。
  public onClipChange: ((clipped: boolean) => void) | null = null;

  // clientX/clientY を左上角として root の子として開く。ヘッダを構築してから DOM に追加し、
  // viewport.ts のビューポート変化通知を購読する。body は空のまま返すので、中身は
  // 呼び出し側が自分で組み立てて足す。
  // tempWindowGroup を渡すと、クリップされていない間だけ OverlayManager 上の排他グループに
  // 参加する一時ウィンドウになる(ESC・外側クリックで自動的に閉じ、同グループの他方も追い出す)。
  // 省略すると(例: 負荷確認ウィンドウ)ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number, options: DraggableWindowOptions,
    private readonly overlayManager: OverlayManager, private readonly tempWindowGroup?: string,
  ) {
    this.overlayId = `dw-window-${DraggableWindow.nextId++}`;
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'dw-window';
    this.el.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'dw-header';
    const title = document.createElement('div');
    title.className = 'dw-title';
    this.titleMainEl = document.createElement('div');
    this.titleMainEl.className = 'dw-title-main';
    this.titleMainEl.id = `${this.overlayId}-title`;
    this.el.setAttribute('aria-labelledby', this.titleMainEl.id);
    this.titleSubEl = document.createElement('div');
    this.titleSubEl.className = 'dw-title-sub';
    title.appendChild(this.titleMainEl);
    title.appendChild(this.titleSubEl);

    this.renameCallback = options.onRename ?? null;
    let renameBtn: Button | null = null;
    if (this.renameCallback) {
      renameBtn = new Button('✎', () => this.startRename());
      renameBtn.element.classList.add('dw-btn');
      renameBtn.element.title = '名前を変更';
      renameBtn.element.setAttribute('aria-label', '名前を変更');
    }

    this.clipBtn = new Button('📌', () => this.setClipped(!this._clipped));
    this.clipBtn.element.classList.add('dw-btn');
    this.clipBtn.element.title = 'クリップ';
    this.clipBtn.element.setAttribute('aria-label', 'クリップ');

    // ✕ は他の3窓(格納庫/セーブブラウザ/設定)と同じ見た目に統一する。
    const closeBtn = new CloseButton(() => this.close());

    header.appendChild(title);
    if (renameBtn) header.appendChild(renameBtn.element);
    header.appendChild(this.clipBtn.element);
    header.appendChild(closeBtn.element);
    header.addEventListener('pointerdown', this.handleHeaderPointerDown);
    header.addEventListener('pointermove', this.handleHeaderPointerMove);
    header.addEventListener('pointerup', this.handleHeaderPointerUp);
    header.addEventListener('pointercancel', this.handleHeaderPointerUp);

    this.body = document.createElement('div');

    this.el.appendChild(header);
    this.el.appendChild(this.body);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(this.el);

    this.onResize = () => this.moveTo(this.el.offsetLeft, this.el.offsetTop);
    this.unsubscribeViewport = onViewportChange(this.onResize);

    this.syncHeader(options.title, options.subtitle);
    this.moveTo(clientX, clientY);
    this.bringToFront();
    this.overlayManager.open(this.overlayId, this, this.currentSpec());
  }

  public contains(target: Node): boolean {
    return this.el.contains(target);
  }

  // OverlayManager からの項目ショートカット配送を受ける。クリップ中は受け付けない —
  // 一時ウィンドウは高々1枚なので、クリップされていないウィンドウどうしがキーを取り合うことはない。
  public handleShortcut(code: string): boolean {
    if (this._clipped) return false;
    return this.onHandleShortcut?.(code) ?? false;
  }

  // 現在のクリップ状態から overlayManager へ渡す宣言を組む。tempWindowGroup が無ければ
  // (負荷確認ウィンドウ等)常に ESC・外側クリックのどちらでも閉じない常設ウィンドウとして扱う。
  private currentSpec(): OverlaySpec {
    const isTemp = this.tempWindowGroup !== undefined && !this._clipped;
    return {
      kind: 'window',
      closeOnEscape: isTemp,
      closeOnOutsideClick: isTemp,
      gatesInput: false,
      exclusiveGroup: isTemp ? this.tempWindowGroup : undefined,
    };
  }

  // タイトル・サブタイトルを変化があった要素だけ差分更新する。
  public syncHeader(title: string, subtitle: string | undefined): void {
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.titleMainEl.textContent = title;
    }
    if (subtitle !== this.lastSubtitle) {
      this.lastSubtitle = subtitle;
      this.titleSubEl.textContent = subtitle ?? '';
      this.titleSubEl.style.display = subtitle ? 'block' : 'none';
      this.reclamp();
    }
  }

  // タイトルを編集用の入力欄へ差し替え、確定(Enter/blur)で renameCallback へ通知して表示へ戻す。
  private startRename(): void {
    if (this.renaming || !this.renameCallback) return;
    this.renaming = true;
    const input = new ValueInput(
      { type: 'text' },
      (text) => this.finishRename(input, text),
      () => this.finishRename(input, null),
    );
    input.element.classList.add('dw-title-input');
    input.element.maxLength = 40;
    input.setValue(this.lastTitle);
    this.titleMainEl.replaceWith(input.element);
    input.element.focus();
    input.element.select();
  }

  // リネーム入力欄を終える。value が確定文字列なら(かつ現在のタイトルと異なれば)
  // renameCallback へ通知し、表示をタイトル要素へ戻す。破棄(Escape/無効値)は value が null。
  private finishRename(input: ValueInput, value: string | null): void {
    if (!this.renaming) return;
    this.renaming = false;
    input.element.replaceWith(this.titleMainEl);
    const trimmed = value?.trim();
    if (trimmed && trimmed !== this.lastTitle) this.renameCallback?.(trimmed);
  }

  public get clipped(): boolean {
    return this._clipped;
  }

  // クリップボタンからのみ呼ばれる。ボタンの見た目を切り替え、overlayManager 上の宣言を
  // 今のクリップ状態へ更新したうえで onClipChange を発火する。
  private setClipped(clipped: boolean): void {
    this._clipped = clipped;
    this.clipBtn.element.classList.toggle('clipped', clipped);
    this.overlayManager.reconfigure(this.overlayId, this.currentSpec());
    this.onClipChange?.(clipped);
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    bringOverlayToFront(this.el);
  }

  // 現在位置を要求座標としてビューポート内へクランプし直す。body の中身の変化でサイズが
  // 伸びたときに呼び出し側から呼ぶ — ドラッグで動かした位置はそのまま尊重しつつ、
  // 画面外へのはみ出しだけ戻す。
  public reclamp(): void {
    this.moveTo(this.el.offsetLeft, this.el.offsetTop);
  }

  // 要求座標をビューポート内へクランプして配置する。ドラッグ・resize 再クランプ・
  // 既存ウィンドウを右クリック位置へ動かす呼び出し元の全てから呼ぶ。compact ではボトムシートの
  // 位置を CSS が持つので何もしない(前回の非 compact 時の left/top が残っていれば消す)。
  public moveTo(clientX: number, clientY: number): void {
    if (isCompactViewport()) {
      this.el.style.left = '';
      this.el.style.top = '';
      return;
    }
    const rect = this.el.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.el.style.left = `${pos.x}px`;
    this.el.style.top = `${pos.y}px`;
  }

  // ボタン上からは開始せず、ドラッグ開始点とポインタキャプチャだけ確保する。
  // compact ではボトムシート化していてドラッグ不要なので、そもそも開始しない。
  private handleHeaderPointerDown = (e: PointerEvent): void => {
    if (isCompactViewport()) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = { x: this.el.offsetLeft, y: this.el.offsetTop };
    this.dragging = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // しきい値(CLICK_MOVE_THRESHOLD)を超えて動くまではドラッグ開始とみなさない。
  private handleHeaderPointerMove = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId || this.dragStartClient === null) return;
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    if (!this.dragging && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    this.dragging = true;
    this.moveTo(this.dragStartWindowPos.x + dx, this.dragStartWindowPos.y + dy);
  };

  // ポインタキャプチャを解放してドラッグ状態を終える。
  private handleHeaderPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
    this.dragStartClient = null;
    this.dragging = false;
  };

  // DOM ノードと登録したグローバルリスナを取り除き、overlayManager からも外す。
  // 以後このインスタンスは使えない。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlayManager.close(this.overlayId);
    this.unsubscribeViewport();
    this.el.remove();
  }

  // OverlayHandle 実装: ✕ ボタンと同じ「破棄して呼び出し側へ通知する」経路。ESC・外側クリック
  // どちらで閉じてもここを通るので、onClose の発火経路は一本化される。
  public close(): void {
    this.dispose();
    this.onClose?.();
  }
}
