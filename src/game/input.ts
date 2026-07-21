// キーボード・マウス入力の集約。押下中キーの参照(down)に加え、
// 1フレームぶんのエッジトリガ(押した瞬間のキー/クリック/マウス移動量)を
// update() で確定させ、以後はそのスナップショットを副作用なしに何度でも
// 読み出せる(presses/clicks/rightClicks/mouse)。update() は1フレームに
// つき必ず1回、他の全ての読み出しより前に呼ぶこと(呼び出し元は main.ts の
// rAF ループから呼ばれる Game.update() の先頭)。
export interface MouseDelta {
  dx: number;
  dy: number;
  panDx: number;
  panDy: number;
  wheel: number;
}

const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い

const ZERO_MOUSE_DELTA: MouseDelta = { dx: 0, dy: 0, panDx: 0, panDy: 0, wheel: 0 };

export class Input {
  private keys = new Set<string>();
  // イベントハンドラが書き込む、次の update() 呼び出しまでの未確定分。
  private pendingPresses: string[] = [];
  private pendingClicks: { x: number; y: number }[] = [];
  private pendingRightClicks: { x: number; y: number }[] = [];
  private dx = 0;
  private dy = 0;
  private panDx = 0;
  private panDy = 0;
  private wheel = 0;
  // update() が確定させた、このフレーム分の読み出し専用スナップショット。
  private framePresses: string[] = [];
  private frameClicks: { x: number; y: number }[] = [];
  private frameRightClicks: { x: number; y: number }[] = [];
  private frameMouse: MouseDelta = ZERO_MOUSE_DELTA;
  private dragging = false;
  private panDragging = false;
  private dragMoved = 0;
  // タッチ用: アクティブポインタの座標(ピンチズーム判定に使う)
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  mouseFiring = false;
  onFirstGesture: (() => void) | null = null;
  private gestureFired = false;

  constructor(target: HTMLElement) {
    // キーボード(押下中セット + エッジトリガキュー)
    this.attachKeyboardListeners();
    // ポインタ(左ドラッグ/クリック・右射撃・中パン・ピンチ)
    this.attachPointerListeners(target);
    // ホイールズーム
    this.attachWheelListener(target);
  }

  private attachKeyboardListeners(): void {
    window.addEventListener('keydown', (e) => {
      // Tab のフォーカス移動と Space スクロール、矢印キーでのページスクロールを抑止
      if (
        e.code === 'Tab' ||
        e.code === 'Space' ||
        e.code === 'Period' ||
        e.code === 'Comma' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown'
      ) {
        e.preventDefault();
      }
      // CTRL=前進のキー割り当てがブラウザの Ctrl+S(保存)・Ctrl+R(リロード)等と
      // 衝突するのを防ぐ(Ctrl+W/T/N や Ctrl+数字はブラウザが予約しており
      // JSからは抑止できないため許容する)
      if (
        e.ctrlKey &&
        (e.code === 'KeyS' || e.code === 'KeyD' || e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyR')
      ) {
        e.preventDefault();
      }
      if (!e.repeat) this.pendingPresses.push(e.code);
      this.keys.add(e.code);
      this.fireGesture();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFiring = false;
      this.dragging = false;
      this.panDragging = false;
    });
  }

  private attachPointerListeners(target: HTMLElement): void {
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.style.touchAction = 'none'; // ブラウザのスクロール/ピンチを奪う
    target.addEventListener('pointerdown', (e) => this.onPointerDown(target, e));
    target.addEventListener('pointermove', (e) => this.onPointerMove(e));
    target.addEventListener('pointerup', (e) => this.onPointerUp(e));
    target.addEventListener('pointercancel', (e) => this.onPointerCancel(e));
  }

  private onPointerDown(target: HTMLElement, e: PointerEvent): void {
    this.fireGesture();
    if (e.button === 0) {
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
    } else if (e.button === 2) {
      this.mouseFiring = true;
      this.pendingRightClicks.push({ x: e.clientX, y: e.clientY });
    } else if (e.button === 1) {
      // Map mode consumes this as a camera translation gesture. Keep it
      // separate from the left-drag orbit rotation delta.
      e.preventDefault();
      this.panDragging = true;
      target.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
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
      return;
    }
    if (this.dragging) {
      this.dx += e.movementX;
      this.dy += e.movementY;
      this.dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 0 || e.pointerType === 'touch') {
      this.pointers.delete(e.pointerId);
      if (this.dragging && this.dragMoved < CLICK_MOVE_THRESHOLD) {
        this.pendingClicks.push({ x: e.clientX, y: e.clientY });
      }
      this.dragging = false;
      this.pinchDist = 0;
    }
    if (e.button === 2) this.mouseFiring = false;
    if (e.button === 1) this.panDragging = false;
  }

  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.dragging = false;
    this.panDragging = false;
    this.mouseFiring = false;
    this.pinchDist = 0;
  }

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

  private currentPinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  // タッチ UI などからの仮想キー入力。物理キーボードと同じ扱いで
  // 押下中セットとエッジトリガキューへ反映する。
  setVirtualKey(code: string, down: boolean): void {
    this.fireGesture();
    if (down) {
      if (!this.keys.has(code)) this.pendingPresses.push(code);
      this.keys.add(code);
    } else {
      this.keys.delete(code);
    }
  }

  private fireGesture(): void {
    if (!this.gestureFired && this.onFirstGesture) {
      this.gestureFired = true;
      this.onFirstGesture();
    }
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  // フレームの先頭で1度だけ呼ぶ。イベントハンドラが溜めた未確定分を今フレームの
  // スナップショットとして確定し、次フレーム分の蓄積をリセットする。
  // 呼び出し後は presses/clicks/rightClicks/mouse を副作用なしに何度でも読める。
  update(): void {
    this.framePresses = this.pendingPresses;
    this.frameClicks = this.pendingClicks;
    this.frameRightClicks = this.pendingRightClicks;
    this.frameMouse = { dx: this.dx, dy: this.dy, panDx: this.panDx, panDy: this.panDy, wheel: this.wheel };
    this.pendingPresses = [];
    this.pendingClicks = [];
    this.pendingRightClicks = [];
    this.dx = 0;
    this.dy = 0;
    this.panDx = 0;
    this.panDy = 0;
    this.wheel = 0;
  }

  // 今フレームの押下エッジ。
  presses(): readonly string[] {
    return this.framePresses;
  }

  // 今フレームの左クリック(ドラッグでない短い押下)位置。マップモードのノード配置用。
  clicks(): readonly { x: number; y: number }[] {
    return this.frameClicks;
  }

  // 今フレームの右ボタン押下位置。マップモードのコンテキストメニュー呼び出し用。
  rightClicks(): readonly { x: number; y: number }[] {
    return this.frameRightClicks;
  }

  // 今フレームのマウス移動量。左ドラッグでの視点回転用。
  mouse(): MouseDelta {
    return this.frameMouse;
  }
}
