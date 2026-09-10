// マップビューのガイドとして描く、CR3BP 周期軌道族(ハロー・リヤプノフ・DRO 等)とリサジュー
// 軌道の宣言を組む(表示パネルの軌道ガイドタブ、静止軌道を除く)。設定の kinds(族 id → 表示
// 設定)を1つの経路で回し、族ごとに独立した種類関数を呼ぶ形は取らない。
import { OrbitingMotion } from '../../../physics/celestial-motion';
import { CollinearPoint, SecondaryFrame, secondaryFrameOf } from '../../../physics/lagrange';
import type { CelestialBodies } from '../celestial-bodies';
import { Vec3 } from '../../../math/vec3';
import {
  catalogLoop, dawnDuskGuideLoop, GuideLoop, guideSecondary, lissajousLoop,
  molniyaGuideLoop, sunSyncRepeatGroundTrackLoop, tundraGuideLoop,
} from '../../../physics/orbit-guide';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { LINE_RENDER_ORDER, LineStyle } from '../../../render/line-style';
import type { RenderStyle } from '../../../render/render-style';
import type { ViewMode } from '../../../render/view-mode';
import { SCHEMATIC_LINE } from '../../../render/schematic-style';
import {
  familyGradientColor, familyGradientColorAt, type GuideLineDisplay,
} from '../../../render/celestial/orbit-guide/orbit-guide-view';
import {
  DirectionMarkerMode, GuideGroupId, GuideKindSettings, OrbitGuideSettings,
} from './orbit-guide-settings';
import { combinedCandidateIds, parseGuideKindId } from './orbit-guide-kind-ids';
import { OrbitGuideCatalog } from './orbit-guide-catalog';
import type { CelestialBody } from '../../../physics/celestial-body';

// リサジューの頂点数の打ち切り。周回数ぶんだけ経路が伸びるので、1周ぶんの曲線と違って
// 適応分割は収束しない。最大周回数(30)でも1周あたり数十頂点は残る水準を採る。
const LISSAJOUS_VERTEX_BUDGET = 2048;
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
// 線の中で始点から終点までに振る明度の幅。族ごとの色分けを潰さない範囲で、1本の線の中にも
// 向きの手がかりを与える値。
const LINE_LIGHTNESS_SWING = 0.08;

const ALL_SYSTEMS: readonly CatalogSystemId[] = [
  'earth-moon', 'sun-earth', 'sun-mars', 'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];

// 「基本」群の地球専用参照軌道(静止軌道は天体側のマップ付随表示なのでここには含まない)。
// 族を持たない単一軌道で、CR3BP の系トグルの対象外。
type ReferenceOrbitKind = 'sunSync' | 'dawnDusk' | 'molniya' | 'tundra';
const REFERENCE_ORBIT_KINDS: readonly ReferenceOrbitKind[] = ['sunSync', 'dawnDusk', 'molniya', 'tundra'];

// マップビュー以外のフレームで返す空の列。
const NO_LINES: readonly GuideLineDisplay[] = [];

// 表示時刻から引き直した曲線1本ぶん。形が変わらない限り同じオブジェクトを保つ — 描画側は
// この同一性で点列の引き直しを省く。
interface GuideLineGeometry {
  readonly loop: GuideLoop;
  readonly origin: GuideLineDisplay['origin'];
  readonly shape: GuideLineDisplay['shape'];
}

// 表示中の1本ぶん。family の位置(index/count)は色のグラデーションと族範囲の内分に使う。
interface GuideLineEntry {
  readonly key: string;
  readonly familyId: string;
  readonly system: CatalogSystemId | null;
  readonly point: string | null;
  readonly index: number;
  readonly count: number;
  // 適応分割の頂点予算。既定でよい線は undefined。
  readonly maxVertices: number | undefined;
  // 表示時刻から引き直すまで、また引けなかった時刻では null(その線は描かれない)。
  geometry: GuideLineGeometry | null;
}

// 本数・族範囲・両端の色・進行方向・安定度の見せ方など、1本の折れ線をいまどう描くべきかを
// まとめた値。styleFor が現在の設定から組む(重い計算は含まない)。
interface LineVisual {
  readonly style: LineStyle;
  readonly direction: DirectionMarkerMode;
  readonly animate: boolean;
  readonly markerColor: number;
  // 線の中で色が変わる線だけが持つ。単色の線は style.color だけで塗る。
  readonly colorAt?: GuideLineDisplay['colorAt'];
}

// ガイド線の見た目。線ごとに変わるのは色と不透明度だけで、重なり順は全て参照線の位置。
function lineStyle(color: number, opacity: number): LineStyle {
  return { color, opacity, renderOrder: LINE_RENDER_ORDER.reference };
}

// 線1本ぶんの、表示時刻に依らない識別情報。
function lineEntry(
  familyId: string, system: CatalogSystemId | null, point: string | null,
  index: number, count: number, maxVertices: number | undefined,
): GuideLineEntry {
  return {
    key: `${familyId}:${system}:${point ?? '-'}:${index}`,
    familyId, system, point, index, count, maxVertices, geometry: null,
  };
}

// ガイド線の曲線を、描画側が受ける形へ落とす。頂点を相対化する基準点は曲線上の1点でよいので、
// パラメータ 0 の位置を採る。解析曲線の初期区間は「1区間が半周を超えない」下限で、周回数から
// 決まる(細かさは描画側が決める)。
function loopGeometry(loop: GuideLoop): GuideLineGeometry {
  const shape = loop.shape;
  // 解析曲線は、基準点を差し引くぶんだけ包んで渡す。
  if (shape.kind === 'analytic') {
    const origin = shape.positionAt(0);
    return {
      loop,
      origin,
      shape: {
        kind: 'analytic',
        sample: (t, out) => {
          const p = shape.positionAt(t);
          out.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
        },
        initialSegments: Math.ceil(loop.revolutions * 2),
      },
    };
  }
  // 節点列は位置だけを基準点相対にする(接線は差分なので平行移動を受けない)。
  const origin = shape.positions[0]!;
  const positions: number[] = [];
  const tangents: number[] = [];
  for (const p of shape.positions) positions.push(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  for (const m of shape.tangents) tangents.push(m.x, m.y, m.z);
  return { loop, origin, shape: { kind: 'hermite', knots: { ts: shape.us, positions, tangents } } };
}

function groupOf(familyId: string): GuideGroupId | null {
  return parseGuideKindId(familyId)?.group ?? null;
}

function pointOf(familyId: string): string | null {
  return parseGuideKindId(familyId)?.point ?? null;
}

// 族 id の表示設定を1つに解決する。小題(combinedKey)に属する族は on を
// combinedCandidateIds(押されている軸値から実際に表示される族id集合を組む関数、軸の自動補完も
// ここに1本化されている)への所属で決め、他のフィールドは小題の共有設定を使う。属さない族
// (蝶形・トンボ形・共鳴・DRO)は settings.kinds をそのまま使う。
function effectiveKind(settings: OrbitGuideSettings, familyId: string): GuideKindSettings | undefined {
  const parsed = parseGuideKindId(familyId);
  if (parsed === null || parsed.combinedKey === null) return settings.kinds[familyId];
  const combined = settings.combinedKinds[parsed.combinedKey];
  if (combined === undefined) return undefined;
  const on = combinedCandidateIds(parsed.combinedKey, combined.axisValues).includes(familyId);
  return { ...combined, on };
}

// 表示設定を持ちうる族 id の全体(kinds のキー全部+小題ごとに押されている軸値から組める候補id)。
// effectiveKind と組み合わせて、蝶形/共鳴等の standalone 族と小題の族を同じループで扱える。
function activeFamilyIds(settings: OrbitGuideSettings): readonly string[] {
  const ids = new Set<string>(Object.keys(settings.kinds));
  for (const [key, combined] of Object.entries(settings.combinedKinds)) {
    for (const id of combinedCandidateIds(key, combined.axisValues)) ids.add(id);
  }
  return [...ids];
}

function activeSystems(settings: OrbitGuideSettings): readonly CatalogSystemId[] {
  return ALL_SYSTEMS.filter((id) => settings.systems[id] === true);
}

function sValueFor(kind: GuideKindSettings, index: number, count: number): number {
  if (count <= 1) return kind.rangeMin;
  return kind.rangeMin + ((kind.rangeMax - kind.rangeMin) * index) / (count - 1);
}

// 点列の形を決める設定だけを並べた識別子。色・不透明度・進行方向・安定度は含めないので、
// スライダーを掴んでいる間じゅう全線を焼き直すことがない。
function geometrySignature(settings: OrbitGuideSettings): string {
  const parts: string[] = [];
  for (const id of activeFamilyIds(settings)) {
    const kind = effectiveKind(settings, id);
    if (!kind?.on) continue;
    parts.push(`${id}:${kind.count}:${kind.rangeMin}:${kind.rangeMax}`);
  }
  const l = settings.lissajous;
  if (l.on) {
    parts.push(`lissajous:${l.inPlane}:${l.outOfPlane}:${l.inPlanePhase}:${l.outOfPlanePhase}:${l.cycles}:${l.l1}${l.l2}${l.l3}`);
  }
  const ss = settings.sunSync;
  if (ss.on) parts.push(`sunSync:${ss.repeatDays}:${ss.revsPerRepeat}`);
  const dd = settings.dawnDusk;
  if (dd.on) parts.push(`dawnDusk:${dd.repeatDays}:${dd.revsPerRepeat}:${dd.localTime}`);
  const mo = settings.molniya;
  if (mo.on) parts.push(`molniya:${mo.perigeeAltitude}:${mo.raan}`);
  const tu = settings.tundra;
  if (tu.on) parts.push(`tundra:${tu.perigeeAltitude}:${tu.raan}`);
  parts.push(`systems:${activeSystems(settings).join(',')}`);
  return parts.sort().join('|');
}

// 本数・族範囲・系選択の直積が変わったとき(rebuildLines を要するとき)だけ変わる識別子。
// 色・透明度・進行方向・安定度・振幅など、点列や本数を変えない設定は含めない。
function structuralKey(settings: OrbitGuideSettings): string {
  const kindsKey = [...activeFamilyIds(settings)].sort()
    .map((id) => {
      const k = effectiveKind(settings, id);
      return `${id}:${k?.on ?? false}:${k?.on ? k.count : 0}`;
    })
    .join(',');
  const systemsKey = activeSystems(settings).join('+');
  const l = settings.lissajous;
  const referenceKey = REFERENCE_ORBIT_KINDS.map((kind) => `${kind}:${settings[kind].on}`).join(',');
  return `${kindsKey}|${systemsKey}|lissajous:${l.on}:${l.l1}:${l.l2}:${l.l3}|${referenceKey}`;
}

export class OrbitGuideModel {
  private lines: GuideLineEntry[] = [];
  private readonly catalog = new OrbitGuideCatalog();

  private structureKey = '';
  private geometryKey = '';
  private lastComputedTime: number | null = null;
  private lastCatalogGeneration = -1;
  private onLineCountChange: ((count: number) => void) | null = null;

  // 直近に組んだ宣言の列と、それを組んだ設定・見せ方。
  private displays: readonly GuideLineDisplay[] = NO_LINES;
  private displayedSettings: OrbitGuideSettings | null = null;
  private displayedStyle: RenderStyle | null = null;

  public constructor(private readonly celestialBodies: CelestialBodies) {}

  // 総線数が変わるたび(線の顔ぶれを組み直すたび)に呼ばれる。UI が MAX_LINES_PER_KIND 超過の
  // 警告を出すためのフック。
  public setOnLineCountChange(cb: ((count: number) => void) | null): void {
    this.onLineCountChange = cb;
  }

  // このフレームに描くガイド線の宣言を返す(マップビュー以外では空)。曲線の組み直しは、
  // 設定・カタログ・表示時刻のいずれかが動いたときに走る。形も設定も動いていないフレームは
  // 前フレームと同じ宣言をそのまま返す。
  public sync(
    settings: OrbitGuideSettings, displayTime: number, style: RenderStyle, viewMode: ViewMode,
  ): readonly GuideLineDisplay[] {
    if (viewMode !== 'map') return NO_LINES;

    // 本数・族範囲・系選択の直積が変わったときだけ線の顔ぶれを組み直す。
    const structureKey = structuralKey(settings);
    if (structureKey !== this.structureKey) {
      this.rebuildLines(settings);
      this.structureKey = structureKey;
      this.lastComputedTime = null;
    }

    // 点列は、形を決める設定・カタログの世代・表示時刻のいずれかが動いたときだけ引き直す。
    const catalogGeneration = this.catalog.generation;
    const timeMoved = this.lastComputedTime === null
      || Math.abs(displayTime - this.lastComputedTime) >= RECOMPUTE_INTERVAL;
    const geometryKey = geometrySignature(settings);
    const recompute = geometryKey !== this.geometryKey || timeMoved
      || catalogGeneration !== this.lastCatalogGeneration;
    if (recompute) {
      for (const entry of this.lines) {
        const loop = this.computeLoop(entry, displayTime, settings);
        entry.geometry = loop === null ? null : loopGeometry(loop);
      }
      this.geometryKey = geometryKey;
      this.lastComputedTime = displayTime;
      this.lastCatalogGeneration = catalogGeneration;
    }

    if (recompute || settings !== this.displayedSettings || style !== this.displayedStyle) {
      this.displays = this.buildDisplays(settings, style);
      this.displayedSettings = settings;
      this.displayedStyle = style;
    }
    return this.displays;
  }

  // 族の位置設定(0〜1)は、焼き込み側で幾何的に等間隔へ間引いてあるため、そのまま
  // catalogLoop が使うメンバー添字基準の s として渡せる。
  private computeLoop(entry: GuideLineEntry, t: number, settings: OrbitGuideSettings): GuideLoop | null {
    if (entry.familyId === 'lissajous') {
      const l = settings.lissajous;
      const system = this.guideFrameOf(entry.system as CatalogSystemId, t);
      if (system === null) return null;
      return lissajousLoop(
        system, entry.point as CollinearPoint,
        l.inPlane, l.outOfPlane, l.inPlanePhase, l.outOfPlanePhase, l.cycles,
      );
    }
    if (entry.familyId === 'sunSync') {
      const s = settings.sunSync;
      const earth = this.earthBodyAt(t);
      return earth === null ? null
        : sunSyncRepeatGroundTrackLoop(earth, t, s.repeatDays, s.revsPerRepeat);
    }
    if (entry.familyId === 'dawnDusk') {
      const d = settings.dawnDusk;
      const earth = this.earthBodyAt(t);
      return earth === null ? null : dawnDuskGuideLoop(
        earth, t, (r: Vec3, tt: number) => this.celestialBodies.sunDirFrom(r, tt),
        d.repeatDays, d.revsPerRepeat, d.localTime);
    }
    if (entry.familyId === 'molniya') {
      const m = settings.molniya;
      const earth = this.earthBodyAt(t);
      return earth === null ? null
        : molniyaGuideLoop(earth, t, this.earthSpinRate(), m.perigeeAltitude, m.raan);
    }
    if (entry.familyId === 'tundra') {
      const u = settings.tundra;
      const earth = this.earthBodyAt(t);
      return earth === null ? null
        : tundraGuideLoop(earth, t, this.earthSpinRate(), u.perigeeAltitude, u.raan);
    }
    const kind = effectiveKind(settings, entry.familyId);
    if (!kind || entry.system === null) return null;
    const system = this.catalog.systemFor(entry.system);
    if (!system) return null;
    const s = sValueFor(kind, entry.index, entry.count);
    const secondary = this.guideFrameOf(entry.system, t);
    if (secondary === null) return null;
    return catalogLoop(secondary, system, entry.familyId, s);
  }

  // 系の副天体まわりの CR3BP 量を組むための、その時刻の ECI 値一式。副天体が居ない・
  // 公転していない・主天体が引けないなら null(その系のガイドは描かない)。
  private guideFrameOf(system: CatalogSystemId, t: number): SecondaryFrame | null {
    const motion = this.guideSecondaryOf(system);
    return motion === null ? null
      : secondaryFrameOf(this.celestialBodies.celestialMotions, t, motion, t);
  }

  // 系の副天体の運動。星系に居ない・公転していないなら null(その系のガイドは描かない)。
  private guideSecondaryOf(system: CatalogSystemId): OrbitingMotion | null {
    const motion = this.celestialBodies.findMotion(guideSecondary(system));
    return motion instanceof OrbitingMotion ? motion : null;
  }

  // 地球の運動。地球を持たない星系では null(地球専用の参照軌道は描かない)。
  private earthBodyAt(_t: number): CelestialBody | null {
    return this.celestialBodies.has('earth') ? this.celestialBodies.motionOf('earth') : null;
  }

  // 地球の自転角速度 [rad/s]。自転モデルを持たない・地球が居ないなら null。
  private earthSpinRate(): number | null {
    return this.earthMotion()?.spinRate ?? null;
  }

  // 地球の運動。地球を持たない星系では null(地球専用の参照軌道は描かない)。
  private earthMotion(): CelestialBody | null {
    return this.celestialBodies.findMotion('earth');
  }

  // 引けている曲線を持つ線を、いまの見た目とともに宣言へ組む。曲線と基準点はそのまま渡すので、
  // 形が変わらない限り描画側は点列を引き継ぐ。
  private buildDisplays(settings: OrbitGuideSettings, style: RenderStyle): readonly GuideLineDisplay[] {
    const displays: GuideLineDisplay[] = [];
    for (const entry of this.lines) {
      // 曲線を引けなかった線と、設定が消えた線は宣言に出さない(どちらも描かれない)。
      const geometry = entry.geometry;
      if (geometry === null) continue;
      const visual = this.styleFor(entry, settings, style);
      if (visual === null) continue;
      displays.push({
        key: entry.key, familyId: entry.familyId, system: entry.system, point: entry.point,
        origin: geometry.origin, shape: geometry.shape, revolutions: geometry.loop.revolutions,
        style: visual.style, colorAt: visual.colorAt, direction: visual.direction,
        animate: visual.animate, markerColor: visual.markerColor, maxVertices: entry.maxVertices,
      });
    }
    return displays;
  }

  // その線をいま描くべき色・不透明度・進行方向マーカーの出し方を、現在の設定から組む。
  // 設定に対応するエントリが既に消えている(保存データの不整合)なら null(非表示)。
  private styleFor(
    entry: GuideLineEntry, settings: OrbitGuideSettings, style: RenderStyle,
  ): LineVisual | null {
    const referenceKind = REFERENCE_ORBIT_KINDS.find((k) => k === entry.familyId);
    if (style === 'schematic') {
      // 模式図では色分けに意味を持たせない。表示の有無だけは通常どおり設定に従う。
      const on = entry.familyId === 'lissajous' ? settings.lissajous.on
        : referenceKind ? settings[referenceKind].on : effectiveKind(settings, entry.familyId)?.on;
      if (!on) return null;
      const kindDirection = entry.familyId === 'lissajous' ? settings.lissajous
        : referenceKind ? settings[referenceKind] : effectiveKind(settings, entry.familyId)!;
      return {
        style: lineStyle(SCHEMATIC_LINE, 1),
        direction: kindDirection.direction, animate: kindDirection.animate,
        markerColor: SCHEMATIC_LINE,
      };
    }
    if (entry.familyId === 'lissajous') {
      const l = settings.lissajous;
      return {
        style: lineStyle(l.colorStart, l.opacity),
        direction: l.direction, animate: l.animate, markerColor: l.colorStart,
      };
    }
    if (referenceKind) {
      const r = settings[referenceKind];
      return {
        style: lineStyle(r.colorStart, r.opacity),
        direction: r.direction, animate: r.animate, markerColor: r.colorStart,
      };
    }
    const kind = effectiveKind(settings, entry.familyId);
    if (!kind) return null;

    // 族の中の位置(0〜1)が、線ごとの色と安定度の見せ方を決める。
    let gradientT = entry.count <= 1 ? 0 : entry.index / (entry.count - 1);
    if (kind.reversed) gradientT = 1 - gradientT;
    const stability = entry.geometry?.loop.stability;
    const stable = kind.showStability && stability !== undefined && Math.abs(stability) <= STABILITY_NEUTRAL_THRESHOLD;
    const opacity = stable ? Math.min(1, kind.opacity * STABLE_OPACITY_BOOST) : kind.opacity;

    return {
      // 頂点カラーはマテリアル色に乗算されるので、族の色は頂点側だけに載せて線は白に置く。
      style: lineStyle(0xffffff, opacity),
      direction: kind.direction, animate: kind.animate,
      markerColor: familyGradientColor(kind.colorStart, kind.colorEnd, gradientT),
      // 族位置(gradientT)で線ごとの色を決めたうえで、線の中でも始点→終点でわずかに明度を
      // 振り、頂点カラー機構を実際に使ったグラデーションにする。
      colorAt: familyGradientColorAt(kind.colorStart, kind.colorEnd, gradientT, LINE_LIGHTNESS_SWING),
    };
  }

  // 種類ごとの on と系選択から線の顔ぶれを組み直す。本数が変わるとき(structuralKey が
  // 変わったとき)だけ呼ぶ — 色・範囲・透明度だけの変更では呼ばない。
  private rebuildLines(settings: OrbitGuideSettings): void {
    this.lines = [];

    for (const familyId of activeFamilyIds(settings)) {
      const kind = effectiveKind(settings, familyId);
      if (!kind?.on) continue;
      const group = groupOf(familyId);
      if (group === null) continue; // 未知の族 id(壊れた保存データ)は無視
      const point = pointOf(familyId);
      for (const system of activeSystems(settings)) {
        // その系に存在しない族は線を作らない。作っても何も描かれないうえ、線数の警告だけが
        // 膨らんでしまう(どの系にどの族があるかは焼き込みの索引が持つ)。
        if (!this.catalog.hasFamily(system, familyId)) continue;
        for (let i = 0; i < kind.count; i++) {
          this.lines.push(lineEntry(familyId, system, point, i, kind.count, undefined));
        }
      }
    }

    // リサジュー軌道は L1/L2/L3 のうち押されている点ごとに1本。
    if (settings.lissajous.on) {
      const points: readonly ['l1' | 'l2' | 'l3', CollinearPoint][] = [['l1', 'L1'], ['l2', 'L2'], ['l3', 'L3']];
      for (const system of activeSystems(settings)) {
        for (const [flag, point] of points) {
          if (!settings.lissajous[flag]) continue;
          this.lines.push(lineEntry('lissajous', system, point, 0, 1, LISSAJOUS_VERTEX_BUDGET));
        }
      }
    }

    // 地球専用参照軌道は系トグルの対象外なので system は null。
    for (const kind of REFERENCE_ORBIT_KINDS) {
      if (settings[kind].on) this.lines.push(lineEntry(kind, null, null, 0, 1, undefined));
    }

    this.onLineCountChange?.(this.lines.length);
  }
}
