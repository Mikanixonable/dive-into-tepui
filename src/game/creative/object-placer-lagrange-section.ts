// 物体配置パネルの「ラグランジュ点」セクション: 系(主天体-副天体)・共線点・
// 軌道種別(ハロー/リサジュー)と振幅の入力欄を持つ。振幅の既定値は副天体ごとの
// オーダーで決める。
import { SegmentedControl } from '../../hud-kit/widgets';
import { ObjectPicker } from '../../hud-kit/windows/object-picker';
import { MOON } from '../celestial/solar-system/earth-system';
import { lagrangeSystemItemsOf, orbitingIdsOf, primaryDistanceKm } from './orbit-form-fields';
import { numberField, setFieldVisible } from './slider-field';
import type { OverlayManager } from '../../hud-kit/overlay-manager';
import type { CollinearPoint } from '../../physics/lagrange';
import type { PlacementFieldId } from './placement-validation';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { LagrangeForm, PlacementSection } from './object-placer-panel';

type LagrangeOrbitKind = 'halo' | 'lissajous';

// ラグランジュ点配置(ハロー/リサジュー)の既定振幅 [km]。
// 副天体ごとに主天体との距離が3桁近く違うため、妥当なオーダーを副天体ごとに別々に持つ。
const HALO_AX_MOON_KM = 8000;
const HALO_AZ_MOON_KM = 5000;
const HALO_AX_EARTH_KM = 200000;
const HALO_AZ_EARTH_KM = 120000;
const HALO_AX_JUPITER_KM = 7000000;
const HALO_AZ_JUPITER_KM = 4000000;

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

export class ObjectPlacerLagrangeSection implements PlacementSection {
  public readonly element: HTMLElement;
  private readonly lagrangeSecondary: ObjectPicker<string>;
  private readonly lagrangePoint: SegmentedControl<CollinearPoint>;
  private readonly lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;

  private lagrangeSecondaryValue: string = 'moon';
  private lagrangePointValue: CollinearPoint = 'L1';
  private lagrangeOrbitKindValue: LagrangeOrbitKind = 'halo';

  // セクションの DOM を組み立てる。系の選択肢は celestialSystem が実際に持ち、かつ
  // 共線点が行き先として意味を持つ副天体から組む。
  public constructor(private readonly celestialSystem: CelestialSystem, overlayManager: OverlayManager) {
    this.element = document.createElement('div');
    const lagrangeSystemItems = lagrangeSystemItemsOf(celestialSystem, orbitingIdsOf(celestialSystem));
    this.lagrangeSecondary = new ObjectPicker<string>(
      '系', (v) => this.selectLagrangeSecondary(v), overlayManager,
    );
    this.lagrangeSecondary.setGroups([{ label: '', items: lagrangeSystemItems }]);
    this.lagrangeSecondary.setSelected(this.lagrangeSecondaryValue);
    this.element.appendChild(this.lagrangeSecondary.element);
    this.lagrangePoint = new SegmentedControl('点', LAGRANGE_POINT_ITEMS, (v) => {
      this.lagrangePointValue = v;
      this.lagrangePoint.setSelected(v);
    });
    this.lagrangePoint.setSelected(this.lagrangePointValue);
    this.element.appendChild(this.lagrangePoint.element);
    // ハローの面内振幅は面外振幅から三次の振幅拘束で決まるので、入力欄自体を出さない。
    const defaultAmp = this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue);
    this.libAx = numberField(this.element, '面内振幅 ax [km]', defaultAmp.ax, 100, 0);
    this.lagrangeOrbitKind = new SegmentedControl('軌道種別', LAGRANGE_ORBIT_KIND_ITEMS, (v) => {
      this.lagrangeOrbitKindValue = v;
      this.lagrangeOrbitKind.setSelected(v);
      setFieldVisible(this.libAx, v === 'lissajous');
      this.libAx.value = String(this.defaultLagrangeAmplitude(this.lagrangeSecondaryValue).ax);
    });
    this.element.insertBefore(this.lagrangeOrbitKind.element, this.libAx.parentElement);
    this.libAz = numberField(this.element, '面外振幅 az [km]', defaultAmp.az, 100, 0);
    this.lagrangeOrbitKind.setSelected(this.lagrangeOrbitKindValue);
    setFieldVisible(this.libAx, this.lagrangeOrbitKindValue === 'lissajous');
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

  // セクションの入力欄の現在値を、選ばれた軌道種別が使う振幅だけ読み取って組む。
  public readForm(): LagrangeForm {
    const common = {
      placementMode: 'lagrange' as const,
      lagrangeSecondary: this.lagrangeSecondaryValue,
      lagrangePoint: this.lagrangePointValue,
    };
    if (this.lagrangeOrbitKindValue === 'halo') {
      return { ...common, lagrangeOrbitKind: 'halo', azKm: Number(this.libAz.value) };
    }
    return {
      ...common, lagrangeOrbitKind: 'lissajous',
      axKm: Number(this.libAx.value), azKm: Number(this.libAz.value),
    };
  }

  // PlacementFieldId のうちこのセクションが持つ欄を、その行要素へ対応させる。
  public fieldRowFor(field: PlacementFieldId): HTMLElement | null {
    switch (field) {
      case 'inPlaneAmplitude': return this.libAx.parentElement as HTMLElement;
      case 'outOfPlaneAmplitude': return this.libAz.parentElement as HTMLElement;
      default: return null;
    }
  }

  // セクションが作った ObjectPicker もあわせて片付ける。
  public dispose(): void {
    this.lagrangeSecondary.dispose();
  }
}
