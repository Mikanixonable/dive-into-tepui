// マップモードの数値予測軌道(複数ノード対応)を描画するポリライン。
// OrbitLine(解析的な楕円、自機・ターゲット・敵の現在軌道用)とは別に、
// RK4 で数値積分された折れ線(predict.ts の TrajectorySample[])をそのまま
// 頂点列として描画する。ノードで区切られたセグメントごとに色を変え、
// 「まだ実行していない噴射(グレー)→最初のノード後(白)→2個目以降(オレンジ)」
// の順に未来が明るくなる配色にする(既存の plannedOrbitLine の配色思想を踏襲)。
//
// ジオメトリは sync() が trajSamples の参照変化(=予測が再計算された)を検出した
// ときだけ作り直す。各頂点は frame(慣性系/太陽回転系)相対座標へ bake する(点ごとに角が
// 違う非剛体変形)。毎フレームは syncTransform() が剛体 un-bake(group クォータニオン)と
// フローティングオリジン補正(group 平行移動)だけを行う。
import * as THREE from 'three/webgpu';
import { Vec3, v3 } from '../../physics/vec3';
import { Quat } from '../../physics/attitude';
import { RelativeVec3 } from '../../physics/frame';
import { TrajectorySample } from '../../physics/predict';
import { FloatingOrigin } from '../floating-origin';

// 折れ線頂点は地球中心(ECI 原点)基準。group.position はその原点の描画フレーム位置。
const EARTH_CENTER = v3(0, 0, 0);

const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];

// sync() が再構築時にだけ呼ぶファクトリ。再構築の瞬間にしか意味を持たない値
// (表示回転基準角など)をこのタイミングで固定できるよう、遅延評価にしている。
export type TrajLineRebuildContext = {
  nodeTimes: readonly number[];
  // 慣性系サンプル(r, t)を frame 相対座標(頂点)へ焼く。un-bake は syncTransform で剛体回転。
  bake: (r: Vec3, t: number) => RelativeVec3;
};

export class TrajLine {
  readonly group = new THREE.Group();
  private lines: THREE.Line[] = [];
  private geoms: THREE.BufferGeometry[] = [];
  private mats: THREE.LineBasicMaterial[] = [];
  private lastSeenSamples: readonly TrajectorySample[] | null = null;

  constructor() {
    this.group.visible = false;
  }

  // 毎フレーム呼ぶ: trajSamples の参照が前回から変わっていなければ何もしない。
  // 変わっていれば(予測が再計算された)onRebuild() で表示座標変換とノード時刻を
  // 取得し、ノードで区切った色分けセグメントを組み立ててジオメトリを作り直す。
  sync(trajSamples: readonly TrajectorySample[], onRebuild: () => TrajLineRebuildContext): void {
    if (trajSamples === this.lastSeenSamples) return;
    this.lastSeenSamples = trajSamples;
    const { nodeTimes, bake } = onRebuild();

    const segments: RelativeVec3[][] = [];
    let segment: RelativeVec3[] = [];
    let nodeIdx = 0;
    for (const sample of trajSamples) {
      segment.push(bake(sample.r, sample.t));
      if (nodeIdx < nodeTimes.length && sample.t >= nodeTimes[nodeIdx]! - 1e-6) {
        segments.push(segment);
        segment = [segment[segment.length - 1]!];
        nodeIdx++;
      }
    }
    if (segment.length > 1) segments.push(segment);

    this.rebuild(segments);
  }

  // segments: ノードで区切られた frame 相対座標列(un-bake・フローティングオリジン補正前)の配列。
  // 各セグメントは前セグメント終端(ノード位置)を先頭に含めて連続させること
  // (色の切り替わり位置で線が途切れないように)。
  private rebuild(segments: RelativeVec3[][]): void {
    this.clear();
    for (let i = 0; i < segments.length; i++) {
      const pts = segments[i]!;
      if (pts.length < 2) continue;
      const arr = new Float32Array(pts.length * 3);
      for (let j = 0; j < pts.length; j++) {
        const p = pts[j]!;
        arr[j * 3] = p.x;
        arr[j * 3 + 1] = p.y;
        arr[j * 3 + 2] = p.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const color = SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: i === 0 ? 0.55 : 0.85,
        depthWrite: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 2;
      this.geoms.push(geo);
      this.mats.push(mat);
      this.lines.push(line);
      this.group.add(line);
    }
  }

  private clear(): void {
    for (const l of this.lines) this.group.remove(l);
    for (const m of this.mats) m.dispose();
    for (const g of this.geoms) g.dispose();
    this.lines = [];
    this.mats = [];
    this.geoms = [];
  }

  // 毎フレーム呼ぶ: 剛体 un-bake(頂点は frame 相対に bake 済みなので group 回転で慣性系へ戻す)
  // + フローティングオリジン補正(group 位置で ECI 原点を描画フレームへ移す)。THREE の合成は
  // world = position + quaternion·vertex なので、原点まわりの un-bake 回転 → 平行移動の順で正しい。
  syncTransform(fo: FloatingOrigin, unbake: Quat): void {
    this.group.quaternion.set(unbake.x, unbake.y, unbake.z, unbake.w);
    this.group.position.copy(fo.RtoThreeV3(EARTH_CENTER));
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.clear();
  }
}
