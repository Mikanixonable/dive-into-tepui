// ECI 絶対座標の曲線を1本の折れ線として描く共通ラッパー。軌道ガイド線もゼロ速度曲線も、
// 「曲線を1つ持ち、描画原点の移動へ追随しながら Curve へ流す」という同じ形をしている。
// 曲線そのもの(どう補間するか)は呼び出し側が決め、ここは基準点・焼き直しの鍵・
// 描画原点への追随だけを持つ。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../physics/vec3';
import { Curve, CurveColorSampler, CurveSampler } from '../../render/curve';
import { LineStyle } from '../../render/line-style';
import { FloatingOrigin } from '../floating-origin';

export class GuideCurve {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  // 頂点を相対化する基準点(ECI [m])。sample はこの点からの相対を返す。
  private origin: Vec3 | null = null;
  private sampler: CurveSampler | null = null;
  private revision: object = {};
  // 頂点カラーの焼き直し待ち。曲線が変わらなくても色だけ変わることがある。
  private colorsDirty = false;

  // maxVertices は1本の折れ線が持てる頂点数の上限。
  public constructor(style: LineStyle, maxVertices: number) {
    this.curve = new Curve({ style, maxVertices });
    this.line = this.curve.object;
  }

  // 描く曲線を差し替える。origin は頂点を相対化する基準点(ECI [m])、sample は t∈[0,1] で
  // origin からの相対位置を返す関数。
  public setSampler(origin: Vec3, sample: CurveSampler): void {
    this.origin = origin;
    this.sampler = sample;
    this.revision = {};
  }

  // 曲線を持たない状態(非表示)へ戻す。
  public clear(): void {
    this.origin = null;
    this.sampler = null;
    this.revision = {};
  }

  // 曲線上の count+1 点を ECI 絶対座標で返す(両端を含む)。曲線を持たない間は空。
  public samplePoints(count: number): readonly Vec3[] {
    const origin = this.origin;
    const sample = this.sampler;
    if (!origin || !sample) return [];
    const scratch = new THREE.Vector3();
    const points: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
      sample(i / count, scratch);
      points.push({ x: origin.x + scratch.x, y: origin.y + scratch.y, z: origin.z + scratch.z } as Vec3);
    }
    return points;
  }

  // 描画原点の移動へ追随させ、colorAt が指定されていれば頂点カラーで焼く。
  public sync(fo: FloatingOrigin, camera: THREE.Camera, colorAt?: CurveColorSampler): void {
    const origin = this.origin;
    const sample = this.sampler;
    if (!origin || !sample) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(origin));
    this.curve.setCurve(sample, { revision: this.revision, camera, colorAt });
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
