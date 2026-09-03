// 数値/文字/検索入力の唯一の実装。Enter=確定・blur=確定・Escape=破棄の規約に従い、
// 確定した時点の値だけを通知する。
import { expandHitTarget, stopDragPropagation } from './widget-base';

export type ValueInputType = 'text' | 'number' | 'search' | 'color';

// Escape で編集をどう破棄するか。既定は 'revert'(確定済みの値へ戻す)。'clear'(空にする)を
// 渡してよいのは検索フィールドに限る — 「なんとなく Escape でクリア」が他所へ広がらないよう、
// 例外は呼び出し側にこの型で明示させる。
export type EscapeBehavior = 'revert' | 'clear';

export interface ValueInputOptions {
  readonly type: ValueInputType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly placeholder?: string;
  readonly escapeBehavior?: EscapeBehavior;
}

export class ValueInput {
  public readonly element: HTMLInputElement;
  private readonly escapeBehavior: EscapeBehavior;
  private readonly onCommit: (value: string) => void;
  private readonly onCancel: (() => void) | undefined;
  private committedValue = '';
  private suppressBlurCommit = false;

  // onCommit は Enter・blur・commit() 呼び出しで、確定した値を渡して呼ばれる。
  // onCancel は破棄(Escape・無効値での確定)で呼ばれる — 確定と破棄で別の後処理をしたい
  // 呼び出し側(インライン編集欄を開いたままにするか閉じるか、など)のための任意コールバック。
  public constructor(options: ValueInputOptions, onCommit: (value: string) => void, onCancel?: () => void) {
    this.escapeBehavior = options.escapeBehavior ?? 'revert';
    this.onCommit = onCommit;
    this.onCancel = onCancel;
    this.element = document.createElement('input');
    this.element.type = options.type;
    this.element.className = 'w-input';
    if (options.min !== undefined) this.element.min = String(options.min);
    if (options.max !== undefined) this.element.max = String(options.max);
    if (options.step !== undefined) this.element.step = String(options.step);
    if (options.placeholder !== undefined) this.element.placeholder = options.placeholder;
    stopDragPropagation(this.element);
    expandHitTarget(this.element);
    this.element.addEventListener('keydown', (e) => {
      // 打鍵をゲーム操作と誤認されないよう伝播を止める。
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    });
    // Enter/Escape 以外でのフォーカス喪失も確定として扱う。cancel() 側の blur() 呼び出しが
    // これを二重に発火させないよう、suppressBlurCommit で一度だけ無視する。
    this.element.addEventListener('blur', () => {
      if (this.suppressBlurCommit) {
        this.suppressBlurCommit = false;
        return;
      }
      this.commit();
    });
    // ネイティブの色選択ダイアログは Enter/Escape を発火せず blur も遅れがちなので、
    // 確定を示す change でも commit する。
    if (options.type === 'color') this.element.addEventListener('change', () => this.commit());
  }

  // 表示値を確定済みの値として設定する。
  public setValue(value: string): void {
    this.committedValue = value;
    this.element.value = value;
  }

  // 入力中の値を確定として通知する。前回確定した値と変わっていなければ何もしない —
  // 何も編集せずフォーカスを外しただけで呼び出し側の状態(後続ノードなど)が壊れないようにする。
  // 数値欄で非数値・空欄なら破棄扱いにする。
  public commit(): void {
    const text = this.element.value;
    if (this.element.type === 'number' && (text.trim() === '' || !isFinite(Number(text)))) {
      this.cancel();
      return;
    }
    if (text === this.committedValue) return;
    this.committedValue = text;
    this.onCommit(text);
  }

  // 編集を破棄する。revert は確定済みの値へ戻し、clear(検索欄限定)は空にする。
  public cancel(): void {
    this.suppressBlurCommit = true;
    if (this.escapeBehavior === 'clear') {
      this.committedValue = '';
      this.element.value = '';
    } else {
      this.element.value = this.committedValue;
    }
    this.element.blur();
    this.onCancel?.();
  }
}
