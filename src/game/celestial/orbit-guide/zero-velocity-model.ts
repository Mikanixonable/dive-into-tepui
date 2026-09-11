// マップビューのガイドとして描く、CR3BP のゼロ速度曲線の宣言を組む(表示パネルのガイドタブ
// 5.3節)。断面(系×面)ごと・ヤコビ定数ごと・連結成分ごとに1本の曲線を組む。
//
// 2D の等高線抽出(zeroVelocityCurves、O(resolution²))と、それを ECI へ埋め込む変換
// (rotatingFrame、O(1))とで重さが大きく違うので、設定が変わったときだけ前者をやり直し、
// 回転基底が進んだときは後者だけをやり直す。
import { OrbitingMotion } from '../../../physics/celestial-motion';
import { secondaryFrameOf } from '../../../physics/lagrange';
import type { CelestialBodies } from '../celestial-bodies';
import { Vec3 } from '../../../math/vec3';
import { guideSecondary, rotatingFrame } from '../../../physics/orbit-guide';
import { zeroVelocityCurveSet, SectionPlane } from '../../../physics/zero-velocity';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { LINE_RENDER_ORDER, LineStyle } from '../../../render/line-style';
import type { ViewMode } from '../../../render/view-mode';
import type { ZeroVelocityDisplay } from '../../../render/celestial/orbit-guide/zero-velocity-view';
import { ZeroVelocitySettings } from './orbit-guide-settings';
import { catalogSystemScale } from './orbit-guide-catalog';

const COLOR_ZERO_VELOCITY_LINE = 0xd97a94;

// 断面の描画範囲 [両天体間距離を1とする無次元単位]。主天体(原点寄り)・副天体(1−μ 付近)の
// 双方と、その外側に開くヤコビ定数の低い曲線の一部までを含む値として 1.6 を採る
// (μ が小さい系でも副天体は 1 の近くにあり、L4/L5 は距離1の正三角配置にあるため、
// 1.6 あれば両天体・共線点・トロヤ点のネックまで一通り入る)。系のスケールにのみ依存する
// 無次元値なので、断面8つ(地球-月・太陽-地球・太陽-木星・太陽-土星 × xy/xz)すべてで共通に使える。
const HALF = 1.6;
// 片側の格子分割数。臨界ヤコビ定数付近でネックが偽って閉じない(=解像度不足で連結成分の
// 判定を誤る)のを避けるため、負荷との兼ね合いでやや高めの300を採る。曲線の滑らかさは
// 節点間のエルミート補間と描画側の適応分割が決めるので、この値には依らない。
const RESOLUTION = 300;
// 曲線を ECI へ埋め込み直す表示時刻の間隔 [s]。回転系では曲線が静止しているので、時刻の効果は
// 基底の回転だけに現れる。最も速い地球-月系(周期 27.3 日)でもこの間に 0.05° しか回らない。
const RECOMPUTE_INTERVAL = 300;
// 始点・終点をこれ未満の距離(無次元単位)で「同じ点」とみなし、閉じた輪として描く。
// zeroVelocityCurves が実際に一周した成分は始点と終点が完全に一致する(浮動小数の丸め
// ぶんだけ僅かに異なりうる)ので、格子の1辺よりずっと小さい値で十分。
const CLOSE_EPSILON = 1e-9;
type Point2 = readonly [number, number];

// マップビュー以外のフレームで返す空の列。
const NO_LINES: readonly ZeroVelocityDisplay[] = [];

// 断面の定義。系と面の組は8つで固定。
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
  { key: 'sunJupiterXY', system: 'sun-jupiter', plane: 'xy' },
  { key: 'sunJupiterXZ', system: 'sun-jupiter', plane: 'xz' },
  { key: 'sunSaturnXY', system: 'sun-saturn', plane: 'xy' },
  { key: 'sunSaturnXZ', system: 'sun-saturn', plane: 'xz' },
];

// 断面上で抽出した1本ぶんの静的な形(無次元2次元座標)。時刻に依存しないので、設定が
// 変わらない限り使い回す。
interface ShapeEntry {
  readonly system: CatalogSystemId;
  readonly plane: SectionPlane;
  readonly points2d: readonly Point2[];
  readonly closed: boolean;
}

// 断面の形を表示時刻の回転基底へ埋め込んだ曲線1本。形が変わらない限り同じオブジェクトを
// 保つ — 描画側はこの同一性で点列の引き直しを省く。
interface EmbeddedContour {
  readonly origin: ZeroVelocityDisplay['origin'];
  readonly shape: ZeroVelocityDisplay['shape'];
}

// ゼロ速度曲線の見た目。線ごとに変わるのは不透明度だけ。
function lineStyle(opacity: number): LineStyle {
  return { color: COLOR_ZERO_VELOCITY_LINE, opacity, renderOrder: LINE_RENDER_ORDER.reference };
}

// 等高線の点列を、origin からの相対位置を持つ節点列の曲線に組む。等高線は滑らかな関数 2Ω の
// 等位集合なので、隣接点の中心差分を接線にすれば節点の間をエルミートで埋められる。closed なら
// 末尾に始点を足して輪を閉じ、端の接線も輪を跨いで取る。
function contourShape(
  points: readonly Vec3[], closed: boolean, origin: Vec3,
): ZeroVelocityDisplay['shape'] {
  const ring = closed ? [...points, points[0]!] : points;
  const last = ring.length - 1;
  const ts: number[] = [];
  const positions: number[] = [];
  const tangents: number[] = [];
  for (let i = 0; i <= last; i++) {
    const p = ring[i]!;
    ts.push(i / last);
    positions.push(p.x - origin.x, p.y - origin.y, p.z - origin.z);
    // 端では輪を跨いで隣を取る。閉じていない線の端だけが片側差分(1区間ぶんの幅)になる。
    const prev = i === 0 ? (closed ? last - 1 : 0) : i - 1;
    const next = i === last ? (closed ? 1 : last) : i + 1;
    const width = ((i === 0 || i === last) && !closed ? 1 : 2) / last;
    const a = ring[prev]!;
    const b = ring[next]!;
    tangents.push((b.x - a.x) / width, (b.y - a.y) / width, (b.z - a.z) / width);
  }
  return { kind: 'hermite', knots: { ts, positions, tangents } };
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

export class ZeroVelocityModel {
  private shapes: readonly ShapeEntry[] = [];
  // shapes と同じ並びで、埋め込めた断面だけを持つ曲線。
  private contours: readonly EmbeddedContour[] = [];
  private structureKey = '';
  private lastComputedTime: number | null = null;

  // 直近に組んだ宣言の列と、それを組んだ設定。
  private displays: readonly ZeroVelocityDisplay[] = NO_LINES;
  private displayedSettings: ZeroVelocitySettings | null = null;

  public constructor(private readonly celestialBodies: CelestialBodies) {}

  // このフレームに描くゼロ速度曲線の宣言を返す(マップビュー以外では空)。等高線の抽出
  // (格子走査)は断面やヤコビ定数が変わったときだけ、ECI への埋め込みは回転基底が目に見えて
  // 回ったときだけ走る。
  public sync(
    settings: ZeroVelocitySettings, displayTime: number, viewMode: ViewMode,
  ): readonly ZeroVelocityDisplay[] {
    if (viewMode !== 'map') return NO_LINES;

    // 断面・ヤコビ定数が変わったときだけ等高線を抽出し直す。
    const structureKey = structuralKey(settings);
    if (structureKey !== this.structureKey) {
      this.rebuildShapes(settings);
      this.structureKey = structureKey;
      this.lastComputedTime = null; // 形が変わったので埋め込みも必ずやり直す
    }

    // 回転基底が目に見えて回ったときだけ ECI へ埋め込み直す。
    const timeMoved = this.lastComputedTime === null
      || Math.abs(displayTime - this.lastComputedTime) >= RECOMPUTE_INTERVAL;
    if (timeMoved) {
      this.contours = this.embed(displayTime);
      this.lastComputedTime = displayTime;
    }

    if (timeMoved || settings !== this.displayedSettings) {
      const style = lineStyle(settings.opacity);
      this.displays = this.contours.map(({ origin, shape }) => ({ origin, shape, style }));
      this.displayedSettings = settings;
    }
    return this.displays;
  }

  // 系ごとの μ。索引から引くので、族の点列の読み込みを待たない。
  private muFor(system: CatalogSystemId): number | null {
    return catalogSystemScale(system)?.mu ?? null;
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
          // 閉じた輪は最後の点(始点と重複)を落とし、閉じているという事実だけを持たせる。
          const points2d = closed ? points.slice(0, -1) : points;
          shapes.push({ system: section.system, plane: section.plane, points2d, closed });
        }
      }
    }
    this.shapes = shapes;
  }

  // キャッシュ済みの2次元形状を、その時刻の回転基底(rotatingFrame)で ECI へ埋め込み直す
  // (軽い処理、表示時刻が動くたびに呼んでよい)。基底を組めない系の断面は落とす。
  private embed(displayTime: number): readonly EmbeddedContour[] {
    // 系ごとに rotatingFrame を1回だけ求めて使い回す。
    const frames = new Map<CatalogSystemId, ReturnType<typeof rotatingFrame>>();
    const contours: EmbeddedContour[] = [];
    for (const { system, plane, points2d, closed } of this.shapes) {
      let frame = frames.get(system);
      if (frame === undefined) {
        const mu = this.muFor(system);
        const motion = this.celestialBodies.findMotion(guideSecondary(system));
        const secondary = mu === null || !(motion instanceof OrbitingMotion) ? null
          : secondaryFrameOf(this.celestialBodies.celestialMotions, displayTime, motion, displayTime);
        frame = secondary === null || mu === null ? null : rotatingFrame(secondary, mu);
        frames.set(system, frame);
      }
      if (!frame) continue;
      const { origin, xHat, yHat, zHat, unit } = frame;
      const points3d = points2d.map(([u, v]): Vec3 => {
        const second = plane === 'xy' ? yHat : zHat;
        return {
          x: origin.x + (u * xHat.x + v * second.x) * unit,
          y: origin.y + (u * xHat.y + v * second.y) * unit,
          z: origin.z + (u * xHat.z + v * second.z) * unit,
        } as Vec3;
      });
      // 頂点を相対化する基準点は曲線上の1点でよいので、成分の先頭を採る。
      const base = points3d[0]!;
      contours.push({ origin: base, shape: contourShape(points3d, closed, base) });
    }
    return contours;
  }
}
