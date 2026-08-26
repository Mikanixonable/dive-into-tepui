// 非質量ターゲット(艦・基地)基準時、ケプラー軌道要素からは描けない軌道楕円の代わりに描く
// 相対軌跡。OrbitLine の兄弟で、こちらは自エンティティと対象、双方の未来予測から同時刻の状態を
// 取り、その相対位置(自 - 対象)を結ぶ。対象のいまの位置を平行移動の基準にする点は OrbitLine が
// 中心天体のいまの位置を基準にするのと同じ考え方。過去へは伸ばさず、どちらかの予測が尽きた時点
// で打ち切る(外挿はしない)。
import * as THREE from 'three/webgpu';
import { strongestAttractor } from '../physics/celestial-body';
import type { Ephemeris } from '../physics/ephemeris';
import { add, sub, v3, Vec3 } from '../physics/vec3';
import type { FrameAnchorSource } from '../physics/frame';
import type { KinematicState } from '../physics/kinematic-state';
import type { GameEntity } from './game-entity/game-entity';
import { entityStateAt } from './simulation/entity-state-at';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveKnots } from '../render/curve';
import { LineStyle } from '../render/line-style';

// 頂点数の打ち切り。相対軌跡は表示期間(現在の未来予測窓)が限られるため、実軌道の折れ線
// (trajectory-line.ts の MAX_VERTICES=4096)ほどの余裕は要らない。
const MAX_VERTICES = 1024;

export class RelativeOrbitLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  // 直近に曲線を組んだ self.predicted の保持列(参照)。この参照が変わらない限り、既に計算した
  // 節点は時刻ごとに決定論的で変化しないため、Curve の焼き直しを起こさない。
  private lastSelfSamples: readonly KinematicState[] | null = null;
  private revision: object = {};
  // 直近に curve.setTransform へ渡した対象の位置(ECI)。samplePoints の絶対座標化に使う。
  private origin: Vec3 | null = null;

  constructor(style: LineStyle) {
    this.curve = new Curve({ style, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  // 曲線を消し、当たり判定向けのサンプル点も空にする(次回 sync までは何も返さない)。
  hide(): void {
    this.curve.clear();
    this.lastSelfSamples = null;
    this.origin = null;
  }

  // self の未来予測サンプル時刻ごとに target との相対位置を求めて曲線を作り直す。target の予測
  // が self より短ければ、届く範囲までで打ち切る。どちらかの予測を持たなければ非表示にする。
  sync(
    self: GameEntity, target: GameEntity, fo: FloatingOrigin, camera: THREE.Camera,
    frameAnchors: FrameAnchorSource, ephemeris: Ephemeris,
  ): void {
    const selfSamples = self.predicted?.samplesOldestFirst() ?? null;
    const times = selfSamples?.map((s) => s.t).filter((t) => t >= self.state.t) ?? [];
    if (times.length < 2) { this.hide(); return; }
    const selfCenter = strongestAttractor(self.state.r, frameAnchors.bodies);
    const targetCenter = strongestAttractor(target.state.r, frameAnchors.bodies);
    const start = times[0]!;
    const span = times[times.length - 1]! - start;
    if (span <= 0) { this.hide(); return; }

    // 節点は (時刻, 相対位置, 相対速度) — 双方の予測を同じ時刻で評価して差分を取る。self 側は
    // times 自身が self.predicted の保持列そのものなので先端を超えない。target 側は
    // entityStateAt が先端を超えるとケプラー外挿してしまうため、先端(frontier)を明示的に見て
    // そこで打ち切る — 外挿はしない。
    const targetFrontier = target.predicted?.state.t ?? target.state.t;
    const ts: number[] = [];
    const positions: number[] = [];
    const tangents: number[] = [];
    for (const t of times) {
      if (t > targetFrontier) break;
      const p = entityStateAt(self, t, selfCenter, ephemeris);
      const q = entityStateAt(target, t, targetCenter, ephemeris);
      if (p === null || q === null) break;
      const rel = sub(p.r, q.r);
      const relV = sub(p.v, q.v);
      ts.push((t - start) / span);
      positions.push(rel.x, rel.y, rel.z);
      tangents.push(relV.x * span, relV.y * span, relV.z * span);
    }
    if (ts.length < 2) { this.hide(); return; }

    // self.predicted の保持列は伸びるだけで既存区間は変わらないので、参照が同じフレームは
    // 節点も同じ値になる — 焼き直しは参照が変わった(=先端が伸びた)ときだけでよい。
    if (selfSamples !== this.lastSelfSamples) {
      this.lastSelfSamples = selfSamples;
      this.revision = {};
    }
    this.origin = target.state.r;
    this.curve.setTransform(fo.RtoThreeV3(target.state.r));
    this.curve.setHermiteCurve({ ts, positions, tangents } satisfies CurveKnots, { revision: this.revision, camera });
    this.curve.setVisible(true);
  }

  // 直近に描いた曲線上のサンプル点列を ECI 絶対座標で返す(右クリックの当たり判定向け)。
  // 曲線を持たない(非表示)間は空配列。
  samplePoints(count: number): readonly Vec3[] {
    const origin = this.origin;
    if (origin === null) return [];
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.curve.sampleAt(i / count, scratch);
      points.push(add(origin, v3(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
