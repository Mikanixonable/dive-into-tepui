// キーボード・マウス入力の集約。押下中キーの参照と、
// フレームごとに消費するエッジトリガ(押した瞬間)キューを提供する。
// マウス: 左ボタン=視点ドラッグ(小さな動きならクリックとして扱う。
// マップモードのノード配置に使う)、右ボタン=射撃(押下位置は takeRightClicks() で
// 取得でき、マップモードのコンテキストメニュー呼び出しに使う)。
export interface MouseDelta {
  dx: number;
  dy: number;
  panDx: number;
  panDy: number;
  wheel: number;
}

const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い

export class Input {
  private keys = new Set<string>();
  private pressQueue: string[] = [];
  private dx = 0;
  private dy = 0;
  private panDx = 0;
  private panDy = 0;
  private wheel = 0;
  private dragging = false;
  private panDragging = false;
  private dragMoved = 0;
  private clicks: { x: number; y: number }[] = [];
  // 右ボタン押下位置のキュー(マップモードのコンテキストメニュー呼び出し用)。
  // 戦闘中は消費されず貯まっていかないよう、呼び出し側は毎フレーム drain する
  // (takeClicks と同じ運用)。
  private rightClicks: { x: number; y: number }[] = [];
  // タッチ用: アクティブポインタの座標(ピンチズーム判定に使う)
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  mouseFiring = false;
  onFirstGesture: (() => void) | null = null;
  private gestureFired = false;

  constructor(target: HTMLElement) {
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
      if (!e.repeat) this.pressQueue.push(e.code);
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

    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.style.touchAction = 'none'; // ブラウザのスクロール/ピンチを奪う
    target.addEventListener('pointerdown', (e) => {
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
        this.rightClicks.push({ x: e.clientX, y: e.clientY });
      } else if (e.button === 1) {
        // Map mode consumes this as a camera translation gesture. Keep it
        // separate from the left-drag orbit rotation delta.
        e.preventDefault();
        this.panDragging = true;
        target.setPointerCapture(e.pointerId);
      }
    });
    target.addEventListener('pointermove', (e) => {
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
    });
    const release = (e: PointerEvent) => {
      if (e.button === 0 || e.pointerType === 'touch') {
        this.pointers.delete(e.pointerId);
        if (this.dragging && this.dragMoved < CLICK_MOVE_THRESHOLD) {
          this.clicks.push({ x: e.clientX, y: e.clientY });
        }
        this.dragging = false;
        this.pinchDist = 0;
      }
      if (e.button === 2) this.mouseFiring = false;
      if (e.button === 1) this.panDragging = false;
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      this.dragging = false;
      this.panDragging = false;
      this.mouseFiring = false;
      this.pinchDist = 0;
    });
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
      if (!this.keys.has(code)) this.pressQueue.push(code);
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

  // 押下エッジをまとめて取得(取得後クリア)
  takePresses(): string[] {
    const q = this.pressQueue;
    this.pressQueue = [];
    return q;
  }

  // 左クリック(ドラッグでない短い押下)位置をまとめて取得(取得後クリア)。マップモードのノード配置用。
  takeClicks(): { x: number; y: number }[] {
    const c = this.clicks;
    this.clicks = [];
    return c;
  }

  // 右ボタン押下位置をまとめて取得(取得後クリア)。マップモードのコンテキストメニュー呼び出し用。
  takeRightClicks(): { x: number; y: number }[] {
    const c = this.rightClicks;
    this.rightClicks = [];
    return c;
  }

  consumeMouse(): MouseDelta {
    const d = {
      dx: this.dx,
      dy: this.dy,
      panDx: this.panDx,
      panDy: this.panDy,
      wheel: this.wheel,
    };
    this.dx = 0;
    this.dy = 0;
    this.panDx = 0;
    this.panDy = 0;
    this.wheel = 0;
    return d;
  }
}
