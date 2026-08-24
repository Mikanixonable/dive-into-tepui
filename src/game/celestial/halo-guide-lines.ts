// マップビューのガイドとして描く、ラグランジュ点まわりの周期・準周期軌道の折れ線群。
// HaloGuideSettings が選ぶ(系×点×南北)の組み合わせごとに halo-guide.ts の点列 API を呼び、
// 回転基底に載った ECI [m] の点列を折れ線として表示・毎フレーム同期する。
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
import { HaloGuideSettings } from './halo-guide-settings';
import * as C from '../const';

const HALO_SAMPLES = 128;
const LISSAJOUS_SAMPLES = 512;
const LISSAJOUS_CYCLES = 4;
const HALO_FAMILY_COUNT = 5;
const EVOLVED_OPACITY = 0.4;
const HALO_OPACITY_MIN = 0.15;
const HALO_OPACITY_MAX = 0.55;

const GUIDE_SYSTEMS: readonly GuideSystem[] = ['sun-earth', 'earth-moon'];
const GUIDE_POINTS: readonly GuidePoint[] = ['L1', 'L2', 'L3'];
const HEMISPHERES: readonly Hemisphere[] = ['north', 'south'];

// initialTs(t の等分割列)は点数だけで決まるので、点数ごとに1回作って使い回す。
const initialTsCache = new Map<number, readonly number[]>();
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
  readonly line: THREE.Object3D;
  private points: readonly Vec3[] | null = null;
  private origin: Vec3 = v3();
  private revision: object = {};

  constructor(style: LineStyle, samples: number, private readonly closed: boolean) {
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
  setPoints(points: readonly Vec3[] | null): void {
    this.points = points && points.length >= 2 ? points : null;
    if (this.points) this.origin = this.points[0]!;
    this.revision = {};
  }

  // 毎フレーム呼ぶ。points は setPoints で設定済みのものを使い、ここでは焼き直さない。
  sync(fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!this.points) {
      this.curve.setVisible(false);
      return;
    }
    this.curve.setTransform(fo.RtoThreeV3(this.origin));
    const span = this.closed ? this.points.length : this.points.length - 1;
    this.curve.setCurve(this.sampler, { revision: this.revision, camera, initialTs: initialTsFor(span) });
    this.curve.setVisible(true);
  }

  hide(): void {
    this.curve.setVisible(false);
  }

  dispose(): void {
    this.curve.dispose();
  }
}

// 表示中の1本ぶん: 描画オブジェクトと、現在の設定・時刻から点列を求める関数。
interface GuideLine {
  readonly curve: PointsCurve;
  readonly compute: (t: number, ephemeris: Ephemeris, settings: HaloGuideSettings) => Vec3[] | null;
}

// ガイド線の本数・組み合わせを決める設定だけを抜いた識別子。振幅・族範囲の値は含めない
// (それらが変わっても本数は変わらないため、点列の再計算だけで足りる)。
function structuralKey(s: HaloGuideSettings): string {
  return [
    s.north, s.south, s.l1, s.l2, s.l3, s.sunEarth, s.earthMoon,
    s.planarLyapunov.on, s.verticalLyapunov.on, s.lissajous.on, s.dro.on,
  ].join(',');
}

// ハロー族の表示範囲を等間隔に割った5本ぶんの s。
function haloSValues(settings: HaloGuideSettings): readonly number[] {
  const { rangeMin, rangeMax } = settings;
  return Array.from(
    { length: HALO_FAMILY_COUNT },
    (_, i) => rangeMin + ((rangeMax - rangeMin) * i) / (HALO_FAMILY_COUNT - 1),
  );
}

function haloOpacity(index: number): number {
  return HALO_OPACITY_MIN + ((HALO_OPACITY_MAX - HALO_OPACITY_MIN) * index) / (HALO_FAMILY_COUNT - 1);
}

export class HaloGuideLines {
  private lines: GuideLine[] = [];
  private settings: HaloGuideSettings | null = null;
  private structureKey = '';
  private pointsKey = '';
  private lastComputedTime: number | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly ephemeris: Ephemeris) {}

  // ゲーム側配線用の setter。sync はここで受けた最新値を読む。
  setSettings(settings: HaloGuideSettings): void {
    this.settings = settings;
  }

  // マップビューかつ gridVisibility.haloOrbits が ON のときだけガイド線を同期する。
  sync(displayTime: number, overviewMode: boolean, visible: boolean, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!overviewMode || !visible || !this.settings) {
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

    const settingsKey = JSON.stringify(settings);
    if (settingsKey !== this.pointsKey || displayTime !== this.lastComputedTime) {
      for (const entry of this.lines) entry.curve.setPoints(entry.compute(displayTime, this.ephemeris, settings));
      this.pointsKey = settingsKey;
      this.lastComputedTime = displayTime;
    }

    for (const entry of this.lines) entry.curve.sync(fo, camera);
  }

  private addLine(
    closed: boolean, samples: number, color: number, opacity: number,
    compute: (t: number, ephemeris: Ephemeris, settings: HaloGuideSettings) => Vec3[] | null,
  ): void {
    const curve = new PointsCurve({ color, opacity, renderOrder: LINE_RENDER_ORDER.reference }, samples, closed);
    this.scene.add(curve.line);
    this.lines.push({ curve, compute });
  }

  // 表示すべき(系×点×南北)の組み合わせから折れ線オブジェクトを作り直す。トグルの直積が
  // 変わったとき(本数が変わるとき)だけ呼ぶ — 振幅・族範囲だけの変更では呼ばない。
  private rebuildLines(settings: HaloGuideSettings): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];

    const systems = GUIDE_SYSTEMS.filter((system) => (system === 'sun-earth' ? settings.sunEarth : settings.earthMoon));
    const points = GUIDE_POINTS.filter((point) => (point === 'L1' ? settings.l1 : point === 'L2' ? settings.l2 : settings.l3));
    const hemispheres = HEMISPHERES.filter((h) => (h === 'north' ? settings.north : settings.south));

    for (const system of systems) {
      for (const point of points) {
        for (const hemisphere of hemispheres) {
          for (let i = 0; i < HALO_FAMILY_COUNT; i++) {
            this.addLine(true, HALO_SAMPLES, C.COLOR_HALO_GUIDE_LINE, haloOpacity(i), (t, ephemeris, s) => {
              const sValue = haloSValues(s)[i]!;
              return haloGuideLoop(t, ephemeris, system, point, sValue, hemisphere, HALO_SAMPLES);
            });
          }
        }
        if (settings.planarLyapunov.on) {
          this.addLine(true, HALO_SAMPLES, C.COLOR_PLANAR_LYAPUNOV_LINE, EVOLVED_OPACITY, (t, ephemeris, s) =>
            planarLyapunovLoop(t, ephemeris, system, point, s.planarLyapunov.amplitude, HALO_SAMPLES));
        }
        if (settings.verticalLyapunov.on) {
          this.addLine(true, HALO_SAMPLES, C.COLOR_VERTICAL_LYAPUNOV_LINE, EVOLVED_OPACITY, (t, ephemeris, s) =>
            verticalLyapunovLoop(t, ephemeris, system, point, s.verticalLyapunov.amplitude, HALO_SAMPLES));
        }
        if (settings.lissajous.on) {
          this.addLine(false, LISSAJOUS_SAMPLES, C.COLOR_LISSAJOUS_LINE, EVOLVED_OPACITY, (t, ephemeris, s) =>
            lissajousPath(
              t, ephemeris, system, point, s.lissajous.inPlane, s.lissajous.outOfPlane,
              LISSAJOUS_CYCLES, LISSAJOUS_SAMPLES,
            ));
        }
      }
      if (settings.dro.on) {
        this.addLine(true, HALO_SAMPLES, C.COLOR_DRO_LINE, EVOLVED_OPACITY, (t, ephemeris, s) =>
          droLoop(t, ephemeris, system, s.dro.amplitude, HALO_SAMPLES));
      }
    }
  }

  dispose(): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];
  }
}
