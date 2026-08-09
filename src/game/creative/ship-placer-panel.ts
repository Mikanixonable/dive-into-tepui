// クリエイティブモードの「艦艇配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で1隻分の ShipPlacerForm を通知する。
// 値から KinematicState を組み立てるのは物理側(stateFromOrbitalElements/haloState/lissajousState)の
// 仕事なので、ここでは行わない。
import { SegmentedControl, hudButton } from '../hud/buttons';
import { BodyPicker, BodyPickerGroup } from '../hud/body-picker';
import { BodyClass, bodyClassOf } from '../celestial/body-class';
import { sameSystemIds } from '../celestial/body-visibility';
import { celestialBodyName } from '../hud/frame-labels';
import { CollinearPoint } from '../../physics/halo';
import { AttractorId } from '../../physics/attractor';
import { bodyDef, primaryOf, CelestialRegistry, SOLAR_SYSTEM, MU_EARTH, R_EARTH, SIDEREAL_DAY, J2_EARTH } from '../../physics/solar-system';
import type { OrbitingId } from '../../physics/attractor';
import { semiMajorFromPeriod } from '../../physics/elements';
import type { PlacementFieldId, PlacementFieldIssue } from './placement-validation';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';

export type ObjectType = 'player' | 'enemy' | 'ammo' | 'base';
export type ReferenceAttractor = AttractorId;
export type SizeShapeMode = 'apsides' | 'semiMajorEcc' | 'periodEcc';
export type PlacementMode = 'elements' | 'lagrange';
export type LagrangeOrbitKind = 'halo' | 'lissajous';

// 軌道要素指定のサイズ/形: sizeMode が選んだ組の値だけを持つ。
export type EllipticSizeForm =
  | { readonly sizeMode: 'apsides'; readonly peAltKm: number; readonly apAltKm: number }
  | { readonly sizeMode: 'semiMajorEcc'; readonly semiMajorKm: number; readonly eccentricity: number }
  | { readonly sizeMode: 'periodEcc'; readonly periodHours: number; readonly eccentricity: number };

// 軌道要素指定一式: 基準天体・サイズ/形(上記)・向き/位相。
export type ElementsForm = {
  readonly placementMode: 'elements';
  readonly attractor: ReferenceAttractor;
  readonly incDeg: number;
  readonly raanDeg: number;
  readonly argpDeg: number;
  readonly nuDeg: number;
} & EllipticSizeForm;

// ラグランジュ点指定一式: 軌道種別ごとに持つ振幅が異なる(ハローは面外振幅のみ — 面内振幅は
// 三次の振幅拘束で導出されるので入力値を持たない。リサジューは両方)。
export type LagrangeForm = {
  readonly placementMode: 'lagrange';
  readonly lagrangeSecondary: OrbitingId;
  readonly lagrangePoint: CollinearPoint;
} & (
  | { readonly lagrangeOrbitKind: 'halo'; readonly azKm: number }
  | { readonly lagrangeOrbitKind: 'lissajous'; readonly axKm: number; readonly azKm: number }
);

// 確定時点のフォーム値。placementMode を判別子とし、選ばれた配置方法(・サイズ/形・軌道種別)が
// 実際に使う値だけを持つ。
export type ShipPlacerForm = { readonly objectType: ObjectType } & (ElementsForm | LagrangeForm);

// open() の事前入力: 'body' は基準天体だけをその値へ合わせる(他のフィールドは前回の値のまま) —
// マップの現在フォーカスを新規配置の初期値にする経路。'objectType' は種類だけを合わせる —
// 複製元の軌道要素一式は引き継げない(または引き継ぐと基地の基準天体制約に反する)ときの経路。
// 'form' は種類を objectType に固定し、軌道要素一式をその値へ書き換える —
// 軌道要素をそのまま引き継げる複製の経路。
export type ShipPlacerPreset =
  | { readonly kind: 'body'; readonly attractor: ReferenceAttractor }
  | { readonly kind: 'objectType'; readonly objectType: ObjectType }
  | { readonly kind: 'form'; readonly objectType: ObjectType; readonly form: ElementsForm };

const OBJECT_TYPE_ITEMS: readonly (readonly [ObjectType, string])[] = [
  ['player', '自機'],
  ['enemy', '敵機'],
  ['ammo', '弾薬'],
  ['base', '基地'],
];

const PLACEMENT_MODE_ITEMS: readonly (readonly [PlacementMode, string])[] = [
  ['elements', '軌道要素'],
  ['lagrange', 'ラグランジュ点'],
];

const SIZE_MODE_ITEMS: readonly (readonly [SizeShapeMode, string])[] = [
  ['apsides', '近地点+遠地点'],
  ['semiMajorEcc', '半長軸+離心率'],
  ['periodEcc', '周期+離心率'],
];

// ラグランジュ点を持てる天体(惑星 + 衛星)を副天体として列挙する。軌道要素指定の基準天体も
// これを使う(公転していない恒星を周回の中心には選べない)。
function orbitingIdsOf(registry: CelestialRegistry): readonly OrbitingId[] {
  return Object.keys(registry).filter((id) => bodyDef(registry, id).kind !== 'star');
}

// 天体の候補をクラス別のまとまりへ組む。先頭は「いま選んでいる系」— 実際に選ばれるのは
// ほぼ常に同じ系の別天体なので、1クリック目に置く。
function bodyGroupsOf(
  registry: CelestialRegistry, items: readonly (readonly [ReferenceAttractor, string])[], selected: ReferenceAttractor,
): readonly BodyPickerGroup<ReferenceAttractor>[] {
  const near0 = sameSystemIds(registry, selected);
  const near = items.filter(([id]) => near0.has(id));
  const byClass = (cls: BodyClass) => items.filter(([id]) => bodyClassOf(registry, id) === cls);
  return [
    { label: 'いま選んでいる系', items: near },
    { label: '惑星', items: byClass('planet') },
    { label: '衛星', items: byClass('satellite') },
    { label: '準惑星', items: byClass('dwarf') },
    { label: '小天体', items: byClass('smallBody') },
  ].filter((g) => g.items.length > 0);
}

// 表示名を「中心天体名-自分の名」として ephemeris から組む(primaryOf で主星を解決する)。
function lagrangeSystemItemsOf(ephemeris: Ephemeris, orbitingIds: readonly OrbitingId[]): readonly (readonly [OrbitingId, string])[] {
  return orbitingIds.map((id) => {
    const primary = primaryOf(ephemeris.registry, id);
    const primaryName = primary === null ? celestialBodyName(id) : celestialBodyName(primary);
    return [id, `${primaryName}-${celestialBodyName(id)}`] as const;
  });
}

const LAGRANGE_POINT_ITEMS: readonly (readonly [CollinearPoint, string])[] = [
  ['L1', 'L1'],
  ['L2', 'L2'],
];

const LAGRANGE_ORBIT_KIND_ITEMS: readonly (readonly [LagrangeOrbitKind, string])[] = [
  ['halo', 'ハロー'],
  ['lissajous', 'リサジュー'],
];

// 副天体ごとに妥当なオーダーへ面内/面外振幅の既定値を切り替える(系ごとに主天体間距離が
// 桁違いなため)。
const LAGRANGE_DEFAULT_AMPLITUDE_KM: Partial<Record<OrbitingId, { ax: number; az: number }>> = {
  moon: { ax: C.CREATIVE_HALO_AX_MOON_KM, az: C.CREATIVE_HALO_AZ_MOON_KM },
  earth: { ax: C.CREATIVE_HALO_AX_EARTH_KM, az: C.CREATIVE_HALO_AZ_EARTH_KM },
  jupiter: { ax: C.CREATIVE_HALO_AX_JUPITER_KM, az: C.CREATIVE_HALO_AZ_JUPITER_KM },
};

// 副天体とその主天体の距離 [km](= 副天体の軌道長半径)。
function primaryDistanceKm(secondary: OrbitingId): number {
  const def = bodyDef(SOLAR_SYSTEM, secondary);
  if (def.kind === 'star') throw new Error(`primaryDistanceKm: ${secondary} は恒星なので公転していない`);
  return (def.kind === 'planet' ? def.orbit.a : def.orbit.kepler.a) / 1e3;
}

// 表に無い天体の既定振幅を主天体間距離から導くときの比。月の既定値と月の軌道長半径の比を
// そのまま使うので、表に載っている天体と桁感が揃う。
const AMPLITUDE_AX_RATIO = C.CREATIVE_HALO_AX_MOON_KM / primaryDistanceKm('moon');
const AMPLITUDE_AZ_RATIO = C.CREATIVE_HALO_AZ_MOON_KM / primaryDistanceKm('moon');

const DEG = Math.PI / 180;

// 静止軌道の高度: 恒星日ちょうどの円軌道の半長軸から導出する(マジックナンバーで別途持たない)。
const GEO_ALT_KM = (semiMajorFromPeriod(SIDEREAL_DAY, MU_EARTH) - R_EARTH) / 1e3;

// 太陽同期軌道の傾斜角: その高度の円軌道が J2 摂動で受ける昇交点歳差(dynamics.ts の j2Accel と
// 同じ式)が、地球の公転角速度(SOLAR_SYSTEM の地球公転要素そのもの)にちょうど一致する条件から
// 逆算する。retrograde 解(i>90°)が太陽同期の側。
function sunSyncInclinationDeg(altKm: number): number {
  const a = R_EARTH + altKm * 1e3;
  const n = Math.sqrt(MU_EARTH / (a * a * a));
  const earthOrbitRate = SOLAR_SYSTEM.earth.orbit.lRate;
  const cosI = earthOrbitRate / (-1.5 * n * J2_EARTH * (R_EARTH / a) ** 2);
  return Math.acos(cosI) / DEG;
}

const SUN_SYNC_ALT_KM = 700;
const MOON_LOW_ALT_KM = 100;

// 軌道要素指定のサイズ/形プリセット。近地点+遠地点高度(円軌道は両方同値)と、向きを固定する
// 軌道では傾斜角も併せて埋める。基準天体ごとに桁が違う軌道しか意味を持たないため天体単位で持つ。
type SizePreset = { readonly label: string; readonly peAltKm: number; readonly apAltKm: number; readonly incDeg?: number };
const PRESETS_BY_BODY: Partial<Record<ReferenceAttractor, readonly SizePreset[]>> = {
  earth: [
    { label: '低軌道(LEO)', peAltKm: 400, apAltKm: 400 },
    { label: '静止軌道(GEO)', peAltKm: GEO_ALT_KM, apAltKm: GEO_ALT_KM, incDeg: 0 },
    { label: '太陽同期軌道', peAltKm: SUN_SYNC_ALT_KM, apAltKm: SUN_SYNC_ALT_KM, incDeg: sunSyncInclinationDeg(SUN_SYNC_ALT_KM) },
  ],
  moon: [
    { label: '低軌道', peAltKm: MOON_LOW_ALT_KM, apAltKm: MOON_LOW_ALT_KM },
  ],
};

// ラベル行(.hud-seg + .seg-title)と数値 input を組み立てて返す。root への追加は呼び出し側の仕事
// (numberField はそのまま追加するだけだが、sliderField はスライダー列を同じ行に足してから追加する)。
function buildNumberRow(label: string, defaultValue: number, step: number, min?: number, max?: number): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'hud-seg';
  const heading = document.createElement('span');
  heading.className = 'seg-title';
  heading.textContent = label;
  row.appendChild(heading);
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(defaultValue);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  // #hud はマップドラッグを拾うため、この入力上のポインタ操作がカメラドラッグへ抜けないようにする。
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  row.appendChild(input);
  return { row, input };
}

// ラベル付き数値入力を1行分組み立てて root へ追加し、input 要素を返す。
function numberField(root: HTMLElement, label: string, defaultValue: number, step: number, min?: number, max?: number): HTMLInputElement {
  const { row, input } = buildNumberRow(label, defaultValue, step, min, max);
  root.appendChild(row);
  return input;
}

// numberField が組んだ入力の行(ラベルごと)を出し入れする。
function setFieldVisible(input: HTMLInputElement, visible: boolean): void {
  (input.parentElement as HTMLElement).style.display = visible ? '' : 'none';
}

// numberField にスライダー+目盛りを添えた行。数値入力とスライダーは双方向に同期する。
// 値⇔スライダー位置(0..1)の対応と目盛りラベルは呼び出し側が bindAngleSlider/
// bindEccentricitySlider/bindRelativeSlider 経由で決める(角度・離心率は固定範囲の線形対応、
// 半長軸・周期・高度は上限がなく基準値相対の対応になるため、この行自体は対応関係を知らない)。
interface SliderRow {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  readonly slider: HTMLInputElement;
  setTicks(labels: readonly string[]): void;
  setMapping(toT: (value: number) => number, fromT: (t: number) => number): void;
  // bindRelativeSlider が結んだ行にだけ立つ: 基準値相対スライダーの基準をいまの input.value へ
  // 取り直す。値を外部から書き換えたときはこれも呼ばないと、つまみの位置が実際の値とずれる。
  rebase?(): void;
}

function sliderField(root: HTMLElement, label: string, defaultValue: number, step: number, min?: number, max?: number): SliderRow {
  const wrap = document.createElement('div');
  wrap.className = 'slider-field';

  const { row, input } = buildNumberRow(label, defaultValue, step, min, max);

  const sliderCol = document.createElement('div');
  sliderCol.className = 'slider-col';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1000';
  slider.step = '1';
  slider.addEventListener('pointerdown', (e) => e.stopPropagation());
  sliderCol.appendChild(slider);

  const ticksEl = document.createElement('div');
  ticksEl.className = 'slider-ticks';
  sliderCol.appendChild(ticksEl);

  row.appendChild(sliderCol);
  wrap.appendChild(row);

  root.appendChild(wrap);

  let toT = (v: number): number => v;
  let fromT = (t: number): number => t;
  const syncSliderFromInput = (): void => {
    const t = Math.max(0, Math.min(1, toT(Number(input.value))));
    slider.value = String(Math.round(t * 1000));
  };
  input.addEventListener('input', syncSliderFromInput);
  slider.addEventListener('input', () => {
    // 入力欄の刻みへ丸めてから書き戻す。高度スライダーは書き戻した値を次のドラッグの基準に
    // 取り直すので、丸めないと端数がドラッグのたびに積み上がる。
    input.value = String(Math.round(fromT(Number(slider.value) / 1000) / step) * step);
  });

  return {
    element: wrap,
    input,
    slider,
    setTicks(labels) {
      ticksEl.innerHTML = '';
      for (const text of labels) {
        const span = document.createElement('span');
        span.textContent = text;
        ticksEl.appendChild(span);
      }
    },
    setMapping(newToT, newFromT) {
      toT = newToT;
      fromT = newFromT;
      syncSliderFromInput();
    },
  };
}

// 角度スライダー(i/Ω/ω/ν): 0..rangeDeg の線形対応、90度ごとに目盛りを表示する。
function bindAngleSlider(field: SliderRow, rangeDeg: number): void {
  field.setMapping((v) => v / rangeDeg, (t) => t * rangeDeg);
  const tickCount = rangeDeg / 90 + 1;
  field.setTicks(Array.from({ length: tickCount }, (_, i) => `${i * 90}°`));
}

// 離心率スライダー: 0..0.99 の線形対応、0/0.25/0.5/0.75/0.99 に目盛りを表示する。
function bindEccentricitySlider(field: SliderRow): void {
  const max = 0.99;
  field.setMapping((v) => v / max, (t) => t * max);
  field.setTicks([0, 0.25, 0.5, 0.75, 0.99].map((v) => v.toFixed(2)));
}

// 基準値相対スライダーの倍率: 中央(t=0)を基準値の100%とし、左は等倍で0%まで、
// 右は2倍指数で400%まで伸びる。上限のない量を有限のスライダー幅で操作するための仕様。
function relativeMultiplier(tOffset: number): number {
  return tOffset <= 0 ? 1 + tOffset : Math.pow(2, 2 * tOffset);
}

// 基準値相対スライダー(Ap/Pe高度・半長軸・周期): ドラッグ開始時点の値を基準の100%として
// スライダー中央に据え、ドラッグが終わるたびにそのときの値を新しい基準に取り直してつまみを
// 中央へ戻す(基準を固定しないと上限のない量を動かせない)。refFloor は基準値の下限 —
// 基準はスライダーの可動範囲そのものなので、値が 0 まで下がったときに 0 を基準にすると倍率を
// いくら掛けても 0 のままになり、二度と操作で戻せなくなる。量ごとに単位・オーダーが違うので
// 呼び出し側がその量にとって妥当な床を渡す。
function bindRelativeSlider(field: SliderRow, refFloor: number): void {
  const rebase = (): void => {
    const ref = Math.max(Number(field.input.value), refFloor);
    field.setMapping(
      (v) => {
        const mult = v / ref;
        const tOffset = mult <= 1 ? mult - 1 : Math.log2(mult) / 2;
        return (tOffset + 1) / 2;
      },
      (t) => ref * relativeMultiplier(2 * t - 1),
    );
    field.setTicks([0, 0.5, 1, 2, 4].map((m) => `${Math.round((ref * m) * 100) / 100}`));
  };
  field.slider.addEventListener('pointerdown', rebase);
  field.slider.addEventListener('pointerup', rebase);
  field.rebase = rebase;
  rebase();
}

// 高度・半長軸の基準値の下限(km): 一度のドラッグでこの4倍まで戻せる値を床に置く。
const ALTITUDE_REF_FLOOR_KM = 100;
// 周期の基準値の下限(h): 高度と同じ床を使うと大きすぎて操作不能になるため、周期のオーダーに合わせる。
const PERIOD_REF_FLOOR_HOURS = 0.1;

export class ShipPlacerPanel {
  onConfirm: ((name: string, form: ShipPlacerForm) => void) | null = null;
  onClose: (() => void) | null = null;

  private _isOpen = false;
  get isOpen(): boolean { return this._isOpen; }

  private readonly panel: HTMLElement;
  private readonly objectType: SegmentedControl<ObjectType>;
  private readonly placementMode: SegmentedControl<PlacementMode>;
  private readonly placementGroups: Record<PlacementMode, HTMLElement>;
  private readonly attractor: BodyPicker<ReferenceAttractor>;
  private readonly sizeMode: SegmentedControl<SizeShapeMode>;
  private readonly sizeGroups: Record<SizeShapeMode, HTMLElement>;
  private readonly nameInput: HTMLInputElement;
  private readonly peAlt: SliderRow;
  private readonly apAlt: SliderRow;
  private readonly semiMajor: SliderRow;
  private readonly eccSemiMajor: SliderRow;
  private readonly period: SliderRow;
  private readonly eccPeriod: SliderRow;
  private readonly inc: SliderRow;
  private readonly raan: SliderRow;
  private readonly argp: SliderRow;
  private readonly nu: SliderRow;
  private readonly lagrangeSecondary: BodyPicker<OrbitingId>;
  private readonly lagrangePoint: SegmentedControl<CollinearPoint>;
  private readonly lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;
  private readonly refreshPresets: () => void;
  private readonly attractorItems: readonly (readonly [ReferenceAttractor, string])[];
  // 基地は敵の射程となる惑星近傍を避けるため、軌道要素指定の基準天体は月だけに絞る
  // (地球・木星は選択肢自体を出さない — placement-validation.ts の validateBaseReferenceFields と対にする)。
  private readonly baseAttractorItems: readonly (readonly [ReferenceAttractor, string])[];
  private readonly lagrangeSystemItems: readonly (readonly [OrbitingId, string])[];
  private readonly issueList: HTMLElement;
  private issueRows: readonly HTMLElement[] = [];
  private lastIssueKey = '';

  private objectTypeValue: ObjectType = 'player';
  private placementModeValue: PlacementMode = 'elements';
  private attractorValue: ReferenceAttractor = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';
  private lagrangeSecondaryValue: OrbitingId = 'moon';
  private lagrangePointValue: CollinearPoint = 'L1';
  private lagrangeOrbitKindValue: LagrangeOrbitKind = 'halo';

  // 艦艇配置パネルの DOM を組み立て、root へ追加する。基準天体・ラグランジュ系の選択肢は
  // ephemeris が実際に持つレジストリから組む。
  private readonly registry: CelestialRegistry;
  // BodyPicker のポップアップの親。パネル自身の overflow に切られないよう HUD ルートへ置く。
  private readonly hudRoot: HTMLElement;

  constructor(root: HTMLElement, ephemeris: Ephemeris) {
    this.registry = ephemeris.registry;
    this.hudRoot = root;
    const orbitingIds = orbitingIdsOf(ephemeris.registry);
    this.attractorItems = orbitingIds.map((id) => [id, celestialBodyName(id)] as const);
    this.baseAttractorItems = this.attractorItems.filter(([id]) => id === 'moon');
    this.lagrangeSystemItems = lagrangeSystemItemsOf(ephemeris, orbitingIds);

    this.panel = document.createElement('div');
    this.panel.id = 'hud-shipplacer';
    this.panel.className = 'panel';
    // モーダルとして画面右上に配置
    this.panel.style.position = 'fixed';
    this.panel.style.top = '20px';
    this.panel.style.right = '20px';
    this.panel.style.width = 'max-content';
    this.panel.style.zIndex = '30';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = '軌道オブジェクト配置';
    this.panel.appendChild(title);

    this.objectType = new SegmentedControl('種類', OBJECT_TYPE_ITEMS, (v) => this.selectObjectType(v));
    this.objectType.setSelected(this.objectTypeValue);
    this.panel.appendChild(this.objectType.element);

    this.placementMode = new SegmentedControl('配置方法', PLACEMENT_MODE_ITEMS, (v) => this.selectPlacementMode(v));
    this.panel.appendChild(this.placementMode.element);

    const elements = this.buildElementsGroup();
    this.attractor = elements.attractor;
    this.sizeMode = elements.sizeMode;
    this.sizeGroups = elements.sizeGroups;
    this.peAlt = elements.peAlt;
    this.apAlt = elements.apAlt;
    this.semiMajor = elements.semiMajor;
    this.eccSemiMajor = elements.eccSemiMajor;
    this.period = elements.period;
    this.eccPeriod = elements.eccPeriod;
    this.inc = elements.inc;
    this.raan = elements.raan;
    this.argp = elements.argp;
    this.nu = elements.nu;
    this.refreshPresets = elements.refreshPresets;
    this.selectSizeMode(this.sizeModeValue);
    this.panel.appendChild(elements.element);

    const lagrange = this.buildLagrangeGroup();
    this.lagrangeSecondary = lagrange.lagrangeSecondary;
    this.lagrangePoint = lagrange.lagrangePoint;
    this.lagrangeOrbitKind = lagrange.lagrangeOrbitKind;
    this.libAx = lagrange.libAx;
    this.libAz = lagrange.libAz;
    this.panel.appendChild(lagrange.element);

    this.placementGroups = { elements: elements.element, lagrange: lagrange.element };
    this.selectPlacementMode(this.placementModeValue);

    const nameRow = this.buildNameRow();
    this.nameInput = nameRow.nameInput;
    this.panel.appendChild(nameRow.element);

    this.issueList = document.createElement('div');
    this.issueList.className = 'issue-list';
    this.issueList.style.display = 'none';
    this.panel.appendChild(this.issueList);

    this.buildButtonsAndKeybinds();

    // root (hud-modal-shield) に追加
    root.appendChild(this.panel);
  }

  // 軌道要素指定の一式(基準天体・サイズ/形・向き・位相)を1つの div にまとめて返す。
  // サイズ/形の3つの入力組はどれか1つだけを表示する(selectSizeMode が切り替える)ので、
  // 呼び出し側は返った sizeGroups を this.sizeGroups へ代入してから selectSizeMode を呼ぶ必要がある。
  private buildElementsGroup(): {
    element: HTMLElement;
    attractor: BodyPicker<ReferenceAttractor>;
    sizeMode: SegmentedControl<SizeShapeMode>;
    sizeGroups: Record<SizeShapeMode, HTMLElement>;
    peAlt: SliderRow;
    apAlt: SliderRow;
    semiMajor: SliderRow;
    eccSemiMajor: SliderRow;
    period: SliderRow;
    eccPeriod: SliderRow;
    inc: SliderRow;
    raan: SliderRow;
    argp: SliderRow;
    nu: SliderRow;
    refreshPresets: () => void;
  } {
    const elementsGroup = document.createElement('div');
    const attractorControl = new BodyPicker<ReferenceAttractor>(this.hudRoot, '基準天体', (v) => {
      this.attractorValue = v;
      attractorControl.setSelected(v);
      this.refreshPresets();
    });
    attractorControl.setGroups(bodyGroupsOf(this.registry, this.attractorItems, this.attractorValue));
    attractorControl.setSelected(this.attractorValue);
    elementsGroup.appendChild(attractorControl.element);

    const sizeMode = new SegmentedControl('サイズ/形', SIZE_MODE_ITEMS, (v) => this.selectSizeMode(v));

    const apsidesGroup = document.createElement('div');
    const peAlt = sliderField(apsidesGroup, '近地点高度 [km]', 400, 10, 0);
    bindRelativeSlider(peAlt, ALTITUDE_REF_FLOOR_KM);
    const apAlt = sliderField(apsidesGroup, '遠地点高度 [km]', 400, 10, 0);
    bindRelativeSlider(apAlt, ALTITUDE_REF_FLOOR_KM);

    const semiMajorGroup = document.createElement('div');
    const semiMajor = sliderField(semiMajorGroup, '半長軸 [km]', 6771, 10, 0);
    bindRelativeSlider(semiMajor, ALTITUDE_REF_FLOOR_KM);
    const eccSemiMajor = sliderField(semiMajorGroup, '離心率', 0, 0.01, 0, 0.99);
    bindEccentricitySlider(eccSemiMajor);

    const periodGroup = document.createElement('div');
    const period = sliderField(periodGroup, '周期 [h]', 1.54, 0.01, 0);
    bindRelativeSlider(period, PERIOD_REF_FLOOR_HOURS);
    const eccPeriod = sliderField(periodGroup, '離心率', 0, 0.01, 0, 0.99);
    bindEccentricitySlider(eccPeriod);

    const sizeGroups = { apsides: apsidesGroup, semiMajorEcc: semiMajorGroup, periodEcc: periodGroup };

    // プリセット行: 基準天体が変わるたび refreshPresets で候補を差し替える(選ぶと近地点/遠地点
    // 高度・必要なら傾斜角を書き換え、サイズ/形を近地点+遠地点表示へ揃える)。
    const presetRow = document.createElement('div');
    presetRow.className = 'hud-seg preset-row';
    const refreshPresets = (): void => {
      presetRow.innerHTML = '';
      const presets = PRESETS_BY_BODY[this.attractorValue] ?? [];
      presetRow.style.display = presets.length > 0 ? '' : 'none';
      if (presets.length === 0) return;
      const heading = document.createElement('span');
      heading.className = 'seg-title';
      heading.textContent = 'プリセット';
      presetRow.appendChild(heading);
      for (const preset of presets) {
        presetRow.appendChild(hudButton(preset.label, () => {
          this.setSliderValue(peAlt, preset.peAltKm);
          this.setSliderValue(apAlt, preset.apAltKm);
          if (preset.incDeg !== undefined) this.setSliderValue(inc, preset.incDeg);
          this.selectSizeMode('apsides');
        }));
      }
    };

    elementsGroup.appendChild(presetRow);
    elementsGroup.appendChild(sizeMode.element);
    elementsGroup.appendChild(apsidesGroup);
    elementsGroup.appendChild(semiMajorGroup);
    elementsGroup.appendChild(periodGroup);

    // 向き(i/Ω/ω)と位相(ν)は組の選択によらず常に有効。i は 0..180、それ以外は 0..360 の
    // 線形スライダー(45度刻みの目盛り)を添える。
    const inc = sliderField(elementsGroup, '傾斜角 i [deg]', 0, 1, 0, 180);
    bindAngleSlider(inc, 180);
    const raan = sliderField(elementsGroup, '昇交点赤経 Ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(raan, 360);
    const argp = sliderField(elementsGroup, '近点引数 ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(argp, 360);
    const nu = sliderField(elementsGroup, '真近点角 ν [deg]', 0, 1, 0, 360);
    bindAngleSlider(nu, 360);

    refreshPresets();

    return { element: elementsGroup, attractor: attractorControl, sizeMode, sizeGroups, peAlt, apAlt, semiMajor, eccSemiMajor, period, eccPeriod, inc, raan, argp, nu, refreshPresets };
  }

  // ラグランジュ点指定(ハロー/リサジュー)の一式を1つの div にまとめて返す。
  private buildLagrangeGroup(): {
    element: HTMLElement;
    lagrangeSecondary: BodyPicker<OrbitingId>;
    lagrangePoint: SegmentedControl<CollinearPoint>;
    lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
    libAx: HTMLInputElement;
    libAz: HTMLInputElement;
  } {
    const lagrangeGroup = document.createElement('div');
    const lagrangeSecondary = new BodyPicker<OrbitingId>(this.hudRoot, '系', (v) => this.selectLagrangeSecondary(v));
    lagrangeSecondary.setGroups([{ label: '', items: this.lagrangeSystemItems }]);
    lagrangeSecondary.setSelected(this.lagrangeSecondaryValue);
    lagrangeGroup.appendChild(lagrangeSecondary.element);
    const lagrangePoint = new SegmentedControl('点', LAGRANGE_POINT_ITEMS, (v) => {
      this.lagrangePointValue = v;
      this.lagrangePoint.setSelected(v);
    });
    lagrangePoint.setSelected(this.lagrangePointValue);
    lagrangeGroup.appendChild(lagrangePoint.element);
    // ハローの面内振幅は面外振幅から三次の振幅拘束で決まるので、入力欄自体を出さない。
    let libAx: HTMLInputElement;
    const lagrangeOrbitKind = new SegmentedControl('軌道種別', LAGRANGE_ORBIT_KIND_ITEMS, (v) => {
      this.lagrangeOrbitKindValue = v;
      this.lagrangeOrbitKind.setSelected(v);
      setFieldVisible(libAx, v === 'lissajous');
      libAx.value = String(this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue).ax);
    });
    lagrangeGroup.appendChild(lagrangeOrbitKind.element);
    const defaultAmp = this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue);
    libAx = numberField(lagrangeGroup, '面内振幅 ax [km]', defaultAmp.ax, 100, 0);
    const libAz = numberField(lagrangeGroup, '面外振幅 az [km]', defaultAmp.az, 100, 0);
    lagrangeOrbitKind.setSelected(this.lagrangeOrbitKindValue);
    setFieldVisible(libAx, this.lagrangeOrbitKindValue === 'lissajous');

    return { element: lagrangeGroup, lagrangeSecondary, lagrangePoint, lagrangeOrbitKind, libAx, libAz };
  }

  // 名称行(ラベル + テキスト入力)を組み立てて返す。
  private buildNameRow(): { element: HTMLElement; nameInput: HTMLInputElement } {
    const nameRow = document.createElement('div');
    nameRow.className = 'hud-seg';
    const nameHeading = document.createElement('span');
    nameHeading.className = 'seg-title';
    nameHeading.textContent = '名称';
    nameRow.appendChild(nameHeading);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '空欄で自動命名';
    nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    nameRow.appendChild(nameInput);
    return { element: nameRow, nameInput };
  }

  // 配置/キャンセルのボタン行を this.panel に追加し、Enter/ESC のキーバインドを登録する。
  // キーバインドは window に貼るため、パネルを開いていない間は素通りさせる。
  private buildButtonsAndKeybinds(): void {
    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '10px';
    btnRow.style.marginTop = '12px';
    btnRow.appendChild(hudButton('配置 [Enter]', () => this.confirm()));
    btnRow.appendChild(hudButton('キャンセル [ESC]', () => {
      this.close();
      this.onClose?.();
    }));
    this.panel.appendChild(btnRow);

    window.addEventListener('keydown', (e) => {
      if (!this._isOpen) return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        this.close();
        this.onClose?.();
      } else if (e.key === 'Enter') {
        e.stopImmediatePropagation();
        this.confirm();
      }
    });
  }

  // 種類を切り替える。基地は月基準の軌道要素かラグランジュ点指定でしか設置できない
  // (placement-validation.ts の validateBaseReferenceFields と対応)ので、基準天体の選択肢を
  // 月だけに絞り、月以外が選ばれていたら月へ寄せ直す。基地以外へ戻したら選択肢も元に戻す。
  private selectObjectType(v: ObjectType): void {
    this.objectTypeValue = v;
    this.objectType.setSelected(v);
    if (v === 'base') {
      if (this.attractorValue !== 'moon') this.attractorValue = 'moon';
      this.attractor.setGroups([{ label: '', items: this.baseAttractorItems }]);
    } else {
      this.attractor.setGroups(bodyGroupsOf(this.registry, this.attractorItems, this.attractorValue));
    }
    this.attractor.setSelected(this.attractorValue);
    this.refreshPresets();
  }

  // サイズ/形の入力組を切り替え、選ばれた組以外を隠す。
  private selectSizeMode(mode: SizeShapeMode): void {
    this.sizeModeValue = mode;
    this.sizeMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.sizeGroups) as [SizeShapeMode, HTMLElement][]) {
      group.style.display = key === mode ? 'block' : 'none';
    }
  }

  // 配置方法(軌道要素/ラグランジュ点)を切り替え、選ばれなかった側を隠す。
  private selectPlacementMode(mode: PlacementMode): void {
    this.placementModeValue = mode;
    this.placementMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.placementGroups) as [PlacementMode, HTMLElement][]) {
      group.style.display = key === mode ? 'block' : 'none';
    }
  }

  // 副天体を切り替え、面内/面外振幅の既定値をその系のオーダーへ更新する。
  private selectLagrangeSecondary(secondary: OrbitingId): void {
    this.lagrangeSecondaryValue = secondary;
    this.lagrangeSecondary.setSelected(secondary);
    const amp = this.defaultLagrangeAmplitude(secondary);
    this.libAx.value = String(amp.ax);
    this.libAz.value = String(amp.az);
  }

  // 副天体ごとの面内/面外振幅の既定値を返す(系ごとに主天体間距離が桁違いなため)。
  private defaultLagrangeAmplitude(secondary: OrbitingId): { ax: number; az: number } {
    const listed = LAGRANGE_DEFAULT_AMPLITUDE_KM[secondary];
    if (listed !== undefined) return listed;
    const distanceKm = primaryDistanceKm(secondary);
    return { ax: distanceKm * AMPLITUDE_AX_RATIO, az: distanceKm * AMPLITUDE_AZ_RATIO };
  }

  // フォームの現在値を読み、onConfirm へ通知する。
  private confirm(): void {
    // 空欄なら確定側(CreativeStage.placeObject)が種別ごとの既定名で自動命名する。
    const name = this.nameInput.value.trim();
    const form = this.getForm();
    this.onConfirm?.(name, form);
    this.close();
    this.onClose?.();
  }

  // 現在のフォームの値を、選ばれた組・種別が使う値だけを読み取って ShipPlacerForm へ組む。
  // プレビュー用にも使用。
  getForm(): ShipPlacerForm {
    const objectType = this.objectTypeValue;
    if (this.placementModeValue === 'lagrange') {
      const common = {
        placementMode: 'lagrange' as const,
        lagrangeSecondary: this.lagrangeSecondaryValue,
        lagrangePoint: this.lagrangePointValue,
      };
      if (this.lagrangeOrbitKindValue === 'halo') {
        return { objectType, ...common, lagrangeOrbitKind: 'halo', azKm: Number(this.libAz.value) };
      }
      return {
        objectType, ...common, lagrangeOrbitKind: 'lissajous',
        axKm: Number(this.libAx.value), azKm: Number(this.libAz.value),
      };
    }
    const common = {
      placementMode: 'elements' as const,
      attractor: this.attractorValue,
      incDeg: Number(this.inc.input.value),
      raanDeg: Number(this.raan.input.value),
      argpDeg: Number(this.argp.input.value),
      nuDeg: Number(this.nu.input.value),
    };
    if (this.sizeModeValue === 'apsides') {
      return {
        objectType, ...common, sizeMode: 'apsides',
        peAltKm: Number(this.peAlt.input.value), apAltKm: Number(this.apAlt.input.value),
      };
    } else if (this.sizeModeValue === 'semiMajorEcc') {
      return {
        objectType, ...common, sizeMode: 'semiMajorEcc',
        semiMajorKm: Number(this.semiMajor.input.value), eccentricity: Number(this.eccSemiMajor.input.value),
      };
    } else {
      return {
        objectType, ...common, sizeMode: 'periodEcc',
        periodHours: Number(this.period.input.value), eccentricity: Number(this.eccPeriod.input.value),
      };
    }
  }

  // PlacementFieldId をハイライト対象の行要素へ対応させる。離心率は sizeMode が選んだ組の
  // 入力欄だけがハイライト対象になる(もう一方は非表示なので指しても意味がない)。
  private fieldRowFor(field: PlacementFieldId): HTMLElement | undefined {
    switch (field) {
      case 'periapsisAltitude': return this.peAlt.element;
      case 'apoapsisAltitude': return this.apAlt.element;
      case 'semiMajorAxis': return this.semiMajor.element;
      case 'period': return this.period.element;
      case 'eccentricity':
        return this.sizeModeValue === 'semiMajorEcc' ? this.eccSemiMajor.element
          : this.sizeModeValue === 'periodEcc' ? this.eccPeriod.element : undefined;
      case 'inclination': return this.inc.element;
      case 'raan': return this.raan.element;
      case 'argumentOfPeriapsis': return this.argp.element;
      case 'trueAnomaly': return this.nu.element;
      case 'referenceAttractor': return this.attractor.element;
      case 'inPlaneAmplitude': return this.libAx.parentElement as HTMLElement;
      case 'outOfPlaneAmplitude': return this.libAz.parentElement as HTMLElement;
    }
  }

  // 検証結果を差分反映する。CreativeStage.update が毎フレーム導出した issues を渡す想定 —
  // 前回と同じ内容なら DOM に触らない(該当欄の枠色とメッセージ一覧をまとめて持つ)。
  setIssues(issues: readonly PlacementFieldIssue[]): void {
    // sizeModeValue も差分判定に含める: 'eccentricity' が指す行(fieldRowFor)は
    // sizeMode によって変わるため、issues の中身が変わらなくても再反映が要る場合がある。
    const key = `${this.sizeModeValue}|${issues.map((issue) => `${issue.field}:${issue.message}`).join('|')}`;
    if (key === this.lastIssueKey) return;
    this.lastIssueKey = key;

    for (const row of this.issueRows) row.classList.remove('field-issue');
    this.issueRows = issues.map((issue) => this.fieldRowFor(issue.field)).filter((row): row is HTMLElement => row !== undefined);
    for (const row of this.issueRows) row.classList.add('field-issue');

    this.issueList.innerHTML = '';
    for (const issue of issues) {
      const line = document.createElement('div');
      line.className = 'issue-line';
      line.textContent = issue.message;
      this.issueList.appendChild(line);
    }
    this.issueList.style.display = issues.length > 0 ? '' : 'none';
  }

  // パネルを開く。preset の種別で事前入力の範囲が変わる(ShipPlacerPreset 参照)。
  // 'body' は基準天体が現在の種類で選べる ID のときだけ差し替える。
  open(preset?: ShipPlacerPreset): void {
    if (preset?.kind === 'form') {
      this.selectObjectType(preset.objectType);
      this.applyElementsForm(preset.form);
    } else if (preset?.kind === 'objectType') {
      this.selectObjectType(preset.objectType);
    } else if (preset?.kind === 'body') {
      const allowed = this.objectTypeValue === 'base' ? this.baseAttractorItems : this.attractorItems;
      if (allowed.some(([id]) => id === preset.attractor)) {
        this.attractorValue = preset.attractor;
        this.attractor.setSelected(this.attractorValue);
        this.refreshPresets();
      }
    }
    this._isOpen = true;
    this.panel.style.display = 'block';
  }

  close(): void {
    this._isOpen = false;
    this.panel.style.display = 'none';
  }

  // SliderRow へ値を書き込み、対応する数値入力の input イベントを発火させたうえで
  // 基準値相対スライダーの基準を取り直す(値と rebase を分けて呼ぶ経路を作らないための唯一の書き込み口 —
  // rebase を欠くとつまみの位置が新しい値と食い違う)。
  private setSliderValue(row: SliderRow, value: number): void {
    row.input.value = String(value);
    row.input.dispatchEvent(new Event('input'));
    row.rebase?.();
  }

  // 軌道要素一式をフォームへ書き込む。form.attractor は呼び出し側 (open) が現在の種類で選べる
  // 基準天体であることを保証済みの前提で、確認なしにそのまま書き込む。
  private applyElementsForm(form: ElementsForm): void {
    this.selectPlacementMode('elements');
    this.attractorValue = form.attractor;
    this.attractor.setSelected(this.attractorValue);
    this.refreshPresets();
    this.selectSizeMode(form.sizeMode);

    if (form.sizeMode === 'apsides') {
      this.setSliderValue(this.peAlt, form.peAltKm);
      this.setSliderValue(this.apAlt, form.apAltKm);
    } else if (form.sizeMode === 'semiMajorEcc') {
      this.setSliderValue(this.semiMajor, form.semiMajorKm);
      this.setSliderValue(this.eccSemiMajor, form.eccentricity);
    } else {
      this.setSliderValue(this.period, form.periodHours);
      this.setSliderValue(this.eccPeriod, form.eccentricity);
    }
    this.setSliderValue(this.inc, form.incDeg);
    this.setSliderValue(this.raan, form.raanDeg);
    this.setSliderValue(this.argp, form.argpDeg);
    this.setSliderValue(this.nu, form.nuDeg);
  }
}
