// 題名・説明・操作ボタンで結果を返すモーダルの共通の骨組み。
// OverlayManager への登録と、確定/取消/ESCを同じ結果callbackへ集約する終端だけを担い、
// 本体(入力欄など)とボタンの意味は使い側が body と actions へ挟み込む。
import type { OverlayHandle, OverlayManager } from '../overlay-manager';

export interface ModalOverlayRequest {
  readonly title?: string;
  readonly message?: string;
}

// 1つの OverlayManager に同じ id で複数登録されると前のオーバーレイが管理を失うため、
// インスタンスごとに固有の id を割り当てる。
let nextModalOverlayId = 1;

export class ModalOverlay<T> implements OverlayHandle {
  private readonly overlayId = `modal-overlay-${nextModalOverlayId++}`;
  public readonly element: HTMLDivElement;
  // 状態属性(destructive など)を書きたいときの対象のパネル。
  public readonly panel: HTMLElement;
  // メッセージと操作行のあいだに挟む、使い側の本体の置き場。
  public readonly body: HTMLElement;
  // 確定・取消ボタンを使い側が並べる行。
  public readonly actions: HTMLElement;
  private readonly title: HTMLElement;
  private readonly message: HTMLElement;
  private onResult: ((value: T) => void) | null = null;
  private cancelValue!: T;
  private openState = false;

  // className はオーバーレイ自身と子要素のクラス名の接頭辞(.modal-overlay-* ではなく
  // .confirmation-overlay-* のように使い側の名前で見える化する)として使う。
  // 要素は open() されるまで DOM へ挿さず、overlayManager が modal の層へ置く。
  public constructor(
    private readonly overlayManager: OverlayManager,
    className: string,
  ) {
    this.element = document.createElement('div');
    this.element.className = className;
    this.element.hidden = true;
    // 題名・説明・本体・操作行の縦積みパネルを組む。
    const panel = document.createElement('div');
    panel.className = `${className}-panel ui-surface-focus`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    this.panel = panel;
    this.title = document.createElement('h3');
    this.title.className = `${className}-title`;
    panel.appendChild(this.title);
    this.message = document.createElement('p');
    this.message.className = `${className}-message`;
    panel.appendChild(this.message);
    this.body = document.createElement('div');
    this.body.className = `${className}-body`;
    panel.appendChild(this.body);
    this.actions = document.createElement('div');
    this.actions.className = `${className}-actions`;
    panel.appendChild(this.actions);
    this.element.appendChild(panel);
    // パネル内の押下を窓ごとのドラッグ・外側クリック判定と混ぜない。
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  // モーダルを一枚だけ開く。既存のモーダルが開いていれば取消として解決してから重ねない。
  // onResult は確定時の値、取消・ESC 時は cancelValue を受け取る。
  public open(request: ModalOverlayRequest, cancelValue: T, onResult: (value: T) => void): void {
    this.resolve(this.cancelValue);
    this.openState = true;
    this.cancelValue = cancelValue;
    this.onResult = onResult;
    // 題名・説明は任意 — 無ければ行ごと畳む。
    this.title.textContent = request.title ?? '';
    this.title.hidden = request.title === undefined || request.title === '';
    this.message.textContent = request.message ?? '';
    this.message.hidden = request.message === undefined || request.message === '';
    this.element.hidden = false;
    this.overlayManager.open(this.overlayId, this.element, this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false,
      gatesInput: true, dimsBackground: true, pausesGame: true,
    });
  }

  public contains(target: Node): boolean { return this.element.contains(target); }

  // DOM と登録を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    this.close();
    this.element.remove();
  }

  // ESC・外側クリックと取消ボタンを同じ取消結果へ集約する。
  public close(): void {
    this.resolve(this.cancelValue);
  }

  // 結果callback、DOM、OverlayManagerを一度だけ同時に閉じる。
  public resolve(value: T): void {
    if (!this.openState) return;
    this.openState = false;
    const callback = this.onResult;
    this.onResult = null;
    this.element.hidden = true;
    this.overlayManager.close(this.overlayId);
    callback?.(value);
  }
}
