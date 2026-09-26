// クリエイティブモードの「物体配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で ObjectPlacerForm を通知する。
import {
  buildGroupTitle, buildLabeledRow, Button, CloseButton, SegmentedControl, ValueInput,
} from '../../hud/widgets';
import { ObjectPicker } from '../hud/windows/object-picker';
import { ENTITY_GLYPH } from '../marker/marker-identity';
import { baseMarkerSvg, shipMarkerSvg } from '../marker/marker-shapes';
import { clampOverlayPosition } from '../../hud/layout';
import { onViewportChange } from '../../hud/viewport';
import { isCompactViewport } from '../../hud/breakpoints';
import { wireHeaderDrag } from '../../hud/window-drag';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import { getApsisLabelSpec } from '../hud/orbit/orbit-labels';
import type { CollinearPoint } from '../../physics/lagrange';
import { MOON, MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../celestial/solar-system/earth-system';
import { semiMajorFromPeriod } from '../../physics/elements';
import type { PlacementFieldId, PlacementFieldIssue } from './placement-validation';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';
import { bodyGroupsOf, lagrangeSystemItemsOf, orbitingIdsOf, primaryDistanceKm, sunSyncInclinationDeg } from './orbit-form-fields';
import {
  type SliderRow, bindAngleSlider, bindEccentricitySlider, bindRelativeSlider, numberField, setFieldVisible, sliderField,
} from './slider-field';

// ラグランジュ点配置(ハロー/リサジュー)の既定振幅 [km]。
// 副天体ごとに主天体との距離が3桁近く違うため、妥当なオーダーを副天体ごとに別々に持つ。
const HALO_AX_MOON_KM = 8000;
const HALO_AZ_MOON_KM = 5000;
const HALO_AX_EARTH_KM = 200000;
const HALO_AZ_EARTH_KM = 120000;
const HALO_AX_JUPITER_KM = 7000000;
const HALO_AZ_JUPITER_KM = 4000000;

export type ReferenceCelestialBody = string;
type SizeShapeMode = 'apsides' | 'semiMajorEcc' | 'periodEcc';
type PlacementMode = 'elements' | 'lagrange';
type LagrangeOrbitKind = 'halo' | 'lissajous';

// 軌道要素指定のサイズ/形: sizeMode が選んだ組の値だけを持つ。
type EllipticSizeForm =
  | { readonly sizeMode: 'apsides'; readonly peAltKm: number; readonly apAltKm: number }
  | { readonly sizeMode: 'semiMajorEcc'; readonly semiMajorKm: number; readonly eccentricity: number }
  | { readonly sizeMode: 'periodEcc'; readonly periodHours: number; readonly eccentricity: number };

// 軌道要素指定一式: 基準天体・サイズ/形(上記)・向き/位相。
export type ElementsForm = {
  readonly placementMode: 'elements';
  readonly celestialBody: ReferenceCelestialBody;
  readonly incDeg: number;
  readonly raanDeg: number;
  readonly argpDeg: number;
  readonly nuDeg: number;
} & EllipticSizeForm;

// ラグランジュ点指定一式: 軌道種別ごとに持つ振幅が異なる。リサジューは面内・面外の両方を取り、
// ハローは面外だけを取る — ハローの面内振幅は三次の振幅拘束から面外振幅が決める。
export type LagrangeForm = {
  readonly placementMode: 'lagrange';
  readonly lagrangeSecondary: string;
  readonly lagrangePoint: CollinearPoint;
} & (
  | { readonly lagrangeOrbitKind: 'halo'; readonly azKm: number }
  | { readonly lagrangeOrbitKind: 'lissajous'; readonly axKm: number; readonly azKm: number }
);

// 確定時点のフォーム値。placementMode を判別子とし、選ばれた配置方法(・サイズ/形・軌道種別)が
// 実際に使う値だけを持つ。
export type ShipPlacementPreset = 'combat-ship' | 'base-ship';
export type ObjectPlacementSelection = ShipPlacementPreset | Exclude<DynamicEntityKind, 'player' | 'base'>;
export type ObjectPlacerForm = { readonly selection: ObjectPlacementSelection } & (ElementsForm | LagrangeForm);

// open() の事前入力: 'body' は基準天体だけをその値へ合わせる(他のフィールドは前回の値のまま) —
// マップの現在フォーカスを新規配置の初期値にする経路。'selection' は preset/種類だけを合わせる —
// 複製元の軌道要素一式は引き継げない(または引き継ぐと基地の基準天体制約に反する)ときの経路。
// 'form' は preset/種類を selection に固定し、軌道要素一式をその値へ書き換える —
// 軌道要素をそのまま引き継げる複製の経路。
type ObjectPlacerPreset =
  | { readonly kind: 'body'; readonly celestialBody: ReferenceCelestialBody }
  | { readonly kind: 'selection'; readonly selection: ObjectPlacementSelection }
  | { readonly kind: 'form'; readonly selection: ObjectPlacementSelection; readonly form: ElementsForm };

// アイコンはマップ実マーカーと同じ形状(自機=鏃の塗りつぶし、敵機=鏃の中抜き、基地=正七角形)。
const ENTITY_KIND_ITEMS: readonly (readonly [ObjectPlacementSelection, string, string])[] = [
  ['combat-ship', '自機', shipMarkerSvg(true)],
  ['enemy', '敵機', shipMarkerSvg(false)],
  ['ammo', '弾薬', ENTITY_GLYPH.ammo],
  ['fuel', 'RCS燃料', ENTITY_GLYPH.fuel],
  ['base-ship', '基地', baseMarkerSvg()],
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

const LAGRANGE_POINT_ITEMS: readonly (readonly [CollinearPoint, string])[] = [
  ['L1', 'L1'],
  ['L2', 'L2'],
];

const LAGRANGE_ORBIT_KIND_ITEMS: readonly (readonly [LagrangeOrbitKind, string])[] = [
  ['halo', 'ハロー'],
  ['lissajous', 'リサジュー'],
];

// 表に載せた副天体の既定振幅 [km]。
const LAGRANGE_DEFAULT_AMPLITUDE_KM: Partial<Record<string, { ax: number; az: number }>> = {
  moon: { ax: HALO_AX_MOON_KM, az: HALO_AZ_MOON_KM },
  earth: { ax: HALO_AX_EARTH_KM, az: HALO_AZ_EARTH_KM },
  jupiter: { ax: HALO_AX_JUPITER_KM, az: HALO_AZ_JUPITER_KM },
};

// 表に無い天体の既定振幅を主天体間距離から導くときの比。
const AMPLITUDE_AX_RATIO = HALO_AX_MOON_KM / primaryDistanceKm(MOON);
const AMPLITUDE_AZ_RATIO = HALO_AZ_MOON_KM / primaryDistanceKm(MOON);

// 静止軌道の高度 [km]。
const GEO_ALT_KM = (semiMajorFromPeriod(SIDEREAL_DAY, MU_EARTH) - R_EARTH) / 1e3;

const SUN_SYNC_ALT_KM = 700;
const MOON_LOW_ALT_KM = 100;

// 軌道要素指定のサイズ/形プリセット。意味を持つ軌道が基準天体ごとに違うので、天体単位で持つ。
interface SizePreset { readonly label: string; readonly peAltKm: number; readonly apAltKm: number; readonly incDeg?: number }
const PRESETS_BY_BODY: Partial<Record<ReferenceCelestialBody, readonly SizePreset[]>> = {
  earth: [
    { label: '低軌道(LEO)', peAltKm: 400, apAltKm: 400 },
    { label: '静止軌道(GEO)', peAltKm: GEO_ALT_KM, apAltKm: GEO_ALT_KM, incDeg: 0 },
    { label: '太陽同期軌道', peAltKm: SUN_SYNC_ALT_KM, apAltKm: SUN_SYNC_ALT_KM, incDeg: sunSyncInclinationDeg(SUN_SYNC_ALT_KM) },
  ],
  moon: [
    { label: '低軌道', peAltKm: MOON_LOW_ALT_KM, apAltKm: MOON_LOW_ALT_KM },
  ],
};

// 高度・半長軸の基準値の下限(km): 一度のドラッグでこの4倍まで戻せる値を床に置く。
const ALTITUDE_REF_FLOOR_KM = 100;
// 周期の基準値の下限(h): 高度と同じ床を使うと大きすぎて操作不能になるため、周期のオーダーに合わせる。
const PERIOD_REF_FLOOR_HOURS = 0.1;

export class ObjectPlacerPanel implements OverlayHandle {
  onConfirm: ((name: string, form: ObjectPlacerForm) => void) | null = null;

  private _isOpen = false;
  get isOpen(): boolean { return this._isOpen; }

  private readonly panel: HTMLElement;
  private readonly entityKind: SegmentedControl<ObjectPlacementSelection>;
  private readonly placementMode: SegmentedControl<PlacementMode>;
  private readonly placementGroups: Record<PlacementMode, HTMLElement>;
  private readonly celestialBody: ObjectPicker<ReferenceCelestialBody>;
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
  private readonly lagrangeSecondary: ObjectPicker<string>;
  private readonly lagrangePoint: SegmentedControl<CollinearPoint>;
  private readonly lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;
  private readonly refreshPresets: () => void;
  private readonly celestialBodyItems: readonly (readonly [ReferenceCelestialBody, string])[];
  // 基地は敵の射程となる惑星近傍を避けるため、軌道要素指定の基準天体を月だけに絞った選択肢。
  private readonly baseCelestialBodyItems: readonly (readonly [ReferenceCelestialBody, string])[];
  private readonly lagrangeSystemItems: readonly (readonly [string, string])[];
  private readonly issueList: HTMLElement;
  private issueRows: readonly HTMLElement[] = [];
  private lastIssueKey = '';

  private entityKindValue: ObjectPlacementSelection = 'combat-ship';
  private placementModeValue: PlacementMode = 'elements';
  private celestialBodyValue: ReferenceCelestialBody = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';
  private lagrangeSecondaryValue: string = 'moon';
  private lagrangePointValue: CollinearPoint = 'L1';
  private lagrangeOrbitKindValue: LagrangeOrbitKind = 'halo';
  private readonly unsubscribeViewport: () => void;

  // 物体配置パネルの DOM を組み立てる。基準天体・ラグランジュ系の選択肢は celestialSystem が
  // 実際に持つ天体から組む。要素は開くまで DOM へ挿さず、overlayManager が window の層へ置く。
  constructor(
    private readonly celestialSystem: CelestialSystem,
    private readonly overlayManager: OverlayManager,
  ) {
    const orbitingIds = orbitingIdsOf(celestialSystem);
    this.celestialBodyItems = orbitingIds.map((id) => [id, celestialSystem.nameOf(id)] as const);
    this.baseCelestialBodyItems = this.celestialBodyItems.filter(([id]) => id === 'moon');
    this.lagrangeSystemItems = lagrangeSystemItemsOf(celestialSystem, orbitingIds);

    this.panel = document.createElement('div');
    this.panel.id = 'hud-object-placer';
    this.panel.className = 'panel hidden editorial-control-sheet';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const header = document.createElement('div');
    header.className = 'panel-shell-head editorial-panel-head';
    const code = document.createElement('span');
    code.className = 'ui-section-code';
    code.setAttribute('aria-hidden', 'true');
    code.textContent = 'INS';
    const title = document.createElement('h3');
    title.className = 'editorial-panel-title';
    title.textContent = 'OBJECT INSERT';
    header.append(code, title);
    header.appendChild(new CloseButton(() => this.close()).element);
    this.panel.appendChild(header);
    // ヘッダーを掴んで動かせる浮遊ウィンドウにする。compact の下端シート中はドラッグしない。
    wireHeaderDrag(header, {
      position: () => ({ x: this.panel.offsetLeft, y: this.panel.offsetTop }),
      moveTo: (x, y) => this.moveTo(x, y),
      enabled: () => this._isOpen && !isCompactViewport(),
    });
    this.unsubscribeViewport = onViewportChange(() => {
      if (this._isOpen) this.moveTo(this.panel.offsetLeft, this.panel.offsetTop);
    });

    this.entityKind = new SegmentedControl('種類', ENTITY_KIND_ITEMS, (v) => this.selectEntityKind(v));
    this.entityKind.setSelected(this.entityKindValue);
    this.panel.appendChild(this.entityKind.element);

    this.placementMode = new SegmentedControl('配置方法', PLACEMENT_MODE_ITEMS, (v) => this.selectPlacementMode(v));
    this.panel.appendChild(this.placementMode.element);

    const elements = this.buildElementsGroup();
    this.celestialBody = elements.celestialBody;
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
    this.issueList.className = 'issue-list ui-status-note ui-status-note--danger hidden';
    this.panel.appendChild(this.issueList);

    this.buildButtonsAndKeybinds();
  }

  // 軌道要素指定の一式(基準天体・サイズ/形・向き・位相)を1つの div にまとめて返す。返った
  // sizeGroups を this.sizeGroups へ代入してから selectSizeMode を呼ばないと、表示が揃わない。
  private buildElementsGroup(): {
    element: HTMLElement;
    celestialBody: ObjectPicker<ReferenceCelestialBody>;
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
    const celestialBodyControl = new ObjectPicker<ReferenceCelestialBody>('基準天体', (v) => {
      this.celestialBodyValue = v;
      celestialBodyControl.setSelected(v);
      this.refreshPresets();
    }, this.overlayManager);
    celestialBodyControl.setGroups(bodyGroupsOf(this.celestialSystem, this.celestialBodyItems, this.celestialBodyValue));
    celestialBodyControl.setSelected(this.celestialBodyValue);
    elementsGroup.appendChild(celestialBodyControl.element);

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

    const presetRow = document.createElement('div');
    presetRow.className = 'w-group preset-row';
    // 基準天体の現在値に合わせて、入力欄のラベルとプリセット候補を組み直す。
    // celestialBodyValue を書き換えたら必ず呼ぶ。
    const refreshPresets = (): void => {
      // 近地点/遠地点の呼び名は基準天体で変わる。
      const peSpec = getApsisLabelSpec('pe', this.celestialBodyValue);
      const apSpec = getApsisLabelSpec('ap', this.celestialBodyValue);
      peAlt.setLabel(`${peSpec.nameJa}高度 [km]`);
      apAlt.setLabel(`${apSpec.nameJa}高度 [km]`);
      sizeMode.setItems([
        ['apsides', `${peSpec.nameJa}+${apSpec.nameJa}`],
        ['semiMajorEcc', '半長軸+離心率'],
        ['periodEcc', '周期+離心率'],
      ]);
      // プリセットはその天体に意味を持つものだけを出し、無ければ行ごと隠す。
      presetRow.innerHTML = '';
      const presets = PRESETS_BY_BODY[this.celestialBodyValue] ?? [];
      presetRow.classList.toggle('hidden', presets.length === 0);
      if (presets.length === 0) return;
      presetRow.appendChild(buildGroupTitle('プリセット'));
      for (const preset of presets) {
        const btn = new Button(preset.label, () => {
          this.setSliderValue(peAlt, preset.peAltKm);
          this.setSliderValue(apAlt, preset.apAltKm);
          if (preset.incDeg !== undefined) this.setSliderValue(inc, preset.incDeg);
          this.selectSizeMode('apsides');
        });
        presetRow.appendChild(btn.element);
      }
    };

    elementsGroup.appendChild(presetRow);
    elementsGroup.appendChild(sizeMode.element);
    elementsGroup.appendChild(apsidesGroup);
    elementsGroup.appendChild(semiMajorGroup);
    elementsGroup.appendChild(periodGroup);

    // 向き(i/Ω/ω)と位相(ν)は、サイズ/形の選択によらず常に有効。
    const inc = sliderField(elementsGroup, '傾斜角 i [deg]', 0, 1, 0, 180);
    bindAngleSlider(inc, 180);
    const raan = sliderField(elementsGroup, '昇交点赤経 Ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(raan, 360);
    const argp = sliderField(elementsGroup, '近点引数 ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(argp, 360);
    const nu = sliderField(elementsGroup, '真近点角 ν [deg]', 0, 1, 0, 360);
    bindAngleSlider(nu, 360);

    refreshPresets();

    return { element: elementsGroup, celestialBody: celestialBodyControl, sizeMode, sizeGroups, peAlt, apAlt, semiMajor, eccSemiMajor, period, eccPeriod, inc, raan, argp, nu, refreshPresets };
  }

  // ラグランジュ点指定(ハロー/リサジュー)の一式を1つの div にまとめて返す。
  private buildLagrangeGroup(): {
    element: HTMLElement;
    lagrangeSecondary: ObjectPicker<string>;
    lagrangePoint: SegmentedControl<CollinearPoint>;
    lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
    libAx: HTMLInputElement;
    libAz: HTMLInputElement;
  } {
    const lagrangeGroup = document.createElement('div');
    const lagrangeSecondary = new ObjectPicker<string>(
      '系', (v) => this.selectLagrangeSecondary(v), this.overlayManager,
    );
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
    const defaultAmp = this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue);
    const libAx = numberField(lagrangeGroup, '面内振幅 ax [km]', defaultAmp.ax, 100, 0);
    const lagrangeOrbitKind = new SegmentedControl('軌道種別', LAGRANGE_ORBIT_KIND_ITEMS, (v) => {
      this.lagrangeOrbitKindValue = v;
      this.lagrangeOrbitKind.setSelected(v);
      setFieldVisible(libAx, v === 'lissajous');
      libAx.value = String(this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue).ax);
    });
    lagrangeGroup.insertBefore(lagrangeOrbitKind.element, libAx.parentElement);
    const libAz = numberField(lagrangeGroup, '面外振幅 az [km]', defaultAmp.az, 100, 0);
    lagrangeOrbitKind.setSelected(this.lagrangeOrbitKindValue);
    setFieldVisible(libAx, this.lagrangeOrbitKindValue === 'lissajous');

    return { element: lagrangeGroup, lagrangeSecondary, lagrangePoint, lagrangeOrbitKind, libAx, libAz };
  }

  // 名称行(ラベル + テキスト入力)を組み立てて返す。
  private buildNameRow(): { element: HTMLElement; nameInput: HTMLInputElement } {
    const nameRow = buildLabeledRow('名称');
    const nameField = new ValueInput({ type: 'text', placeholder: '空欄で自動命名' }, () => {});
    nameRow.appendChild(nameField.element);
    return { element: nameRow, nameInput: nameField.element };
  }

  // 配置ボタンを this.panel に追加する。Enter でも確定できるので、ラベルに [Enter] を出す。
  private buildButtonsAndKeybinds(): void {
    const btnRow = document.createElement('div');
    btnRow.className = 'shipplacer-btn-row';
    btnRow.appendChild(new Button('配置 [Enter]', () => this.confirm()).element);
    this.panel.appendChild(btnRow);
  }

// 種類を切り替える。基地は月基準の軌道要素かラグランジュ点指定でしか設置できない
// (placement-validation.ts の validateBaseReferenceFields と対応)ので、基準天体の選択肢を
// 月だけに絞り、月以外が選ばれていたら月へ寄せ直す。基地以外へ戻したら選択肢も元に戻す。
  private selectEntityKind(v: ObjectPlacementSelection): void {
    this.entityKindValue = v;
    this.entityKind.setSelected(v);
    if (v === 'base-ship') {
      if (this.celestialBodyValue !== 'moon') this.celestialBodyValue = 'moon';
      this.celestialBody.setGroups([{ label: '', items: this.baseCelestialBodyItems }]);
    } else {
      this.celestialBody.setGroups(bodyGroupsOf(this.celestialSystem, this.celestialBodyItems, this.celestialBodyValue));
    }
    this.celestialBody.setSelected(this.celestialBodyValue);
    this.refreshPresets();
  }

  // サイズ/形の入力組を切り替え、選ばれた組以外を隠す。
  private selectSizeMode(mode: SizeShapeMode): void {
    this.sizeModeValue = mode;
    this.sizeMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.sizeGroups) as [SizeShapeMode, HTMLElement][]) {
      group.classList.toggle('hidden', key !== mode);
    }
  }

  // 配置方法(軌道要素/ラグランジュ点)を切り替え、選ばれなかった側を隠す。
  private selectPlacementMode(mode: PlacementMode): void {
    this.placementModeValue = mode;
    this.placementMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.placementGroups) as [PlacementMode, HTMLElement][]) {
      group.classList.toggle('hidden', key !== mode);
    }
  }

  // 副天体を切り替え、面内/面外振幅の既定値をその系のオーダーへ更新する。
  private selectLagrangeSecondary(secondary: string): void {
    this.lagrangeSecondaryValue = secondary;
    this.lagrangeSecondary.setSelected(secondary);
    const amp = this.defaultLagrangeAmplitude(secondary);
    this.libAx.value = String(amp.ax);
    this.libAz.value = String(amp.az);
  }

  // 副天体ごとの面内/面外振幅の既定値 [km]。
  private defaultLagrangeAmplitude(secondary: string): { ax: number; az: number } {
    const listed = LAGRANGE_DEFAULT_AMPLITUDE_KM[secondary];
    if (listed !== undefined) return listed;
    const distanceKm = primaryDistanceKm(this.celestialSystem.motionOf(secondary).def);
    return { ax: distanceKm * AMPLITUDE_AX_RATIO, az: distanceKm * AMPLITUDE_AZ_RATIO };
  }

  // フォームの現在値を読み、onConfirm へ通知する。
  private confirm(): void {
    const name = this.nameInput.value.trim();
    const form = this.getForm();
    this.onConfirm?.(name, form);
    this.close();
  }

  // 現在のフォームの値を、選ばれた組・種別が使う値だけを読み取って ObjectPlacerForm へ組む。
  getForm(): ObjectPlacerForm {
    const selection = this.entityKindValue;
    // ラグランジュ点指定: 軌道種別が使う振幅だけを読む。
    if (this.placementModeValue === 'lagrange') {
      const common = {
        placementMode: 'lagrange' as const,
        lagrangeSecondary: this.lagrangeSecondaryValue,
        lagrangePoint: this.lagrangePointValue,
      };
      if (this.lagrangeOrbitKindValue === 'halo') {
        return { selection, ...common, lagrangeOrbitKind: 'halo', azKm: Number(this.libAz.value) };
      }
      return {
        selection, ...common, lagrangeOrbitKind: 'lissajous',
        axKm: Number(this.libAx.value), azKm: Number(this.libAz.value),
      };
    }
    // 軌道要素指定: 向き/位相は常に読み、サイズ/形は選ばれた組の2欄だけを読む。
    const common = {
      placementMode: 'elements' as const,
      celestialBody: this.celestialBodyValue,
      incDeg: Number(this.inc.input.value),
      raanDeg: Number(this.raan.input.value),
      argpDeg: Number(this.argp.input.value),
      nuDeg: Number(this.nu.input.value),
    };
    if (this.sizeModeValue === 'apsides') {
      return {
        selection, ...common, sizeMode: 'apsides',
        peAltKm: Number(this.peAlt.input.value), apAltKm: Number(this.apAlt.input.value),
      };
    } else if (this.sizeModeValue === 'semiMajorEcc') {
      return {
        selection, ...common, sizeMode: 'semiMajorEcc',
        semiMajorKm: Number(this.semiMajor.input.value), eccentricity: Number(this.eccSemiMajor.input.value),
      };
    } else {
      return {
        selection, ...common, sizeMode: 'periodEcc',
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
      case 'referenceCelestialBody': return this.celestialBody.element;
      case 'inPlaneAmplitude': return this.libAx.parentElement as HTMLElement;
      case 'outOfPlaneAmplitude': return this.libAz.parentElement as HTMLElement;
    }
  }

  // 検証結果を差分反映する。前回と同じ内容なら DOM に触らない(該当欄の枠色とメッセージ一覧を
  // まとめて持つ)。
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
    this.issueList.classList.toggle('hidden', issues.length === 0);
  }

  // パネルを開く。preset があればその種別ぶんだけ事前入力してから開く。
  open(preset?: ObjectPlacerPreset): void {
    // 事前入力の範囲は preset の種別で決まる。
    if (preset?.kind === 'form') {
      this.selectEntityKind(preset.selection);
      this.applyElementsForm(preset.form);
    } else if (preset?.kind === 'selection') {
      this.selectEntityKind(preset.selection);
    } else if (preset?.kind === 'body') {
      const allowed = this.entityKindValue === 'base-ship' ? this.baseCelestialBodyItems : this.celestialBodyItems;
      if (allowed.some(([id]) => id === preset.celestialBody)) {
        this.celestialBodyValue = preset.celestialBody;
        this.celestialBody.setSelected(this.celestialBodyValue);
        this.refreshPresets();
      }
    }
    this._isOpen = true;
    this.panel.classList.remove('hidden');
    this.overlayManager.open('object-placer', this.panel, this, {
      kind: 'window', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false,
    });
    // 開くたび右上(上部クロームの下)の既定位置から始める。
    this.placeAtDefault();
  }

  // 開いたときの既定位置へ置く。CSS の右上アンカーへ戻してから、実寸を測って left/top に
  // 焼き付ける(以後はドラッグ・クランプが left/top だけを扱えるようにするため)。
  private placeAtDefault(): void {
    if (isCompactViewport()) {
      this.moveTo(0, 0);
      return;
    }
    this.panel.style.left = '';
    this.panel.style.right = '';
    const rect = this.panel.getBoundingClientRect();
    this.moveTo(rect.left, rect.top);
  }

  // 要求座標をビューポート内へクランプして配置する。compact では下端シートの位置を CSS へ
  // 委ねる(前回の非 compact 時の left/top/right が残っていれば消す)。
  private moveTo(clientX: number, clientY: number): void {
    if (isCompactViewport()) {
      this.panel.style.left = '';
      this.panel.style.top = '';
      this.panel.style.right = '';
      return;
    }
    // CSS 側の既定 right と両方効くのを避けるため、left へ焼き付けるなら右アンカーは無効にする。
    this.panel.style.right = 'auto';
    const rect = this.panel.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.panel.style.left = `${pos.x}px`;
    this.panel.style.top = `${pos.y}px`;
  }

  // パネルを閉じ、オーバーレイの登録も外す。開いていなければ何も起きない。
  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.panel.classList.add('hidden');
    this.overlayManager.close('object-placer');
  }

  contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // パネル DOM と登録を取り除き、基準天体・系の ObjectPicker もあわせて片付ける。
  dispose(): void {
    this.close();
    this.unsubscribeViewport();
    this.panel.remove();
    this.celestialBody.dispose();
    this.lagrangeSecondary.dispose();
  }

  // 項目ショートカットを受ける。Enter なら確定して true を返す。
  handleShortcut(code: string): boolean {
    if (code !== 'Enter') return false;
    this.confirm();
    return true;
  }

  // SliderRow へ値を書き込む。input イベントの発火と基準値の取り直しまで含む —
  // rebase を欠くとつまみの位置が新しい値と食い違う。
  private setSliderValue(row: SliderRow, value: number): void {
    row.input.value = String(value);
    row.input.dispatchEvent(new Event('input'));
    row.rebase?.();
  }

  // 軌道要素一式をフォームへ書き込む。form.celestialBody が現在の種類で選べる基準天体である
  // ことを前提にする。
  private applyElementsForm(form: ElementsForm): void {
    // まず表示する入力組を form に合わせる。
    this.selectPlacementMode('elements');
    this.celestialBodyValue = form.celestialBody;
    this.celestialBody.setSelected(this.celestialBodyValue);
    this.refreshPresets();
    this.selectSizeMode(form.sizeMode);

    // サイズ/形は選ばれた組の2欄だけを書く。
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
    // 向きと位相は組によらず常に書く。
    this.setSliderValue(this.inc, form.incDeg);
    this.setSliderValue(this.raan, form.raanDeg);
    this.setSliderValue(this.argp, form.argpDeg);
    this.setSliderValue(this.nu, form.nuDeg);
  }
}
