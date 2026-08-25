// マップビューのガイドとして描く、CR3BP のゼロ速度曲線(表示パネルのガイドタブ5.3節)。
// 断面(系×面)ごと・ヤコビ定数ごと・連結成分ごとに1本の折れ線を描く。
//
// 2D の等高線抽出(zeroVelocityCurves、O(resolution²))と、それを ECI へ埋め込む変換
// (rotatingFrame、O(1))とで重さが大きく違うので、設定が変わったときだけ前者をやり直し、
// 回転基底が進んだときは後者だけをやり直す(orbit-guide-lines.ts の RECOMPUTE_INTERVAL と
// 同じ考え方)。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { Vec3 } from '../../physics/vec3';
import { rotatingFrame } from '../../physics/orbit-guide';
import { zeroVelocityCurves, SectionPlane } from '../../physics/zero-velocity';
import type { CatalogSystemId } from '../../physics/orbit-catalog';
import { FloatingOrigin } from '../floating-origin';
import { GuideCurve } from './guide-curve';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { ZeroVelocitySettings } from './orbit-guide-settings';
import { OrbitGuideCatalog } from './orbit-guide-catalog';
import * as C from '../const';

// 断面の描画範囲 [両天体間距離を1とする無次元単位]。主天体(原点寄り)・副天体(1−μ 付近)の
// 双方と、その外側に開くヤコビ定数の低い曲線の一部までを含む値として 1.6 を採る
// (μ が小さい系でも副天体は 1 の近くにあり、L4/L5 は距離1の正三角配置にあるため、
// 1.6 あれば両天体・共線点・トロヤ点のネックまで一通り入る)。系のスケールにのみ依存する
// 無次元値なので、断面4つ(地球-月・太陽-地球 × xy/xz)すべてで共通に使える。
const HALF = 1.6;
// 片側の格子分割数。臨界ヤコビ定数付近でネックが偽って閉じない(=解像度不足で連結成分の
// 判定を誤る)のを避けるため、見た目と負荷の兼ね合いでやや高めの300を採る。
const RESOLUTION = 300;
// 点列を引き直す表示時刻の間隔 [s]。orbit-guide-lines.ts と同じ値・同じ理由
// (回転系は静止しているので、時刻の効果は基底の回転だけに現れる)。
const RECOMPUTE_INTERVAL = 300;
// 始点・終点をこれ未満の距離(無次元単位)で「同じ点」とみなし、閉じた輪として描く。
// zeroVelocityCurves が実際に一周した成分は始点と終点が完全に一致する(浮動小数の丸め
// ぶんだけ僅かに異なりうる)ので、格子の1辺よりずっと小さい値で十分。
const CLOSE_EPSILON = 1e-9;
// 1本の折れ線の頂点予算。実際の連結成分の長さは形に依存するため上限を大きめに取る
// (片側300分割の格子で1成分が総辺数の大半を占めることは実用上ほぼ無いが、保険として
// 格子1辺あたり数点分の余裕を見込む)。
const VERTEX_BUDGET = 2000;

type Point2 = readonly [number, number];

// 断面の定義。系と面の組は4つで固定。
interface Section {
  readonly key: keyof ZeroVelocitySettings;
  readonly system: CatalogSystemId;
  readonly plane: SectionPlane;
}

const SECTIONS: readonly Section[] = [
  { key: 'earthMoonXY', system: 'earth-moon', plane: 'xy' },
  { key: 'earthMoonXZ', system: 'earth-moon', plane: 'xz' },
  { key: 'sunEarthXY', system: 'sun-earth', plane: 'xy' },
  { key: 'sunEarthXZ', system: 'sun-earth', plane: 'xz' },
];

// 断面上で抽出した1本ぶんの静的な形(無次元2次元座標)。時刻に依存しないので、設定が
// 変わらない限り使い回す。
interface ShapeEntry {
  readonly system: CatalogSystemId;
  readonly plane: SectionPlane;
  readonly points2d: readonly Point2[];
  readonly closed: boolean;
}

// ECI 絶対座標 [m] の点列を1本の折れ線として描く(orbit-guide-lines.ts の GuideCurve と
// 同じ流儀の小さなラッパー。読み取り専用ファイルにある実装をここで複製している)。

interface LineEntry {
  readonly shape: ShapeEntry;
  readonly curve: GuideCurve;
}

// multiple の設定からヤコビ定数の列を組む。1本なら jacobi 単体、多数なら
// jacobiMin〜jacobiMax を count 等分した値。
function jacobiValues(settings: ZeroVelocitySettings): readonly number[] {
  if (!settings.multiple) return [settings.jacobi];
  const { jacobiMin, jacobiMax, count } = settings;
  if (count <= 1) return [jacobiMin];
  return Array.from({ length: count }, (_, i) => jacobiMin + ((jacobiMax - jacobiMin) * i) / (count - 1));
}

// 設定のうち、抽出する曲線の形(=マーチングスクエア再実行の要否)を決める部分だけの識別子。
// opacity は形に関わらないので含めない。
function structuralKey(settings: ZeroVelocitySettings): string {
  const on = SECTIONS.filter((s) => settings[s.key] === true).map((s) => s.key).join(',');
  const jacobi = jacobiValues(settings).join(',');
  return `${on}|${jacobi}`;
}

export class ZeroVelocityLines {
  private readonly catalog = new OrbitGuideCatalog();
  private shapes: readonly ShapeEntry[] = [];
  private lines: LineEntry[] = [];
  private settings: ZeroVelocitySettings | null = null;
  private structureKey = '';
  private lastComputedTime: number | null = null;

  public constructor(private readonly scene: THREE.Scene, private readonly ephemeris: Ephemeris) {}

  // ゲーム側配線用の setter。sync はここで受けた最新値を読む。
  public setSettings(settings: ZeroVelocitySettings): void {
    this.settings = settings;
  }

  // マップビューのときだけ曲線を同期する。等高線の抽出(格子走査)は断面やヤコビ定数が
  // 変わったときだけ、ECI への埋め込みは回転基底が目に見えて回ったときだけ走る。
  public sync(displayTime: number, overviewMode: boolean, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!overviewMode || !this.settings) {
      for (const entry of this.lines) entry.curve.hide();
      return;
    }
    const settings = this.settings;

    const structureKey = structuralKey(settings);
    if (structureKey !== this.structureKey) {
      this.rebuildShapes(settings);
      this.structureKey = structureKey;
      this.lastComputedTime = null; // 形が変わったので埋め込みも必ずやり直す
    }

    const timeMoved = this.lastComputedTime === null
      || Math.abs(displayTime - this.lastComputedTime) >= RECOMPUTE_INTERVAL;
    if (timeMoved) {
      this.reembed(displayTime);
      this.lastComputedTime = displayTime;
    }

    for (const entry of this.lines) {
      entry.curve.sync(fo, camera);
      entry.curve.setOpacity(settings.opacity);
    }
  }

  // 系ごとの μ。地球-月・太陽-地球はどちらも起動時から静的に読み込まれているカタログなので
  // 常に取れる(読み込み待ちで null になることはない)。
  private muFor(system: CatalogSystemId): number | null {
    return this.catalog.systemFor(system)?.mu ?? null;
  }

  // 断面×ヤコビ定数ごとにマーチングスクエア法で等高線を抽出し直す(重い処理、設定が
  // 変わったときだけ呼ぶ)。
  private rebuildShapes(settings: ZeroVelocitySettings): void {
    const shapes: ShapeEntry[] = [];
    const jacobis = jacobiValues(settings);
    for (const section of SECTIONS) {
      if (settings[section.key] !== true) continue;
      const mu = this.muFor(section.system);
      if (mu === null) continue;
      // 断面ごとに 2Ω の格子を1度だけ組み、全てのヤコビ定数の等高線をそこから引く。
      for (const components of zeroVelocityCurveSet(mu, jacobis, section.plane, HALF, RESOLUTION)) {
        for (const points of components) {
          if (points.length < 2) continue;
          const first = points[0]!;
          const last = points[points.length - 1]!;
          const dx = first[0] - last[0];
          const dy = first[1] - last[1];
          const closed = dx * dx + dy * dy < CLOSE_EPSILON * CLOSE_EPSILON;
          // 閉じた輪は最後の点(始点と重複)を落とす。閉じ方はサンプラ側(closed=true)が
          // 末尾→先頭を結んで担う。
          const points2d = closed ? points.slice(0, -1) : points;
          shapes.push({ system: section.system, plane: section.plane, points2d, closed });
        }
      }
    }
    this.shapes = shapes;

    // 曲線オブジェクトの本数を形の本数に合わせ直す(orbit-guide-lines.ts の rebuildLines
    // と同じく、本数が変わるとき=マーチングスクエアをやり直したときだけ作り直す)。
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = this.shapes.map((shape) => {
      const curve = new GuideCurve(
        { color: C.COLOR_ZERO_VELOCITY_LINE, opacity: settings.opacity, renderOrder: LINE_RENDER_ORDER.reference },
        VERTEX_BUDGET,
        shape.closed,
      );
      this.scene.add(curve.line);
      return { shape, curve };
    });
  }

  // 回転基底(rotatingFrame)が変わった分だけを、キャッシュ済みの2次元形状へ適用し直す
  // (軽い処理、表示時刻が動くたびに呼んでよい)。
  private reembed(displayTime: number): void {
    // 系ごとに rotatingFrame を1回だけ求めて使い回す。
    const frames = new Map<CatalogSystemId, ReturnType<typeof rotatingFrame>>();
    for (const entry of this.lines) {
      const { system, plane, points2d } = entry.shape;
      let frame = frames.get(system);
      if (frame === undefined) {
        const mu = this.muFor(system);
        frame = mu === null ? null : rotatingFrame(displayTime, this.ephemeris, system, mu);
        frames.set(system, frame);
      }
      if (!frame) {
        entry.curve.setPoints([]);
        continue;
      }
      const { origin, xHat, yHat, zHat, unit } = frame;
      const points3d = points2d.map(([u, v]): Vec3 => {
        const second = plane === 'xy' ? yHat : zHat;
        return {
          x: origin.x + (u * xHat.x + v * second.x) * unit,
          y: origin.y + (u * xHat.y + v * second.y) * unit,
          z: origin.z + (u * xHat.z + v * second.z) * unit,
        } as Vec3;
      });
      entry.curve.setPoints(points3d);
    }
  }

  // 全ての折れ線をシーンから外して破棄する。
  public dispose(): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];
    this.shapes = [];
  }
}
