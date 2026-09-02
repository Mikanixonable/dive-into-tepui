// マップビューのガイドとして描く、CR3BP 周期軌道族(ハロー・リヤプノフ・DRO 等)と
// リサジュー軌道の折れ線群(表示パネルの軌道ガイドタブ、静止軌道を除く)。設定の kinds
// (族 id → 表示設定)を1つの経路で回し、族ごとに独立した種類関数を呼ぶ形は取らない。
import * as THREE from 'three/webgpu';
import { CelestialMotion, OrbitingMotion } from '../../../physics/celestial-motion';
import { CollinearPoint, SecondaryFrame, secondaryFrameOf } from '../../../physics/lagrange';
import type { CelestialSystem } from '../celestial-system';
import { Vec3 } from '../../../math/vec3';
import {
  catalogLoop, dawnDuskGuideLoop, GuideLoop, guideSecondary, lissajousLoop,
  molniyaGuideLoop, sunSyncRepeatGroundTrackLoop, tundraGuideLoop,
} from '../../../physics/orbit-guide';
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { FloatingOrigin } from '../../camera/floating-origin';
import { CurveColorSampler } from '../../../render/curve';
import { LINE_RENDER_ORDER } from '../../../render/line-style';
import type { RenderStyle } from '../../../render/render-style';
import type { WorldView } from '../../view-manager';
import { SCHEMATIC_LINE } from '../../../render/schematic-style';
import { GuideCurve } from './guide-curve';
import {
  GuideGroupId, GuideKindSettings, OrbitGuideSettings,
} from './orbit-guide-settings';
import { combinedCandidateIds, parseGuideKindId } from './orbit-guide-kind-ids';
import { OrbitGuideCatalog } from './orbit-guide-catalog';
import { DirectionMarkers } from './direction-markers';

// リサジューの頂点数の打ち切り。周回数ぶんだけ経路が伸びるので、1周ぶんの曲線と違って
// 適応分割は収束しない。最大周回数(30)でも1周あたり数十頂点は残る水準を採る。
const LISSAJOUS_VERTEX_BUDGET = 2048;
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

// 「基本」群の地球専用参照軌道(静止軌道は celestial-system.ts が別枠で描くのでここには
// 含まない)。族を持たない単一軌道で、CR3BP の系トグルの対象外。
type ReferenceOrbitKind = 'sunSync' | 'dawnDusk' | 'molniya' | 'tundra';
const REFERENCE_ORBIT_KINDS: readonly ReferenceOrbitKind[] = ['sunSync', 'dawnDusk', 'molniya', 'tundra'];

// 当たり判定向けに、表示中の1本のガイド線をその識別情報・ECI 点列とともに表す。
export interface VisibleGuideLine {
  readonly key: string;
  // カタログの族 id、リサジューは 'lissajous'、地球専用参照軌道は ReferenceOrbitKind。
  readonly familyId: string;
  // 地球専用参照軌道は系を持たないので null。
  readonly system: CatalogSystemId | null;
  // 族 id に含まれるラグランジュ点(L1〜L5)。持たない族(dro/dpo/lpo/resonant/参照軌道)は null。
  readonly point: string | null;
  readonly points: readonly Vec3[];
}

// 表示中の1本ぶん。family の位置(index/count)は色のグラデーションと族範囲の内分に使う。
interface GuideLineEntry {
  readonly curve: GuideCurve;
  readonly familyId: string;
  readonly system: CatalogSystemId | null;
  readonly point: string | null;
  readonly index: number;
  readonly count: number;
  lastLoop: GuideLoop | null;
}

// ガイド線の曲線を GuideCurve へ流す。頂点を相対化する基準点は曲線上の1点でよいので、
// パラメータ 0 の位置を採る。解析曲線の初期区間は「1区間が半周を超えない」下限で、
// 周回数から決まる(細かさは Curve が決める)。
function applyLoop(curve: GuideCurve, loop: GuideLoop): void {
  const shape = loop.shape;
  // 解析曲線は、基準点を差し引くぶんだけ包んで渡す。
  if (shape.kind === 'analytic') {
    const origin = shape.positionAt(0);
    curve.setAnalytic(
      origin,
      (t, out) => {
        const p = shape.positionAt(t);
        out.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      },
      Math.ceil(loop.revolutions * 2),
    );
    return;
  }
  // 節点列は位置だけを基準点相対にする(接線は差分なので平行移動を受けない)。
  const origin = shape.positions[0]!;
  const positions: number[] = [];
  const tangents: number[] = [];
  for (const p of shape.positions) positions.push(p.x - origin.x, p.y - origin.y, p.z - origin.z);
  for (const m of shape.tangents) tangents.push(m.x, m.y, m.z);
  curve.setHermite(origin, { ts: shape.us, positions, tangents });
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

// 本数・族範囲・両端の色・進行方向・安定度の見せ方など、1本の折れ線をいまどう描くべきかを
// まとめた値。styleFor が現在の設定から毎フレーム組み直す(重い計算は含まない)。
interface LineVisualStyle {
  readonly opacity: number;
  readonly direction: GuideKindSettings['direction'];
  readonly animate: boolean;
  readonly markerColor: number;
  // 線のマテリアル色。頂点カラーはこれに乗算されるので、colorAt を持つ線は白にする。
  readonly color: number;
  // 線の中で色が変わる線だけが持つ。単色の線は color だけで塗る。
  readonly colorAt?: CurveColorSampler;
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

  public constructor(private readonly scene: THREE.Scene, private readonly celestialSystem: CelestialSystem) {
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

  public sync(
    style: RenderStyle, displayTime: number, view: WorldView, fo: FloatingOrigin, camera: THREE.Camera,
  ): void {
    if (view !== 'map' || !this.settings) {
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
        if (loop) applyLoop(entry.curve, loop);
        else entry.curve.clear();
      }
      this.geometryKey = geometryKey;
      this.lastComputedTime = displayTime;
      this.lastCatalogGeneration = catalogGeneration;
    }

    this.markers.beginFrame();
    this.markers.cacheCamera(camera);
    for (const entry of this.lines) {
      const visual = this.styleFor(entry, settings, style);
      if (!visual) {
        entry.curve.hide();
        continue;
      }
      entry.curve.setStyle(visual.color, visual.opacity);
      entry.curve.sync(fo, camera, visual.colorAt);
      if (entry.lastLoop) {
        this.markers.addLoop(
          entry.curve, entry.lastLoop.revolutions, visual.direction, visual.animate, visual.markerColor, fo,
        );
      }
    }
    this.markers.endFrame();
  }

  // 表示中のガイド線を、当たり判定向けの識別情報付きで返す(マップ視点外・0本の間は空)。
  // sampleCount は1本を何分割して点列に落とすか — クリック位置を拾う細かさを決めるだけで、
  // 描かれる線の細かさとは無関係。
  public visibleLines(sampleCount: number): readonly VisibleGuideLine[] {
    const visible: VisibleGuideLine[] = [];
    for (const entry of this.lines) {
      const points = entry.curve.samplePoints(sampleCount);
      if (points.length < 2) continue;
      visible.push({
        key: `${entry.familyId}:${entry.system}:${entry.point ?? '-'}:${entry.index}`,
        familyId: entry.familyId, system: entry.system, point: entry.point, points,
      });
    }
    return visible;
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
        earth, t, (r: Vec3, tt: number) => this.celestialSystem.sunDirFrom(r, tt),
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
      : secondaryFrameOf(this.celestialSystem.celestialMotions, t, motion, t);
  }

  // 系の副天体の運動。星系に居ない・公転していないなら null(その系のガイドは描かない)。
  private guideSecondaryOf(system: CatalogSystemId): OrbitingMotion | null {
    const motion = this.celestialSystem.find(guideSecondary(system))?.motion;
    return motion instanceof OrbitingMotion ? motion : null;
  }

  // 地球の運動。地球を持たない星系では null(地球専用の参照軌道は描かない)。
  private earthBodyAt(_t: number): CelestialMotion | null {
    return this.celestialSystem.has('earth') ? this.celestialSystem.motionOf('earth') : null;
  }

  // 地球の自転角速度 [rad/s]。自転モデルを持たない・地球が居ないなら null。
  private earthSpinRate(): number | null {
    return this.earthMotion()?.spinRate ?? null;
  }

  // 地球の運動。地球を持たない星系では null(地球専用の参照軌道は描かない)。
  private earthMotion(): CelestialMotion | null {
    return this.celestialSystem.find('earth')?.motion ?? null;
  }

  // その線をいま描くべき色・不透明度・進行方向マーカーの出し方を、現在の設定から組む。
  // 設定に対応するエントリが既に消えている(保存データの不整合)なら null(非表示)。
  private styleFor(
    entry: GuideLineEntry, settings: OrbitGuideSettings, style: RenderStyle,
  ): LineVisualStyle | null {
    const referenceKind = REFERENCE_ORBIT_KINDS.find((k) => k === entry.familyId);
    if (style === 'schematic') {
      // 模式図では色分けに意味を持たせない。表示の有無だけは通常どおり設定に従う。
      const on = entry.familyId === 'lissajous' ? settings.lissajous.on
        : referenceKind ? settings[referenceKind].on : effectiveKind(settings, entry.familyId)?.on;
      if (!on) return null;
      const kindDirection = entry.familyId === 'lissajous' ? settings.lissajous
        : referenceKind ? settings[referenceKind] : effectiveKind(settings, entry.familyId)!;
      return {
        opacity: 1, direction: kindDirection.direction, animate: kindDirection.animate,
        markerColor: SCHEMATIC_LINE, color: SCHEMATIC_LINE,
      };
    }
    if (entry.familyId === 'lissajous') {
      const l = settings.lissajous;
      return {
        opacity: l.opacity, direction: l.direction, animate: l.animate,
        markerColor: l.colorStart, color: l.colorStart,
      };
    }
    if (referenceKind) {
      const r = settings[referenceKind];
      return {
        opacity: r.opacity, direction: r.direction, animate: r.animate,
        markerColor: r.colorStart, color: r.colorStart,
      };
    }
    const kind = effectiveKind(settings, entry.familyId);
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
      color: 0xffffff,
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
        for (let i = 0; i < kind.count; i++) this.addCatalogLine(familyId, system, point, i, kind.count);
      }
    }

    if (settings.lissajous.on) {
      const points: readonly ['l1' | 'l2' | 'l3', CollinearPoint][] = [['l1', 'L1'], ['l2', 'L2'], ['l3', 'L3']];
      for (const system of activeSystems(settings)) {
        for (const [flag, point] of points) {
          if (settings.lissajous[flag]) this.addLissajousLine(system, point);
        }
      }
    }

    for (const kind of REFERENCE_ORBIT_KINDS) {
      if (settings[kind].on) this.addReferenceEllipseLine(kind);
    }

    this.onLineCountChange?.(this.lines.length);
  }

  // 焼き込み族の1本ぶんを組んでシーンへ加える。
  private addCatalogLine(familyId: string, system: CatalogSystemId, point: string | null, index: number, count: number): void {
    const curve = new GuideCurve({ color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference });
    this.scene.add(curve.line);
    this.lines.push({ curve, familyId, system, point, index, count, lastLoop: null });
  }

  // リサジュー軌道の1本ぶんを組んでシーンへ加える。
  private addLissajousLine(system: CatalogSystemId, point: CollinearPoint): void {
    const curve = new GuideCurve({ color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference }, LISSAJOUS_VERTEX_BUDGET);
    this.scene.add(curve.line);
    this.lines.push({ curve, familyId: 'lissajous', system, point, index: 0, count: 1, lastLoop: null });
  }

  // 地球専用参照軌道(基本群、太陽同期準回帰・ドーンダスク・モルニヤ・ツンドラ)の1本を
  // 組んでシーンへ加える。系トグルの対象外なので system は null。
  private addReferenceEllipseLine(kind: ReferenceOrbitKind): void {
    const curve = new GuideCurve({ color: 0xffffff, opacity: 0.4, renderOrder: LINE_RENDER_ORDER.reference });
    this.scene.add(curve.line);
    this.lines.push({ curve, familyId: kind, system: null, point: null, index: 0, count: 1, lastLoop: null });
  }

  // 全てのガイド線とマーカーをシーンから外して破棄する。
  public dispose(): void {
    for (const entry of this.lines) {
      entry.curve.line.removeFromParent();
      entry.curve.dispose();
    }
    this.lines = [];
    this.markers.dispose();
  }
}
