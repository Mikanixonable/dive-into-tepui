// 軌跡(DynamicTrajectory)の描画区間 [from, to] を1本の単色折れ線として描く。区間の状態を各時刻の
// 座標系相対へ焼き(bake)、表示時刻の座標系の剛体運動で慣性系へ戻して(un-bake)描く。保持区間が
// to に届かないときは、先端を中心天体まわりの二体軌道とみなして to まで外挿し継ぎ足す。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { FrameAnchorSource, FrameTransform, framePoint, ReferenceFrame, toFrameState, toInertialPoint } from '../../physics/frame';
import { DynamicTrajectory, ExtrapolationCenter } from '../../physics/dynamic-trajectory';
import { extrapolatedRelativeStates } from '../../physics/kepler-extrapolation';
import { StateQueue } from '../../physics/state-queue';
import { add, Vec3 } from '../../math/vec3';
import type { CameraFrame } from '../camera/camera-frame';
import { Curve, CurveKnots } from '../curve';
import { LineStyle } from '../line-style';
import type { CelestialFrameSource } from './celestial-frame-source';

// 頂点数の上限。数百周が重なる区間(28日表示など)は何頂点あっても収束しないので頭打ちにする。
// 値は、マップの通常のズームで 99% の区間の残留誤差がサジッタ目標(0.5px)を下回る水準(400周の
// 軌跡の内側から見ると 1.4px まで上がるが、軌跡が画面を埋める網目になり見分けられない)。
const MAX_VERTICES = 4096;

// 外挿区間に足すサンプル数の上限。
const MAX_EXTRAPOLATED_SAMPLES = 2048;

// 描く軌跡が無いときの点列。再 bake は点列の参照で判定するので、空の点列を毎回作ると
// 空の線が毎フレーム焼き直しになる。
const NO_SAMPLES: readonly KinematicState[] = [];

// 外挿区間に使う目標サンプル間隔 [s]。既存の保持列の間引き間隔(baseInterval)に合わせ、
// 履歴が空(baseInterval が 0)なら外挿する区間全体を64分割した間隔にする。
function extrapolationTargetInterval(baseInterval: number, span: number): number {
  return baseInterval > 0 ? baseInterval : span / 64;
}

// tip(保持区間の末尾)から to までを、tip を center まわりの二体ケプラー軌道とみなして外挿した
// ECI 絶対状態列(時刻昇順、tip 自身を除く)。離心率が高すぎる・双曲線などで外挿できないときは空配列。
function extrapolatedTailStates(
  tip: KinematicState, center: ExtrapolationCenter, to: number,
  baseInterval: number, celestialBodies: CelestialFrameSource,
): KinematicState[] {
  const span = to - tip.t;
  const target = extrapolationTargetInterval(baseInterval, span);
  const count = Math.min(MAX_EXTRAPOLATED_SAMPLES, Math.max(2, Math.ceil(span / target)));
  // 外挿は center 相対なので、各サンプルの時刻の center の ECI 状態を足し戻す。
  return extrapolatedRelativeStates(tip, center.celestialBody, center.pivot, to, count).map((s) => {
    const centerState = celestialBodies.stateAt(center.celestialBody.id, s.t);
    return kinematicState<'eci'>(s.t, add(s.r, centerState.r), add(s.v, centerState.v));
  });
}

export class TrajectoryLine {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  private lastSamples: readonly KinematicState[] | null = null;
  private lastFrame: ReferenceFrame | null = null;
  private lastFrom: number | null = null;
  private lastTo: number | null = null;
  // 直近に焼き込んだ外挿区間の to。外挿を持たない bake では null に戻し、次に外挿が要る
  // フレームで必ず焼き直させる。
  private lastExtrapolatedTo: number | null = null;
  private readonly unbakeQuat = new THREE.Quaternion();

  // bake 済みの frame 相対状態列。節点はここから取り、描画区間の端だけ内挿する。
  private baked = new StateQueue();
  // bake 済み列の時刻(昇順)。節点列を組み直すのに使う。
  private bakedTimes: readonly number[] = [];
  // Curve へ渡す節点列。描画区間が変わったときだけ buildKnots が組み直す。
  private knots: CurveKnots | null = null;
  // 描画区間の下限(bake 済み区間の先頭へクランプ済み)。null は下限なし(保持区間全体を描く)。
  private startTime: number | null = null;
  // 描画区間の上限(bake 済み区間の末尾へクランプ済み)。null は上限なし。
  private endTime: number | null = null;
  // 直近の sync で描いた線を慣性系へ戻す un-bake 変換。線が消えているあいだは null。
  private unbakeTransform: FrameTransform | null = null;

  // 単色の折れ線を構築する。style は最初のフレームの見た目で、以後は sync が渡す値で
  // 上書きされる(破線になるかどうかだけは、ここで渡した style の dash が決める)。
  public constructor(style: LineStyle) {
    this.curve = new Curve(style, MAX_VERTICES);
    this.line = this.curve.object;
  }

  // このフレームに描く軌跡・区間・座標系・見た目を反映する。from/to はそれぞれ描画の下限/上限
  // 時刻で、null ならその側は無制限。displayTime は un-bake に使う表示時刻。
  // trajectory が null か、描ける区間が潰れているときは線が消え、samplePoints も空になる。
  public sync(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null,
    frame: ReferenceFrame, displayTime: number, celestialBodies: CelestialFrameSource,
    frameAnchors: FrameAnchorSource, style: LineStyle, camera: CameraFrame,
  ): void {
    this.curve.setStyle(style);
    this.bakeKnots(trajectory, from, to, frame, celestialBodies, frameAnchors);
    const start = this.startTime;
    const end = this.endTime;
    const knots = this.knots;
    if (this.baked.size < 2 || start === null || end === null || start >= end || knots === null) {
      this.unbakeTransform = null;
      this.curve.clear();
      return;
    }
    // un-bake の変換は曲線を焼く前に渡す — 適応分割はこの変換を通した画面上の大きさで粗さを測る。
    const tf = celestialBodies.frames.transformAt(frame, displayTime, frameAnchors);
    this.unbakeTransform = tf;
    this.unbakeQuat.set(tf.q.x, tf.q.y, tf.q.z, tf.q.w);
    this.curve.setTransform(camera.floatingOrigin.RtoThreeV3(tf.origin), this.unbakeQuat);
    this.curve.setHermiteCurve(knots, camera.camera, camera.viewport.height);
  }

  // trajectory の保持区間のうち [from, to](保持区間の端へクランプ)を座標系相対の節点列へ焼く。
  // 保持区間が to に届かず先端が中心天体を持つなら、to まで外挿して継ぎ足す。
  private bakeKnots(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null, frame: ReferenceFrame,
    celestialBodies: CelestialFrameSource, frameAnchors: FrameAnchorSource,
  ): void {
    const samples = trajectory?.samplesOldestFirst() ?? NO_SAMPLES;
    const tip = samples.length > 0 ? samples[samples.length - 1]! : null;
    const center = trajectory?.extrapolationCenter ?? null;
    const extrapolating = to !== null && tip !== null && center !== null && to > tip.t;

    // 座標系相対への焼き直しは重いので、保持列か frame が変わったときと、外挿中に to が外挿
    // 1間隔以上動いたときに限る(1間隔未満なら描画末尾の遅れは見た目に出ない)。
    const rebaked = !extrapolating
      ? samples !== this.lastSamples || frame !== this.lastFrame
      : samples !== this.lastSamples || frame !== this.lastFrame || this.lastExtrapolatedTo === null
        || Math.abs(to! - this.lastExtrapolatedTo) >= extrapolationTargetInterval(trajectory!.sampleInterval, to! - tip!.t);

    if (rebaked) {
      this.lastSamples = samples;
      this.lastFrame = frame;
      const tail = extrapolating
        ? extrapolatedTailStates(tip!, center!, to!, trajectory!.sampleInterval, celestialBodies)
        : [];
      const combined = tail.length > 0 ? [...samples, ...tail] : samples;
      // 補間は座標系に依らないので、座標系相対の位置・速度を 'eci' ブランドのまま詰める
      // (このブランドは関数の外へ出ない)。回転系は時刻で向きが変わるので、サンプルごとの時刻で評価する。
      const queue = new StateQueue(Math.max(1, combined.length));
      for (const s of combined) {
        const rel = toFrameState(celestialBodies.frames.transformAt(frame, s.t, frameAnchors), s);
        queue.push(kinematicState<'eci'>(s.t, rel.r, rel.v));
      }
      this.baked = queue;
      this.bakedTimes = combined.map((s) => s.t);
      this.lastExtrapolatedTo = extrapolating ? to : null;
    }
    // 描画区間を焼いた区間へクランプし、区間が変わったら節点列を組み直す。
    this.startTime = this.baked.size > 0 ? Math.max(from ?? -Infinity, this.baked.oldest!.t) : null;
    this.endTime = this.baked.size > 0 ? Math.min(to ?? Infinity, this.baked.newest!.t) : null;
    if (rebaked || from !== this.lastFrom || to !== this.lastTo) {
      this.lastFrom = from;
      this.lastTo = to;
      this.knots = this.buildKnots();
    }
  }

  // 描画区間 [startTime, endTime] に入る状態を、Curve へ渡す節点列に組む。両端は区間端で
  // 内挿した状態、間は bake 済みサンプルそのもの。
  private buildKnots(): CurveKnots | null {
    const start = this.startTime;
    const end = this.endTime;
    if (start === null || end === null || end <= start) return null;
    const times = [start, ...this.bakedTimes.filter((t) => t > start && t < end), end];
    const states = times.map((t) => this.baked.at(t)).filter((s): s is KinematicState => s !== null);
    if (states.length < 2) return null;
    const span = end - start;
    const ts: number[] = [];
    const positions: number[] = [];
    const tangents: number[] = [];
    for (const s of states) {
      ts.push((s.t - start) / span);
      positions.push(s.r.x, s.r.y, s.r.z);
      // パラメータは時刻を span で割った値なので、その微分は速度の span 倍。
      tangents.push(s.v.x * span, s.v.y * span, s.v.z * span);
    }
    return { ts, positions, tangents };
  }

  // 直近の sync で描いた線上の、当たり判定向けの ECI 絶対座標のサンプル点列を返す。
  // 線が消えているあいだは空配列。
  public samplePoints(count: number): readonly Vec3[] {
    const tf = this.unbakeTransform;
    if (tf === null) return [];
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.curve.sampleAt(i / count, scratch);
      points.push(toInertialPoint(tf, framePoint(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  // 描画資源を解放する。以後この線は描けない。
  public dispose(): void {
    this.curve.dispose();
  }
}
