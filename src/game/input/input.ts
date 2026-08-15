// キーボード・マウス入力の集約。押下中キーの参照(down)に加え、
// 1フレームぶんのエッジトリガ(押した瞬間のキー/クリック/右クリック/マウス移動量)を
// update() で確定させる。エッジトリガは先着順の消費モデルで、
// take* の handler が true を返したイベントはキューから取り除かれる。
import {
  CLICK_MOVE_THRESHOLD,
  RIGHT_CLICK_MOVE_THRESHOLD,
  TOUCH_DOUBLE_TAP_MS,
  TOUCH_DOUBLE_TAP_PX,
  TOUCH_LONG_PRESS_FEEDBACK_MS,
  TOUCH_LONG_PRESS_MS,
} from '../const';
import { KeyBinding, SCROLL_GUARD_KEYS } from './key-mapping';

// 直近に検知した入力の種別。タッチパッドの表示可否(touch.ts)が読む。
export type PointerKind = 'touch' | 'mouse';

export interface MouseDelta {
  dx: number;
  dy: number;
  panDx: number;
  panDy: number;
  wheel: number;
  roll: number;
}

// 画面座標のポインタイベント1件(クリック・右クリック)。
export interface PointerPoint {
  x: number;
  y: number;
}

// どの操作にも割り当てていないが、押されるとフォーカスが移動してゲームが操作不能に
// なるため既定動作だけ止めるキー。
const FOCUS_GUARD_CODE = 'Tab';

// code がこのキー割り当てに一致するか(altCodes も含めて)判定する。
function matchesCode(key: KeyBinding, code: string): boolean {
  return key.code === code || (key.altCodes?.includes(code) ?? false);
}

const ZERO_MOUSE_DELTA: MouseDelta = { dx: 0, dy: 0, panDx: 0, panDy: 0, wheel: 0, roll: 0 };

// macOS では Command キーを押している間、他のキーの keyup がページに配送されない。
// その間に離されたキーは押しっぱなしとして残り続けるため、Command が離された時点で
// 押下中セット全体を捨てる(どのキーが実際に離されたかは知りようがない)。
const META_CODES = ['MetaLeft', 'MetaRight'];

export class Input {
  private keys = new Set<string>();
  // takeHeld で確保済みの code。down()/takeKey()/takeKeys() からは見えなくなる。
  private claimedCodes = new Set<string>();
  private pendingPresses: string[] = [];
  private pendingClicks: PointerPoint[] = [];
  private pendingDoubleClicks: PointerPoint[] = [];
  private pendingMiddleClicks: PointerPoint[] = [];
  private pendingRightClicks: PointerPoint[] = [];
  private dx = 0;
  private dy = 0;
  private panDx = 0;
  private panDy = 0;
  private wheel = 0;
  private roll = 0;
  private framePresses: string[] = [];
  private frameClicks: PointerPoint[] = [];
  private frameDoubleClicks: PointerPoint[] = [];
  private frameMiddleClicks: PointerPoint[] = [];
  private frameRightClicks: PointerPoint[] = [];
  private frameMouse: MouseDelta = ZERO_MOUSE_DELTA;
  private dragging = false;
  private panDragging = false;
  private rightActive = false;
  private panDragMoved = 0;
  private dragMoved = 0;
  private rightDragMoved = 0;
  // タッチ用: アクティブポインタの座標(ピンチズーム・二本指パン判定に使う)
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchCentroid: PointerPoint | null = null;
  private pinchAngle = 0;
  // 直近に検知した入力種別が変わるたびに通知する(タッチ⇄マウス/キーボードの切替を含む)。
  onPointerKindChange: ((kind: PointerKind) => void) | null = null;
  private lastPointerKind: PointerKind | null = null;
  // keydown・pointerdown・仮想キー押下(setVirtualKey の down=true)でのみ発火する
  // (pointermove では発火しない)。
  onUserGesture: (() => void) | null = null;
  // タッチの長押し(右クリック合成)。1本指のジェスチャにしか存在しないので
  // pointers のような Map ではなく単一の状態で持つ。
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressPointerId: number | null = null;
  private longPressFired = false;
  // タッチの長押しに対する視覚フィードバック。point で表示位置を渡し、null で非表示にする。
  onLongPressFeedback: ((point: PointerPoint | null) => void) | null = null;
  // 直近に成立したタップ(ダブルタップ合成用)。タッチ由来でなければ null のまま。
  private lastTap: { x: number; y: number; time: number } | null = null;
  // 直近に成立したクリックがタッチ由来だったか。真なら、二重計上を避けるため
  // ブラウザ標準の dblclick イベントによる合成をこちらで抑止する。
  private lastPointerUpWasTouch = false;
  private readonly target: HTMLElement;

  // キーボード・ポインタ・ホイールのイベントリスナーを登録する。
  constructor(target: HTMLElement) {
    this.target = target;
    this.attachKeyboardListeners();
    this.attachPointerListeners();
    this.attachWheelListener();
  }

  // キーボードイベントを購読し、押下エッジと押下中セットを更新する。
  private attachKeyboardListeners(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('pagehide', this.handlePageHide);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  // keydown を受け、押下エッジ(pendingPresses)と押下中セット(keys)へ反映する。
  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    // Space スクロール・矢印キーのページスクロールと、割り当ての無い Tab による
    // フォーカス移動(ゲームが操作不能になる)を抑止する
    if (e.code === FOCUS_GUARD_CODE || SCROLL_GUARD_KEYS.some((k) => matchesCode(k, e.code))) {
      e.preventDefault();
    }
    if (!e.repeat) {
      this.pendingPresses.push(e.code);
      this.onUserGesture?.();
    }
    this.keys.add(e.code);
    this.notePointerKind('mouse');
  };

  // keyup を受け、Command キーなら押下中状態を丸ごと解除し、それ以外は押下中セットから外す。
  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    if (META_CODES.includes(e.code)) this.releaseAll();
    else this.keys.delete(e.code);
  };

  private readonly handleBlur = (): void => this.releaseAll();
  private readonly handlePageHide = (): void => this.releaseAll();

  // タブが非表示になったら押下中・ドラッグ中の状態をすべて解除する。
  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) this.releaseAll();
  };

  // 押下中・ドラッグ中の状態をすべて解除する。keyup / pointerup が届かないまま
  // 操作が中断された場合の復帰点。
  private releaseAll(): void {
    this.keys.clear();
    this.claimedCodes.clear();
    this.dragging = false;
    this.panDragging = false;
    this.cancelLongPress();
  }

  // target のポインタイベントを購読する。
  private attachPointerListeners(): void {
    this.target.addEventListener('contextmenu', this.handleContextMenu);
    this.target.style.touchAction = 'none'; // ブラウザのスクロール/ピンチを奪う
    this.target.addEventListener('pointerdown', this.handlePointerDown);
    this.target.addEventListener('pointermove', this.handlePointerMove);
    this.target.addEventListener('pointerup', this.handlePointerUp);
    this.target.addEventListener('pointercancel', this.handlePointerCancel);
    // マウスのダブルクリック連打判定(タイミング・移動量とも)はブラウザの標準実装に委ねる。
    // タッチ由来のクリックは自前で合成する(registerTap)ため、二重に積まないよう除外する。
    this.target.addEventListener('dblclick', this.handleDblClick);
  }

  private readonly handleContextMenu = (e: Event): void => e.preventDefault();

  // 左ボタンかつタッチ由来のクリックでなければ、ダブルクリックとして積む。
  private readonly handleDblClick = (e: MouseEvent): void => {
    if (e.button === 0 && !this.lastPointerUpWasTouch) {
      this.pendingDoubleClicks.push({ x: e.clientX, y: e.clientY });
    }
  };

  // 左ボタン・右ボタンはともにドラッグ/ピンチ開始(右クリックは閾値未満ならコンテキストメニュー用のクリックとして扱う)、中ボタンはパン開始として扱う。
  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.notePointerKind(e.pointerType === 'touch' ? 'touch' : 'mouse');
    this.onUserGesture?.();
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft) {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size >= 2) {
        // 2本目以降の指が増えるたびピンチ基準(距離・重心)を今の配置で取り直す —
        // 3本目以降を古い基準のまま扱うと、置いた瞬間に重心が跳んでパンが暴れる。
        this.dragging = false;
        this.pinchDist = this.currentPinchDist();
        this.pinchCentroid = this.currentCentroid();
        this.pinchAngle = this.currentPinchAngle();
        this.cancelLongPress();
      } else if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragMoved = 0;
        this.target.setPointerCapture(e.pointerId);
        if (e.pointerType === 'touch') this.startLongPress(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    } else if (isRight) {
      this.rightActive = true;
      this.rightDragMoved = 0;
      this.target.setPointerCapture(e.pointerId);
    } else if (e.button === 1) {
      // 中ボタンの既定動作(オートスクロール)を抑止する。
      e.preventDefault();
      this.panDragging = true;
      this.panDragMoved = 0;
      this.target.setPointerCapture(e.pointerId);
    }
  };

  // アクティブなジェスチャ(ピンチ/パン/ドラッグ)に応じて移動量を積算する。
  private readonly handlePointerMove = (e: PointerEvent): void => {
    this.notePointerKind(e.pointerType === 'touch' ? 'touch' : 'mouse');
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pointers.size >= 2) {
      // 二本指ジェスチャ: 指の間隔の変化をホイール量へ(開く = ズームイン)、
      // 重心の移動をパン量へ、2点を結ぶ角度の変化をロール量へ、同時に折り込む
      // (実指は回しながら開くため排他にしない)。
      const d = this.currentPinchDist();
      this.wheel += (this.pinchDist - d) * 3;
      this.pinchDist = d;
      const centroid = this.currentCentroid();
      if (this.pinchCentroid) {
        this.panDx += centroid.x - this.pinchCentroid.x;
        this.panDy += centroid.y - this.pinchCentroid.y;
      }
      this.pinchCentroid = centroid;
      const angle = this.currentPinchAngle();
      // -π..π の範囲でしか値を持たない角度どうしの差分は、跨いだぶんを ±2π で
      // 正規化しないと回転方向が反転してしまう。
      let dAngle = angle - this.pinchAngle;
      dAngle = ((dAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      this.roll += dAngle;
      this.pinchAngle = angle;
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
      // 静止条件が崩れたら長押しは成立させない。
      if (this.longPressPointerId === e.pointerId && this.dragMoved >= CLICK_MOVE_THRESHOLD) {
        this.cancelLongPress();
      }
    }
  }

  // ドラッグ量が閾値未満ならクリックとして記録し、各ジェスチャを終了する。
  // 長押しが成立済みのポインタは、離した瞬間に左クリックまで合成しないよう除外する。
  private readonly handlePointerUp = (e: PointerEvent): void => {
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft || e.pointerType === 'touch') {
      this.pointers.delete(e.pointerId);
      // 長押しがすでに右クリックへ結実したポインタは、離した指を左クリックへも
      // 二重に変換しない。
      const longPressConsumed = this.longPressPointerId === e.pointerId && this.longPressFired;
      if (this.dragging && !longPressConsumed) {
        if (this.pushIfClick(this.pendingClicks, this.dragMoved, e)) this.registerTap(e);
      }
      this.dragging = false;
      if (this.pointers.size >= 2) {
        // 3本以上の一部だけが離れてもピンチが続くなら、基準を今の配置で取り直す
        // (onPointerDown が指を増やすたびに行うのと同じ理由)。
        this.pinchDist = this.currentPinchDist();
        this.pinchCentroid = this.currentCentroid();
        this.pinchAngle = this.currentPinchAngle();
      } else {
        this.pinchDist = 0;
        this.pinchCentroid = null;
        this.pinchAngle = 0;
      }
    }
    if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
    if (e.button === 1) {
      if (this.panDragging) this.pushIfClick(this.pendingMiddleClicks, this.panDragMoved, e);
      this.panDragging = false;
    }
    if (isRight) {
      if (this.rightActive) {
        if (this.rightDragMoved < RIGHT_CLICK_MOVE_THRESHOLD) {
          this.pendingRightClicks.push({ x: e.clientX, y: e.clientY });
        }
      }
      this.rightActive = false;
    }
  }

  // ポインタ消失時に全ジェスチャ状態をリセットする。
  private readonly handlePointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.dragging = false;
    this.panDragging = false;
    this.rightActive = false;
    this.pinchDist = 0;
    this.pinchCentroid = null;
    this.pinchAngle = 0;
    if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
  };

  // moved が閾値未満(ドラッグでなくクリック)なら e の座標を queue に積み、積んだかを返す。
  // 左・中・右ボタン共通のクリック判定はここに一本化する。
  private pushIfClick(queue: PointerPoint[], moved: number, e: PointerEvent): boolean {
    if (moved >= CLICK_MOVE_THRESHOLD) return false;
    queue.push({ x: e.clientX, y: e.clientY });
    return true;
  }

  // pointerId の長押しタイマーを開始する。TOUCH_LONG_PRESS_FEEDBACK_MS 後に
  // onLongPressFeedback を、TOUCH_LONG_PRESS_MS 後に右クリックを合成する。
  private startLongPress(pointerId: number, point: PointerPoint): void {
    this.cancelLongPress();
    this.longPressPointerId = pointerId;
    this.longPressFired = false;
    this.longPressFeedbackTimer = setTimeout(() => this.onLongPressFeedback?.(point), TOUCH_LONG_PRESS_FEEDBACK_MS);
    this.longPressTimer = setTimeout(() => {
      this.longPressFired = true;
      this.onLongPressFeedback?.(null);
      this.pendingRightClicks.push(point);
    }, TOUCH_LONG_PRESS_MS);
  }

  // 進行中の長押し判定を打ち切り、表示中の視覚フィードバックがあれば消す。
  private cancelLongPress(): void {
    if (this.longPressTimer !== null) clearTimeout(this.longPressTimer);
    if (this.longPressFeedbackTimer !== null) clearTimeout(this.longPressFeedbackTimer);
    this.longPressTimer = null;
    this.longPressFeedbackTimer = null;
    if (this.longPressPointerId !== null) this.onLongPressFeedback?.(null);
    this.longPressPointerId = null;
  }

  // 成立したクリックがタッチ由来なら、直近のタップとの時間差・距離を見てダブルタップを
  // pendingDoubleClicks へ合成する。マウス由来は dblclick イベントに任せるため何もしない。
  private registerTap(e: PointerEvent): void {
    this.lastPointerUpWasTouch = e.pointerType === 'touch';
    if (!this.lastPointerUpWasTouch) {
      this.lastTap = null;
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    const now = performance.now();
    // 2連続で成立すればダブルタップとして消費し、3連続目が単独の新しいタップ列の
    // 起点にならないよう lastTap を毎回リセットする。
    if (
      this.lastTap &&
      now - this.lastTap.time <= TOUCH_DOUBLE_TAP_MS &&
      Math.hypot(x - this.lastTap.x, y - this.lastTap.y) <= TOUCH_DOUBLE_TAP_PX
    ) {
      this.pendingDoubleClicks.push({ x, y });
      this.lastTap = null;
    } else {
      this.lastTap = { x, y, time: now };
    }
  }

  // アクティブなポインタの重心を返す(呼び出し側で size >= 2 を確認していること)。
  private currentCentroid(): PointerPoint {
    let x = 0;
    let y = 0;
    for (const p of this.pointers.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / this.pointers.size, y: y / this.pointers.size };
  }

  // target のホイールイベントを購読する。
  private attachWheelListener(): void {
    this.target.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  // ホイール操作を wheel 量として積算する。
  private readonly handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.wheel += e.deltaY;
  };

  // アクティブな2点間の距離を返す。
  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // アクティブな2点を結ぶ線分の画面上の角度 [rad] を返す。
  private currentPinchAngle(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // タッチ UI や HUD の代替操作ボタンからの仮想キー入力。物理キーボードと同じ扱いで
  // 押下中セットとエッジトリガキューへ反映する。ポインタ種別の通知はしない —
  // 呼び出し元がタッチ由来とは限らない(HUD 上の代替ボタンはマウスでも押せる)ため。
  setVirtualKey(key: KeyBinding, down: boolean): void {
    if (down) {
      if (!this.keys.has(key.code)) this.pendingPresses.push(key.code);
      this.keys.add(key.code);
      this.onUserGesture?.();
    } else {
      this.keys.delete(key.code);
    }
  }

  // key を1フレームぶんだけ押されたことにする。HUD 上の代替操作ボタンが物理キーと
  // 同じ押下エッジを合成する唯一の経路。
  tapKey(key: KeyBinding): void {
    this.setVirtualKey(key, true);
    this.setVirtualKey(key, false);
  }

  // kind が直前の値から変わっていれば記録して onPointerKindChange へ通知する。
  private notePointerKind(kind: PointerKind): void {
    if (this.lastPointerKind === kind) return;
    this.lastPointerKind = kind;
    this.onPointerKindChange?.(kind);
  }

  // code が押下中かつ未確保か返す。
  private isDown(code: string): boolean {
    return this.keys.has(code) && !this.claimedCodes.has(code);
  }

  // key が現在押下中か返す。takeHeld で確保済みの code は押下と見なさない。
  down(key: KeyBinding): boolean {
    return this.isDown(key.code) || (key.altCodes?.some((c) => this.isDown(c)) ?? false);
  }

  // 今フレーム key がホールドされていれば、その code (と altCodes) を先着で確保して true を返す。
  // 確保した code は以後 down() / takeKey() / takeKeys() から見えなくなる。
  takeHeld(key: KeyBinding): boolean {
    if (!this.down(key)) return false;
    this.claimedCodes.add(key.code);
    for (const c of key.altCodes ?? []) this.claimedCodes.add(c);
    return true;
  }

  // フレームの先頭で1度だけ呼ぶ。イベントハンドラが溜めた未確定分を今フレームの
  // スナップショットとして確定し、次フレーム分の蓄積をリセットする。
  update(): void {
    this.claimedCodes.clear();
    // 蓄積分を今フレームのスナップショットとして確定
    this.framePresses = this.pendingPresses;
    this.frameClicks = this.pendingClicks;
    this.frameDoubleClicks = this.pendingDoubleClicks;
    this.frameMiddleClicks = this.pendingMiddleClicks;
    this.frameRightClicks = this.pendingRightClicks;
    this.frameMouse = {
      dx: this.dx, dy: this.dy, panDx: this.panDx, panDy: this.panDy, wheel: this.wheel, roll: this.roll,
    };
    // 次フレーム分の蓄積をリセット
    this.pendingPresses = [];
    this.pendingClicks = [];
    this.pendingDoubleClicks = [];
    this.pendingMiddleClicks = [];
    this.pendingRightClicks = [];
    this.dx = 0;
    this.dy = 0;
    this.panDx = 0;
    this.panDy = 0;
    this.wheel = 0;
    this.roll = 0;
  }

  // 今フレームの押下エッジに key があれば消費して true を返す。takeHeld で確保済みの
  // code は渡さない。
  takeKey(key: KeyBinding): boolean {
    const i = this.framePresses.findIndex((code) => matchesCode(key, code) && !this.claimedCodes.has(code));
    if (i === -1) return false;
    this.framePresses.splice(i, 1);
    return true;
  }

  // 今フレームの未消費の押下エッジを順に渡し、handler が true を返したものを消費する。
  // takeHeld で確保済みの code は渡さない。
  takeKeys(handler: (code: string) => boolean): void {
    for (const code of [...this.framePresses]) {
      if (this.claimedCodes.has(code)) continue;
      if (!handler(code)) continue;
      const i = this.framePresses.indexOf(code);
      if (i !== -1) this.framePresses.splice(i, 1);
    }
  }

  // 今フレームの未消費の左クリック(ドラッグでない短い押下)を順に渡し、handler が true を返したものを消費する。
  takeClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameClicks, handler);
  }

  // 今フレームの未消費のダブルクリックを順に渡し、handler が true を返したものを消費する。
  takeDoubleClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameDoubleClicks, handler);
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

  // window/document/canvas(target)に張った12個のリスナーを外し、releaseAll() で
  // 押下中・ドラッグ中の状態も畳む。target は GameScene 所有で Input 自身より長生きするため、
  // ここで確実に外さないと次に構築する Input へも同じイベントが二重に配送され続ける。
  dispose(): void {
    // window/document に張った5個。
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('pagehide', this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    // canvas(target)に張った7個。
    this.target.removeEventListener('contextmenu', this.handleContextMenu);
    this.target.removeEventListener('pointerdown', this.handlePointerDown);
    this.target.removeEventListener('pointermove', this.handlePointerMove);
    this.target.removeEventListener('pointerup', this.handlePointerUp);
    this.target.removeEventListener('pointercancel', this.handlePointerCancel);
    this.target.removeEventListener('dblclick', this.handleDblClick);
    this.target.removeEventListener('wheel', this.handleWheel);
    this.releaseAll();
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
