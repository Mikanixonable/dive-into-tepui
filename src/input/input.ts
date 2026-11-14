// キーボード・マウス入力の集約。押下中キーの参照(down)に加え、
// 1フレームぶんのエッジトリガ(押した瞬間のキー/クリック/右クリック/押下/マウス移動量)を
// update() で確定させる。エッジトリガは先着順の消費モデルで、
// take* の handler が true を返したイベントはキューから取り除かれる。
// takePresses で掴んだ押下は掴みドラッグになり、その指の移動は mouse() と
// 2本指ジェスチャへ載らず、離してもクリックを合成しない。
import { type KeyBinding, SCROLL_GUARD_KEYS } from './key-mapping';

// これ未満の累積移動量ならドラッグではなくクリック扱い [px]
export const CLICK_MOVE_THRESHOLD = 6;
const RIGHT_CLICK_MOVE_THRESHOLD = 50; // [px]
const TOUCH_LONG_PRESS_MS = 500; // タッチの長押しを右クリックとみなすまでの静止時間 [ms]
const TOUCH_LONG_PRESS_FEEDBACK_MS = 300; // 長押し成立前に視覚フィードバックを出すまでの時間 [ms]
const TOUCH_DOUBLE_TAP_MS = 400; // タッチの連続タップをダブルタップとみなす時間差の上限 [ms]
const TOUCH_DOUBLE_TAP_PX = 24; // 同上、タップ間の許容移動距離 [px]

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

// ポインタイベント1件の位置(クリック・押下など)。
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

// PointerPoint に、それを起こしたポインタを併記したもの。掴まれた押下から合成された
// クリック・タップを取り消すために使う。ブラウザの dblclick イベント由来はポインタを
// 持たないので null。
interface PointerPointRecord extends PointerPoint {
  readonly pointerId: number | null;
}

// 左ボタン・単指の押下。takePresses の handler が受け取る。
export interface PointerPress {
  // 押下ごとに振る識別子。grabbedDrag で同じドラッグを引く鍵。
  readonly id: number;
  // 押下位置(キャンバス座標 [px])。
  readonly point: PointerPoint;
}

// takePresses の内部記録。DOM のポインタイベントと対応付けるためにポインタを併記する。
interface PointerPressRecord extends PointerPress {
  readonly pointerId: number;
}

// 掴まれた押下のドラッグ状態。grabbedDrag が返す。
export interface GrabbedDrag {
  readonly id: number;
  // 押下位置(キャンバス座標 [px])。
  readonly start: PointerPoint;
  // 現在位置(キャンバス座標 [px])。
  readonly point: PointerPoint;
  // 離した位置(キャンバス座標 [px])。まだ押されている間は null。
  readonly released: PointerPoint | null;
}

// grabs が持つ内部記録。
interface GrabbedDragRecord {
  readonly id: number;
  readonly pointerId: number;
  readonly start: PointerPoint;
  point: PointerPoint;
  // 掴んでからの累積移動量 [px]。長押しの静止条件に使う。
  moved: number;
  released: PointerPoint | null;
  // 離した記録を既に1フレーム見せたか。見せた分は次の update() で捨てる。
  releaseAnnounced: boolean;
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
  private pendingClicks: PointerPointRecord[] = [];
  private pendingDoubleClicks: PointerPointRecord[] = [];
  private pendingMiddleClicks: PointerPointRecord[] = [];
  private pendingRightClicks: PointerPointRecord[] = [];
  private pendingPointerPresses: PointerPressRecord[] = [];
  private dx = 0;
  private dy = 0;
  private panDx = 0;
  private panDy = 0;
  private wheel = 0;
  private roll = 0;
  private framePresses: string[] = [];
  private frameClicks: PointerPointRecord[] = [];
  private frameDoubleClicks: PointerPointRecord[] = [];
  private frameMiddleClicks: PointerPointRecord[] = [];
  private frameRightClicks: PointerPointRecord[] = [];
  private framePointerPresses: PointerPressRecord[] = [];
  private frameMouse: MouseDelta = ZERO_MOUSE_DELTA;
  // 左ポインタごとの、今フレームのスナップショットに積まれた移動量と蓄積中の移動量。
  // 押下が掴まれたとき、その指の分を mouse() から遡って差し引くために使う。
  private frameDragDeltas = new Map<number, { dx: number; dy: number }>();
  private periodDragDeltas = new Map<number, { dx: number; dy: number }>();
  // 左ポインタごとの離された位置。押下と解放が同じフレームに収まった押下が掴まれたとき、
  // 離した位置をドラッグへ引き継ぐために使う。
  private frameReleasedPoints = new Map<number, PointerPoint>();
  private periodReleasedPoints = new Map<number, PointerPoint>();
  // 掴まれたドラッグ(pointerId が鍵)。mouse() の集計と2本指ジェスチャの本数から外れる。
  private grabs = new Map<number, GrabbedDragRecord>();
  // PointerPress.id の採番。pointerId と別に持つのは、ブラウザが pointerId を
  // 使い回しても押下を区別できるようにするため。
  private nextPressId = 1;
  // キャンバス上の最後のポインタ位置(キャンバス座標 [px])。キャンバス外では null。
  private _pointerPoint: PointerPoint | null = null;
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
  public onPointerKindChange: ((kind: PointerKind) => void) | null = null;
  private lastPointerKind: PointerKind | null = null;
  // タッチの長押し(右クリック合成)。1本指のジェスチャにしか存在しないので
  // pointers のような Map ではなく単一の状態で持つ。
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressPointerId: number | null = null;
  private longPressFired = false;
  private _longPressPoint: PointerPoint | null = null;

  // 長押しの判定中であることを示す画面上の位置。押し始めから TOUCH_LONG_PRESS_FEEDBACK_MS が
  // 経つまでと、右クリックを合成した後は null。
  public get longPressPoint(): PointerPoint | null { return this._longPressPoint; }
  // キャンバス上の最後のポインタ位置(キャンバス座標 [px])。押していなくても追従し、
  // キャンバス外へ出ると null。
  public get pointerPoint(): PointerPoint | null { return this._pointerPoint; }
  // 直近に成立したタップ(ダブルタップ合成用)。タッチ由来でなければ null のまま。
  private lastTap: { x: number; y: number; time: number; pointerId: number } | null = null;
  // 直近に成立したクリックがタッチ由来だったか。真なら、二重計上を避けるため
  // ブラウザ標準の dblclick イベントによる合成をこちらで抑止する。
  private lastPointerUpWasTouch = false;
  // 直近に離した指が掴まれたドラッグだったか。真なら、掴んだ押下がブラウザの
  // dblclick イベントをクリック相当へ結実させないよう抑止する。
  private lastPointerUpWasGrabbed = false;

  // キーボード・ポインタ・ホイールのイベントリスナーを登録する。
  public constructor(private readonly target: HTMLElement) {
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
    if (!e.repeat) this.pendingPresses.push(e.code);
    this.keys.add(e.code);
    this.notePointerKind('mouse');
  };

  // keyup を受け、Command キーなら押下中状態を一括解除し、それ以外は押下中セットから除外する。
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
    // 掴んだ指は離されたものとして受け手へ届ける。
    for (const grab of this.grabs.values()) grab.released = { ...grab.point };
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
    this.target.addEventListener('pointerleave', this.handlePointerLeave);
    // マウスのダブルクリック連打判定(タイミング・移動量とも)はブラウザの標準実装に委ねる。
    // タッチ由来のクリックは自前で合成する(registerTap)ため、二重に積まないよう除外する。
    this.target.addEventListener('dblclick', this.handleDblClick);
  }

  private readonly handleContextMenu = (e: Event): void => e.preventDefault();

  // 左ボタンかつタッチ由来・掴まれた指由来のどちらでもなければ、ダブルクリックとして積む。
  private readonly handleDblClick = (e: MouseEvent): void => {
    if (e.button === 0 && !this.lastPointerUpWasTouch && !this.lastPointerUpWasGrabbed) {
      this.pendingDoubleClicks.push({ x: e.clientX, y: e.clientY, pointerId: null });
    }
  };

  // 左ボタン・右ボタンはともにドラッグ/ピンチ開始(右クリックは閾値未満ならコンテキストメニュー用のクリックとして扱う)、中ボタンはパン開始として扱う。
  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.notePointerKind(e.pointerType === 'touch' ? 'touch' : 'mouse');
    this.syncPointerPoint(e);
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft) {
      // 同じ指が離した直後に残った掴みの記録は、次の押下へ引き継がない。
      this.grabs.delete(e.pointerId);
      this.pendingPointerPresses.push({
        id: this.nextPressId++, pointerId: e.pointerId,
        point: this.canvasPoint(e.clientX, e.clientY),
      });
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

  // アクティブなジェスチャ(ピンチ/パン/ドラッグ/掴み)に応じて移動量を積算する。
  private readonly handlePointerMove = (e: PointerEvent): void => {
    this.notePointerKind(e.pointerType === 'touch' ? 'touch' : 'mouse');
    this.syncPointerPoint(e);
    const grab = this.grabs.get(e.pointerId);
    if (grab !== undefined) {
      // 掴んだ指の移動はドラッグ自身の記録へだけ積み、mouse() とジェスチャへ載せない。
      grab.point = this.canvasPoint(e.clientX, e.clientY);
      grab.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
      // 静止条件が崩れたら長押しは成立させない。
      if (this.longPressPointerId === e.pointerId && grab.moved >= CLICK_MOVE_THRESHOLD) {
        this.cancelLongPress();
      }
      return;
    }
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
      // ポインタごとの分も記録し、掴まれたときに遡って外せるようにする。
      const delta = this.periodDragDeltas.get(e.pointerId) ?? { dx: 0, dy: 0 };
      delta.dx += e.movementX;
      delta.dy += e.movementY;
      this.periodDragDeltas.set(e.pointerId, delta);
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
    // タッチは指を離した時点で位置を持たない。マウスは離した点へホバーを置く。
    if (e.pointerType === 'touch') this._pointerPoint = null;
    else this.syncPointerPoint(e);
    const isRight = e.button === 2 || (e.button === 0 && e.ctrlKey);
    const isLeft = e.button === 0 && !e.ctrlKey;
    if (isLeft || e.pointerType === 'touch') {
      this.periodReleasedPoints.set(e.pointerId, this.canvasPoint(e.clientX, e.clientY));
      const grab = this.grabs.get(e.pointerId);
      if (grab !== undefined) this.releaseGrab(grab, e);
      this.lastPointerUpWasGrabbed = grab !== undefined;
      this.pointers.delete(e.pointerId);
      if (grab === undefined) {
        // 長押しがすでに右クリックへ結実したポインタは、離した指を左クリックへも
        // 二重に変換しない。掴んだ指は同じくクリックを合成しない(上の分岐)。
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
    }
    if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
    if (e.button === 1) {
      if (this.panDragging) this.pushIfClick(this.pendingMiddleClicks, this.panDragMoved, e);
      this.panDragging = false;
    }
    if (isRight) {
      if (this.rightActive) {
        if (this.rightDragMoved < RIGHT_CLICK_MOVE_THRESHOLD) {
          this.pendingRightClicks.push({ x: e.clientX, y: e.clientY, pointerId: e.pointerId });
        }
      }
      this.rightActive = false;
    }
  }

  // ポインタ消失時にジェスチャ状態をリセットする。掴んだ指はドラッグを離したことにするだけで、
  // 残りの指のジェスチャは続く。
  private readonly handlePointerCancel = (e: PointerEvent): void => {
    this.periodReleasedPoints.set(e.pointerId, this.canvasPoint(e.clientX, e.clientY));
    const grab = this.grabs.get(e.pointerId);
    if (grab !== undefined) this.releaseGrab(grab, e);
    this.pointers.delete(e.pointerId);
    // 掴んでいた指でなければ、押下中・ドラッグ中のジェスチャ状態ごと畳む。
    if (grab === undefined) {
      this.dragging = false;
      this.panDragging = false;
      this.rightActive = false;
      this.pinchDist = 0;
      this.pinchCentroid = null;
      this.pinchAngle = 0;
    }
    if (this.longPressPointerId === e.pointerId) this.cancelLongPress();
    this._pointerPoint = null;
  };

  // ポインタがキャンバスを出たら、追跡しているポインタ位置を消す。
  private readonly handlePointerLeave = (): void => {
    this._pointerPoint = null;
  };

  // 掴んだドラッグを離されたものとして記録する。
  private releaseGrab(grab: GrabbedDragRecord, e: PointerEvent): void {
    grab.point = this.canvasPoint(e.clientX, e.clientY);
    grab.released = grab.point;
  }

  // moved が閾値未満(ドラッグでなくクリック)なら e の座標を queue に積み、積んだかを返す。
  // 左・中・右ボタン共通のクリック判定はここに一本化する。
  private pushIfClick(queue: PointerPointRecord[], moved: number, e: PointerEvent): boolean {
    if (moved >= CLICK_MOVE_THRESHOLD) return false;
    queue.push({ x: e.clientX, y: e.clientY, pointerId: e.pointerId });
    return true;
  }

  // pointerId の長押しタイマーを開始する。TOUCH_LONG_PRESS_FEEDBACK_MS 後に
  // longPressPoint を立て、TOUCH_LONG_PRESS_MS 後に右クリックを合成する。
  private startLongPress(pointerId: number, point: PointerPoint): void {
    this.cancelLongPress();
    this.longPressPointerId = pointerId;
    this.longPressFired = false;
    this.longPressFeedbackTimer = setTimeout(() => { this._longPressPoint = point; }, TOUCH_LONG_PRESS_FEEDBACK_MS);
    this.longPressTimer = setTimeout(() => {
      this.longPressFired = true;
      this._longPressPoint = null;
      this.pendingRightClicks.push({ ...point, pointerId });
    }, TOUCH_LONG_PRESS_MS);
  }

  // 進行中の長押し判定を打ち切る。
  private cancelLongPress(): void {
    if (this.longPressTimer !== null) clearTimeout(this.longPressTimer);
    if (this.longPressFeedbackTimer !== null) clearTimeout(this.longPressFeedbackTimer);
    this.longPressTimer = null;
    this.longPressFeedbackTimer = null;
    this._longPressPoint = null;
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
      this.pendingDoubleClicks.push({ x, y, pointerId: e.pointerId });
      this.lastTap = null;
    } else {
      this.lastTap = { x, y, time: now, pointerId: e.pointerId };
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
  public setVirtualKey(key: KeyBinding, down: boolean): void {
    if (down) {
      if (!this.keys.has(key.code)) this.pendingPresses.push(key.code);
      this.keys.add(key.code);
    } else {
      this.keys.delete(key.code);
    }
  }

  // key を1フレームぶんだけ押されたことにする。HUD 上の代替操作ボタンが物理キーと
  // 同じ押下エッジを合成する唯一の経路。
  public tapKey(key: KeyBinding): void {
    this.setVirtualKey(key, true);
    this.setVirtualKey(key, false);
  }

  // kind が直前の値から変わっていれば記録して onPointerKindChange へ通知する。
  private notePointerKind(kind: PointerKind): void {
    if (this.lastPointerKind === kind) return;
    this.lastPointerKind = kind;
    this.onPointerKindChange?.(kind);
  }

  // クライアント座標をキャンバス座標へ写す。DOM 上で進んでいるドラッグの位置を
  // キャンバス内の位置として読むときに使う。
  public canvasPoint(clientX: number, clientY: number): PointerPoint {
    const rect = this.target.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // ポインタがキャンバス内にあれば最後の位置を記録し、外に出ていれば null にする。
  private syncPointerPoint(e: PointerEvent): void {
    const point = this.canvasPoint(e.clientX, e.clientY);
    const rect = this.target.getBoundingClientRect();
    this._pointerPoint = point.x >= 0 && point.x < rect.width && point.y >= 0 && point.y < rect.height
      ? point : null;
  }

  // code が押下中かつ未確保か返す。
  private isDown(code: string): boolean {
    return this.keys.has(code) && !this.claimedCodes.has(code);
  }

  // key が現在押下中か返す。takeHeld で確保済みの code は押下と見なさない。
  public down(key: KeyBinding): boolean {
    return this.isDown(key.code) || (key.altCodes?.some((c) => this.isDown(c)) ?? false);
  }

  // 今フレーム key がホールドされていれば、その code (と altCodes) を先着で確保して true を返す。
  // 確保した code は以後 down() / takeKey() / takeKeys() から見えなくなる。
  public takeHeld(key: KeyBinding): boolean {
    if (!this.down(key)) return false;
    this.claimedCodes.add(key.code);
    for (const c of key.altCodes ?? []) this.claimedCodes.add(c);
    return true;
  }

  // フレームの先頭で1度だけ呼ぶ。イベントハンドラが溜めた未確定分を今フレームの
  // スナップショットとして確定し、次フレーム分の蓄積をリセットする。
  public update(): void {
    this.claimedCodes.clear();
    // 蓄積分を今フレームのスナップショットとして確定
    this.framePresses = this.pendingPresses;
    this.frameClicks = this.pendingClicks;
    this.frameDoubleClicks = this.pendingDoubleClicks;
    this.frameMiddleClicks = this.pendingMiddleClicks;
    this.frameRightClicks = this.pendingRightClicks;
    this.framePointerPresses = this.pendingPointerPresses;
    this.frameMouse = {
      dx: this.dx, dy: this.dy, panDx: this.panDx, panDy: this.panDy, wheel: this.wheel, roll: this.roll,
    };
    // ポインタごとの移動量もスナップショットし、掴まれた分を遡って外せるようにする。
    this.frameDragDeltas = this.periodDragDeltas;
    this.periodDragDeltas = new Map();
    this.frameReleasedPoints = this.periodReleasedPoints;
    this.periodReleasedPoints = new Map();
    // 離した掴みは、受け手が離した事実を読めるよう1フレームだけ残す。
    for (const [pointerId, grab] of this.grabs) {
      if (grab.released === null) continue;
      if (grab.releaseAnnounced) this.grabs.delete(pointerId);
      else grab.releaseAnnounced = true;
    }
    // 次フレーム分の蓄積をリセット
    this.pendingPresses = [];
    this.pendingClicks = [];
    this.pendingDoubleClicks = [];
    this.pendingMiddleClicks = [];
    this.pendingRightClicks = [];
    this.pendingPointerPresses = [];
    this.dx = 0;
    this.dy = 0;
    this.panDx = 0;
    this.panDy = 0;
    this.wheel = 0;
    this.roll = 0;
  }

  // 今フレームの押下エッジに key があれば消費して true を返す。takeHeld で確保済みの
  // code は渡さない。
  public takeKey(key: KeyBinding): boolean {
    const i = this.framePresses.findIndex((code) => matchesCode(key, code) && !this.claimedCodes.has(code));
    if (i === -1) return false;
    this.framePresses.splice(i, 1);
    return true;
  }

  // 今フレームの未消費の押下エッジを順に渡し、handler が true を返したものを消費する。
  // takeHeld で確保済みの code は渡さない。
  public takeKeys(handler: (code: string) => boolean): void {
    for (const code of [...this.framePresses]) {
      if (this.claimedCodes.has(code)) continue;
      if (!handler(code)) continue;
      const i = this.framePresses.indexOf(code);
      if (i !== -1) this.framePresses.splice(i, 1);
    }
  }

  // 今フレームの未消費の左ボタン・単指の押下を順に渡し、handler が true を返した押下を
  // 掴んだドラッグにする。掴んだドラッグは mouse() の移動量と2本指ジェスチャの本数から外れ、
  // 離されてもクリック・ダブルクリックを合成しない。
  public takePresses(handler: (press: PointerPress) => boolean): void {
    for (const press of [...this.framePointerPresses]) {
      if (!handler(press)) continue;
      const i = this.framePointerPresses.indexOf(press);
      if (i !== -1) this.framePointerPresses.splice(i, 1);
      this.grabPress(press);
    }
  }

  // 掴んだドラッグ id の現在の状態。離した記録は1フレームだけ残り、消えたら null。
  public grabbedDrag(id: number): GrabbedDrag | null {
    for (const grab of this.grabs.values()) {
      if (grab.id !== id) continue;
      // 該当する掴みを見つけたらコピーして返す(呼び手が中身を変えても記録へ影響しない)。
      return {
        id: grab.id,
        start: { ...grab.start },
        point: { ...grab.point },
        released: grab.released === null ? null : { ...grab.released },
      };
    }
    return null;
  }

  // 押下を掴んだドラッグにする。その指を1本指ドラッグ・ピンチの対象から外し、
  // 今フレームのスナップショットへ既に積まれた移動量を mouse() から差し引く。
  private grabPress(press: PointerPressRecord): void {
    if (this.grabs.has(press.pointerId)) return;
    // 押した指が同じフレームで既に離されていたなら、掴んだ時点で離した記録にする。
    const released = this.pointers.has(press.pointerId)
      ? null
      : this.frameReleasedPoints.get(press.pointerId) ?? { ...press.point };
    this.grabs.set(press.pointerId, {
      id: press.id, pointerId: press.pointerId,
      start: { ...press.point }, point: { ...press.point },
      moved: 0, released, releaseAnnounced: false,
    });
    // 同じフレームで既に合成済みのクリック・タップは、掴んだ押下のものとして取り消す。
    removePointerPoints(this.frameClicks, press.pointerId);
    removePointerPoints(this.frameDoubleClicks, press.pointerId);
    if (this.lastTap?.pointerId === press.pointerId) this.lastTap = null;
    const delta = this.frameDragDeltas.get(press.pointerId);
    if (delta !== undefined) {
      this.frameMouse = {
        ...this.frameMouse,
        dx: this.frameMouse.dx - delta.dx,
        dy: this.frameMouse.dy - delta.dy,
      };
    }
    const wasTracked = this.pointers.delete(press.pointerId);
    if (wasTracked) {
      // 残った指が1本だけなら、その指が1本指ドラッグを引き継ぐ。
      this.dragging = this.pointers.size === 1;
      if (this.dragging) this.dragMoved = 0;
    }
  }

  // 今フレームの未消費の左クリック(ドラッグでない短い押下)を順に渡し、handler が true を返したものを消費する。
  public takeClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameClicks, handler);
  }

  // 今フレームの未消費のダブルクリックを順に渡し、handler が true を返したものを消費する。
  public takeDoubleClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameDoubleClicks, handler);
  }

  // 今フレームの未消費の中ボタンクリックを順に渡し、handler が true を返したものを消費する。
  public takeMiddleClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameMiddleClicks, handler);
  }

  // 今フレームの未消費の右ボタン押下を順に渡し、handler が true を返したものを消費する。
  public takeRightClicks(handler: (point: PointerPoint) => boolean): void {
    takeFrom(this.frameRightClicks, handler);
  }

  // 今フレームのマウス移動量・パン量・ホイール量を返す。
  public mouse(): MouseDelta {
    return this.frameMouse;
  }

  // window/document/canvas(target)に張った13個のリスナーを外し、releaseAll() で
  // 押下中・ドラッグ中の状態も畳む。target は GameScene 所有で Input 自身より長生きするため、
  // ここで確実に外さないと次に構築する Input へも同じイベントが二重に配送され続ける。
  public dispose(): void {
    // window/document に張った5個。
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('pagehide', this.handlePageHide);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    // canvas(target)に張った8個。
    this.target.removeEventListener('contextmenu', this.handleContextMenu);
    this.target.removeEventListener('pointerdown', this.handlePointerDown);
    this.target.removeEventListener('pointermove', this.handlePointerMove);
    this.target.removeEventListener('pointerup', this.handlePointerUp);
    this.target.removeEventListener('pointercancel', this.handlePointerCancel);
    this.target.removeEventListener('pointerleave', this.handlePointerLeave);
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

// queue から pointerId が起こした分をすべて取り除く。
function removePointerPoints(queue: PointerPointRecord[], pointerId: number): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const entry = queue[i];
    if (entry !== undefined && entry.pointerId === pointerId) queue.splice(i, 1);
  }
}
