// クリエイティブモードの「艦艇配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で1隻分の ShipPlacerForm を通知する。
// 値から OrbitState を組み立てるのは物理側(stateFromElements/haloState/lissajousState)の
// 仕事なので、ここでは行わない。
import { SegmentedControl, hudButton } from '../hud/buttons';
import { LibrationPoint, LibrationSystem } from '../../physics/halo';
import * as C from '../const';

export type ObjectType = 'player' | 'enemy' | 'ammo';
export type ReferenceBody = 'earth' | 'moon';
export type SizeShapeMode = 'apsides' | 'semiMajorEcc' | 'periodEcc';
export type PlacementMode = 'elements' | 'libration';
export type LibrationOrbitKind = 'halo' | 'lissajous';

// 確定時点のフォーム全値。placementMode が 'elements' なら sizeMode が選んだ組(残りは無視して
// よい)、'libration' ならラグランジュ点側の値を使う — 両方まとめて渡し、どちらを使うかは
// 確定側(CreativeStage)が placementMode を見て決める。
export interface ShipPlacerForm {
  readonly objectType: ObjectType;
  readonly placementMode: PlacementMode;
  readonly body: ReferenceBody;
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
  readonly librationSystem: LibrationSystem;
  readonly librationPoint: LibrationPoint;
  readonly librationOrbitKind: LibrationOrbitKind;
  readonly axKm: number;
  readonly azKm: number;
}

const OBJECT_TYPE_ITEMS: readonly (readonly [ObjectType, string])[] = [
  ['player', '自機'],
  ['enemy', '敵機'],
  ['ammo', '弾薬'],
];

const PLACEMENT_MODE_ITEMS: readonly (readonly [PlacementMode, string])[] = [
  ['elements', '軌道要素'],
  ['libration', 'ラグランジュ点'],
];

const BODY_ITEMS: readonly (readonly [ReferenceBody, string])[] = [
  ['earth', '地球'],
  ['moon', '月'],
];

const SIZE_MODE_ITEMS: readonly (readonly [SizeShapeMode, string])[] = [
  ['apsides', '近地点+遠地点'],
  ['semiMajorEcc', '半長軸+離心率'],
  ['periodEcc', '周期+離心率'],
];

const LIBRATION_SYSTEM_ITEMS: readonly (readonly [LibrationSystem, string])[] = [
  ['earthMoon', '地球-月'],
  ['sunEarth', '太陽-地球'],
];

const LIBRATION_POINT_ITEMS: readonly (readonly [LibrationPoint, string])[] = [
  ['L1', 'L1'],
  ['L2', 'L2'],
];

const LIBRATION_ORBIT_KIND_ITEMS: readonly (readonly [LibrationOrbitKind, string])[] = [
  ['halo', 'ハロー'],
  ['lissajous', 'リサジュー'],
];

// 系ごとに妥当なオーダーへ面内/面外振幅の既定値を切り替える(地球-月系と太陽-地球系は
// 主天体間距離が3桁近く違う)。
const LIBRATION_DEFAULT_AMPLITUDE_KM: Record<LibrationSystem, { ax: number; az: number }> = {
  earthMoon: { ax: C.CREATIVE_HALO_AX_EARTHMOON_KM, az: C.CREATIVE_HALO_AZ_EARTHMOON_KM },
  sunEarth: { ax: C.CREATIVE_HALO_AX_SUNEARTH_KM, az: C.CREATIVE_HALO_AZ_SUNEARTH_KM },
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
  onChange: (() => void) | null = null;
  onClose: (() => void) | null = null;

  private readonly panel: HTMLElement;
  private readonly objectType: SegmentedControl<ObjectType>;
  private readonly placementMode: SegmentedControl<PlacementMode>;
  private readonly placementGroups: Record<PlacementMode, HTMLElement>;
  private readonly body: SegmentedControl<ReferenceBody>;
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
  private readonly librationSystem: SegmentedControl<LibrationSystem>;
  private readonly librationPoint: SegmentedControl<LibrationPoint>;
  private readonly librationOrbitKind: SegmentedControl<LibrationOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;

  private objectTypeValue: ObjectType = 'player';
  private placementModeValue: PlacementMode = 'elements';
  private bodyValue: ReferenceBody = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';
  private librationSystemValue: LibrationSystem = 'earthMoon';
  private librationPointValue: LibrationPoint = 'L1';
  private librationOrbitKindValue: LibrationOrbitKind = 'halo';
  private shipCount = 0;

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
    this.body = new SegmentedControl('基準天体', BODY_ITEMS, (v) => { this.bodyValue = v; this.body.setSelected(v); });
    this.body.setSelected(this.bodyValue);
    elementsGroup.appendChild(this.body.element);

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
    const librationGroup = document.createElement('div');
    this.librationSystem = new SegmentedControl('系', LIBRATION_SYSTEM_ITEMS, (v) => this.selectLibrationSystem(v));
    this.librationSystem.setSelected(this.librationSystemValue);
    librationGroup.appendChild(this.librationSystem.element);
    this.librationPoint = new SegmentedControl('点', LIBRATION_POINT_ITEMS, (v) => {
      this.librationPointValue = v;
      this.librationPoint.setSelected(v);
    });
    this.librationPoint.setSelected(this.librationPointValue);
    librationGroup.appendChild(this.librationPoint.element);
    // ハローの面内振幅は面外振幅から三次の振幅拘束で決まるので、入力欄自体を出さない。
    this.librationOrbitKind = new SegmentedControl('軌道種別', LIBRATION_ORBIT_KIND_ITEMS, (v) => {
      this.librationOrbitKindValue = v;
      this.librationOrbitKind.setSelected(v);
      setFieldVisible(this.libAx, v === 'lissajous');
    });
    librationGroup.appendChild(this.librationOrbitKind.element);
    const defaultAmp = LIBRATION_DEFAULT_AMPLITUDE_KM[this.librationSystemValue];
    this.libAx = numberField(librationGroup, '面内振幅 ax [km]', defaultAmp.ax, 100);
    this.libAz = numberField(librationGroup, '面外振幅 az [km]', defaultAmp.az, 100);
    this.librationOrbitKind.setSelected(this.librationOrbitKindValue);
    setFieldVisible(this.libAx, this.librationOrbitKindValue === 'lissajous');
    this.panel.appendChild(librationGroup);

    this.placementGroups = { elements: elementsGroup, libration: librationGroup };
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

    // 入力変更イベントのバインド
    const inputs = this.panel.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i++) {
      inputs[i]!.addEventListener('input', () => this.onChange?.());
    }
  }

  // サイズ/形の入力組を切り替え、選ばれた組以外を隠す。
  private selectSizeMode(mode: SizeShapeMode): void {
    this.sizeModeValue = mode;
    this.sizeMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.sizeGroups) as [SizeShapeMode, HTMLElement][]) {
      group.style.display = key === mode ? 'block' : 'none';
    }
    this.onChange?.();
  }

  // 配置方法(軌道要素/ラグランジュ点)を切り替え、選ばれなかった側を隠す。
  private selectPlacementMode(mode: PlacementMode): void {
    this.placementModeValue = mode;
    this.placementMode.setSelected(mode);
    for (const [key, group] of Object.entries(this.placementGroups) as [PlacementMode, HTMLElement][]) {
      group.style.display = key === mode ? 'block' : 'none';
    }
    this.onChange?.();
  }

  // 系を切り替え、面内/面外振幅の既定値をその系のオーダーへ更新する。
  private selectLibrationSystem(system: LibrationSystem): void {
    this.librationSystemValue = system;
    this.librationSystem.setSelected(system);
    const amp = LIBRATION_DEFAULT_AMPLITUDE_KM[system];
    this.libAx.value = String(amp.ax);
    this.libAz.value = String(amp.az);
    this.onChange?.();
  }

  // フォームの現在値を読み、onConfirm へ通知する。
  private confirm(): void {
    this.shipCount++;
    // 空欄なら連番で自動命名する。
    const name = this.nameInput.value.trim() || `SHIP-${this.shipCount}`;
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
      body: this.bodyValue,
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
      librationSystem: this.librationSystemValue,
      librationPoint: this.librationPointValue,
      librationOrbitKind: this.librationOrbitKindValue,
      axKm: Number(this.libAx.value),
      azKm: Number(this.libAz.value),
    };
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
    if (visible) this.onChange?.();
  }
}
