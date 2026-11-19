// タッチの複数指ジェスチャの追跡。押下中の左ポインタの座標と、差分を取るピンチ基準
// (指の間隔・重心・2点を結ぶ角度)を持ち、移動イベントをホイール・パン・ロール量へ
// 換算する。指の追跡から外れたポインタはジェスチャの本数へ数えない。
import type { PointerPoint } from './pointer-point';

// move が返す1イベントぶんのジェスチャ量。
export interface PinchDelta {
  readonly wheel: number;
  readonly panDx: number;
  readonly panDy: number;
  readonly roll: number;
}

export class PinchTracker {
  // アクティブポインタの座標(ピンチズーム・二本指パン判定に使う)。
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinchCentroid: PointerPoint | null = null;
  private pinchAngle = 0;

  // 追跡中のポインタ数。
  public get size(): number { return this.pointers.size; }

  // pointerId が追跡中か。
  public has(pointerId: number): boolean {
    return this.pointers.has(pointerId);
  }

  // ポインタを追跡へ加える。
  public add(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  // ポインタを追跡から外す。追跡中だったかを返す。
  public delete(pointerId: number): boolean {
    return this.pointers.delete(pointerId);
  }

  // ポインタの現在位置を更新し、追跡中の指が2本以上なら基準との差分を
  // ホイール・パン・ロール量として返す。2本未満なら null。
  public move(e: PointerEvent): PinchDelta | null {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    if (this.pointers.size < 2) return null;
    // 二本指ジェスチャ: 指の間隔の変化をホイール量へ(開く = ズームイン)、
    // 重心の移動をパン量へ、2点を結ぶ角度の変化をロール量へ、同時に折り込む
    // (実指は回しながら開くため排他にしない)。
    const dist = this.currentPinchDist();
    const wheel = (this.pinchDist - dist) * 3;
    this.pinchDist = dist;
    const centroid = this.currentCentroid();
    let panDx = 0;
    let panDy = 0;
    if (this.pinchCentroid) {
      panDx = centroid.x - this.pinchCentroid.x;
      panDy = centroid.y - this.pinchCentroid.y;
    }
    this.pinchCentroid = centroid;
    const angle = this.currentPinchAngle();
    // -π..π の範囲でしか値を持たない角度どうしの差分は、跨いだぶんを ±2π で
    // 正規化しないと回転方向が反転してしまう。
    const roll = (((angle - this.pinchAngle) + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.pinchAngle = angle;
    return { wheel, panDx, panDy, roll };
  }

  // 残っている指の配置でピンチ基準を取り直す。指が増減した直後に呼ぶ —
  // 古い基準のままだと配置が変わった瞬間に重心が跳んでパンが暴れる。
  // 指が2本未満なら基準を消す。
  public rebase(): void {
    if (this.pointers.size >= 2) {
      this.pinchDist = this.currentPinchDist();
      this.pinchCentroid = this.currentCentroid();
      this.pinchAngle = this.currentPinchAngle();
    } else {
      this.clearBaseline();
    }
  }

  // ピンチ基準を消す。追跡中のポインタはそのまま残す。
  public clearBaseline(): void {
    this.pinchDist = 0;
    this.pinchCentroid = null;
    this.pinchAngle = 0;
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
}
