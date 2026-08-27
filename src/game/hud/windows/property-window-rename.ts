// プロパティウィンドウのタイトルをその場で改名する UI。onRename が渡されたときだけヘッダに
// 改名ボタンを追加し、押すとタイトル要素を入力欄へ差し替える。確定した文字列は onRename へ
// 通知し、表示をタイトル要素へ戻すところまでを持つ。
import { Button, ValueInput } from '../widgets';
import type { DraggableWindow } from './draggable-window';

export class PropertyWindowRename {
  private titleMainEl: HTMLElement;
  private readonly renameCallback: ((name: string) => void) | null;
  private renaming = false;
  private lastTitle: string;

  // タイトル要素を覚え、onRename が渡されたときだけヘッダへ改名ボタンを足す。
  public constructor(
    private readonly win: DraggableWindow, initialTitle: string, onRename: ((name: string) => void) | null,
  ) {
    this.lastTitle = initialTitle;
    this.renameCallback = onRename;
    this.titleMainEl = win.element.querySelector<HTMLElement>('.dg-window-title-main')!;
    // onRename を持つ対象にだけ改名ボタンを添える。
    if (this.renameCallback) {
      const renameBtn = new Button('✎', () => this.startRename());
      renameBtn.element.classList.add('dg-window-btn');
      renameBtn.element.title = '名前を変更';
      renameBtn.element.setAttribute('aria-label', '名前を変更');
      win.headerExtras.appendChild(renameBtn.element);
    }
  }

  // タイトルが書き換わったことを伝える。次に改名を開始したときの入力欄の初期値、および
  // 確定文字列が変化したかどうかの比較対象として使う。
  public updateTitle(title: string): void {
    this.lastTitle = title;
  }

  // タイトルを編集用の入力欄へ差し替え、確定(Enter/blur)で renameCallback へ通知して表示へ戻す。
  private startRename(): void {
    if (this.renaming || !this.renameCallback) return;
    this.renaming = true;
    // 確定(Enter/blur)・破棄(Escape)のどちらでも finishRename へ合流させる。
    const input = new ValueInput(
      { type: 'text' },
      (text) => this.finishRename(input, text),
      () => this.finishRename(input, null),
    );
    input.element.classList.add('prop-window-title-input');
    input.element.maxLength = 40;
    input.setValue(this.lastTitle);
    // タイトル表示要素を入力欄へ差し替え、そのまま編集を始められるようにする。
    this.titleMainEl.replaceWith(input.element);
    this.titleMainEl = input.element;
    input.element.focus();
    input.element.select();
  }

  // リネーム入力欄を終える。value が確定文字列なら(かつ現在のタイトルと異なれば)
  // renameCallback へ通知し、表示をタイトル要素へ戻す。破棄(Escape/無効値)は value が null。
  private finishRename(input: ValueInput, value: string | null): void {
    if (!this.renaming) return;
    this.renaming = false;
    const displayEl = this.win.element.querySelector<HTMLElement>('.dg-window-title-main')!;
    input.element.replaceWith(displayEl);
    this.titleMainEl = displayEl;
    const trimmed = value?.trim();
    if (trimmed && trimmed !== this.lastTitle) this.renameCallback?.(trimmed);
  }
}
