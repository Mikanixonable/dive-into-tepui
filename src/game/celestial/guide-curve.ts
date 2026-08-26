// ECI 絶対座標の曲線を1本の折れ線として描く。曲線を基準点からの相対で保って Curve へ流し、
// 描画原点の移動へ毎フレーム追随させる。描かれている曲線上の点を ECI 絶対座標で引く口も
// 持つので、進行方向マーカーと当たり判定は線と同じ曲線を読める。
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
  // いま持っている曲線の識別子。曲線を差し替えるたびに新しくして、samplePoints に引き直させる。
  private revision: object = {};
  // sync で Curve へ渡し終えた曲線の revision。曲線を持たない間は null。
  private syncedRevision: object | null = null;
  // 直近に samplePoints が返した点列と、それを引いた曲線・分割数。
  private sampledPoints: readonly Vec3[] = [];
  private sampledRevision: object | null = null;
  private sampledCount = 0;
  private initialSegments: number | undefined = undefined;
  private readonly scratch = new THREE.Vector3();

  // maxVertices の意味は Curve と同じ(収束しない曲線の打ち切り)。
  public constructor(style: LineStyle, maxVertices?: number) {
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
    this.syncedRevision = null;
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

  // 曲線上の count+1 点を ECI 絶対座標で返す(両端を含む)。sync を通っていない間は空。
  // 曲線が変わるまでは同じ配列を返す(毎フレーム呼ばれても引き直さない)。
  public samplePoints(count: number): readonly Vec3[] {
    const revision = this.syncedRevision;
    if (revision === null) return [];
    if (revision !== this.sampledRevision || count !== this.sampledCount) {
      const points: Vec3[] = [];
      for (let i = 0; i <= count; i++) points.push(this.pointAt(i / count));
      this.sampledPoints = points;
      this.sampledRevision = revision;
      this.sampledCount = count;
    }
    return this.sampledPoints;
  }

  // 描画原点の移動へ追随させ、colorAt が指定されていれば頂点カラーで焼く。
  public sync(fo: FloatingOrigin, camera: THREE.Camera, colorAt?: CurveColorSampler): void {
    const origin = this.origin;
    if (!origin) {
      this.syncedRevision = null;
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(origin));
    const opts = { camera, colorAt, initialSegments: this.initialSegments };
    if (this.analytic) this.curve.setAnalyticCurve(this.analytic, opts);
    else if (this.knots) this.curve.setHermiteCurve(this.knots, opts);
    this.syncedRevision = this.revision;
    this.curve.setVisible(true);
  }

  // 線の色と不透明度を差し替える。
  public setStyle(color: number, opacity: number): void {
    this.curve.setColor(color);
    this.curve.setOpacity(opacity);
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

