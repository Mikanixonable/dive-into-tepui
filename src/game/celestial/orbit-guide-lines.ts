// マップビューのガイドとして描く、CR3BP 周期軌道族(ハロー・リヤプノフ・DRO 等)と
// リサジュー軌道の折れ線群(表示パネルの軌道ガイドタブ、静止軌道を除く)。設定の kinds
// (族 id → 表示設定)を1つの経路で回し、族ごとに独立した種類関数を呼ぶ形は取らない。
import * as THREE from 'three/webgpu';
import { Ephemeris } from '../../physics/ephemeris';
import { Vec3 } from '../../physics/vec3';
import { catalogLoop, GuideLoop, GuidePoint, lissajousLoop } from '../../physics/orbit-guide';
import type { CatalogSystemId } from '../../physics/orbit-catalog';
import { FloatingOrigin } from '../floating-origin';
import { CurveColorSampler } from '../../render/curve';
import { LINE_RENDER_ORDER } from '../../render/line-style';
import { GuideCurve } from './guide-curve';
import {
  GUIDE_GROUPS, GuideGroupId, GuideKindSettings, OrbitGuideSettings,
} from './orbit-guide-settings';
import { OrbitGuideCatalog } from './orbit-guide-catalog';
import { DirectionMarkers } from './direction-markers';

// 族の折れ線1本ぶんの頂点予算。焼き込みは全族96点(orbit-catalog.ts)で統一されているので、
// 適応分割による追加ぶんを見込んでも十分な余裕を持たせる。
const CATALOG_LINE_VERTEX_BUDGET = 256;
const LISSAJOUS_VERTEX_BUDGET = 512;
const LISSAJOUS_SAMPLES = 512;
// マーカーの InstancedPool 容量。指定本数がこれを超える組み合わせでは、画面に出す線自体は
// 指定どおり描くが(8の#9)マーカーは古いものから溢れて描かれなくなる。
const MARKER_POOL_CAPACITY = 3000;
// 点列を引き直す表示時刻の間隔 [s]。ガイド線は回転系で静止しているので、時刻の効果は基底の
// 回転だけに現れる。最も速い地球-月系(周期 27.3 日)でもこの間に 0.05° しか回らない。
const RECOMPUTE_INTERVAL = 300;
// 安定性指数(1 が中立の下限、離れるほど不安定)がこの値以下なら「安定」として太く見せる。
// 実測データでの境界確定は物理側の担当だが、族の大半が1.0〜数十まで広く分布する中で、
// 中立に近い区間だけを拾う値として1.5を採る。
const STABILITY_NEUTRAL_THRESHOLD = 1.5;
// three.js の LineBasicMaterial.linewidth は多くの環境(特に WebGPU バックエンド)で効かない
// ため、安定な軌道は太さの代わりに不透明度を上げて見分けをつける。
const STABLE_OPACITY_BOOST = 1.8;

const ALL_SYSTEMS: readonly CatalogSystemId[] = [
  'earth-moon', 'sun-earth', 'sun-mars', 'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];

// 当たり判定向けに、表示中の1本のガイド線をその識別情報・ECI 点列とともに表す。
export interface VisibleGuideLine {
  readonly key: string;
  // カタログの族 id、またはリサジューは 'lissajous'。
  readonly familyId: string;
  readonly system: CatalogSystemId;
  // 族 id に含まれるラグランジュ点(L1〜L5)。持たない族(dro/dpo/lpo/resonant)は null。
  readonly point: string | null;
  readonly points: readonly Vec3[];
}

// 表示中の1本ぶん。family の位置(index/count)は色のグラデーションと族範囲の内分に使う。
interface GuideLineEntry {
  readonly curve: GuideCurve;
  readonly familyId: string;
  readonly system: CatalogSystemId;
  readonly point: string | null;
  readonly index: number;
  readonly count: number;
  lastLoop: GuideLoop | null;
}

// 族 id からその種類が属する群を判定する。「軸方向軌道」「垂直軌道」は共線点(L1-L3)と
// 三角点(L4/L5)の双方にあるので、末尾のラグランジュ点で見分ける。
function groupOf(familyId: string): GuideGroupId | null {
  if (familyId.startsWith('resonant-')) return 'resonant';
  if (familyId === 'dro' || familyId === 'dpo' || familyId.startsWith('lpo-')) return 'secondary';
  if (familyId.startsWith('short-') || familyId.startsWith('longp-')) return 'triangular';
  if (familyId.startsWith('axial-') || familyId.startsWith('vertical-')) {
    return /L[45]/.test(familyId) ? 'triangular' : 'collinear';
  }
  if (
    familyId.startsWith('lyapunov-') || familyId.startsWith('halo-')
    || familyId.startsWith('butterfly-') || familyId.startsWith('dragonfly-')
  ) return 'collinear';
  return null;
}

function pointOf(familyId: string): string | null {
  return /L[1-5]/.exec(familyId)?.[0] ?? null;
}

function activeSystemsForGroup(settings: OrbitGuideSettings, group: GuideGroupId): readonly CatalogSystemId[] {
  const flags = settings.systems[group];
  return ALL_SYSTEMS.filter((id) => flags[id] === true);
}

function sValueFor(kind: GuideKindSettings, index: number, count: number): number {
  if (count <= 1) return kind.rangeMin;
  return kind.rangeMin + ((kind.rangeMax - kind.rangeMin) * index) / (count - 1);
}

// 本数・族範囲・両端の色・進行方向・安定度の見せ方など、1本の折れ線をいまどう描くべきかを
// まとめた値。styleFor が現在の設定から毎フレーム組み直す(重い計算は含まない)。
interface LineVisualStyle {
  readonly opacity: number;
  readonly direction: GuideKindSettings['direction'];
  readonly animate: boolean;
  readonly markerColor: number;
  readonly colorAt: CurveColorSampler;
}

// 点列の形を決める設定だけを並べた識別子。色・不透明度・進行方向・安定度は含めないので、
// スライダーを掴んでいる間じゅう全線を焼き直すことがない。
function geometrySignature(settings: OrbitGuideSettings): string {
  const parts: string[] = [];
  for (const [id, kind] of Object.entries(settings.kinds)) {
    if (!kind.on) continue;
    parts.push(`${id}:${kind.count}:${kind.rangeMin}:${kind.rangeMax}`);
  }
  const l = settings.lissajous;
  if (l.on) {
    parts.push(`lissajous:${l.inPlane}:${l.outOfPlane}:${l.inPlanePhase}:${l.outOfPlanePhase}:${l.cycles}:${l.l1}${l.l2}${l.l3}`);
  }
  for (const [group, systems] of Object.entries(settings.systems)) {
    const on = Object.entries(systems).filter(([, enabled]) => enabled).map(([id]) => id).join(',');
    parts.push(`${group}:${on}`);
  }
  return parts.sort().join('|');
}

// 本数・族範囲・系選択の直積が変わったとき(rebuildLines を要するとき)だけ変わる識別子。
// 色・透明度・進行方向・安定度・振幅など、点列や本数を変えない設定は含めない。
function structuralKey(settings: OrbitGuideSettings): string {
  const kindsKey = Object.keys(settings.kinds).sort()
    .map((id) => {
      const k = settings.kinds[id]!;
      return `${id}:${k.on}:${k.on ? k.count : 0}`;
    })
    .join(',');
  const systemsKey = GUIDE_GROUPS
    .map((g) => `${g}=${ALL_SYSTEMS.filter((s) => settings.systems[g][s] === true).join('+')}`)
    .join(',');
  const l = settings.lissajous;
  return `${kindsKey}|${systemsKey}|lissajous:${l.on}:${l.l1}:${l.l2}:${l.l3}`;
}

export class OrbitGuideLines {
  private lines: GuideLineEntry[] = [];
  private readonly catalog = new OrbitGuideCatalog();

  private readonly markers: DirectionMarkers;
  private settings: OrbitGuideSettings | null = null;
  private structureKey = '';
  private geometryKey = '';
  private lastComputedTime: number | null = null;
  private lastCatalogGeneration = -1;
  private onLineCountChange: ((count: number) => void) | null = null;

  public constructor(private readonly scene: THREE.Scene, private readonly ephemeris: Ephemeris) {
    this.markers = new DirectionMarkers(scene, MARKER_POOL_CAPACITY, LINE_RENDER_ORDER.reference);
  }

  public setSettings(settings: OrbitGuideSettings): void {
    this.settings = settings;
  }

  // 総線数が変わるたび(rebuildLines のたび)に呼ばれる。UI が MAX_LINES_PER_KIND 超過の
  // 警告を出すためのフック。
  public setOnLineCountChange(cb: ((count: number) => void) | null): void {
    this.onLineCountChange = cb;
  }

  public sync(displayTime: number, overviewMode: boolean, fo: FloatingOrigin, camera: THREE.Camera): void {
    if (!overviewMode || !this.settings) {
      for (const entry of this.lines) entry.curve.hide();
      // マーカーは InstancedPool が前のフレームの行列を保つので、空のフレームを1つ流して消す。
      this.markers.beginFrame();
      this.markers.endFrame();
      return;
    }
    const settings = this.settings;

    const structureKey = structuralKey(settings);
    if (structureKey !== this.structureKey) {
      this.rebuildLines(settings);
      this.structureKey = structureKey;
      this.lastComputedTime = null;
    }

    const catalogGeneration = this.catalog.generation;
    const timeMoved = this.lastComputedTime === null
      || Math.abs(displayTime - this.lastComputedTime) >= RECOMPUTE_INTERVAL;
    const geometryKey = geometrySignature(settings);
    if (geometryKey !== this.geometryKey || timeMoved || catalogGeneration !== this.lastCatalogGeneration) {
      for (const entry of this.lines) {
        const loop = this.computeLoop(entry, displayTime, settings);
        entry.lastLoop = loop;
        entry.curve.setPoints(loop?.points ?? null);
      }
      this.geometryKey = geometryKey;
      this.lastComputedTime = displayTime;
      this.lastCatalogGeneration = catalogGeneration;
    }

    this.markers.beginFrame();
    this.markers.cacheCamera(camera);
    for (const entry of this.lines) {
      const style = this.styleFor(entry, settings);
      if (!style) {
        entry.curve.hide();
        continue;
      }
      entry.curve.sync(fo, camera, style.colorAt);
      entry.curve.setOpacity(style.opacity);
      if (entry.lastLoop) {
        this.markers.addLoop(entry.lastLoop, style.direction, style.animate, style.markerColor, fo);
      }
    }
    this.markers.endFrame();
  }

  // 表示中のガイド線を、当たり判定向けの識別情報付きで返す(マップ視点外・0本の間は空)。
  public visibleLines(): readonly VisibleGuideLine[] {
    const visible: VisibleGuideLine[] = [];
    for (const entry of this.lines) {
      const points = entry.curve.worldPoints();
      if (points.length < 2) continue;
      visible.push({
        key: `${entry.familyId}:${entry.system}:${entry.point ?? '-'}:${entry.index}`,
        familyId: entry.familyId, system: entry.system, point: entry.point, points,
      });
    }
    return visible;
  }

  private computeLoop(entry: GuideLineEntry, t: number, settings: OrbitGuideSettings): GuideLoop | null {
    if (entry.familyId === 'lissajous') {
      const l = settings.lissajous;
      return lissajousLoop(
        t, this.ephemeris, entry.system, entry.point as GuidePoint,
        l.inPlane, l.outOfPlane, l.inPlanePhase, l.outOfPlanePhase, l.cycles, LISSAJOUS_SAMPLES,
      );
    }
    const kind = settings.kinds[entry.familyId];
    if (!kind) return null;
    const system = this.catalog.systemFor(entry.system);
    if (!system) return null;
    return catalogLoop(t, this.ephemeris, system, entry.system, entry.familyId, sValueFor(kind, entry.index, entry.count));
  }

  // その線をいま描くべき色・不透明度・進行方向マーカーの出し方を、現在の設定から組む。
  // 設定に対応するエントリが既に消えている(保存データの不整合)なら null(非表示)。
  private styleFor(entry: GuideLineEntry, settings: OrbitGuideSettings): LineVisualStyle | null {
    if (entry.familyId === 'lissajous') {
      const l = settings.lissajous;
      const color = new THREE.Color(l.colorStart);
      return {
        opacity: l.opacity, direction: l.direction, animate: l.animate, markerColor: l.colorStart,
        colorAt: (_t, out) => out.copy(color),
      };
    }
    const kind = settings.kinds[entry.familyId];
    if (!kind) return null;

    let gradientT = entry.count <= 1 ? 0 : entry.index / (entry.count - 1);
    if (kind.reversed) gradientT = 1 - gradientT;
    const start = new THREE.Color(kind.colorStart);
    const end = new THREE.Color(kind.colorEnd);
    const base = new THREE.Color().lerpColors(start, end, gradientT);

    const stability = entry.lastLoop?.stability;
    const stable = kind.showStability && stability !== undefined && Math.abs(stability) <= STABILITY_NEUTRAL_THRESHOLD;
    const opacity = stable ? Math.min(1, kind.opacity * STABLE_OPACITY_BOOST) : kind.opacity;

    return {
      opacity, direction: kind.direction, animate: kind.animate, markerColor: base.getHex(),
      // 族位置(gradientT)で線ごとの色を決めたうえで、線の中でも始点→終点でわずかに明度を
      // 振り、Curve の頂点カラー機構を実際に使ったグラデーションにする。
      colorAt: (curveT, out) => out.copy(base).offsetHSL(0, 0, (curveT - 0.5) * 0.08),
    };
  }

  // 種類ごとの on と系選択から折れ線オブジェクトを作り直す。本数が変わるとき(structuralKey
  // が変わったとき)だけ呼ぶ — 色・範囲・透明度だけの変更では呼ばない。
  private rebuildLines(settings: OrbitGuideSettings): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];

    for (const [familyId, kind] of Object.entries(settings.kinds)) {
      if (!kind.on) continue;
      const group = groupOf(familyId);
      if (group === null) continue; // 未知の族 id(壊れた保存データ)は無視
      const point = pointOf(familyId);
      for (const system of activeSystemsForGroup(settings, group)) {
        for (let i = 0; i < kind.count; i++) this.addCatalogLine(familyId, system, point, i, kind.count);
      }
    }

    if (settings.lissajous.on) {
      const points: readonly ['l1' | 'l2' | 'l3', GuidePoint][] = [['l1', 'L1'], ['l2', 'L2'], ['l3', 'L3']];
      for (const system of activeSystemsForGroup(settings, 'collinear')) {
        for (const [flag, point] of points) {
          if (settings.lissajous[flag]) this.addLissajousLine(system, point);
        }
      }
    }

    this.onLineCountChange?.(this.lines.length);
  }

  private addCatalogLine(familyId: string, system: CatalogSystemId, point: string | null, index: number, count: number): void {
    const curve = new GuideCurve({ color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference }, CATALOG_LINE_VERTEX_BUDGET, true);
    this.scene.add(curve.line);
    this.lines.push({ curve, familyId, system, point, index, count, lastLoop: null });
  }

  private addLissajousLine(system: CatalogSystemId, point: GuidePoint): void {
    const curve = new GuideCurve({ color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference }, LISSAJOUS_VERTEX_BUDGET, false);
    this.scene.add(curve.line);
    this.lines.push({ curve, familyId: 'lissajous', system, point, index: 0, count: 1, lastLoop: null });
  }

  public dispose(): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];
    this.markers.dispose();
  }
}
