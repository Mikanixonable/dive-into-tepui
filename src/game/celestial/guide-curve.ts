// ECI 絶対座標の曲線を1本の折れ線として描く共通ラッパー。軌道ガイド線もゼロ速度曲線も、
// 「曲線を1つ持ち、描画原点の移動へ追随しながら Curve へ流す」という同じ形をしている。
// 曲線そのもの(どう補間するか)は呼び出し側が決め、ここは基準点・焼き直しの鍵・
// 描画原点への追随だけを持つ。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Curve, CurveColorSampler, CurveKnots, CurveSampler } from '../../render/curve';
import { LineStyle } from '../../render/line-style';
import { FloatingOrigin } from '../floating-origin';

export class GuideCurve {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  // 頂点を相対化する基準点(ECI [m])。sample はこの点からの相対を返す。
  private origin: Vec3 | null = null;
  // 直近に渡された曲線。Curve へどう渡すかは種類で分かれるので、種類ごとに保つ。
  private analytic: CurveSampler | null = null;
  private knots: CurveKnots | null = null;
  private revision: object = {};
  // 頂点カラーの焼き直し待ち。曲線が変わらなくても色だけ変わることがある。
  private colorsDirty = false;
  private initialSegments: number | undefined = undefined;
  private readonly scratch = new THREE.Vector3();

  // maxVertices は1本の折れ線が持てる頂点数の上限。
  public constructor(style: LineStyle, maxVertices: number) {
    this.curve = new Curve({ style, maxVertices });
    this.line = this.curve.object;
  }

  // 閉じた式で書ける曲線を描く。origin は頂点を相対化する基準点(ECI [m])、sample は
  // t∈[0,1] で origin からの相対位置を返す。initialSegments の意味は Curve 側と同じ。
  public setAnalytic(origin: Vec3, sample: CurveSampler, initialSegments?: number): void {
    this.origin = origin;
    this.analytic = sample;
    this.knots = null;
    this.initialSegments = initialSegments;
    this.revision = {};
  }

  // 離散サンプルしか無い曲線を、節点の位置と接線から描く。節点は origin からの相対。
  public setHermite(origin: Vec3, knots: CurveKnots): void {
    this.origin = origin;
    this.analytic = null;
    this.knots = knots;
    this.revision = {};
  }

  // 曲線を持たない状態(非表示)へ戻す。
  public clear(): void {
    this.origin = null;
    this.analytic = null;
    this.knots = null;
    this.revision = {};
  }

  // 曲線上の t∈[0,1] の点を ECI 絶対座標で返す。曲線を持たない間は原点。
  // sync を通ったあとにだけ意味のある値を返す(描かれている曲線をそのまま読むため)。
  public pointAt(t: number): Vec3 {
    const origin = this.origin;
    if (!origin) return { x: 0, y: 0, z: 0 } as Vec3;
    this.curve.sampleAt(t, this.scratch);
    return {
      x: origin.x + this.scratch.x, y: origin.y + this.scratch.y, z: origin.z + this.scratch.z,
    } as Vec3;
  }

  // 曲線上の count+1 点を ECI 絶対座標で返す(両端を含む)。曲線を持たない間は空。
  public samplePoints(count: number): readonly Vec3[] {
    if (!this.origin) return [];
    const points: Vec3[] = [];
    for (let i = 0; i <= count; i++) points.push(this.pointAt(i / count));
    return points;
  }

  // 描画原点の移動へ追随させ、colorAt が指定されていれば頂点カラーで焼く。
  public sync(fo: FloatingOrigin, camera: THREE.Camera, colorAt?: CurveColorSampler): void {
    const origin = this.origin;
    if (!origin) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(origin));
    const opts = { revision: this.revision, camera, colorAt, initialSegments: this.initialSegments };
    if (this.analytic) this.curve.setAnalyticCurve(this.analytic, opts);
    else if (this.knots) this.curve.setHermiteCurve(this.knots, opts);
    if (this.colorsDirty && colorAt) {
      this.curve.setColors(colorAt);
      this.colorsDirty = false;
    }
    this.curve.setVisible(true);
  }

  // 線の色と不透明度を差し替える。
  public setStyle(color: number, opacity: number): void {
    this.curve.setColor(color);
    this.curve.setOpacity(opacity);
  }

  // 頂点カラーだけが変わったことを伝え、次の sync で色を焼き直させる。
  public invalidateColors(): void {
    this.colorsDirty = true;
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

// 点列を線形補間する CurveSampler。closed なら points[末尾]→points[0] を結んで輪を閉じる。
// 折れ線そのものが曲線であるデータ用で、滑らかな曲線の標本には使わない
// (適応分割は入力の折れ線を超える精度を作れない)。
export function polylineSampler(points: readonly Vec3[], origin: Vec3, closed: boolean): CurveSampler {
  const n = points.length;
  const span = closed ? n : n - 1;
  return (t, out) => {
    const f = Math.min(span, Math.max(0, t * span));
    const i0 = Math.min(span - 1, Math.floor(f));
    const frac = f - i0;
    const p0 = points[i0]!;
    const p1 = points[closed ? (i0 + 1) % n : i0 + 1]!;
    out.set(
      p0.x - origin.x + frac * (p1.x - p0.x),
      p0.y - origin.y + frac * (p1.y - p0.y),
      p0.z - origin.z + frac * (p1.z - p0.z),
    );
  };
}
