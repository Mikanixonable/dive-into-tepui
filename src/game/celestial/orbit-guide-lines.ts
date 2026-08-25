// マップビューのガイドとして描く、ラグランジュ点まわりの周期・準周期軌道の折れ線群
// (表示パネルの軌道ガイドタブ、静止軌道を除く5種)。OrbitGuideSettings が種類ごとに
// 独立して持つ軸(系×点×南北)の直積ごとに halo-guide.ts の点列 API を呼び、回転基底に
// 載った ECI [m] の点列を折れ線として表示・毎フレーム同期する。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { v3, Vec3 } from '../../physics/vec3';
import {
  droLoop, GuidePoint, GuideSystem, haloGuideLoop, Hemisphere, lissajousPath,
  planarLyapunovLoop, verticalLyapunovLoop,
} from '../../physics/halo-guide';
import { FloatingOrigin } from '../floating-origin';
import { Curve, CurveSampler } from '../../render/curve';
import { LINE_RENDER_ORDER, LineStyle } from '../../render/line-style';
import { GuideAxes, OrbitGuideSettings } from './orbit-guide-settings';
import * as C from '../const';

const HALO_SAMPLES = 512;
const LISSAJOUS_SAMPLES = 512;
const LISSAJOUS_CYCLES = 4;
const HALO_FAMILY_COUNT = 5;
const EVOLVED_OPACITY = 0.4;
const HALO_OPACITY_MIN = 0.15;
const HALO_OPACITY_MAX = 0.55;
// 点列を引き直す表示時刻の間隔 [s]。ガイド線は回転系で静止しているので、時刻の効果は基底の
// 回転だけに現れる。最も速い地球-月系(周期 27.3 日)でもこの間に 0.05° しか回らない。
const RECOMPUTE_INTERVAL = 300;

const GUIDE_SYSTEMS: readonly GuideSystem[] = ['sun-earth', 'earth-moon'];
const GUIDE_POINTS: readonly GuidePoint[] = ['L1', 'L2', 'L3'];
const HEMISPHERES: readonly Hemisphere[] = ['north', 'south'];

// initialTs(t の等分割列)は点数だけで決まるので、点数ごとに1回作って使い回す。
const initialTsCache = new Map<number, readonly number[]>();
// span 区間を等分する t の列。同じ点数の折れ線どうしで使い回す。
function initialTsFor(span: number): readonly number[] {
  const cached = initialTsCache.get(span);
  if (cached) return cached;
  const ts = Array.from({ length: span + 1 }, (_, i) => i / span);
  initialTsCache.set(span, ts);
  return ts;
}

// ECI 絶対座標 [m] の点列を1本の折れ線として描く。closed なら points[末尾]→points[0] を
// 結んで輪を閉じる。頂点は points[0] を原点とした相対値で焼く(f32 精度は Curve 側の
// pivot 追従に任せる)。
class PointsCurve {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  private points: readonly Vec3[] | null = null;
  private origin: Vec3 = v3();
  private revision: object = {};

  public constructor(style: LineStyle, samples: number, private readonly closed: boolean) {
    this.curve = new Curve({ style, maxVertices: samples + 1 });
    this.line = this.curve.object;
  }

  // t∈[0,1] を points 上の弧長索引へ写す。closed は points[n-1]→points[0] の帰り辺を含む。
  private readonly sampler: CurveSampler = (t, out) => {
    const points = this.points;
    if (!points || points.length === 0) {
      out.set(0, 0, 0);
      return;
    }
    const n = points.length;
    const span = this.closed ? n : n - 1;
    const f = Math.min(span, Math.max(0, t * span));
    const i0 = Math.min(span - 1, Math.floor(f));
    const frac = f - i0;
    const p0 = points[i0]!;
    const p1 = points[this.closed ? (i0 + 1) % n : i0 + 1]!;
    out.set(
      p0.x - this.origin.x + frac * (p1.x - p0.x),
      p0.y - this.origin.y + frac * (p1.y - p0.y),
      p0.z - this.origin.z + frac * (p1.z - p0.z),
    );
  };

  // 新しい点列を設定する。null / 2点未満は非表示。
  public setPoints(points: readonly Vec3[] | null): void {
    this.points = points && points.length >= 2 ? points : null;
    if (this.points) this.origin = this.points[0]!;
    this.revision = {};
  }

  // 直近に設定した点列(ECI 絶対座標)。当たり判定などその形状を読みたい呼び出し側向け。
  public worldPoints(): readonly Vec3[] {
    return this.points ?? [];
  }

  // 描画原点の移動へ追随させる。頂点は setPoints で設定済みの点列から焼く。
  public sync(fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!this.points) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(this.origin));
    const span = this.closed ? this.points.length : this.points.length - 1;
    this.curve.setCurve(this.sampler, { revision: this.revision, camera, initialTs: initialTsFor(span) });
    this.curve.setVisible(true);
  }

  public hide(): void {
    this.curve.setVisible(false);
  }

  public dispose(): void {
    this.curve.dispose();
  }
}

// 軌道ガイドの種類(5.2節、静止軌道を除く)。
export type OrbitGuideKind = 'halo' | 'planarLyapunov' | 'verticalLyapunov' | 'lissajous' | 'dro';

// 当たり判定向けに、表示中の1本のガイド線をその識別情報・ECI 点列とともに表す。
export interface VisibleGuideLine {
  readonly key: string;
  readonly kind: OrbitGuideKind;
  readonly system: GuideSystem;
  readonly point: GuidePoint | null;
  readonly hemisphere: Hemisphere | null;
  readonly points: readonly Vec3[];
}

// 表示中の1本ぶん: 描画オブジェクトと、現在の設定・時刻から点列を求める関数、および
// その線がどの系・ラグランジュ点・半球に属するかの識別情報(DRO は系のみ)。
interface GuideLine {
  readonly curve: PointsCurve;
  readonly compute: (t: number, ephemeris: Ephemeris, settings: OrbitGuideSettings) => Vec3[] | null;
  readonly kind: OrbitGuideKind;
  readonly system: GuideSystem;
  readonly point: GuidePoint | null;
  readonly hemisphere: Hemisphere | null;
}

// 系×点(L1/L2/L3)の軸を持つ種類が共通して使う、ON な系・点の列。
function activeSystems(axes: GuideAxes): readonly GuideSystem[] {
  return GUIDE_SYSTEMS.filter((system) => (system === 'sun-earth' ? axes.sunEarth : axes.earthMoon));
}
function activePoints(axes: GuideAxes): readonly GuidePoint[] {
  return GUIDE_POINTS.filter((point) => (point === 'L1' ? axes.l1 : point === 'L2' ? axes.l2 : axes.l3));
}

// ガイド線の本数・組み合わせを決める設定だけを抜いた識別子。振幅・族範囲の値は含めない
// (それらが変わっても本数は変わらないため、点列の再計算だけで足りる)。種類ごとに軸が
// 独立しているため、全種類の on と軸を漏れなく含める。
function axesKey(axes: GuideAxes): string {
  return `${axes.sunEarth},${axes.earthMoon},${axes.l1},${axes.l2},${axes.l3}`;
}
function structuralKey(s: OrbitGuideSettings): string {
  return [
    'halo', s.halo.on, axesKey(s.halo), s.halo.north, s.halo.south,
    'planar', s.planarLyapunov.on, axesKey(s.planarLyapunov),
    'vertical', s.verticalLyapunov.on, axesKey(s.verticalLyapunov),
    'lissajous', s.lissajous.on, axesKey(s.lissajous),
    'dro', s.dro.on, s.dro.sunEarth, s.dro.earthMoon,
  ].join('|');
}

// 表示範囲を等間隔に割った index 番目のハロー族の位置。
function haloSValue(settings: OrbitGuideSettings, index: number): number {
  const { rangeMin, rangeMax } = settings.halo;
  return rangeMin + ((rangeMax - rangeMin) * index) / (HALO_FAMILY_COUNT - 1);
}

function haloOpacity(index: number): number {
  return HALO_OPACITY_MIN + ((HALO_OPACITY_MAX - HALO_OPACITY_MIN) * index) / (HALO_FAMILY_COUNT - 1);
}

export class OrbitGuideLines {
  private lines: GuideLine[] = [];
  private settings: OrbitGuideSettings | null = null;
  private structureKey = '';
  private computedSettings: OrbitGuideSettings | null = null;
  private lastComputedTime: number | null = null;

  public constructor(private readonly scene: THREE.Scene, private readonly ephemeris: Ephemeris) {}

  // ゲーム側配線用の setter。sync はここで受けた最新値を読む。
  public setSettings(settings: OrbitGuideSettings): void {
    this.settings = settings;
  }

  // マップビューのときだけガイド線を同期する。表示可否のゲートは種類ごとの on に移っている
  // ため、visible の引数は持たない(rebuildLines が0本にすることで非表示を表す)。
  public sync(displayTime: number, overviewMode: boolean, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!overviewMode || !this.settings) {
      for (const entry of this.lines) entry.curve.hide();
      return;
    }
    const settings = this.settings;

    const structureKey = structuralKey(settings);
    if (structureKey !== this.structureKey) {
      this.rebuildLines(settings);
      this.structureKey = structureKey;
      this.lastComputedTime = null; // 本数を作り直した以上、点列も必ず引き直す
    }

    // 点列は回転基底の向きにしか時刻依存しない。設定が差し替わったときと、基底が目に見えて
    // 回ったときにだけ引き直す。
    const timeMoved = this.lastComputedTime === null
      || Math.abs(displayTime - this.lastComputedTime) >= RECOMPUTE_INTERVAL;
    if (settings !== this.computedSettings || timeMoved) {
      for (const entry of this.lines) entry.curve.setPoints(entry.compute(displayTime, this.ephemeris, settings));
      this.computedSettings = settings;
      this.lastComputedTime = displayTime;
    }

    for (const entry of this.lines) entry.curve.sync(fo, camera);
  }

  // 表示中のガイド線を、当たり判定向けの識別情報付きで返す(マップ視点外・0本の間は空)。
  public visibleLines(): readonly VisibleGuideLine[] {
    const visible: VisibleGuideLine[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      const entry = this.lines[i]!;
      const points = entry.curve.worldPoints();
      if (points.length < 2) continue;
      visible.push({
        key: `${entry.kind}-${i}`, kind: entry.kind, system: entry.system, point: entry.point,
        hemisphere: entry.hemisphere, points,
      });
    }
    return visible;
  }

  // ガイド線を1本組んでシーンへ加える。compute はその線の点列を設定・時刻から求める。
  private addLine(
    closed: boolean, samples: number, color: number, opacity: number,
    kind: OrbitGuideKind, system: GuideSystem, point: GuidePoint | null, hemisphere: Hemisphere | null,
    compute: (t: number, ephemeris: Ephemeris, settings: OrbitGuideSettings) => Vec3[] | null,
  ): void {
    const curve = new PointsCurve({ color, opacity, renderOrder: LINE_RENDER_ORDER.reference }, samples, closed);
    this.scene.add(curve.line);
    this.lines.push({ curve, compute, kind, system, point, hemisphere });
  }

  // 種類ごとの on と軸から折れ線オブジェクトを作り直す。トグルの直積が変わったとき
  // (本数が変わるとき)だけ呼ぶ — 振幅・族範囲だけの変更では呼ばない。
  private rebuildLines(settings: OrbitGuideSettings): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];

    // ハロー: 系×点×南北 の直積 × 族5本。
    if (settings.halo.on) {
      const systems = activeSystems(settings.halo);
      const points = activePoints(settings.halo);
      const hemispheres = HEMISPHERES.filter((h) => (h === 'north' ? settings.halo.north : settings.halo.south));
      for (const system of systems) {
        for (const point of points) {
          for (const hemisphere of hemispheres) {
            for (let i = 0; i < HALO_FAMILY_COUNT; i++) {
              this.addLine(
                true, HALO_SAMPLES, C.COLOR_HALO_GUIDE_LINE, haloOpacity(i), 'halo', system, point, hemisphere,
                (t: number, ephemeris: Ephemeris, s: OrbitGuideSettings) =>
                  haloGuideLoop(t, ephemeris, system, point, haloSValue(s, i), hemisphere, HALO_SAMPLES),
              );
            }
          }
        }
      }
    }

    // 平面リヤプノフ・垂直リヤプノフ・リサジュー: いずれも系×点。
    if (settings.planarLyapunov.on) {
      for (const system of activeSystems(settings.planarLyapunov)) {
        for (const point of activePoints(settings.planarLyapunov)) {
          this.addLine(
            true, HALO_SAMPLES, C.COLOR_PLANAR_LYAPUNOV_LINE, EVOLVED_OPACITY, 'planarLyapunov', system, point, null,
            (t: number, ephemeris: Ephemeris, s: OrbitGuideSettings) =>
              planarLyapunovLoop(t, ephemeris, system, point, s.planarLyapunov.amplitude, HALO_SAMPLES),
          );
        }
      }
    }
    if (settings.verticalLyapunov.on) {
      for (const system of activeSystems(settings.verticalLyapunov)) {
        for (const point of activePoints(settings.verticalLyapunov)) {
          this.addLine(
            true, HALO_SAMPLES, C.COLOR_VERTICAL_LYAPUNOV_LINE, EVOLVED_OPACITY, 'verticalLyapunov', system, point, null,
            (t: number, ephemeris: Ephemeris, s: OrbitGuideSettings) =>
              verticalLyapunovLoop(t, ephemeris, system, point, s.verticalLyapunov.amplitude, HALO_SAMPLES),
          );
        }
      }
    }
    if (settings.lissajous.on) {
      for (const system of activeSystems(settings.lissajous)) {
        for (const point of activePoints(settings.lissajous)) {
          this.addLine(
            false, LISSAJOUS_SAMPLES, C.COLOR_LISSAJOUS_LINE, EVOLVED_OPACITY, 'lissajous', system, point, null,
            (t: number, ephemeris: Ephemeris, s: OrbitGuideSettings) =>
              lissajousPath(
                t, ephemeris, system, point, s.lissajous.inPlane, s.lissajous.outOfPlane,
                LISSAJOUS_CYCLES, LISSAJOUS_SAMPLES,
              ),
          );
        }
      }
    }

    // DRO: ラグランジュ点を持たず、系のみ。
    if (settings.dro.on) {
      const systems = GUIDE_SYSTEMS.filter((system) => (system === 'sun-earth' ? settings.dro.sunEarth : settings.dro.earthMoon));
      for (const system of systems) {
        this.addLine(
          true, HALO_SAMPLES, C.COLOR_DRO_LINE, EVOLVED_OPACITY, 'dro', system, null, null,
          (t: number, ephemeris: Ephemeris, s: OrbitGuideSettings) =>
            droLoop(t, ephemeris, system, s.dro.amplitude, HALO_SAMPLES),
        );
      }
    }
  }

  public dispose(): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];
  }
}
