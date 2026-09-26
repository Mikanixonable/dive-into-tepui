// ドラッグ移動とピン留め（クリップ）に対応したウィンドウ枠。タイトルやピン留め・閉じるボタンを備え、
// ドラッグ操作、OverlayManager への登録更新、ビューポート変化時の再クランプ、最前面化を制御する。
// 本文要素はコンストラクタの引数として注入する。
// #hud 配下の window レイヤに配置するため、リセットスタイルを上書きできるようセレクタは `#hud` で始める。
import { clampOverlayPosition } from '../layout';
import { onViewportChange } from '../viewport';
import { isCompactViewport, MQ_COMPACT } from '../breakpoints';
import { Button, CloseButton } from '../widgets';
import { injectOnce } from '../inject-style';
import { injectCommonUiStyle } from '../style/common-ui-style';
import type { OverlayHandle, OverlayManager, SurfaceSpec } from '../overlay-manager';
import { wireHeaderDrag } from '../window-drag';

const STYLE = `
#hud .dg-window {
  position: fixed; display: block; min-width: 200px; max-width: 280px;
  pointer-events: auto;
  border-radius: var(--radius-window); overflow: hidden; font-size: var(--font-m);
  font-family: var(--font-family); user-select: none;
  -webkit-user-select: none;
}
/* compact: ドラッグ窓を画面下のボトムシートへ変える。高さは overlay 共通トークンで揃え、
   長いプロパティでも 40% の狭い領域へ押し込まない。 */
@media ${MQ_COMPACT} {
  #hud .dg-window {
    right: 0; bottom: 0; width: 100%; min-width: 0; max-width: 100%;
    max-height: var(--overlay-max-h-l); overflow-y: auto; overscroll-behavior: contain;
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
/* ヘッダの flex 行へ直接子として並んだのと同じ見た目で任意のボタンを追加できる枠。
   自身はレイアウトに参加しない。 */
#hud .dg-window-header-extras { display: contents; }
#hud .dg-window-btn {
  flex: none; width: 18px; height: 18px; line-height: 18px; text-align: center;
  border: 0; border-radius: 50%;
  background: var(--glass-control); color: var(--text);
  cursor: pointer; font-size: var(--font-s); padding: 0;
}
#hud .dg-window-btn:hover { background: var(--glass-control-hover); color: var(--color-primary-hover); }
#hud .dg-window-btn.clipped { background: var(--color-primary-fill); color: var(--color-primary); }
#hud .dg-window.tgt {
  background: color-mix(in srgb, var(--color-primary) 16%, var(--glass-focus));
}
`;

export interface DraggableWindowOptions {
  readonly title: string;
  readonly subtitle?: string;
  // タイトル前に添える対象種別のグリフ。Unicode 文字または SVG マークアップ(信頼できる
  // 内部生成の文字列を渡す)。省略すると添えない。値は開いた時点で固定する。
  readonly icon?: string;
  // クリップ済みの状態で開く。省略時は false。
  readonly initiallyClipped?: boolean;
  // 渡すとクリップされていない間だけこの排他グループに参加する一時ウィンドウになる。
  // 省略すると ESC・外側クリックのどちらでも閉じない常設ウィンドウになる。
  readonly unclippedWindowGroup?: string;
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

  private readonly onResize: () => void;
  private readonly unsubscribeViewport: () => void;

  // 閉じられた(dispose 済み)ことを通知するコールバック。ESC・外側クリック・✕ ボタンの
  // どの経路で閉じても等しく発火する。
  public onClose: (() => void) | null = null;
  // クリップ状態変更の通知コールバック。一覧表示等の追従に利用する。
  public onClipChange: ((clipped: boolean) => void) | null = null;
  // 項目ショートカットの一致判定コールバック。一致したら true を返す。
  public onShortcut: ((code: string) => boolean) | null = null;

  // clientX/clientY を左上角として開く。viewport.ts のビューポート変化通知を購読し、
  // overlayManager へ登録する。要素は overlayManager が window の層へ置く。
  public constructor(
    clientX: number, clientY: number,
    private readonly options: DraggableWindowOptions, private readonly overlayManager: OverlayManager,
  ) {
    this.overlayId = `dg-window-${DraggableWindow.nextId++}`;
    this._clipped = options.initiallyClipped ?? false;
    injectCommonUiStyle();
    injectOnce('dg-window', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'dg-window ui-surface-focus';
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
    this.clipBtn.element.classList.add('dg-window-btn', 'ui-icon-control');
    this.clipBtn.element.title = 'クリップ';
    this.clipBtn.element.setAttribute('aria-label', 'クリップ');
    this.clipBtn.element.classList.toggle('clipped', this._clipped);

    // ✕ は他の窓(セーブブラウザ/設定)と同じ見た目に統一する。
    const closeBtn = new CloseButton(() => this.close());

    header.appendChild(title);
    header.appendChild(this.headerExtras);
    header.appendChild(this.clipBtn.element);
    header.appendChild(closeBtn.element);
    // compact ではボトムシート化しており、ドラッグの起点確保は不要になる。
    wireHeaderDrag(header, {
      position: () => ({ x: this.element.offsetLeft, y: this.element.offsetTop }),
      moveTo: (x, y) => this.moveTo(x, y),
      enabled: () => !isCompactViewport(),
    });

    this.body = document.createElement('div');

    this.element.appendChild(header);
    this.element.appendChild(this.body);
    this.element.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.element.addEventListener('contextmenu', (e) => e.preventDefault());

    this.onResize = () => this.moveTo(this.element.offsetLeft, this.element.offsetTop);
    this.unsubscribeViewport = onViewportChange(this.onResize);

    this.setHeader(options.title, options.subtitle);
    // 先に登録して要素を DOM へ置いてから、実寸を測って位置を決める。
    this.overlayManager.open(this.overlayId, this.element, this, this.currentSpec());
    this.moveTo(clientX, clientY);
  }

  // OverlayHandle 実装。target がウィンドウ要素の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.element.contains(target);
  }

  // OverlayHandle 実装: クリップ中は受け付けない — 一時ウィンドウは高々1枚なので、
  // クリップされていないウィンドウどうしがキーを取り合うことはない。項目の一致判定は
  // onShortcut コールバックへ委譲する。
  public handleShortcut(code: string): boolean {
    if (this._clipped) return false;
    return this.onShortcut?.(code) ?? false;
  }

  // 現在のクリップ状態から overlayManager へ渡す宣言を組む。unclippedWindowGroup が無ければ
  // 常に ESC・外側クリックのどちらでも閉じない常設ウィンドウとして扱う。
  private currentSpec(): SurfaceSpec {
    const isUnclippedExclusive = this.options.unclippedWindowGroup !== undefined && !this._clipped;
    return {
      kind: 'window',
      closeOnEscape: isUnclippedExclusive,
      closeOnOutsideClick: isUnclippedExclusive,
      gatesInput: false,
      exclusiveGroup: isUnclippedExclusive ? this.options.unclippedWindowGroup : undefined,
    };
  }

  // タイトル・サブタイトルを変化があった要素だけ差分更新する。
  public setHeader(title: string, subtitle: string | undefined): void {
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.titleMainEl.textContent = title;
    }
    // サブタイトルの有無で表示行数が変わるため、変化した時だけ再クランプする。
    if (subtitle !== this.lastSubtitle) {
      this.lastSubtitle = subtitle;
      this.titleSubEl.textContent = subtitle ?? '';
      this.titleSubEl.style.display = subtitle ? 'block' : 'none';
      this.reclamp();
    }
  }

  // 対象が現在のターゲットであることを示す帯び色を、ルート要素へ付け替える。
  public setBadge(isTarget: boolean): void {
    this.element.classList.toggle('tgt', isTarget);
  }

  // 現在クリップされているかどうか。
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

  // window レイヤ内で最前面にする。台帳の順も一緒に動くので、ESC・ショートカットの
  // 配送先もこの窓が最前面になる。
  public bringToFront(): void {
    this.overlayManager.raise(this.overlayId);
  }

  // 現在位置を要求座標としてビューポート内へクランプし直す。内容の変化でサイズが伸びた
  // ときに使う — ドラッグで動かした位置はそのまま尊重しつつ、画面外へのはみ出しだけ戻す。
  private reclamp(): void {
    this.moveTo(this.element.offsetLeft, this.element.offsetTop);
  }

  // 要求座標をビューポート内へクランプして配置する。compact ではボトムシートの位置を CSS へ
  // 委ねる(前回の非 compact 時の left/top が残っていれば消す)。
  public moveTo(clientX: number, clientY: number): void {
    if (isCompactViewport()) {
      this.element.style.left = '';
      this.element.style.top = '';
      return;
    }
    const rect = this.element.getBoundingClientRect();
    // ウィンドウの実寸とビューポートに収まるよう要求座標をクランプする。
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.element.style.left = `${pos.x}px`;
    this.element.style.top = `${pos.y}px`;
  }

  // DOM ノードと登録したグローバルリスナを取り除き、overlayManager からも外す。
  // 以後このインスタンスは使えない。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.overlayManager.close(this.overlayId);
    this.unsubscribeViewport();
    this.element.remove();
  }

  // OverlayHandle 実装: ✕ ボタンと同一経路で破棄し、onClose を発火する。
  // ESC・外側クリックいずれで閉じてもここを経由するため、発火経路は一本化される。
  public close(): void {
    this.dispose();
    this.onClose?.();
  }
}
