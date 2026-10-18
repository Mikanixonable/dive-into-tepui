// 取り消しにくい操作を OverlayManager の入力ゲート下で確認する共通モーダル。
// 建造の確定確認(ConstructionConfirmationPort)を含め、題名+説明+確定/取消の確認は
// すべてこの1枚が担う。開閉の骨組みは ModalOverlay が持つ。
import { KEY_MAPPING } from '../../input/key-mapping';
import { injectOnce } from '../inject-style';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { Button } from '../widgets/button';
import { ModalOverlay } from './modal-overlay';

const STYLE = `
#hud .confirmation-overlay {
  position: absolute; inset: 0; display: grid; place-items: center; padding: var(--space-6);
  pointer-events: auto;
}
#hud .confirmation-overlay[hidden] { display: none !important; }
#hud .confirmation-overlay-panel {
  display: grid; gap: var(--space-5);
  width: min(32rem, calc(100vw - var(--space-6) * 2)); max-height: var(--overlay-max-h-s);
  overflow-y: auto; padding: var(--space-6); color: var(--text);
}
#hud .confirmation-overlay-title {
  display: flex; align-items: center; gap: var(--space-4); margin: 0;
  color: var(--text-strong); font-size: var(--font-l); font-weight: 600;
}
#hud .confirmation-overlay-panel[data-destructive="true"] .confirmation-overlay-title::before {
  content: '▲'; color: var(--role-warning); font-size: var(--font-s);
}
#hud .confirmation-overlay-message { margin: 0; color: var(--text-muted); white-space: pre-wrap; line-height: 1.6; }
#hud .confirmation-overlay-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
#hud .confirmation-overlay-actions .w-btn { display: inline-flex; align-items: center; }
`;

export interface ConfirmationOverlayRequest {
  readonly title?: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  // 取り消せない結果を伴う操作の確認なら true。題名へ記号 ▲ を添え、確定ボタンを警告の面にする。
  readonly destructive?: boolean;
}

export class ConfirmationOverlay implements OverlayHandle {
  private readonly shell: ModalOverlay<boolean>;
  private readonly confirm: Button;
  private readonly cancel: Button;

  // モーダルの骨組みを組み、確定/取消ボタンを操作行へ置く。
  public constructor(overlayManager: OverlayManager) {
    injectOnce('confirmation-overlay', STYLE);
    this.shell = new ModalOverlay<boolean>(overlayManager, 'confirmation-overlay');
    this.confirm = new Button('実行', () => this.shell.resolve(true));
    this.cancel = new Button(
      'キャンセル', () => this.shell.resolve(false), undefined, undefined, KEY_MAPPING.pauseMenu.label,
    );
    this.shell.actions.append(this.cancel.element, this.confirm.element);
  }

  // 確認を一枚だけ開く。既存の確認が開いていれば取消として解決してから重ねない。
  // onResult は確定で true、取消・ESCで false を受け取る。
  public open(request: ConfirmationOverlayRequest, onResult: (confirmed: boolean) => void): void {
    this.confirm.setLabel(request.confirmLabel ?? '実行');
    this.cancel.setLabel(request.cancelLabel ?? 'キャンセル');
    const destructive = request.destructive === true;
    this.shell.panel.dataset['destructive'] = String(destructive);
    this.confirm.element.classList.toggle('w-btn--danger', destructive);
    this.confirm.element.classList.toggle('w-btn--primary', !destructive);
    this.shell.open(request, false, onResult);
    // 取り消せない結果を伴うので、Enter で即確定しないよう取消へフォーカスを置く。
    this.cancel.element.focus();
  }

  // open() と同じ要求形状の別名。要求/結果の契約を持つ呼び出し側はこちらを使う。
  public request(request: ConfirmationOverlayRequest, onResult: (confirmed: boolean) => void): void {
    this.open(request, onResult);
  }

  public contains(target: Node): boolean { return this.shell.contains(target); }

  // DOM と登録を取り除く。以後このインスタンスは使えない。
  public dispose(): void {
    this.shell.dispose();
  }

  // ESCと取消ボタンを同じ取消結果(false)へ集約する。
  public close(): void {
    this.shell.close();
  }
}
