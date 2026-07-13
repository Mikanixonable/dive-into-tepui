// キーボード・マウス入力の集約。押下中キーの参照と、
// フレームごとに消費するエッジトリガ(押した瞬間)キューを提供する。
// マウス: 左ボタン=視点ドラッグ(小さな動きならクリックとして扱う。
// マップモードのノード配置に使う)、右ボタン=射撃。
export interface MouseDelta {
  dx: number;
  dy: number;
  wheel: number;
}

const CLICK_MOVE_THRESHOLD = 6; // これ未満の累積移動量ならドラッグではなくクリック扱い

export class Input {
  private keys = new Set<string>();
  private pressQueue: string[] = [];
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private dragging = false;
  private dragMoved = 0;
  private clicks: { x: number; y: number }[] = [];
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
    });

    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('pointerdown', (e) => {
      this.fireGesture();
      if (e.button === 0) {
        this.dragging = true;
        this.dragMoved = 0;
        target.setPointerCapture(e.pointerId);
      } else if (e.button === 2) {
        this.mouseFiring = true;
      }
    });
    target.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        this.dx += e.movementX;
        this.dy += e.movementY;
        this.dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
      }
    });
    const release = (e: PointerEvent) => {
      if (e.button === 0) {
        if (this.dragging && this.dragMoved < CLICK_MOVE_THRESHOLD) {
          this.clicks.push({ x: e.clientX, y: e.clientY });
        }
        this.dragging = false;
      }
      if (e.button === 2) this.mouseFiring = false;
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', () => {
      this.dragging = false;
      this.mouseFiring = false;
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

  consumeMouse(): MouseDelta {
    const d = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    return d;
  }
}
