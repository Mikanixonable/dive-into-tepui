// クリエイティブモードの「艦艇配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で1隻分の ShipPlacerForm を通知する。
// 値から KinematicState を組み立てるのは物理側(stateFromOrbitalElements/haloState/lissajousState)の
// 仕事なので、ここでは行わない。
import { SegmentedControl, hudButton } from '../hud/buttons';
import { ATTRACTOR_NAMES } from '../hud/frame-labels';
import { CollinearPoint } from '../../physics/halo';
import { AttractorId } from '../../physics/attractor';
import { bodyDef, SOLAR_SYSTEM } from '../../physics/solar-system';
import type { OrbitingId } from '../../physics/attractor';
import * as C from '../const';

export type ObjectType = 'player' | 'enemy' | 'ammo' | 'base';
export type ReferenceAttractor = AttractorId;
export type SizeShapeMode = 'apsides' | 'semiMajorEcc' | 'periodEcc';
export type PlacementMode = 'elements' | 'lagrange';
export type LagrangeOrbitKind = 'halo' | 'lissajous';

// 確定時点のフォーム全値。placementMode が 'elements' なら sizeMode が選んだ組(残りは無視して
// よい)、'lagrange' ならラグランジュ点側の値を使う — 両方まとめて渡し、どちらを使うかは
// 確定側(CreativeStage)が placementMode を見て決める。
export interface ShipPlacerForm {
  readonly objectType: ObjectType;
  readonly placementMode: PlacementMode;
  readonly attractor: ReferenceAttractor;
  readonly sizeMode: SizeShapeMode;
  readonly peAltKm: number;
  readonly apAltKm: number;
  readonly semiMajorKm: number;
  readonly eccentricity: number;
  readonly periodHours: number;
  readonly incDeg: number;
  readonly raanDeg: number;
  readonly argpDeg: number;
  readonly nuDeg: number;
  readonly lagrangeSecondary: OrbitingId;
  readonly lagrangePoint: CollinearPoint;
  readonly lagrangeOrbitKind: LagrangeOrbitKind;
  readonly axKm: number;
  readonly azKm: number;
}

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

// ラグランジュ点を持てる天体(惑星 + 衛星)を副天体として列挙し、表示名を
// 「中心天体名-自分の名」としてレジストリから組む。軌道要素指定の基準天体もこれを使う
// (公転していない恒星を周回の中心には選べない)。
const ORBITING_IDS = (Object.keys(SOLAR_SYSTEM) as AttractorId[])
  .filter((id) => bodyDef(id).kind !== 'star') as OrbitingId[];

const ATTRACTOR_ITEMS: readonly (readonly [ReferenceAttractor, string])[] = ORBITING_IDS.map((id) => [id, ATTRACTOR_NAMES[id]]);

const LAGRANGE_SYSTEM_ITEMS: readonly (readonly [OrbitingId, string])[] = ORBITING_IDS.map((id) => {
  const def = bodyDef(id);
  const primary: AttractorId = def.kind === 'planet' ? 'sun' : def.planet;
  return [id, `${ATTRACTOR_NAMES[primary]}-${ATTRACTOR_NAMES[id]}`] as const;
});

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
const LAGRANGE_DEFAULT_AMPLITUDE_KM: Record<OrbitingId, { ax: number; az: number }> = {
  moon: { ax: C.CREATIVE_HALO_AX_MOON_KM, az: C.CREATIVE_HALO_AZ_MOON_KM },
  earth: { ax: C.CREATIVE_HALO_AX_EARTH_KM, az: C.CREATIVE_HALO_AZ_EARTH_KM },
  jupiter: { ax: C.CREATIVE_HALO_AX_JUPITER_KM, az: C.CREATIVE_HALO_AZ_JUPITER_KM },
};

// ラベル付き数値入力を1行分組み立てて root へ追加し、input 要素を返す。
function numberField(root: HTMLElement, label: string, defaultValue: number, step: number): HTMLInputElement {
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
  // #hud はマップドラッグを拾うため、この入力上のポインタ操作がカメラドラッグへ抜けないようにする。
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  row.appendChild(input);
  root.appendChild(row);
  return input;
}

// numberField が組んだ入力の行(ラベルごと)を出し入れする。
function setFieldVisible(input: HTMLInputElement, visible: boolean): void {
  (input.parentElement as HTMLElement).style.display = visible ? '' : 'none';
}

export class ShipPlacerPanel {
  onConfirm: ((name: string, form: ShipPlacerForm) => void) | null = null;
  onClose: (() => void) | null = null;

  private _isOpen = false;
  get isOpen(): boolean { return this._isOpen; }

  private readonly panel: HTMLElement;
  private readonly objectType: SegmentedControl<ObjectType>;
  private readonly placementMode: SegmentedControl<PlacementMode>;
  private readonly placementGroups: Record<PlacementMode, HTMLElement>;
  private readonly attractorControl: SegmentedControl<ReferenceAttractor>;
  private readonly sizeMode: SegmentedControl<SizeShapeMode>;
  private readonly sizeGroups: Record<SizeShapeMode, HTMLElement>;
  private readonly nameInput: HTMLInputElement;
  private readonly peAlt: HTMLInputElement;
  private readonly apAlt: HTMLInputElement;
  private readonly semiMajor: HTMLInputElement;
  private readonly eccSemiMajor: HTMLInputElement;
  private readonly period: HTMLInputElement;
  private readonly eccPeriod: HTMLInputElement;
  private readonly inc: HTMLInputElement;
  private readonly raan: HTMLInputElement;
  private readonly argp: HTMLInputElement;
  private readonly nu: HTMLInputElement;
  private readonly lagrangeSecondary: SegmentedControl<OrbitingId>;
  private readonly lagrangePoint: SegmentedControl<CollinearPoint>;
  private readonly lagrangeOrbitKind: SegmentedControl<LagrangeOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;

  private objectTypeValue: ObjectType = 'player';
  private placementModeValue: PlacementMode = 'elements';
  private attractorValue: ReferenceAttractor = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';
  private lagrangeSecondaryValue: OrbitingId = 'moon';
  private lagrangePointValue: CollinearPoint = 'L1';
  private lagrangeOrbitKindValue: LagrangeOrbitKind = 'halo';

  // 艦艇配置パネルの DOM を組み立て、root へ追加する。
  constructor(root: HTMLElement) {
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

    this.objectType = new SegmentedControl('種類', OBJECT_TYPE_ITEMS, (v) => { this.objectTypeValue = v; this.objectType.setSelected(v); });
    this.objectType.setSelected(this.objectTypeValue);
    this.panel.appendChild(this.objectType.element);

    this.placementMode = new SegmentedControl('配置方法', PLACEMENT_MODE_ITEMS, (v) => this.selectPlacementMode(v));
    this.panel.appendChild(this.placementMode.element);

    // 軌道要素指定の一式(基準天体・サイズ/形・向き・位相)をまとめて1つの div に収め、
    // ラグランジュ点指定と排他に表示切替できるようにする。
    const elementsGroup = document.createElement('div');
    this.attractorControl = new SegmentedControl('基準天体', ATTRACTOR_ITEMS, (v) => { this.attractorValue = v; this.attractorControl.setSelected(v); });
    this.attractorControl.setSelected(this.attractorValue);
    elementsGroup.appendChild(this.attractorControl.element);

    this.sizeMode = new SegmentedControl('サイズ/形', SIZE_MODE_ITEMS, (v) => this.selectSizeMode(v));
    elementsGroup.appendChild(this.sizeMode.element);

    // サイズ/形の3つの入力組はどれか1つだけを表示する(selectSizeMode が切り替える)。
    const apsidesGroup = document.createElement('div');
    this.peAlt = numberField(apsidesGroup, '近地点高度 [km]', 400, 10);
    this.apAlt = numberField(apsidesGroup, '遠地点高度 [km]', 400, 10);
    elementsGroup.appendChild(apsidesGroup);

    const semiMajorGroup = document.createElement('div');
    this.semiMajor = numberField(semiMajorGroup, '半長軸 [km]', 6771, 10);
    this.eccSemiMajor = numberField(semiMajorGroup, '離心率', 0, 0.01);
    elementsGroup.appendChild(semiMajorGroup);

    const periodGroup = document.createElement('div');
    this.period = numberField(periodGroup, '周期 [h]', 1.54, 0.01);
    this.eccPeriod = numberField(periodGroup, '離心率', 0, 0.01);
    elementsGroup.appendChild(periodGroup);

    this.sizeGroups = { apsides: apsidesGroup, semiMajorEcc: semiMajorGroup, periodEcc: periodGroup };
    this.selectSizeMode(this.sizeModeValue);

    // 向き(i/Ω/ω)と位相(ν)は組の選択によらず常に有効。
    this.inc = numberField(elementsGroup, '傾斜角 i [deg]', 51.6, 1);
    this.raan = numberField(elementsGroup, '昇交点赤経 Ω [deg]', 0, 1);
    this.argp = numberField(elementsGroup, '近点引数 ω [deg]', 0, 1);
    this.nu = numberField(elementsGroup, '真近点角 ν [deg]', 0, 1);
    this.panel.appendChild(elementsGroup);

    // ラグランジュ点指定(ハロー/リサジュー)の一式。
    const lagrangeGroup = document.createElement('div');
    this.lagrangeSecondary = new SegmentedControl('系', LAGRANGE_SYSTEM_ITEMS, (v) => this.selectLagrangeSecondary(v));
    this.lagrangeSecondary.setSelected(this.lagrangeSecondaryValue);
    lagrangeGroup.appendChild(this.lagrangeSecondary.element);
    this.lagrangePoint = new SegmentedControl('点', LAGRANGE_POINT_ITEMS, (v) => {
      this.lagrangePointValue = v;
      this.lagrangePoint.setSelected(v);
    });
    this.lagrangePoint.setSelected(this.lagrangePointValue);
    lagrangeGroup.appendChild(this.lagrangePoint.element);
    // ハローの面内振幅は面外振幅から三次の振幅拘束で決まるので、入力欄自体を出さない。
    this.lagrangeOrbitKind = new SegmentedControl('軌道種別', LAGRANGE_ORBIT_KIND_ITEMS, (v) => {
      this.lagrangeOrbitKindValue = v;
      this.lagrangeOrbitKind.setSelected(v);
      setFieldVisible(this.libAx, v === 'lissajous');
    });
    lagrangeGroup.appendChild(this.lagrangeOrbitKind.element);
    const defaultAmp = LAGRANGE_DEFAULT_AMPLITUDE_KM[this.lagrangeSecondaryValue];
    this.libAx = numberField(lagrangeGroup, '面内振幅 ax [km]', defaultAmp.ax, 100);
    this.libAz = numberField(lagrangeGroup, '面外振幅 az [km]', defaultAmp.az, 100);
    this.lagrangeOrbitKind.setSelected(this.lagrangeOrbitKindValue);
    setFieldVisible(this.libAx, this.lagrangeOrbitKindValue === 'lissajous');
    this.panel.appendChild(lagrangeGroup);

    this.placementGroups = { elements: elementsGroup, lagrange: lagrangeGroup };
    this.selectPlacementMode(this.placementModeValue);

    const nameRow = document.createElement('div');
    nameRow.className = 'hud-seg';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'オブジェクト名(空欄で自動命名)';
    this.nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    nameRow.appendChild(this.nameInput);
    this.panel.appendChild(nameRow);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '10px';
    btnRow.style.marginTop = '12px';
    btnRow.appendChild(hudButton('配置 [Enter]', () => this.confirm()));
    btnRow.appendChild(hudButton('キャンセル [ESC]', () => {
      this.setVisible(false);
      this.onClose?.();
    }));
    this.panel.appendChild(btnRow);

    // Enter / ESC キー操作のバインド
    window.addEventListener('keydown', (e) => {
      if (this.panel.style.display === 'none') return;
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        this.setVisible(false);
        this.onClose?.();
      } else if (e.key === 'Enter') {
        e.stopImmediatePropagation();
        this.confirm();
      }
    });

    // root (hud-modal-shield) に追加
    root.appendChild(this.panel);
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
    const amp = LAGRANGE_DEFAULT_AMPLITUDE_KM[secondary];
    this.libAx.value = String(amp.ax);
    this.libAz.value = String(amp.az);
  }

  // フォームの現在値を読み、onConfirm へ通知する。
  private confirm(): void {
    // 空欄なら確定側(CreativeStage.placeObject)が種別ごとの既定名で自動命名する。
    const name = this.nameInput.value.trim();
    // 選ばれなかった側の入力値も含めてまとめて渡す(確定側が placementMode/sizeMode を見て
    // 使う組を選ぶ)。
    const form = this.getForm();
    this.onConfirm?.(name, form);
    this.setVisible(false);
    this.onClose?.();
  }

  // 現在のフォームの値を読み取って ShipPlacerForm を返す。プレビュー用にも使用。
  getForm(): ShipPlacerForm {
    return {
      objectType: this.objectTypeValue,
      placementMode: this.placementModeValue,
      attractor: this.attractorValue,
      sizeMode: this.sizeModeValue,
      peAltKm: Number(this.peAlt.value),
      apAltKm: Number(this.apAlt.value),
      semiMajorKm: Number(this.semiMajor.value),
      eccentricity: this.sizeModeValue === 'periodEcc' ? Number(this.eccPeriod.value) : Number(this.eccSemiMajor.value),
      periodHours: Number(this.period.value),
      incDeg: Number(this.inc.value),
      raanDeg: Number(this.raan.value),
      argpDeg: Number(this.argp.value),
      nuDeg: Number(this.nu.value),
      lagrangeSecondary: this.lagrangeSecondaryValue,
      lagrangePoint: this.lagrangePointValue,
      lagrangeOrbitKind: this.lagrangeOrbitKindValue,
      axKm: Number(this.libAx.value),
      azKm: Number(this.libAz.value),
    };
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this._isOpen = visible;
    this.panel.style.display = visible ? 'block' : 'none';
  }
}
