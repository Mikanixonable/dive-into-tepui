// HUD の全オーバーレイ(モーダル・ポップアップ・ウィンドウ)を一つの台帳へ登録し、
// 重なり順(最前面が誰か)・ESC の配送先・項目ショートカットの配送先・外側クリックでの
// 自動クローズ・入力ゲート・ゲームの一時停止を一元的に決める。登録されたオーバーレイどうしの
// 論理的な順序を持ち、外側クリックの判定は1箇所のキャプチャリスナに集約する。
//
// オーバーレイの表面の DOM の置き場は、この台帳へ渡す spec.kind から一意に決まる
// (KIND_LAYER)。呼び出し側は自分で #hud の層を選んで要素を置かない — 開くときに
// 要素を渡し、台帳が kind の層へ移す。
import { createHudElement } from './hud-element';
import type { OverlayLayers, OverlayLayerName } from './overlay-layer';

// 表面を持つオーバーレイの種別。'mode' は表面を持たない論理登録(建造モードのように
// ESC・一時停止・入力の取り合いだけを要するもの)で、openMode からだけ積まれる。
export type OverlayKind = 'modal' | 'popup' | 'window' | 'mode';
type SurfaceKind = Exclude<OverlayKind, 'mode'>;

// kind と #hud 直下の物理層の対応。モーダルはゲート層の遮蔽幕より上でなければならない
// (さもないと開いたモーダル自身の操作まで遮蔽される)ので、最上位の system 層に置く。
const KIND_LAYER: Readonly<Record<SurfaceKind, OverlayLayerName>> = {
  window: 'window', popup: 'popup', modal: 'system',
};

// クリップされていない一時ウィンドウ(プロパティウィンドウ・軌道分析パネル)が同時に高々1枚しか
// 開かないための排他グループ名。クリップ状態の遷移ごとの出し入れは各ウィンドウ自身が持つ。
export const UNCLIPPED_WINDOW_GROUP = 'unclipped-window';

export interface OverlaySpec {
  readonly kind: OverlayKind;
  readonly closeOnEscape: boolean;
  readonly closeOnOutsideClick: boolean;
  // true の間、この一枚が開いているだけで背景(3D世界・タッチパッド)への入力を完全に遮る。
  // 一時停止メニューのように背後を覗き見させたいモーダルは false にする。
  readonly gatesInput: boolean;
  // モーダル表示中に背景を暗くするか。省略時はモーダルなら暗くし、背景を見せるモーダルだけ false にする。
  readonly dimsBackground?: boolean;
  // true の間、この一枚が開いているだけでゲームの時間を止める。省略時は止めない。
  readonly pausesGame?: boolean;
  // 同じ名前を持つオーバーレイは同時に1つしか開かない — 開けば同グループの他方を閉じる。
  readonly exclusiveGroup?: string;
}

// 表面を持つオーバーレイの宣言。open() はこの形だけを受け、kind から置き場を導く。
export type SurfaceSpec = Omit<OverlaySpec, 'kind'> & { readonly kind: SurfaceKind };

// 表面を持たない登録の宣言。openMode() が受ける。kind は 'mode' に固定される。
export type ModeSpec = Omit<OverlaySpec, 'kind'>;

// 各オーバーレイの持ち主が実装する、開閉判定に使うハンドル。閉じる実処理・対象要素の判定は
// 実装側が持つ。
export interface OverlayHandle {
  contains(target: Node): boolean;
  close(): void;
  // 項目ショートカット(キーコード)を1つ受け取り、自分の開いている項目の中に一致する
  // ものがあれば実行して true を返す。実装しないハンドルは対象外として扱われる。
  handleShortcut?(code: string): boolean;
}

interface OverlayEntry {
  readonly id: string;
  // 表面を持つオーバーレイの要素。'mode' 登録は null。
  readonly element: HTMLElement | null;
  readonly handle: OverlayHandle;
  spec: OverlaySpec;
}

// 現在フォーカスしている要素がテキスト入力(input/textarea/contentEditable)かどうかを返す。
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export class OverlayManager {
  private readonly stack: OverlayEntry[] = [];
  private readonly shield: HTMLElement;
  private wasModalOpen = false;

  // layers は #hud 直下の重なり順レイヤ一式。遮蔽幕(shield)は入力ゲート用の全画面要素で、
  // ゲート層へここで1枚だけ作る。
  public constructor(private readonly layers: OverlayLayers) {
    this.shield = createHudElement('div', 'hud-overlay-shield', layers.gate);
    this.shield.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    this.shield.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    // 外側クリックを捕捉する唯一のキャプチャリスナ。登録済みの各オーバーレイの contains/close を
    // 通じて判定・応答する。
    document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.sync();
  }

  // id のオーバーレイが現在開いているかどうかを返す。
  public isOverlayOpen(id: string): boolean {
    return this.stack.some((e) => e.id === id);
  }

  // 入力をゲートしているオーバーレイ(kind:'modal' かつ gatesInput:true)が1つでも開いているか。
  // 個々のオーバーレイの ID を直接指定せずに「背景入力を遮蔽すべきか」を判定して返す。
  public isInputGated(): boolean {
    return this.stack.some((e) => e.spec.kind === 'modal' && e.spec.gatesInput);
  }

  // ゲームの時間を止めるオーバーレイ(pausesGame:true)が1つでも開いているか。
  public isGamePaused(): boolean {
    return this.stack.some((e) => e.spec.pausesGame === true);
  }

  // handle を id で開く/最前面へ動かす。element は spec.kind の層へ移され、その層の最前面になる —
  // 呼び出し側は層を選ばない。既に同じ id があれば一旦外してから積み直す。
  // 排他グループが指定されていれば、同グループの他の開いているオーバーレイを先に閉じる。
  public open(id: string, element: HTMLElement, handle: OverlayHandle, spec: SurfaceSpec): void {
    this.layers[KIND_LAYER[spec.kind]].appendChild(element);
    this.close(id);
    this.evictGroup(id, spec.exclusiveGroup);
    this.stack.push({ id, element, handle, spec });
    this.sync();
  }

  // 表面を持たない論理登録(建造モードのような、常設の操作面を別の置き場に持つ状態)を積む。
  // kind は 'mode' になり、DOM の置き場はここでは扱わない。
  public openMode(id: string, handle: OverlayHandle, spec: ModeSpec): void {
    this.close(id);
    this.evictGroup(id, spec.exclusiveGroup);
    this.stack.push({ id, element: null, handle, spec: { ...spec, kind: 'mode' } });
    this.sync();
  }

  // 登録中のオーバーレイを最前面へ動かす。層内の DOM 順と台帳の順はここで一緒に更新される
  // ので、ESC・ショートカット配送の「最前面」と見えている最前面がずれない。
  public raise(id: string): void {
    const index = this.stack.findIndex((e) => e.id === id);
    if (index === -1) return;
    const entry = this.stack.splice(index, 1)[0]!;
    this.stack.push(entry);
    entry.element?.parentElement?.appendChild(entry.element);
    this.sync();
  }

  // 開いたまま宣言だけ更新する(クリップ状態の変化など、最前面への並べ替えを伴わない場合)。
  public reconfigure(id: string, spec: OverlaySpec): void {
    const entry = this.stack.find((e) => e.id === id);
    if (!entry) return;
    entry.spec = spec;
    this.evictGroup(id, spec.exclusiveGroup);
    this.sync();
  }

  // 台帳から外す。未登録の id は無視する(重複呼び出しに対して冪等)。
  public close(id: string): void {
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
  public closeTopmostOnEscape(): boolean {
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
  // 実行する。handleShortcut を持たない/一致しないハンドルは素通りして1つ下を試すので、
  // 手前の対象外なオーバーレイの下に積まれたものまで配送が届く。テキスト入力へフォーカスが
  // ある間は誰にも配らない。
  public dispatchShortcut(code: string): boolean {
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
    const dimBackground = this.stack.some(
      (e) => e.spec.kind === 'modal' && e.spec.dimsBackground !== false,
    );
    const gateInput = this.isInputGated();
    this.shield.style.pointerEvents = gateInput ? 'auto' : 'none';
    this.layers.gate.classList.toggle('hud-overlay-gate', gateInput);
    document.body.classList.toggle('hud-overlay-modal-open', modalOpen);
    document.body.classList.toggle('hud-overlay-dim-background', dimBackground);
    // 「開いている限り毎回」ではなく、モーダルが無→有に変わった瞬間だけ発火する — 2枚開いた
    // 状態から1枚閉じただけで押しっぱなしの仮想キーを全解放してしまうのを防ぐ。
    if (modalOpen && !this.wasModalOpen) window.dispatchEvent(new Event('tepui-release-touch-inputs'));
    this.wasModalOpen = modalOpen;
  }
}
