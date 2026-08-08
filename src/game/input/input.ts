// キーボード・マウス入力の集約。押下中キーの参照(down)に加え、
// 1フレームぶんのエッジトリガ(押した瞬間のキー/クリック/右クリック/マウス移動量)を
// update() で確定させる。エッジトリガは先着順の消費モデルで、
// take* の handler が true を返したイベントはキューから取り除かれる。
import { CTRL_GUARD_KEYS, KeyBinding, SCROLL_GUARD_KEYS } from './key-mapping';

export interface MouseDelta {
  dx: number;
  dy: number;
  panDx: number;
  panDy: number;
  wheel: number;
}

// 画面座標のポインタイベント1件(クリック・右クリック)。
export interface PointerPoint {
  x: number;
  y: number;
}

const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い

// どの操作にも割り当てていないが、押されるとフォーカスが移動してゲームが操作不能に
// なるため既定動作だけ止めるキー。
const FOCUS_GUARD_CODE = 'Tab';

// code がこのキー割り当てに一致するか(altCodes も含めて)判定する。
function matchesCode(key: KeyBinding, code: string): boolean {
  return key.code === code || (key.altCodes?.includes(code) ?? false);
}

const ZERO_MOUSE_DELTA: MouseDelta = { dx: 0, dy: 0, panDx: 0, panDy: 0, wheel: 0 };

// macOS では Command キーを押している間、他のキーの keyup がページに配送されない。
// その間に離されたキーは押しっぱなしとして残り続けるため、Command が離された時点で
// 押下中セット全体を捨てる(どのキーが実際に離されたかは知りようがない)。
const META_CODES = ['MetaLeft', 'MetaRight'];

export class Input {
  private keys = new Set<string>();
  private pendingPresses: string[] = [];
  private pendingClicks: PointerPoint[] = [];
  private pendingMiddleClicks: PointerPoint[] = [];
  private pendingRightClicks: PointerPoint[] = [];
  private dx = 0;
  private dy = 0;
  private panDx = 0;
  private panDy = 0;
  private wheel = 0;
  private framePresses: string[] = [];
  private frameClicks: PointerPoint[] = [];
  private frameMiddleClicks: PointerPoint[] = [];
  private frameRightClicks: PointerPoint[] = [];
  private frameMouse: MouseDelta = ZERO_MOUSE_DELTA;
  private dragging = false;
  private panDragging = false;
  private rightActive = false;
  private panDragMoved = 0;
  private dragMoved = 0;
  private rightDragMoved = 0;
  // タッチ用: アクティブポインタの座標(ピンチズーム判定に使う)
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  onFirstGesture: (() => void) | null = null;
  private gestureFired = false;

  // キーボード・ポインタ・ホイールのイベントリスナーを登録する。
  constructor(target: HTMLElement) {
    this.attachKeyboardListeners();
    this.attachPointerListeners(target);
    this.attachWheelListener(target);
  }

  // キーボードイベントを購読し、押下エッジと押下中セットを更新する。
  private attachKeyboardListeners(): void {
    window.addEventListener('keydown', (e) => {
      // Space スクロール・矢印キーのページスクロールと、割り当ての無い Tab による
      // フォーカス移動(ゲームが操作不能になる)を抑止する
      if (e.code === FOCUS_GUARD_CODE || SCROLL_GUARD_KEYS.some((k) => matchesCode(k, e.code))) {
        e.preventDefault();
      }
      if (e.ctrlKey && CTRL_GUARD_KEYS.some((k) => k.code === e.code)) {
        e.preventDefault();
      }
      if (!e.repeat) this.pendingPresses.push(e.code);
      this.keys.add(e.code);
      this.fireGesture();
    });
    window.addEventListener('keyup', (e) => {
      if (META_CODES.includes(e.code)) this.releaseAll();
      else this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('pagehide', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  // 押下中・ドラッグ中の状態をすべて解除する。keyup / pointerup が届かないまま
  // 操作が中断された場合の復帰点。
  private releaseAll(): void {
    this.keys.clear();
    this.dragging = false;
    this.panDragging = false;
  }

  // target のポインタイベントを購読する。
  private attachPointerListeners(target: HTMLElement): void {
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.style.touchAction = 'none'; // ブラウザのスクロール/ピンチを奪う
    target.addEventListener('pointerdown', (e) => this.onPointerDown(target, e));
    target.addEventListener('pointermove', (e) => this.onPointerMove(e));
    target.addEventListener('pointerup', (e) => this.onPointerUp(e));
    target.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
  }

  // 左ボタン・右ボタンはともにドラッグ/ピンチ開始(右クリックは閾値未満ならコンテキストメニュー用のクリックとして扱う)、中ボタンはパン開始として扱う。
  private onPointerDown(target: HTMLElement, e: PointerEvent): void {
    this.fireGesture();
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        // 2本指になったらドラッグをやめてピンチズームに移行
        this.dragging = false;
        this.pinchDist = this.currentPinchDist();
      } else if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragMoved = 0;
        target.setPointerCapture(e.pointerId);
      }
    } else if (isRight) {
      this.rightActive = true;
      this.rightDragMoved = 0;
      target.setPointerCapture(e.pointerId);
    } else if (e.button === 1) {
      // 中ボタンの既定動作(オートスクロール)を抑止する。
      e.preventDefault();
      this.panDragging = true;
      this.panDragMoved = 0;
      target.setPointerCapture(e.pointerId);
    }
  }

  // アクティブなジェスチャ(ピンチ/パン/ドラッグ)に応じて移動量を積算する。
  private onPointerMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pointers.size >= 2) {
      // ピンチ: 指の間隔の変化をホイール量へ変換(開く = ズームイン)
      const d = this.currentPinchDist();
      this.wheel += (this.pinchDist - d) * 3;
      this.pinchDist = d;
      return;
    }
    if (this.panDragging) {
      this.panDx += e.movementX;
      this.panDy += e.movementY;
      this.panDragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
      return;
    }
    if (this.rightActive) {
      this.rightDragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
      return;
    }
    if (this.dragging) {
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
    }
  }

  // ドラッグ量が閾値未満ならクリックとして記録し、各ジェスチャを終了する。
  private onPointerUp = (e: PointerEvent): void => {
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft || e.pointerType === 'touch') {
      this.pointers.delete(e.pointerId);
      if (this.dragging) this.pushIfClick(this.pendingClicks, this.dragMoved, e);
      this.dragging = false;
      this.pinchDist = 0;
    }
    if (e.button === 1) {
      if (this.panDragging) this.pushIfClick(this.pendingMiddleClicks, this.panDragMoved, e);
      this.panDragging = false;
    }
    if (isRight) {
      if (this.rightActive) {
        if (this.rightDragMoved < 50) {
          this.pendingRightClicks.push({ x: e.clientX, y: e.clientY });
        }
      }
      this.rightActive = false;
    }
  }

  // ポインタ消失時に全ジェスチャ状態をリセットする。
  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.dragging = false;
    this.panDragging = false;
    this.rightActive = false;
    this.pinchDist = 0;
  }

  // moved が閾値未満(ドラッグでなくクリック)なら e の座標を queue に積む。
  // 左・中・右ボタン共通のクリック判定はここに一本化する。
  private pushIfClick(queue: PointerPoint[], moved: number, e: PointerEvent): void {
    if (moved < CLICK_MOVE_THRESHOLD) queue.push({ x: e.clientX, y: e.clientY });
  }

  // ホイール操作を wheel 量として積算する。
  private attachWheelListener(target: HTMLElement): void {
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += e.deltaY;
      },
      { passive: false },
    );
  }

  // アクティブな2点間の距離を返す。
  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // タッチ UI などからの仮想キー入力。物理キーボードと同じ扱いで
  // 押下中セットとエッジトリガキューへ反映する。
  setVirtualKey(key: KeyBinding, down: boolean): void {
    this.fireGesture();
    if (down) {
      if (!this.keys.has(key.code)) this.pendingPresses.push(key.code);
      this.keys.add(key.code);
    } else {
      this.keys.delete(key.code);
    }
  }

  // 初回のユーザー操作で一度だけ onFirstGesture を呼ぶ。
  private fireGesture(): void {
    if (!this.gestureFired && this.onFirstGesture) {
      this.gestureFired = true;
      this.onFirstGesture();
    }
  }

  // key が現在押下中か返す。
  down(key: KeyBinding): boolean {
    return this.keys.has(key.code) || (key.altCodes?.some((c) => this.keys.has(c)) ?? false);
  }

  // フレームの先頭で1度だけ呼ぶ。イベントハンドラが溜めた未確定分を今フレームの
  // スナップショットとして確定し、次フレーム分の蓄積をリセットする。
  update(): void {
    // 蓄積分を今フレームのスナップショットとして確定
    this.framePresses = this.pendingPresses;
    this.frameClicks = this.pendingClicks;
    this.frameMiddleClicks = this.pendingMiddleClicks;
    this.frameRightClicks = this.pendingRightClicks;
    this.frameMouse = { dx: this.dx, dy: this.dy, panDx: this.panDx, panDy: this.panDy, wheel: this.wheel };
    // 次フレーム分の蓄積をリセット
    this.pendingPresses = [];
    this.pendingClicks = [];
    this.pendingMiddleClicks = [];
    this.pendingRightClicks = [];
    this.dx = 0;
    this.dy = 0;
    this.panDx = 0;
    this.panDy = 0;
    this.wheel = 0;
  }

  // 今フレームの押下エッジに key があれば消費して true を返す。
  takeKey(key: KeyBinding): boolean {
    const i = this.framePresses.findIndex((code) => matchesCode(key, code));
    if (i === -1) return false;
    this.framePresses.splice(i, 1);
    return true;
  }

  // 今フレームの未消費の押下エッジを順に渡し、handler が true を返したものを消費する。
  takeKeys(handler: (code: string) => boolean): void {
    for (const code of [...this.framePresses]) {
      if (!handler(code)) continue;
      const i = this.framePresses.indexOf(code);
      if (i !== -1) this.framePresses.splice(i, 1);
    }
  }

  // 今フレームの未消費の左クリック(ドラッグでない短い押下)を順に渡し、handler が true を返したものを消費する。
  takeClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameClicks, handler);
  }

  // 今フレームの未消費の中ボタンクリックを順に渡し、handler が true を返したものを消費する。
  takeMiddleClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameMiddleClicks, handler);
  }

  // 今フレームの未消費の右ボタン押下を順に渡し、handler が true を返したものを消費する。
  takeRightClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameRightClicks, handler);
  }

  // 今フレームのマウス移動量・パン量・ホイール量を返す。
  mouse(): MouseDelta {
    return this.frameMouse;
  }
}

// queue から handler が true を返した要素を取り除きながら順に渡す。
function takeFrom(queue: PointerPoint[], handler: (point: PointerPoint) => boolean): void {
  for (const point of [...queue]) {
    if (!handler(point)) continue;
    const i = queue.indexOf(point);
    if (i !== -1) queue.splice(i, 1);
  }
}
