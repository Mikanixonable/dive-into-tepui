// 多ノードの計画軌道を区間ごとの予測弧として解く。計画を区間へ分解し、各区間の到達状態・
// アプシス・衝突点と、画面上の最寄り点を答える。折れ線は PlanPathView へ宣言して描く。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { KinematicState } from '../../physics/kinematic-state';
import type { CelestialBody } from '../../physics/celestial-body';
import { Vec3 } from '../../math/vec3';
import { FrameAnchorSource, FrameTransform, ReferenceFrame, toFrameDir, toFramePoint, toInertialDir, toInertialPoint } from '../../physics/frame';

import { Projected } from '../../math/projection';
import { isOccluded } from '../../physics/occlusion';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { PlanPathView, type PlanArcLine } from '../../render/plan/plan-path-view';
import { LINE_RENDER_ORDER, type LineStyle } from '../../render/line-style';
import type { ProjectFn, ScaleFn } from '../../math/projection';
import { DisplayDurationSource, PlanData, TimeRange, segmentDurationFrom } from './plan';
import { BodyImpact, PredictedArc } from '../dynamic/predicted-arc';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import { clipSamplesTo, samplesInRange, stateAt, withinEnd } from './arc-range';
import { goldenSectionMin } from '../../math/optimize';
import { SHIP_BCINV, SHIP_SRP_COEFF } from '../dynamic/dynamic-entity/ship';
import { PLAYER_HULL_RADIUS } from '../player/player';

// 折れ線が自分自身に重なる(周回を跨いで表示期間が延びた)場合、最短画面距離からこの
// 許容差以内の候補のうち最も早い時刻のものを選ぶ [px]
const NEAREST_SAMPLE_TIE_PX = 3;

// 計画軌道の破線1本・間隔の画面上の長さ [px] と不透明度。マップの倍率は数桁変わるので、
// 実距離で固定すると拡大時は数本の線分に、縮小時はサブピクセルになって実線と区別できない。
const PLAN_ARC_DASH_PX = 8;
const PLAN_ARC_GAP_PX = 6;
const PLAN_ARC_OPACITY = 0.85;

// 区間 index ごとの折れ線の色。末尾の色を以降の区間で使い回す。
const SEGMENT_COLORS = [0xffb36b, 0xff8a26, 0xff6a00];
const arcColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;

// i 番目の区間の折れ線の見た目。mpp [m/px] は破線の画面ピクセル指定を実距離へ直す尺度。
function lineStyle(i: number, mpp: number): LineStyle {
  return {
    color: arcColor(i), opacity: PLAN_ARC_OPACITY, renderOrder: LINE_RENDER_ORDER.plan,
    dash: { dashSize: PLAN_ARC_DASH_PX * mpp, gapSize: PLAN_ARC_GAP_PX * mpp },
  };
}

const OFFSCREEN: Projected = { x: 0, y: 0, front: false };
const NO_SAMPLES: readonly KinematicState[] = [];

// 時刻の近さで tie-break するときに同点とみなす幅[s]。
const TIME_TIE_SEC = 1e-6;

// nearestSample が最寄りサンプルの左右区間を補間曲線上で細分するときの黄金分割探索の反復回数。
const NEAREST_SAMPLE_REFINE_ITERATIONS = 20;

// 起点状態 state0 から時刻 end [s] までの1区間。
interface Segment { state0: KinematicState; end: number }

// 1区間ぶんの積分ソース。弧の [from, to] を読む。owned が偽なら、ノードを1つも持たない唯一の
// 区間が操作艦自身の予測弧を借りたもの(艦の予測がまだ無いフレームは arc が null)。
interface SegmentSource { arc: PredictedArc | null; from: number; to: number; owned: boolean }

// 最後のバーン後(これから乗る軌道)の区間で見つかったアプシス。
// periapsis/apoapsis は、区間が地表到達等で打ち切られてその極値へ届かなければ null。
// *Center はその極値を検出した弧が答える中心天体。
interface FinalSegment {
  readonly periapsis: KinematicState | null;
  readonly apoapsis: KinematicState | null;
  readonly periapsisCenter: CelestialBody | null;
  readonly apoapsisCenter: CelestialBody | null;
}

// 計画軌道上の1点と、それが属する区間の index。
interface PlanPathSample {
  readonly state: KinematicState;
  readonly arcIdx: number;
}

// update() が確定させた表示変換。サンプルは自身の時刻の frame で bake し、displayTime の unbake で
// 表示座標(ECI)へ戻す。frameAnchors は登録天体でない基準の解決役。
interface DisplayTransform {
  readonly frame: ReferenceFrame;
  readonly displayTime: number;
  readonly frameAnchors: FrameAnchorSource;
  readonly unbake: FrameTransform;
}

export class PlanPath {
  // 先頭 activeCount 本がこのフレームの区間に対応する(区間が減れば末尾を捨てる)。
  private readonly sources: SegmentSource[] = [];
  private activeCount = 0;
  // 先頭 _nodeCount 本がノードで終わる区間(= 各ノードの到達状態を持つ)。
  private _nodeCount = 0;
  // このフレームに宣言した弧を描く折れ線の view。
  private readonly view: PlanPathView;
  // 直近の update() が確定させた表示変換。update() を一度も通していなければ null。
  private displayTransform: DisplayTransform | null = null;
  // 折れ線が載っている座標系。update() を通した後に読む。
  public get displayFrame(): ReferenceFrame { return this.requireDisplayTransform().frame; }
  private project: ProjectFn | null = null;
  // sync が最後に受け取ったカメラ位置。nearestSample の遮蔽判定に使う。
  private cameraPos: Vec3 | null = null;
  private final: FinalSegment | null = null;
  // 画面へ描く時間窓 [s]。ノードが複数あると計画全体は表示期間より長くなり得るので、
  // 積分範囲とは別に持つ。
  private displayFrom = 0;
  private displayTo = 0;
  // clipSamplesTo が実際に切り詰めた(= 新規配列を作った)結果を区間の index ごとに
  // (元配列, to) でメモ化したもの。
  private readonly samplesCache: ({ source: readonly KinematicState[]; to: number; result: readonly KinematicState[] } | null)[] = [];
  // 直近の update() で作り直した区間の本数。
  public lastRebuiltArcs = 0;

  // 折れ線の view を scene へ登録する。displayDuration は末尾区間の長さを決める表示期間。
  public constructor(
    scene: THREE.Scene,
    private readonly celestialBodies: CelestialBodies,
    private readonly displayDuration: DisplayDurationSource,
  ) {
    this.view = new PlanPathView(scene);
  }

  // このフレームの表示変換(座標系・un-bake 時刻)を確定させ、起点とノード列から区間列を組み直す。
  // planData が null なら表示変換だけを確定させて区間を空にする。組み直した弧は growableArcs() が
  // 返すので、呼び出し側がそれを requiredEnd まで伸ばす。
  public update(
    planData: PlanData | null, ship: Controllable | null, frame: ReferenceFrame,
    simTime: number, displayTime: number, frameAnchors: FrameAnchorSource, displayDurationSec: number,
  ): void {
    this.displayTransform = {
      frame, displayTime, frameAnchors,
      unbake: this.celestialBodies.frames.transformAt(frame, displayTime, frameAnchors),
    };
    if (planData === null) {
      this.activeCount = 0;
      this.final = null;
      return;
    }
    this.displayFrom = simTime;
    this.displayTo = simTime + Math.max(0, displayDurationSec);
    this.lastRebuiltArcs = 0;
    // 起点→node…→末尾区間に分解する
    const segments = buildSegments(planData, this.celestialBodies, this.displayDuration);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const isFinal = i === segments.length - 1;
      // ノードが1つも無い間の唯一の区間は操作対象の予測弧そのものを借りる。その予測がまだ
      // 生えていないフレームは何も答えず、次のフレームで生え直す。
      if (planData.nodes.length === 0 && isFinal && ship !== null) {
        const arc = ship.motion.arc;
        arc?.apsides?.dropBefore(seg.state0.t);
        this.sources[i] = { arc, from: seg.state0.t, to: seg.end, owned: false };
        continue;
      }
      const prev = this.sources[i];
      let arc = prev?.owned ? prev.arc : null;
      if (!arc || !arc.represents(seg.state0, seg.end)) {
        // 惑星への周回計画のみが対象なので自機の諸元で積分する。外挿の尾を付けると、尾の上に
        // 置いたノードが積分し直した次のノードと繋がらなくなる。
        arc = new PredictedArc(
          seg.state0, this.celestialBodies.celestialMotions, PLAYER_HULL_RADIUS, SHIP_BCINV, SHIP_SRP_COEFF,
          /* keplerTail */ false, /* consumable */ false,
        );
        this.lastRebuiltArcs++;
      }
      arc.requiredEnd = seg.end;
      arc.retainFrom = seg.state0.t;
      this.sources[i] = { arc, from: seg.state0.t, to: seg.end, owned: true };
    }
    this.sources.length = segments.length;
    this.samplesCache.length = segments.length;
    this.activeCount = segments.length;
    this._nodeCount = planData.nodes.length;
    const finalSource = this.sources[segments.length - 1]!;
    this.final = {
      periapsis: this.periapsisOf(finalSource),
      apoapsis: this.apoapsisOf(finalSource),
      periapsisCenter: finalSource.arc?.apsides?.periapsisCenter ?? null,
      apoapsisCenter: finalSource.arc?.apsides?.apoapsisCenter ?? null,
    };
  }

  // いま描いている折れ線そのもの(表示窓で切った区間ごとのサンプル列、時刻昇順)。線の上に
  // 乗せる点(交点など)を探す対象になる。
  public displayedSamples(): readonly (readonly KinematicState[])[] {
    const out: (readonly KinematicState[])[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      // 区間の範囲と表示窓の重なりを描いている部分とし、2点に満たなければ線にならない。
      const source = this.sources[i]!;
      const from = Math.max(this.displayFrom, source.from);
      const to = Math.min(this.displayTo, source.to);
      const drawn = samplesInRange(
        this.samplesOf(i, source), from, to, (t) => this.stateAtSource(source, t),
      );
      if (drawn.length >= 2) out.push(drawn);
    }
    return out;
  }

  // このフレーム owned な弧を区間順(= 時刻順)で返す。どれも requiredEnd まで伸ばす対象。
  public growableArcs(): readonly PredictedArc[] {
    const out: PredictedArc[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const source = this.sources[i]!;
      if (source.owned && source.arc) out.push(source.arc);
    }
    return out;
  }

  // 最後のバーン後の区間。直近の update() が描く計画を受け取っていなければ null。
  public finalSegment(): FinalSegment | null {
    return this.final;
  }

  // このフレームに描く弧を view へ宣言し、画面判定が使う視点を更新する。毎フレーム呼ぶ —
  // 止めると、クリック当たり判定が古い視点のまま残る。
  public sync(camera: CameraFrame): void {
    this.project = camera.project;
    this.cameraPos = camera.position;
    const transform = this.displayTransform;
    if (transform === null) return;
    this.view.sync(
      this.arcLines(camera.scale, transform.frame), transform.displayTime, this.celestialBodies,
      transform.frameAnchors, camera,
    );
  }

  // 折れ線の描画資源を片付ける。
  public dispose(): void {
    this.view.dispose();
  }

  // frame に載せて描く owned な区間の弧。ノードの無い計画は操作対象の予測線と同じ軌道なので空。
  private arcLines(scale: ScaleFn, frame: ReferenceFrame): readonly PlanArcLine[] {
    if (this._nodeCount === 0) return [];
    const lines: PlanArcLine[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const source = this.sources[i]!;
      if (!source.owned || !source.arc) continue;
      // 破線の尺度は区間のサンプル列中央の代表点で引く。代表点が無ければ画面ピクセル指定を
      // そのまま実距離として渡す。
      const samples = this.samplesOf(i, source);
      const mid = samples.length > 0 ? samples[Math.floor(samples.length / 2)]! : null;
      const mpp = mid === null ? 1 : scale(this.toDisplay(mid.r, mid.t));
      // 計画全体が表示期間より長くても、折れ線は表示窓内だけを描く。
      lines.push({
        trajectory: source.arc.trajectory,
        from: Math.max(this.displayFrom, source.from),
        to: Math.min(this.displayTo, source.to),
        frame,
        style: lineStyle(i, mpp),
      });
    }
    return lines;
  }

  // 天体衝突が検出された地点と、その相手の天体(区間ごとに高々1つ)。今フレーム表示中の
  // 区間だけを対象にする。
  public impactPoints(): readonly { readonly state: KinematicState; readonly body: CelestialBody; readonly arcIdx: number }[] {
    const out: { state: KinematicState; body: CelestialBody; arcIdx: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const impact = this.impactOf(this.sources[i]!);
      if (impact) out.push({ state: impact.state, body: impact.body, arcIdx: i });
    }
    return out;
  }

  // 表示中の区間が覆う simTime の範囲。どの区間にもサンプルが無ければ null。
  public timeRange(): { readonly min: number; readonly max: number } | null {
    let minT = Infinity;
    let maxT = -Infinity;
    for (let i = 0; i < this.activeCount; i++) {
      // 区間のサンプル範囲を表示窓で切り、全区間の端を集める。
      const samples = this.samplesOf(i, this.sources[i]!);
      if (samples.length === 0) continue;
      const from = Math.max(samples[0]!.t, this.displayFrom);
      const to = Math.min(samples[samples.length - 1]!.t, this.displayTo);
      if (from > to) continue;
      minT = Math.min(minT, from);
      maxT = Math.max(maxT, to);
    }
    if (minT > maxT) return null;
    return { min: minT, max: maxT };
  }

  // この折れ線が経由するノードの数。
  public get nodeCount(): number {
    return this._nodeCount;
  }

  // 各ノードの到達時点(噴射直前)の状態。到達前に打ち切られた区間は null。
  public arrivalStates(): (KinematicState | null)[] {
    const out: (KinematicState | null)[] = [];
    for (let i = 0; i < this._nodeCount; i++) {
      const source = this.sources[i];
      out.push(source ? this.stateAtSource(source, source.to) : null);
    }
    return out;
  }

  // 時刻 t を保持区間に含む最初の arc から補間した状態を返す。どの arc の外でも null。
  public sampleAt(t: number): KinematicState | null {
    return this.sampleAtWithArc(t)?.state ?? null;
  }

  // 時刻 t の補間状態と、それが属する区間の index を返す。区間ごとに適用済みの Δv が違うので、
  // ノードを区間を跨いで動かすときはこちらで区間を知る。
  public sampleAtWithArc(t: number): PlanPathSample | null {
    for (let i = 0; i < this.activeCount; i++) {
      const s = this.stateAtSource(this.sources[i]!, t);
      if (s) return { state: s, arcIdx: i };
    }
    return null;
  }

  // 時刻 t のサンプル位置 r を、現在の表示座標(ECI)へ変換する。座標系の原点・姿勢はサンプル
  // 時刻 t で bake し、表示時刻で un-bake する。update() を通した後に呼ぶ。
  public toDisplay(r: Vec3, t: number): Vec3 {
    const { frame, frameAnchors, unbake } = this.requireDisplayTransform();
    const bakeTf = this.celestialBodies.frames.transformAt(frame, t, frameAnchors);
    return toInertialPoint(unbake, toFramePoint(bakeTf, r));
  }

  // 時刻 t の方向ベクトル dir を、現在の表示座標(ECI)へ回転する。update() を通した後に呼ぶ。
  public toDisplayDir(dir: Vec3, t: number): Vec3 {
    const { frame, frameAnchors, unbake } = this.requireDisplayTransform();
    const bakeTf = this.celestialBodies.frames.transformAt(frame, t, frameAnchors);
    return toInertialDir(unbake, toFrameDir(bakeTf, dir));
  }

  // 時刻 t のサンプル位置 r をスクリーン座標へ投影する。
  public projectPoint(r: Vec3, t: number): Projected {
    if (!this.project) return OFFSCREEN;
    return this.project(this.toDisplay(r, t));
  }

  // 画面座標に最も近い計画軌道上の点(maxPx 以内)。なければ null。range を渡すとその時刻範囲に
  // 限る。折れ線が自分自身に重なる所では referenceT に最も近い時刻を選ぶので、新規配置は範囲の
  // 下端を、既存ノードのドラッグはそのノードの現在時刻を渡す。
  public nearestSample(
    mx: number,
    my: number,
    maxPx: number,
    referenceT: number,
    range?: TimeRange,
  ): { state: KinematicState, arcIdx: number } | null {
    const maxDSq = maxPx * maxPx;
    const transform = this.displayTransform;
    if (transform === null) return null;
    const cameraPos = this.cameraPos;
    const motions = this.celestialBodies.celestialMotions;
    const candidates: { state: KinematicState; arcIdx: number; sampleIdx: number; dSq: number }[] = [];
    for (let i = 0; i < this.activeCount; i++) {
      const samples = this.samplesOf(i, this.sources[i]!);
      for (let j = 0; j < samples.length; j++) {
        const s = samples[j]!;
        if (range && (s.t < range.min || s.t > range.max)) continue;
        const pos = this.toDisplay(s.r, s.t);
        // 天体に遮蔽されて画面上見えていない点は候補から除く。
        if (cameraPos && isOccluded(cameraPos, pos, motions, transform.frameAnchors.bodiesPivot)) continue;
        const p = this.project ? this.project(pos) : OFFSCREEN;
        if (!p.front) continue;
        const dSq = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
        if (dSq <= maxDSq) candidates.push({ state: s, arcIdx: i, sampleIdx: j, dSq });
      }
    }
    if (candidates.length === 0) return null;

    // 区間は画面距離だけで選ぶ — バーン前後で区間を跨ぐと t の大小が逆転し、時刻で比べると誤る。
    let nearest = candidates[0]!;
    for (const c of candidates) if (c.dSq < nearest.dSq) nearest = c;
    const toleranceDSq = (Math.sqrt(nearest.dSq) + NEAREST_SAMPLE_TIE_PX) ** 2;

    // referenceT が -Infinity なら全候補が同点になり、最後の t 昇順の同点判定だけで最早時刻に落ち着く。
    let best: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (c.arcIdx !== nearest.arcIdx || c.dSq > toleranceDSq) continue;
      const d = Math.abs(c.state.t - referenceT);
      const bestD = best ? Math.abs(best.state.t - referenceT) : Infinity;
      if (!best || d < bestD - TIME_TIE_SEC
        || (Math.abs(d - bestD) <= TIME_TIE_SEC && c.state.t < best.state.t)) best = c;
    }
    if (!best) return null;

    // 選んだ点の左右の隣接サンプルの間で画面距離を単峰とみなし、補間曲線上の最寄り点へ追い込む。
    const source = this.sources[best.arcIdx]!;
    const samples = this.samplesOf(best.arcIdx, source);
    let lo = best.sampleIdx > 0 ? samples[best.sampleIdx - 1]!.t : best.state.t;
    let hi = best.sampleIdx < samples.length - 1 ? samples[best.sampleIdx + 1]!.t : best.state.t;
    if (range) {
      lo = Math.max(lo, range.min);
      hi = Math.min(hi, range.max);
    }
    if (hi <= lo) return { state: best.state, arcIdx: best.arcIdx };

    // 時刻 t の画面距離の2乗。source が t を答えられない、または画面裏に投影される場合は Infinity。
    const f = (t: number): number => {
      const state = this.stateAtSource(source, t);
      if (!state) return Infinity;
      const p = this.projectPoint(state.r, t);
      if (!p.front) return Infinity;
      return (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my);
    };
    const t = goldenSectionMin(lo, hi, f, NEAREST_SAMPLE_REFINE_ITERATIONS);
    const refined = this.stateAtSource(source, t);
    return { state: refined ?? best.state, arcIdx: best.arcIdx };
  }

  // 直近の update() が確定させた表示変換。update() を通す前に引くのは呼び出し順の誤りなので投げる。
  private requireDisplayTransform(): DisplayTransform {
    if (this.displayTransform === null) throw new Error('PlanPath: update() より前に表示変換を引いた');
    return this.displayTransform;
  }

  // source を to でクリップしたサンプル列(arc が無ければ空)。元配列と to が同じ間は同じ配列参照を返す。
  private samplesOf(i: number, source: SegmentSource): readonly KinematicState[] {
    if (!source.arc) return NO_SAMPLES;
    const raw = source.arc.trajectory.samplesOldestFirst();
    const cached = this.samplesCache[i];
    if (cached && cached.source === raw && cached.to === source.to) return cached.result;
    const result = clipSamplesTo(raw, source.to);
    this.samplesCache[i] = { source: raw, to: source.to, result };
    return result;
  }

  // source が答える範囲を to でクリップしたうえでの時刻 t の状態。
  private stateAtSource(source: SegmentSource, t: number): KinematicState | null {
    return source.arc ? stateAt(source.arc.trajectory, t, source.to) : null;
  }

  // source の弧が天体表面へ達した状態。to を超えていれば(区間が縮んでその先で見つかったことに
  // なれば)null。
  private impactOf(source: SegmentSource): BodyImpact | null {
    const impact = source.arc?.impact ?? null;
    return impact && withinEnd(impact.state.t, source.to) ? impact : null;
  }

  // source が答える範囲で最初の近地点。to を超えていれば null。
  private periapsisOf(source: SegmentSource): KinematicState | null {
    const first = source.arc?.apsides?.periapsis ?? null;
    return first && withinEnd(first.t, source.to) ? first : null;
  }

  // source が答える範囲で最初の遠地点。to を超えていれば null。
  private apoapsisOf(source: SegmentSource): KinematicState | null {
    const first = source.arc?.apsides?.apoapsis ?? null;
    return first && withinEnd(first.t, source.to) ? first : null;
  }
}

// 起点から nodes を順にたどって区間列を返す。先頭 nodes.length 本は次のノードで終わり、
// 末尾の1本は segmentDurationFrom ぶん伸びる。
function buildSegments(
  planData: PlanData,
  celestialBodies: CelestialBodies, displayDuration: DisplayDurationSource,
): Segment[] {
  const segments: Segment[] = [];
  let state0 = planData.anchor;
  // ノードを1つずつ経由点として区間を切り出す
  for (const node of planData.nodes) {
    segments.push({ state0, end: node.t });
    state0 = node;
  }
  const motions = celestialBodies.celestialMotions;
  segments.push({ state0, end: state0.t + segmentDurationFrom(state0, motions, displayDuration) });
  return segments;
}
