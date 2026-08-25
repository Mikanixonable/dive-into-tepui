// ドラッグして動かせる、📌 でクリップできるウィンドウの外枠。ヘッダ(タイトル・サブタイトル・
// 呼び出し側が任意のボタンを差し込める枠・📌・✕)・ヘッダのドラッグによる移動
// (CLICK_MOVE_THRESHOLD でクリックと区別)・クリップ状態(既存の .clipped クラス)・
// OverlayManager への登録とクリップ状態に応じた宣言更新・ビューポート変化への再クランプ・
// 最前面化を持つ。本文に何を置くかは呼び出し側の責務 — このクラスは body 要素を貸すだけ。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import { CLICK_MOVE_THRESHOLD } from '../../const';
import { clampOverlayPosition, Point2 } from '../layout';
import { bringToFront as bringOverlayToFront } from '../overlay-layer';
import { onViewportChange } from '../viewport';
import { isCompactViewport, MQ_COMPACT } from '../breakpoints';
import { Button, CloseButton } from '../widgets';
import { injectOnce } from '../widgets/inject-style';
import type { OverlayHandle, OverlayManager, OverlaySpec } from '../overlay-manager';

const STYLE = `
#hud .dg-window {
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
  #hud .dg-window {
    right: 0; bottom: 0; width: 100%; min-width: 0; max-width: 100%;
    max-height: 40vh; max-height: 40dvh; overflow-y: auto;
    border-radius: var(--radius-window) var(--radius-window) 0 0;
  }
}
#hud .dg-window-header {
  display: flex; align-items: flex-start; gap: var(--space-3);
  padding: var(--space-5) var(--space-4) var(--space-4) var(--space-5);
  border: 0; background: transparent;
  cursor: move;
}
@media ${MQ_COMPACT} {
  #hud .dg-window-header { cursor: default; }
}
#hud .dg-window-title { flex: 1; min-width: 0; }
#hud .dg-window-title-top { display: flex; align-items: center; gap: var(--space-2); }
#hud .dg-window-title-icon {
  flex: 0 0 var(--font-m); width: var(--font-m); height: var(--font-m);
  color: var(--text); font-size: var(--font-m); line-height: 1; text-align: center;
}
#hud .dg-window-title-icon svg { display: block; width: 100%; height: 100%; }
#hud .dg-window-title-main { flex: 1; min-width: 0; color: var(--text); font-weight: bold; overflow-wrap: break-word; }
#hud .dg-window-title-sub { color: var(--text); opacity: 0.7; font-size: var(--font-s); margin-top: var(--space-1); }
/* 呼び出し側が任意のボタンを差し込める枠。ヘッダの flex 行へ直接子として並んだのと
   同じ見た目にするため、自身は layout に参加しない。 */
#hud .dg-window-header-extras { display: contents; }
#hud .dg-window-btn {
  flex: none; width: 18px; height: 18px; line-height: 18px; text-align: center;
  border: 0; border-radius: var(--radius-micro); background: var(--surface-2); color: var(--text);
  cursor: pointer; font-size: var(--font-s); padding: 0;
}
#hud .dg-window-btn:hover { background: var(--surface-3); color: var(--color-primary-hover); }
#hud .dg-window-btn.clipped { background: var(--color-primary-fill); color: var(--color-primary); }
#hud .dg-window.tgt { background: color-mix(in srgb, var(--color-primary) 16%, var(--glass-focus)); }
#hud .dg-window.on { background: color-mix(in srgb, var(--color-signal) 16%, var(--glass-focus)); }
`;

export interface DraggableWindowOptions {
  readonly title: string;
  readonly subtitle?: string;
  // タイトル前に添える対象種別のグリフ。Unicode 文字または SVG マークアップ(信頼できる
  // 内部生成の文字列のみ)。省略すると添えない。開いた後は変わらない前提で、setHeader の
  // 差分更新対象にはしない。
  readonly icon?: string;
  // クリップ済みの状態で開く。省略時は false。
  readonly initiallyClipped?: boolean;
  // 渡すとクリップされていない間だけこの排他グループに参加する一時ウィンドウになる。
  // 省略すると ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  readonly tempWindowGroup?: string;
}

export class DraggableWindow implements OverlayHandle {
  private static nextId = 0;
  private static readonly UNSET = Symbol('unset');
  private readonly overlayId: string;
  public readonly element: HTMLDivElement;
  public readonly body: HTMLElement;
  public readonly headerExtras: HTMLElement;
  private readonly titleMainEl: HTMLDivElement;
  private readonly titleSubEl: HTMLDivElement;
  private readonly clipBtn: Button;
  private lastTitle = '';
  private lastSubtitle: string | undefined | typeof DraggableWindow.UNSET = DraggableWindow.UNSET;
  private _clipped: boolean;
  private disposed = false;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };
  private dragging = false;

  private readonly onResize: () => void;
  private readonly unsubscribeViewport: () => void;

  // 閉じられた(dispose 済み)ことを呼び出し側へ知らせる。ESC・外側クリック・✕ ボタンの
  // どの経路で閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップボタンで状態が反転したことを通知する。排他は overlayManager 自身が持つので、
  // これは呼び出し側が見た目の追従(一覧の表示等)を行うためだけの通知。
  public onClipChange: ((clipped: boolean) => void) | null = null;
  // OverlayManager からの項目ショートカット配送を受ける。呼び出し側が項目の一致判定を持つ
  // ため、未設定ならショートカットを受け付けない。
  public onShortcut: ((code: string) => boolean) | null = null;

  // clientX/clientY を左上角として root の子として開く。viewport.ts のビューポート変化通知を
  // 購読し、overlayManager へ登録する。
  public constructor(
    root: HTMLElement, clientX: number, clientY: number,
    private readonly options: DraggableWindowOptions, private readonly overlayManager: OverlayManager,
  ) {
    this.overlayId = `dg-window-${DraggableWindow.nextId++}`;
    this._clipped = options.initiallyClipped ?? false;
    injectOnce('dg-window', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'dg-window';
    this.element.setAttribute('role', 'dialog');

    const header = document.createElement('div');
    header.className = 'dg-window-header';
    const title = document.createElement('div');
    title.className = 'dg-window-title';
    // アイコンは題名の行だけと横並びにする(サブタイトルを含めた全体で中央寄せすると、
    // サブタイトルの有無で題名との高さが揃わなくなるため)。
    const titleMain = document.createElement('div');
    titleMain.className = 'dg-window-title-top';
    if (options.icon) {
      const iconEl = document.createElement('div');
      iconEl.className = 'dg-window-title-icon';
      iconEl.setAttribute('aria-hidden', 'true');
      iconEl.innerHTML = options.icon;
      titleMain.appendChild(iconEl);
    }
    this.titleMainEl = document.createElement('div');
    this.titleMainEl.className = 'dg-window-title-main';
    this.titleMainEl.id = `${this.overlayId}-title`;
    this.element.setAttribute('aria-labelledby', this.titleMainEl.id);
    titleMain.appendChild(this.titleMainEl);
    this.titleSubEl = document.createElement('div');
    this.titleSubEl.className = 'dg-window-title-sub';
    title.appendChild(titleMain);
    title.appendChild(this.titleSubEl);

    this.headerExtras = document.createElement('div');
    this.headerExtras.className = 'dg-window-header-extras';

    this.clipBtn = new Button('📌', () => this.setClipped(!this._clipped));
    this.clipBtn.element.classList.add('dg-window-btn');
    this.clipBtn.element.title = 'クリップ';
    this.clipBtn.element.setAttribute('aria-label', 'クリップ');
    this.clipBtn.element.classList.toggle('clipped', this._clipped);

    // ✕ は他の3窓(格納庫/セーブブラウザ/設定)と同じ見た目に統一する。
    const closeBtn = new CloseButton(() => this.close());

    header.appendChild(title);
    header.appendChild(this.headerExtras);
    header.appendChild(this.clipBtn.element);
    header.appendChild(closeBtn.element);
    header.addEventListener('pointerdown', this.handleHeaderPointerDown);
    header.addEventListener('pointermove', this.handleHeaderPointerMove);
    header.addEventListener('pointerup', this.handleHeaderPointerUp);
    header.addEventListener('pointercancel', this.handleHeaderPointerUp);

    this.body = document.createElement('div');

    this.element.appendChild(header);
    this.element.appendChild(this.body);
    this.element.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.element.addEventListener('contextmenu', (e) => e.preventDefault());
    root.appendChild(this.element);

    this.onResize = () => this.moveTo(this.element.offsetLeft, this.element.offsetTop);
    this.unsubscribeViewport = onViewportChange(this.onResize);

    this.setHeader(options.title, options.subtitle);
    this.moveTo(clientX, clientY);
    this.bringToFront();
    this.overlayManager.open(this.overlayId, this, this.currentSpec());
  }

  public contains(target: Node): boolean {
    return this.element.contains(target);
  }

  // OverlayHandle 実装: クリップ中は受け付けない — 一時ウィンドウは高々1枚なので、
  // クリップされていないウィンドウどうしがキーを取り合うことはない。項目の一致判定は
  // 呼び出し側(onShortcut)が持つ。
  public handleShortcut(code: string): boolean {
    if (this._clipped) return false;
    return this.onShortcut?.(code) ?? false;
  }

  // 現在のクリップ状態から overlayManager へ渡す宣言を組む。tempWindowGroup が無ければ
  // (負荷確認ウィンドウ等)常に ESC・外側クリックのどちらでも閉じない常設ウィンドウとして扱う。
  private currentSpec(): OverlaySpec {
    const isTemp = this.options.tempWindowGroup !== undefined && !this._clipped;
    return {
      kind: 'window',
      closeOnEscape: isTemp,
      closeOnOutsideClick: isTemp,
      gatesInput: false,
      exclusiveGroup: isTemp ? this.options.tempWindowGroup : undefined,
    };
  }

  // タイトル・サブタイトルを変化があった要素だけ差分更新する。
  public setHeader(title: string, subtitle: string | undefined): void {
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

  // 対象が現在のターゲット/操作対象であることを示す帯び色。物体一覧パネルの erow.tgt/.on
  // と同じ字面のクラスを、ウィンドウのルート要素に付け替える。
  public setBadge(kind: 'tgt' | 'on' | null): void {
    this.element.classList.toggle('tgt', kind === 'tgt');
    this.element.classList.toggle('on', kind === 'on');
  }

  public get clipped(): boolean {
    return this._clipped;
  }

  // ボタンの見た目を切り替え、overlayManager 上の宣言を今のクリップ状態へ更新したうえで
  // onClipChange を発火する。
  public setClipped(clipped: boolean): void {
    if (clipped === this._clipped) return;
    this._clipped = clipped;
    this.clipBtn.element.classList.toggle('clipped', clipped);
    this.overlayManager.reconfigure(this.overlayId, this.currentSpec());
    this.onClipChange?.(clipped);
  }

  // window レイヤ内で最前面にする。
  public bringToFront(): void {
    bringOverlayToFront(this.element);
  }

  // 現在位置を要求座標としてビューポート内へクランプし直す。内容の変化でサイズが伸びた
  // ときに使う — ドラッグで動かした位置はそのまま尊重しつつ、画面外へのはみ出しだけ戻す。
  private reclamp(): void {
    this.moveTo(this.element.offsetLeft, this.element.offsetTop);
  }

  // 要求座標をビューポート内へクランプして配置する。ドラッグ・resize 再クランプ・
  // 既存ウィンドウを右クリック位置へ動かす呼び出し元の全てから呼ぶ。compact ではボトムシートの
  // 位置を CSS が持つので何もしない(前回の非 compact 時の left/top が残っていれば消す)。
  public moveTo(clientX: number, clientY: number): void {
    if (isCompactViewport()) {
      this.element.style.left = '';
      this.element.style.top = '';
      return;
    }
    const rect = this.element.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.element.style.left = `${pos.x}px`;
    this.element.style.top = `${pos.y}px`;
  }

  // ボタン上からは開始せず、ドラッグ開始点とポインタキャプチャだけ確保する。
  // compact ではボトムシート化していてドラッグ不要なので、そもそも開始しない。
  private handleHeaderPointerDown = (e: PointerEvent): void => {
    if (isCompactViewport()) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = { x: this.element.offsetLeft, y: this.element.offsetTop };
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
    this.element.remove();
  }

  // OverlayHandle 実装: ✕ ボタンと同じ「破棄して呼び出し側へ通知する」経路。ESC・外側クリック
  // どちらで閉じてもここを通るので、onClose の発火経路は一本化される。
  public close(): void {
    this.dispose();
    this.onClose?.();
  }
}
