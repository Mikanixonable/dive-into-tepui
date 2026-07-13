// キーボード・マウス入力の集約。押下中キーの参照と、
// フレームごとに消費するエッジトリガ(押した瞬間)キューを提供する。
export interface MouseDelta {
  dx: number;
  dy: number;
  wheel: number;
}

export class Input {
  private keys = new Set<string>();
  private pressQueue: string[] = [];
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private rightDrag = false;
  private clicks: { x: number; y: number }[] = [];
  mouseFiring = false;
  onFirstGesture: (() => void) | null = null;
  private gestureFired = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // Tab のフォーカス移動と Space スクロールなどを抑止
      if (e.code === 'Tab' || e.code === 'Space' || e.code === 'Period' || e.code === 'Comma') {
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
      this.rightDrag = false;
    });

    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener('pointerdown', (e) => {
      this.fireGesture();
      if (e.button === 2) {
        this.rightDrag = true;
        target.setPointerCapture(e.pointerId);
      } else if (e.button === 0) {
        this.mouseFiring = true;
        this.clicks.push({ x: e.clientX, y: e.clientY });
      }
    });
    target.addEventListener('pointermove', (e) => {
      if (this.rightDrag) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
    const release = (e: PointerEvent) => {
      if (e.button === 2) this.rightDrag = false;
      if (e.button === 0) this.mouseFiring = false;
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', () => {
      this.rightDrag = false;
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

  // 左クリック位置をまとめて取得(取得後クリア)。マップモードのノード配置用。
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
