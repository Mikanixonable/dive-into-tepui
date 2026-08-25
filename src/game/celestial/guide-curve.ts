// ECI 絶対座標の点列を1本の折れ線として描く共通ラッパー。軌道ガイド線もゼロ速度曲線も、
// 「実座標の点列を持ち、描画原点の移動へ追随しながら Curve へ流す」という同じ形をしている。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Curve, CurveColorSampler, CurveSampler } from '../../render/curve';
import { LineStyle } from '../../render/line-style';
import { FloatingOrigin } from '../floating-origin';

// initialTs(t の等分割列)は点数だけで決まるので、点数ごとに1回作って使い回す。
const initialTsCache = new Map<number, readonly number[]>();
function initialTsFor(span: number): readonly number[] {
  const cached = initialTsCache.get(span);
  if (cached) return cached;
  const ts = Array.from({ length: span + 1 }, (_, i) => i / span);
  initialTsCache.set(span, ts);
  return ts;
}

// ECI 絶対座標 [m] の点列を1本の折れ線として描く。closed なら points[末尾]→points[0] を
// 結んで輪を閉じる。頂点は points[0] を原点とした相対値で焼く(f32 精度は Curve 側の
// pivot 追従に任せる)。
export class GuideCurve {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  private points: readonly Vec3[] | null = null;
  private origin: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
  private revision: object = {};

  public constructor(style: LineStyle, samples: number, private readonly closed: boolean) {
    this.curve = new Curve({ style, maxVertices: samples });
    this.line = this.curve.object;
  }

  private readonly sampler: CurveSampler = (t, out) => {
    const points = this.points;
    if (!points || points.length === 0) {
      out.set(0, 0, 0);
      return;
    }
    const n = points.length;
    const span = this.closed ? n : n - 1;
    const f = Math.min(span, Math.max(0, t * span));
    const i0 = Math.min(span - 1, Math.floor(f));
    const frac = f - i0;
    const p0 = points[i0]!;
    const p1 = points[this.closed ? (i0 + 1) % n : i0 + 1]!;
    out.set(
      p0.x - this.origin.x + frac * (p1.x - p0.x),
      p0.y - this.origin.y + frac * (p1.y - p0.y),
      p0.z - this.origin.z + frac * (p1.z - p0.z),
    );
  };

  // 新しい点列を設定する。null / 2点未満は非表示。
  public setPoints(points: readonly Vec3[] | null): void {
    this.points = points && points.length >= 2 ? points : null;
    if (this.points) this.origin = this.points[0]!;
    this.revision = {};
  }

  public worldPoints(): readonly Vec3[] {
    return this.points ?? [];
  }

  // 描画原点の移動へ追随させ、colorAt が指定されていれば頂点カラーで焼く。
  public sync(fo: FloatingOrigin, camera: THREE.Camera, colorAt?: CurveColorSampler): void {
    if (!this.points) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(this.origin));
    const span = this.closed ? this.points.length : this.points.length - 1;
    this.curve.setCurve(this.sampler, { revision: this.revision, camera, initialTs: initialTsFor(span), colorAt });
    this.curve.setVisible(true);
  }

  public setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  public hide(): void {
    this.curve.setVisible(false);
  }

  public dispose(): void {
    this.curve.dispose();
  }
}

