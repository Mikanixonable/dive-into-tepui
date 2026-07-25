// マップモードの数値予測軌道(複数ノード対応)を描画するポリライン。汎用の点列描画は
// SampledLine(src/render/)へ委譲し、この TrajLine はプラン固有の責務 ―― ノード時刻での
// セグメント分割と「まだ実行していない噴射(グレー)→最初のノード後(白)→2個目以降(オレンジ)」
// の色分け ―― だけを担う薄いラッパ。将来この色分け責務は B-2(PlanTrajectory)へ昇格する。
//
// 各セグメントは 1 本の SampledLine で、bake(頂点を frame 相対へ, syncGeometry が点列/frame
// 変化時のみ) と un-bake(現在時刻の剛体回転 + フローティングオリジン補正, syncTransform が
// 毎フレーム) を各自で行う。TrajLine はどこでセグメントを区切り、各セグメントに何色を割り当てる
// かだけを決める。
import * as THREE from 'three/webgpu';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { TrajectorySample } from '../../physics/predict';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';

// セグメント色: [未実行の噴射前=グレー, 最初のノード後=白, 2個目以降=オレンジ]。
const SEGMENT_COLORS = [0xbfc9d4, 0xffffff, 0xff6a00];
const segmentColor = (i: number): number => SEGMENT_COLORS[Math.min(i, SEGMENT_COLORS.length - 1)]!;
const segmentOpacity = (i: number): number => (i === 0 ? 0.55 : 0.85);

// 余ったセグメント(ノードが減った)を空表示にするための共有参照。同じ参照を渡すことで
// SampledLine.syncGeometry の変化検出が空リビルドを一度きりに抑える。
const EMPTY: readonly TrajectorySample[] = [];

export class TrajLine {
  readonly group = new THREE.Group();
  private segments: SampledLine[] = [];
  private lastSeenSamples: readonly TrajectorySample[] | null = null;
  private lastFrame: Frame | null = null;

  constructor() {
    this.group.visible = false;
  }

  // 毎フレーム呼ぶ。trajSamples の参照 or frame が前回から変わったときだけ、ノード時刻で
  // 区切ったセグメントへ分割し直し、各セグメントを子 SampledLine に渡して bake させる。
  syncGeometry(
    trajSamples: readonly TrajectorySample[],
    frame: Frame,
    ephemeris: Ephemeris,
    nodeTimes: readonly number[],
  ): void {
    if (trajSamples === this.lastSeenSamples && frame === this.lastFrame) return;
    this.lastSeenSamples = trajSamples;
    this.lastFrame = frame;

    const segments = splitAtNodes(trajSamples, nodeTimes);
    for (let i = 0; i < segments.length; i++) {
      this.segmentAt(i).syncGeometry(segments[i]!, frame, ephemeris);
    }
    // 余った子(ノードが減った)は空にして隠す。プールは維持して再利用する。
    for (let i = segments.length; i < this.segments.length; i++) {
      this.segments[i]!.syncGeometry(EMPTY, frame, ephemeris);
    }
  }

  // 毎フレーム: 各セグメントの剛体 un-bake + フローティングオリジン補正。
  syncTransform(frame: Frame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin): void {
    for (const s of this.segments) s.syncTransform(frame, currentTime, ephemeris, fo);
  }

  // セグメント i 用の SampledLine を得る。足りなければプールを伸ばす。色はインデックスで
  // 一意に決まるので、プール再利用でも配色は常に正しい。
  private segmentAt(i: number): SampledLine {
    while (this.segments.length <= i) {
      const idx = this.segments.length;
      const s = new SampledLine(segmentColor(idx), segmentOpacity(idx), 2);
      this.segments.push(s);
      this.group.add(s.line);
    }
    return this.segments[i]!;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    for (const s of this.segments) s.dispose();
    this.segments = [];
  }
}

// ノード時刻でサンプル列を分割する。各セグメントは前セグメント終端(ノード位置)を先頭に
// 含めて連続させ、色の切り替わり位置で線が途切れないようにする。
function splitAtNodes(
  samples: readonly TrajectorySample[],
  nodeTimes: readonly number[],
): TrajectorySample[][] {
  const segments: TrajectorySample[][] = [];
  let segment: TrajectorySample[] = [];
  let nodeIdx = 0;
  for (const sample of samples) {
    segment.push(sample);
    if (nodeIdx < nodeTimes.length && sample.t >= nodeTimes[nodeIdx]! - 1e-6) {
      segments.push(segment);
      segment = [segment[segment.length - 1]!];
      nodeIdx++;
    }
  }
  if (segment.length > 1) segments.push(segment);
  return segments;
}
