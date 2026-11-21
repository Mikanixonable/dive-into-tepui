// 物体配置パネルの「軌道要素」セクション: 基準天体の選択と、サイズ/形(近遠地点・
// 半長軸+離心率・周期+離心率の3組から選んだ1組)・向き/位相の入力欄を持つ。
// プリセット行には基準天体に意味を持つものだけを出す。
import {
  buildGroupTitle, Button, SegmentedControl,
} from '../../hud-kit/widgets';
import { ObjectPicker } from '../../hud-kit/windows/object-picker';
import { getApsisLabelSpec } from '../hud/orbit/orbit-labels';
import { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../celestial/solar-system/earth-system';
import { semiMajorFromPeriod } from '../../physics/elements';
import { bodyGroupsOf, orbitingIdsOf, sunSyncInclinationDeg } from './orbit-form-fields';
import {
  bindAngleSlider, bindEccentricitySlider, bindRelativeSlider, setSliderValue, sliderField, type SliderRow,
} from './slider-field';
import type { OverlayManager } from '../../hud-kit/overlay-manager';
import type { PlacementFieldId } from './placement-validation';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { ElementsForm, PlacementSection, ReferenceCelestialBody } from './object-placer-panel';

type SizeShapeMode = 'apsides' | 'semiMajorEcc' | 'periodEcc';

const SIZE_MODE_ITEMS: readonly (readonly [SizeShapeMode, string])[] = [
  ['apsides', '近地点+遠地点'],
  ['semiMajorEcc', '半長軸+離心率'],
  ['periodEcc', '周期+離心率'],
];

// 静止軌道の高度 [km]。
const GEO_ALT_KM = (semiMajorFromPeriod(SIDEREAL_DAY, MU_EARTH) - R_EARTH) / 1e3;

const SUN_SYNC_ALT_KM = 700;
const MOON_LOW_ALT_KM = 100;

// サイズ/形プリセット。意味を持つ軌道が基準天体ごとに違うので、天体単位で持つ。
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

export class ObjectPlacerElementsSection implements PlacementSection {
  public readonly element: HTMLElement;
  private readonly celestialBody: ObjectPicker<ReferenceCelestialBody>;
  private readonly celestialBodyItems: readonly (readonly [ReferenceCelestialBody, string])[];
  private readonly sizeMode: SegmentedControl<SizeShapeMode>;
  private readonly sizeGroups: Record<SizeShapeMode, HTMLElement>;
  private readonly presetRow: HTMLElement;
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

  private celestialBodyValue: ReferenceCelestialBody = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';

  // セクションの DOM を組み立てる。基準天体の選択肢は celestialSystem が実際に持つ
  // 公転天体から組む。
  public constructor(celestialSystem: CelestialSystem, overlayManager: OverlayManager) {
    this.element = document.createElement('div');
    this.celestialBodyItems = orbitingIdsOf(celestialSystem).map((id) => [id, celestialSystem.nameOf(id)] as const);
    this.celestialBody = new ObjectPicker<ReferenceCelestialBody>('基準天体', (v) => {
      this.celestialBodyValue = v;
      this.celestialBody.setSelected(v);
      this.refreshPresets();
    }, overlayManager);
    this.celestialBody.setGroups(bodyGroupsOf(celestialSystem, this.celestialBodyItems, this.celestialBodyValue));
    this.celestialBody.setSelected(this.celestialBodyValue);
    this.element.appendChild(this.celestialBody.element);

    this.sizeMode = new SegmentedControl('サイズ/形', SIZE_MODE_ITEMS, (v) => this.selectSizeMode(v));

    const apsidesGroup = document.createElement('div');
    this.peAlt = sliderField(apsidesGroup, '近地点高度 [km]', 400, 10, 0);
    bindRelativeSlider(this.peAlt, ALTITUDE_REF_FLOOR_KM);
    this.apAlt = sliderField(apsidesGroup, '遠地点高度 [km]', 400, 10, 0);
    bindRelativeSlider(this.apAlt, ALTITUDE_REF_FLOOR_KM);

    const semiMajorGroup = document.createElement('div');
    this.semiMajor = sliderField(semiMajorGroup, '半長軸 [km]', 6771, 10, 0);
    bindRelativeSlider(this.semiMajor, ALTITUDE_REF_FLOOR_KM);
    this.eccSemiMajor = sliderField(semiMajorGroup, '離心率', 0, 0.01, 0, 0.99);
    bindEccentricitySlider(this.eccSemiMajor);

    const periodGroup = document.createElement('div');
    this.period = sliderField(periodGroup, '周期 [h]', 1.54, 0.01, 0);
    bindRelativeSlider(this.period, PERIOD_REF_FLOOR_HOURS);
    this.eccPeriod = sliderField(periodGroup, '離心率', 0, 0.01, 0, 0.99);
    bindEccentricitySlider(this.eccPeriod);

    this.sizeGroups = { apsides: apsidesGroup, semiMajorEcc: semiMajorGroup, periodEcc: periodGroup };

    this.presetRow = document.createElement('div');
    this.presetRow.className = 'w-group preset-row';

    this.element.appendChild(this.presetRow);
    this.element.appendChild(this.sizeMode.element);
    this.element.appendChild(apsidesGroup);
    this.element.appendChild(semiMajorGroup);
    this.element.appendChild(periodGroup);

    // 向き(i/Ω/ω)と位相(ν)は、サイズ/形の選択によらず常に有効。
    this.inc = sliderField(this.element, '傾斜角 i [deg]', 0, 1, 0, 180);
    bindAngleSlider(this.inc, 180);
    this.raan = sliderField(this.element, '昇交点赤経 Ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(this.raan, 360);
    this.argp = sliderField(this.element, '近点引数 ω [deg]', 0, 1, 0, 360);
    bindAngleSlider(this.argp, 360);
    this.nu = sliderField(this.element, '真近点角 ν [deg]', 0, 1, 0, 360);
    bindAngleSlider(this.nu, 360);

    this.refreshPresets();
    this.selectSizeMode(this.sizeModeValue);
  }

  // 基準天体を id へ切り替える。基準天体になれない(候補に無い) id なら何も触らず
  // false を返す。
  public selectCelestialBody(id: ReferenceCelestialBody): boolean {
    if (!this.celestialBodyItems.some(([itemId]) => itemId === id)) return false;
    this.celestialBodyValue = id;
    this.celestialBody.setSelected(this.celestialBodyValue);
    this.refreshPresets();
    return true;
  }

  // 基準天体の現在値に合わせて、入力欄のラベルとプリセット候補を組み直す。
  // celestialBodyValue を書き換えたら必ず呼ぶ。
  private refreshPresets(): void {
    // 近地点/遠地点の呼び名は基準天体で変わる。
    const peSpec = getApsisLabelSpec('pe', this.celestialBodyValue);
    const apSpec = getApsisLabelSpec('ap', this.celestialBodyValue);
    this.peAlt.setLabel(`${peSpec.nameJa}高度 [km]`);
    this.apAlt.setLabel(`${apSpec.nameJa}高度 [km]`);
    this.sizeMode.setItems([
      ['apsides', `${peSpec.nameJa}+${apSpec.nameJa}`],
      ['semiMajorEcc', '半長軸+離心率'],
      ['periodEcc', '周期+離心率'],
    ]);
    // プリセットはその天体に意味を持つものだけを出し、無ければ行ごと隠す。
    this.presetRow.innerHTML = '';
    const presets = PRESETS_BY_BODY[this.celestialBodyValue] ?? [];
    this.presetRow.classList.toggle('hidden', presets.length === 0);
    if (presets.length === 0) return;
    this.presetRow.appendChild(buildGroupTitle('プリセット'));
    for (const preset of presets) {
      const btn = new Button(preset.label, () => {
        setSliderValue(this.peAlt, preset.peAltKm);
        setSliderValue(this.apAlt, preset.apAltKm);
        if (preset.incDeg !== undefined) setSliderValue(this.inc, preset.incDeg);
        this.selectSizeMode('apsides');
      });
      this.presetRow.appendChild(btn.element);
    }
  }

  // サイズ/形の入力組を切り替え、選ばれた組以外を隠す。
  private selectSizeMode(mode: SizeShapeMode): void {
    this.sizeModeValue = mode;
    this.sizeMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.sizeGroups) as [SizeShapeMode, HTMLElement][]) {
      group.classList.toggle('hidden', key !== mode);
    }
  }

  // セクションの入力欄の現在値を、選ばれたサイズ/形の組が使う値だけ読み取って組む。
  // 向き/位相は常に読む。
  public readForm(): ElementsForm {
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
        ...common, sizeMode: 'apsides',
        peAltKm: Number(this.peAlt.input.value), apAltKm: Number(this.apAlt.input.value),
      };
    } else if (this.sizeModeValue === 'semiMajorEcc') {
      return {
        ...common, sizeMode: 'semiMajorEcc',
        semiMajorKm: Number(this.semiMajor.input.value), eccentricity: Number(this.eccSemiMajor.input.value),
      };
    } else {
      return {
        ...common, sizeMode: 'periodEcc',
        periodHours: Number(this.period.input.value), eccentricity: Number(this.eccPeriod.input.value),
      };
    }
  }

  // PlacementFieldId のうちこのセクションが持つ欄を、その行要素へ対応させる。
  // 離心率は sizeMode が選んだ組の入力欄だけが対象になる(もう一方は非表示なので指しても意味がない)。
  public fieldRowFor(field: PlacementFieldId): HTMLElement | null {
    switch (field) {
      case 'periapsisAltitude': return this.peAlt.element;
      case 'apoapsisAltitude': return this.apAlt.element;
      case 'semiMajorAxis': return this.semiMajor.element;
      case 'period': return this.period.element;
      case 'eccentricity':
        return this.sizeModeValue === 'semiMajorEcc' ? this.eccSemiMajor.element
          : this.sizeModeValue === 'periodEcc' ? this.eccPeriod.element : null;
      case 'inclination': return this.inc.element;
      case 'raan': return this.raan.element;
      case 'argumentOfPeriapsis': return this.argp.element;
      case 'trueAnomaly': return this.nu.element;
      default: return null;
    }
  }

  // 軌道要素一式をフォームへ書き込む。form.celestialBody が登録されている公転天体である
  // ことを前提にする。
  public applyForm(form: ElementsForm): void {
    // まず表示する入力組を form に合わせる。
    this.celestialBodyValue = form.celestialBody;
    this.celestialBody.setSelected(this.celestialBodyValue);
    this.refreshPresets();
    this.selectSizeMode(form.sizeMode);

    // サイズ/形は選ばれた組の2欄だけを書く。
    if (form.sizeMode === 'apsides') {
      setSliderValue(this.peAlt, form.peAltKm);
      setSliderValue(this.apAlt, form.apAltKm);
    } else if (form.sizeMode === 'semiMajorEcc') {
      setSliderValue(this.semiMajor, form.semiMajorKm);
      setSliderValue(this.eccSemiMajor, form.eccentricity);
    } else {
      setSliderValue(this.period, form.periodHours);
      setSliderValue(this.eccPeriod, form.eccentricity);
    }
    // 向きと位相は組によらず常に書く。
    setSliderValue(this.inc, form.incDeg);
    setSliderValue(this.raan, form.raanDeg);
    setSliderValue(this.argp, form.argpDeg);
    setSliderValue(this.nu, form.nuDeg);
  }

  // セクションが作った ObjectPicker もあわせて片付ける。
  public dispose(): void {
    this.celestialBody.dispose();
  }
}
