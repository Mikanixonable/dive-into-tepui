// DOM 要素へのポインタドラッグ・ホイール・ピンチ操作を、パン移動量 [px] とズーム量
// (ホイールデルタ相当の無次元値)へ変換するジェスチャ変換器。変換した値を実際の状態へ
// どう反映するかは知らず、コンストラクタで受け取った onPan/onZoom へそのまま渡す。

const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const PINCH_ZOOM_SENSITIVITY = 0.004;

export class PointerPanZoom {
  // ドラッグ/ピンチで押されているポインタ。中心(重心)の移動をパン、2本間の
  // 距離の変化をズームに使う。
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private lastPanPoint: { x: number; y: number } | null = null;
  private lastPinchDist: number | null = null;

  // el へポインタ/ホイールのイベントリスナーを配線する。
  public constructor(
    el: HTMLElement,
    private readonly onPan: (dxPx: number, dyPx: number) => void,
    private readonly onZoom: (wheelDelta: number) => void,
  ) {
    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      this.lastPanPoint = null;
      this.lastPinchDist = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.handleMove();
    });
    // pointerup/pointercancel 共通のポインタ解放処理。
    const release = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      this.lastPanPoint = null;
      this.lastPinchDist = null;
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => {
      // ページスクロールへ渡さない。ブラウザ既定の passive では効かないため、
      // このリスナー自体を { passive: false } で登録している。
      e.preventDefault();
      this.onZoom(e.deltaY * WHEEL_ZOOM_SENSITIVITY);
    }, { passive: false });
  }

  // 押されている全ポインタの重心の移動をパンへ、2本のときの距離の変化をズームへ変換する。
  private handleMove(): void {
    const points = [...this.pointers.values()];
    const centroid = {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
    if (this.lastPanPoint) this.onPan(centroid.x - this.lastPanPoint.x, centroid.y - this.lastPanPoint.y);
    this.lastPanPoint = centroid;

    // 3本目以降が触れても先頭2本の距離だけを見る — Map の挿入順で決まる。
    const [a, b] = points;
    if (a && b && points.length >= 2) {
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinchDist !== null) this.onZoom(-(dist - this.lastPinchDist) * PINCH_ZOOM_SENSITIVITY);
      this.lastPinchDist = dist;
    } else {
      this.lastPinchDist = null;
    }
  }
}
