// クリエイティブモードの「艦艇配置」パネル: 軌道要素指定とラグランジュ点(ハロー/リサジュー)
// 指定のどちらかを選び、フォームで値を指定して、確定で1隻分の ShipPlacerForm を通知する。
// 値から OrbitState を組み立てるのは物理側(stateFromElements/haloState/lissajousState)の
// 仕事なので、ここでは行わない。
import { SegmentedControl, hudButton } from '../hud/buttons';
import { ATTRACTOR_NAMES } from '../hud/frame-labels';
import { LibrationPoint } from '../../physics/halo';
import { AttractorId } from '../../physics/attractor';
import { bodyDef, SOLAR_SYSTEM } from '../../physics/solar-system';
import type { OrbitingId } from '../../physics/attractor';
import * as C from '../const';

export type ObjectType = 'player' | 'enemy' | 'ammo' | 'base';
export type ReferenceBody = AttractorId;
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
  readonly librationSecondary: OrbitingId;
  readonly librationPoint: LibrationPoint;
  readonly librationOrbitKind: LibrationOrbitKind;
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
  ['libration', 'ラグランジュ点'],
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

const BODY_ITEMS: readonly (readonly [ReferenceBody, string])[] = ORBITING_IDS.map((id) => [id, ATTRACTOR_NAMES[id]]);

// 基地は敵の射程となる惑星近傍を避けるため、軌道要素指定の基準天体は月だけに絞る
// (地球・木星は選択肢自体を出さない — placement-validation.ts の validateBaseReference と対にする)。
const BASE_BODY_ITEMS: readonly (readonly [ReferenceBody, string])[] = BODY_ITEMS.filter(([id]) => id === 'moon');

const LIBRATION_SYSTEM_ITEMS: readonly (readonly [OrbitingId, string])[] = ORBITING_IDS.map((id) => {
  const def = bodyDef(id);
  const primary: AttractorId = def.kind === 'planet' ? 'sun' : def.planet;
  return [id, `${ATTRACTOR_NAMES[primary]}-${ATTRACTOR_NAMES[id]}`] as const;
});

const LIBRATION_POINT_ITEMS: readonly (readonly [LibrationPoint, string])[] = [
  ['L1', 'L1'],
  ['L2', 'L2'],
];

const LIBRATION_ORBIT_KIND_ITEMS: readonly (readonly [LibrationOrbitKind, string])[] = [
  ['halo', 'ハロー'],
  ['lissajous', 'リサジュー'],
];

// 副天体ごとに妥当なオーダーへ面内/面外振幅の既定値を切り替える(系ごとに主天体間距離が
// 桁違いなため)。
const LIBRATION_DEFAULT_AMPLITUDE_KM: Record<OrbitingId, { ax: number; az: number }> = {
  moon: { ax: C.CREATIVE_HALO_AX_MOON_KM, az: C.CREATIVE_HALO_AZ_MOON_KM },
  earth: { ax: C.CREATIVE_HALO_AX_EARTH_KM, az: C.CREATIVE_HALO_AZ_EARTH_KM },
  jupiter: { ax: C.CREATIVE_HALO_AX_JUPITER_KM, az: C.CREATIVE_HALO_AZ_JUPITER_KM },
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
// bindAltitudeSlider 経由で決める(角度は固定範囲の線形対応、高度は基準値相対の対応で
// 意味が異なるため、この行自体は対応関係を知らない)。
interface SliderRow {
  readonly input: HTMLInputElement;
  readonly slider: HTMLInputElement;
  setTicks(labels: readonly string[]): void;
  setMapping(toT: (value: number) => number, fromT: (t: number) => number): void;
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

// 高度スライダーの基準からの相対倍率: 中央(t=0)を基準値の100%とし、左は等倍で0%まで、
// 右は2倍指数で400%まで伸びる。上限のない高度を有限のスライダー幅で操作するための仕様。
function altitudeMultiplier(tOffset: number): number {
  return tOffset <= 0 ? 1 + tOffset : Math.pow(2, 2 * tOffset);
}

// 高度の基準値の下限(km)。基準はスライダーの可動範囲そのものなので、値が 0 まで下がった
// ときに 0 を基準にすると倍率をいくら掛けても 0 のままになり、二度と操作で戻せなくなる。
// 一度のドラッグでこの4倍まで戻せる高度を床に置く。
const ALTITUDE_REF_FLOOR_KM = 100;

// 高度スライダー(Ap/Pe): ドラッグ開始時点の値を基準の100%としてスライダー中央に据え、
// ドラッグが終わるたびにそのときの値を新しい基準に取り直してつまみを中央へ戻す
// (基準を固定しないと上限のない高度を動かせない)。
function bindAltitudeSlider(field: SliderRow): void {
  const rebase = (): void => {
    const ref = Math.max(Number(field.input.value), ALTITUDE_REF_FLOOR_KM);
    field.setMapping(
      (v) => {
        const mult = v / ref;
        const tOffset = mult <= 1 ? mult - 1 : Math.log2(mult) / 2;
        return (tOffset + 1) / 2;
      },
      (t) => ref * altitudeMultiplier(2 * t - 1),
    );
    field.setTicks([0, 0.5, 1, 2, 4].map((m) => `${Math.round(ref * m)}`));
  };
  field.slider.addEventListener('pointerdown', rebase);
  field.slider.addEventListener('pointerup', rebase);
  rebase();
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
  private readonly body: SegmentedControl<ReferenceBody>;
  private readonly sizeMode: SegmentedControl<SizeShapeMode>;
  private readonly sizeGroups: Record<SizeShapeMode, HTMLElement>;
  private readonly nameInput: HTMLInputElement;
  private readonly peAlt: SliderRow;
  private readonly apAlt: SliderRow;
  private readonly semiMajor: HTMLInputElement;
  private readonly eccSemiMajor: HTMLInputElement;
  private readonly period: HTMLInputElement;
  private readonly eccPeriod: HTMLInputElement;
  private readonly inc: SliderRow;
  private readonly raan: SliderRow;
  private readonly argp: SliderRow;
  private readonly nu: SliderRow;
  private readonly librationSecondary: SegmentedControl<OrbitingId>;
  private readonly librationPoint: SegmentedControl<LibrationPoint>;
  private readonly librationOrbitKind: SegmentedControl<LibrationOrbitKind>;
  private readonly libAx: HTMLInputElement;
  private readonly libAz: HTMLInputElement;

  private objectTypeValue: ObjectType = 'player';
  private placementModeValue: PlacementMode = 'elements';
  private bodyValue: ReferenceBody = 'earth';
  private sizeModeValue: SizeShapeMode = 'apsides';
  private librationSecondaryValue: OrbitingId = 'moon';
  private librationPointValue: LibrationPoint = 'L1';
  private librationOrbitKindValue: LibrationOrbitKind = 'halo';

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

    this.objectType = new SegmentedControl('種類', OBJECT_TYPE_ITEMS, (v) => this.selectObjectType(v));
    this.objectType.setSelected(this.objectTypeValue);
    this.panel.appendChild(this.objectType.element);

    this.placementMode = new SegmentedControl('配置方法', PLACEMENT_MODE_ITEMS, (v) => this.selectPlacementMode(v));
    this.panel.appendChild(this.placementMode.element);

    const elements = this.buildElementsGroup();
    this.body = elements.body;
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
    this.selectSizeMode(this.sizeModeValue);
    this.panel.appendChild(elements.element);

    const libration = this.buildLibrationGroup();
    this.librationSecondary = libration.librationSecondary;
    this.librationPoint = libration.librationPoint;
    this.librationOrbitKind = libration.librationOrbitKind;
    this.libAx = libration.libAx;
    this.libAz = libration.libAz;
    this.panel.appendChild(libration.element);

    this.placementGroups = { elements: elements.element, libration: libration.element };
    this.selectPlacementMode(this.placementModeValue);

    const nameRow = this.buildNameRow();
    this.nameInput = nameRow.nameInput;
    this.panel.appendChild(nameRow.element);

    this.buildButtonsAndKeybinds();

    // root (hud-modal-shield) に追加
    root.appendChild(this.panel);
  }

  // 軌道要素指定の一式(基準天体・サイズ/形・向き・位相)を1つの div にまとめて返す。
  // サイズ/形の3つの入力組はどれか1つだけを表示する(selectSizeMode が切り替える)ので、
  // 呼び出し側は返った sizeGroups を this.sizeGroups へ代入してから selectSizeMode を呼ぶ必要がある。
  private buildElementsGroup(): {
    element: HTMLElement;
    body: SegmentedControl<ReferenceBody>;
    sizeMode: SegmentedControl<SizeShapeMode>;
    sizeGroups: Record<SizeShapeMode, HTMLElement>;
    peAlt: SliderRow;
    apAlt: SliderRow;
    semiMajor: HTMLInputElement;
    eccSemiMajor: HTMLInputElement;
    period: HTMLInputElement;
    eccPeriod: HTMLInputElement;
    inc: SliderRow;
    raan: SliderRow;
    argp: SliderRow;
    nu: SliderRow;
  } {
    const elementsGroup = document.createElement('div');
    const body = new SegmentedControl('基準天体', BODY_ITEMS, (v) => { this.bodyValue = v; body.setSelected(v); });
    body.setSelected(this.bodyValue);
    elementsGroup.appendChild(body.element);

    const sizeMode = new SegmentedControl('サイズ/形', SIZE_MODE_ITEMS, (v) => this.selectSizeMode(v));
    elementsGroup.appendChild(sizeMode.element);

    const apsidesGroup = document.createElement('div');
    const peAlt = sliderField(apsidesGroup, '近地点高度 [km]', 400, 10, 0);
    bindAltitudeSlider(peAlt);
    const apAlt = sliderField(apsidesGroup, '遠地点高度 [km]', 400, 10, 0);
    bindAltitudeSlider(apAlt);
    elementsGroup.appendChild(apsidesGroup);

    const semiMajorGroup = document.createElement('div');
    const semiMajor = numberField(semiMajorGroup, '半長軸 [km]', 6771, 10, 0);
    const eccSemiMajor = numberField(semiMajorGroup, '離心率', 0, 0.01, 0, 0.99);
    elementsGroup.appendChild(semiMajorGroup);

    const periodGroup = document.createElement('div');
    const period = numberField(periodGroup, '周期 [h]', 1.54, 0.01, 0);
    const eccPeriod = numberField(periodGroup, '離心率', 0, 0.01, 0, 0.99);
    elementsGroup.appendChild(periodGroup);

    const sizeGroups = { apsides: apsidesGroup, semiMajorEcc: semiMajorGroup, periodEcc: periodGroup };

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

    return { element: elementsGroup, body, sizeMode, sizeGroups, peAlt, apAlt, semiMajor, eccSemiMajor, period, eccPeriod, inc, raan, argp, nu };
  }

  // ラグランジュ点指定(ハロー/リサジュー)の一式を1つの div にまとめて返す。
  private buildLibrationGroup(): {
    element: HTMLElement;
    librationSecondary: SegmentedControl<OrbitingId>;
    librationPoint: SegmentedControl<LibrationPoint>;
    librationOrbitKind: SegmentedControl<LibrationOrbitKind>;
    libAx: HTMLInputElement;
    libAz: HTMLInputElement;
  } {
    const librationGroup = document.createElement('div');
    const librationSecondary = new SegmentedControl('系', LIBRATION_SYSTEM_ITEMS, (v) => this.selectLibrationSecondary(v));
    librationSecondary.setSelected(this.librationSecondaryValue);
    librationGroup.appendChild(librationSecondary.element);
    const librationPoint = new SegmentedControl('点', LIBRATION_POINT_ITEMS, (v) => {
      this.librationPointValue = v;
      this.librationPoint.setSelected(v);
    });
    librationPoint.setSelected(this.librationPointValue);
    librationGroup.appendChild(librationPoint.element);
    // ハローの面内振幅は面外振幅から三次の振幅拘束で決まるので、入力欄自体を出さない。
    let libAx: HTMLInputElement;
    const librationOrbitKind = new SegmentedControl('軌道種別', LIBRATION_ORBIT_KIND_ITEMS, (v) => {
      this.librationOrbitKindValue = v;
      this.librationOrbitKind.setSelected(v);
      setFieldVisible(libAx, v === 'lissajous');
      libAx.value = String(this.defaultLibrationAmplitude(this.librationSecondaryValue).ax);
    });
    librationGroup.appendChild(librationOrbitKind.element);
    const defaultAmp = this.defaultLibrationAmplitude(this.librationSecondaryValue);
    libAx = numberField(librationGroup, '面内振幅 ax [km]', defaultAmp.ax, 100, 0);
    const libAz = numberField(librationGroup, '面外振幅 az [km]', defaultAmp.az, 100, 0);
    librationOrbitKind.setSelected(this.librationOrbitKindValue);
    setFieldVisible(libAx, this.librationOrbitKindValue === 'lissajous');

    return { element: librationGroup, librationSecondary, librationPoint, librationOrbitKind, libAx, libAz };
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
  // キーバインドは window に貼るため、パネルが非表示のときは display チェックで素通りさせる。
  private buildButtonsAndKeybinds(): void {
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
  }

  // 種類を切り替える。基地は月基準の軌道要素かラグランジュ点指定でしか設置できない
  // (placement-validation.ts の validateBaseReference と対応)ので、基準天体の選択肢を
  // 月だけに絞り、月以外が選ばれていたら月へ寄せ直す。基地以外へ戻したら選択肢も元に戻す。
  private selectObjectType(v: ObjectType): void {
    this.objectTypeValue = v;
    this.objectType.setSelected(v);
    if (v === 'base') {
      if (this.bodyValue !== 'moon') this.bodyValue = 'moon';
      this.body.setItems(BASE_BODY_ITEMS);
    } else {
      this.body.setItems(BODY_ITEMS);
    }
    this.body.setSelected(this.bodyValue);
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
  private selectLibrationSecondary(secondary: OrbitingId): void {
    this.librationSecondaryValue = secondary;
    this.librationSecondary.setSelected(secondary);
    const amp = this.defaultLibrationAmplitude(secondary);
    this.libAx.value = String(amp.ax);
    this.libAz.value = String(amp.az);
  }

  // 副天体ごとの面内/面外振幅の既定値を返す(系ごとに主天体間距離が桁違いなため)。
  private defaultLibrationAmplitude(secondary: OrbitingId): { ax: number; az: number } {
    return LIBRATION_DEFAULT_AMPLITUDE_KM[secondary];
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
      body: this.bodyValue,
      sizeMode: this.sizeModeValue,
      peAltKm: Number(this.peAlt.input.value),
      apAltKm: Number(this.apAlt.input.value),
      semiMajorKm: Number(this.semiMajor.value),
      eccentricity: this.sizeModeValue === 'periodEcc' ? Number(this.eccPeriod.value) : Number(this.eccSemiMajor.value),
      periodHours: Number(this.period.value),
      incDeg: Number(this.inc.input.value),
      raanDeg: Number(this.raan.input.value),
      argpDeg: Number(this.argp.input.value),
      nuDeg: Number(this.nu.input.value),
      librationSecondary: this.librationSecondaryValue,
      librationPoint: this.librationPointValue,
      librationOrbitKind: this.librationOrbitKindValue,
      axKm: Number(this.libAx.value),
      azKm: Number(this.libAz.value),
    };
  }

  // パネルの表示/非表示を切り替える。開くときは defaultBody が基準天体になれる ID
  // (公転している天体、かつ基地選択中なら月)なら、基準天体の選択をそれへ合わせる —
  // 呼び出し側がマップの現在フォーカスを渡すことを想定している。
  setVisible(visible: boolean, defaultBody?: string): void {
    this._isOpen = visible;
    this.panel.style.display = visible ? 'block' : 'none';
    const allowed = this.objectTypeValue === 'base' ? BASE_BODY_ITEMS : BODY_ITEMS;
    if (visible && defaultBody !== undefined && allowed.some(([id]) => id === defaultBody)) {
      this.bodyValue = defaultBody as ReferenceBody;
      this.body.setSelected(this.bodyValue);
    }
  }
}
