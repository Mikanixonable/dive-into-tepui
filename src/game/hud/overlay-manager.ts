// HUD の全オーバーレイ(モーダル・ポップアップ・ウィンドウ)を一つの台帳へ登録し、
// 重なり順(最前面が誰か)・ESC の配送先・項目ショートカットの配送先・外側クリックでの
// 自動クローズ・入力ゲートを一元的に決める。層(#hud-layer-*)自体の前後関係は
// overlay-layer.ts が持つ — このクラスが持つのは登録されたオーバーレイどうしの論理的な順序だけ。
// 外側クリックは1箇所のキャプチャリスナへ集約し、各オーバーレイはここへ登録するだけにする。

export type OverlayKind = 'modal' | 'popup' | 'window';

// クリップされていない一時ウィンドウ(プロパティウィンドウ・軌道分析パネル)が同時に高々1枚しか
// 開かないための排他グループ名。クリップ状態の遷移ごとの出し入れは各ウィンドウ自身が持つ。
export const TEMP_WINDOW_GROUP = 'property-window-temp';

export interface OverlaySpec {
  readonly kind: OverlayKind;
  readonly closeOnEscape: boolean;
  readonly closeOnOutsideClick: boolean;
  // true の間、この一枚が開いているだけで背景(3D世界・タッチパッド)への入力を完全に遮る。
  // 一時停止メニューのように背後を覗き見させたいモーダルは false にする。
  readonly gatesInput: boolean;
  // 同じ名前を持つオーバーレイは同時に1つしか開かない — 開けば同グループの他方を閉じる。
  readonly exclusiveGroup?: string;
}

// 開閉の実処理・対象要素は各オーバーレイの持ち主が持つ。このクラスは持ち主の参照を
// 束ねるだけで、閉じ方そのものには関与しない。
export interface OverlayHandle {
  contains(target: Node): boolean;
  close(): void;
  // 項目ショートカット(キーコード)を1つ受け取り、自分の開いている項目の中に一致する
  // ものがあれば実行して true を返す。実装しないハンドルは対象外として扱われる。
  handleShortcut?(code: string): boolean;
}

interface OverlayEntry {
  readonly id: string;
  readonly handle: OverlayHandle;
  spec: OverlaySpec;
}

// テキスト入力へフォーカスがある間は項目ショートカットの対象から外す — ValueInput 自身の
// stopPropagation は DOM の伝播経路を止めるだけで、Input の window keydown 購読とは別経路
// (フォーカス中の要素を素通りしてしまう構成)になり得るため、配送側でも独立に判定する。
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export class OverlayManager {
  private readonly stack: OverlayEntry[] = [];
  private wasModalOpen = false;

  // shield は入力ゲート中に背景の 3D 入力を遮る全画面要素、gateLayer はその親レイヤ
  // (#hud-layer-gate)。いずれも buildHudDom が構築して渡す。
  constructor(private readonly shield: HTMLElement, private readonly gateLayer: HTMLElement) {
    shield.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    shield.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    // 外側クリックを拾う唯一のキャプチャリスナ。個々のオーバーレイは自分で document へ
    // リスナを張らず、ここへ登録した contains/close を通じて判定・応答させる。
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.sync();
  }

  isOverlayOpen(id: string): boolean {
    return this.stack.some((e) => e.id === id);
  }

  // 入力をゲートしているオーバーレイ(kind:'modal' かつ gatesInput:true)が1つでも開いているか。
  // 個々のオーバーレイの id を名指しせずに「背景入力を遮るべきか」を答える。
  isInputGated(): boolean {
    return this.stack.some((e) => e.spec.kind === 'modal' && e.spec.gatesInput);
  }

  // handle を id で開く/最前面へ動かす。既に同じ id があれば一旦外してから積み直す。
  // 排他グループが指定されていれば、同グループの他の開いているオーバーレイを先に閉じる。
  open(id: string, handle: OverlayHandle, spec: OverlaySpec): void {
    this.close(id);
    this.evictGroup(id, spec.exclusiveGroup);
    this.stack.push({ id, handle, spec });
    this.sync();
  }

  // 開いたまま宣言だけ更新する(クリップ状態の変化など、最前面への並べ替えを伴わない場合)。
  reconfigure(id: string, spec: OverlaySpec): void {
    const entry = this.stack.find((e) => e.id === id);
    if (!entry) return;
    entry.spec = spec;
    this.evictGroup(id, spec.exclusiveGroup);
    this.sync();
  }

  // 台帳から外す。未登録の id は無視する(重複呼び出しに対して冪等)。
  close(id: string): void {
    const i = this.stack.findIndex((e) => e.id === id);
    if (i === -1) return;
    this.stack.splice(i, 1);
    this.sync();
  }

  // exceptId 以外で group に属する開いているオーバーレイを閉じる。
  private evictGroup(exceptId: string, group: string | undefined): void {
    if (group === undefined) return;
    for (const other of [...this.stack]) {
      if (other.id !== exceptId && other.spec.exclusiveGroup === group) other.handle.close();
    }
  }

  // 最前面から順に、ESC で閉じられるオーバーレイを1つだけ閉じる。閉じるものが無ければ false を返す。
  closeTopmostOnEscape(): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i]!;
      if (entry.spec.closeOnEscape) {
        entry.handle.close();
        return true;
      }
    }
    return false;
  }

  // 最前面から順に、code に一致する項目ショートカットを持つオーバーレイを探して1つだけ
  // 実行する。closeTopmostOnEscape の兄弟 — handleShortcut を持たない/一致しないハンドルは
  // 素通りして1つ下を試す(クリップ中の PropertyWindow は常に false を返すので、その下に
  // 積まれた一時ウィンドウまで届く)。テキスト入力へフォーカスがある間は誰にも配らない。
  dispatchShortcut(code: string): boolean {
    if (isTextInputFocused()) return false;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i]!;
      if (entry.handle.handleShortcut?.(code)) return true;
    }
    return false;
  }

  // 独立に開いている複数のオーバーレイが同時に「外側クリックで閉じる」対象になり得るので、
  // 最前面の1枚だけでなく該当する全てを閉じる。
  private readonly handleOutsidePointerDown = (e: PointerEvent): void => {
    if (!(e.target instanceof Node)) return;
    const target = e.target;
    for (const entry of [...this.stack]) {
      if (!entry.spec.closeOnOutsideClick) continue;
      if (entry.handle.contains(target)) continue;
      entry.handle.close();
    }
  };

  // 台帳の内容から入力ゲート・タッチ解放イベントの発火可否を導出し、DOM へ反映する。
  private sync(): void {
    const modalOpen = this.stack.some((e) => e.spec.kind === 'modal');
    const gateInput = this.isInputGated();
    this.shield.style.pointerEvents = gateInput ? 'auto' : 'none';
    this.gateLayer.classList.toggle('hud-overlay-gate', gateInput);
    document.body.classList.toggle('hud-overlay-modal-open', modalOpen);
    // 「開いている限り毎回」ではなく、モーダルが無→有に変わった瞬間だけ発火する — 2枚開いた
    // 状態から1枚閉じただけで押しっぱなしの仮想キーを全解放してしまうのを防ぐ。
    if (modalOpen && !this.wasModalOpen) window.dispatchEvent(new Event('tepui-release-touch-inputs'));
    this.wasModalOpen = modalOpen;
  }
}
