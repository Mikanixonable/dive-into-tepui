// 表示パネル(マップモード左レール)の軌道ガイドタブ。CR3BP の周期軌道族(約37種、
// DEVELOP/SPEC/MAP.md 4.1 の表が正本)を、基本/共線点/三角点/副天体周回/共鳴の5群へ分け、
// 群ごとに折りたためる(PanelShell を流用)。種類の見出しはその種類の表示トグルを兼ね、
// ON の種類だけ本数・族範囲・色・進行方向などの設定行を下に出す。状態の正本は持たず、
// 操作のたびに現在の鏡映しから次の OrbitGuideSettings を組んで onSettingsChange へ渡す。
//
// 族 id(焼き込みカタログのキー)から画面に出す群・表示名を導く対応表は、実在する族を
// 呼び出し側から受け取った availableFamilies から作る——族の集合を推測でここへ書き写さない。
import lagrangeOrbits from '../../../assets/orbits/lagrange-orbits.json';
import type { OrbitCatalog, CatalogSystemId } from '../../../physics/orbit-catalog';
import { lagrangeJacobi, type LagrangeLabel } from '../../../physics/zero-velocity';
import { Button, SegmentedControl, ToggleSwitch, ValueInput } from '../widgets';
import {
  AMPLITUDE_MAPPING, COUNT_MAPPING, CYCLES_MAPPING, JACOBI_MAPPING, OPACITY_MAPPING,
  PHASE_MAPPING, RANGE_MAPPING,
  buildColorField, buildValueField, hexColorString, syncValueField,
  type ValueField, type ValueMapping,
} from './guide-value-field';
import { PanelShell } from '../panel-shell';
import { buildKindDefs, defaultColorsFor, type KindDef } from './guide-kind-def';
import {
  DEFAULT_ORBIT_GUIDE_SETTINGS,
  defaultKindSettings,
  GUIDE_GROUPS,
  type DirectionMarkerMode,
  type GuideGroupId,
  type GuideKindSettings,
  type LissajousSettings,
  type OrbitGuideSettings,
} from '../../celestial/orbit-guide-settings';

// 線数がこれを超えたら警告を出す(指定は曲げない、計画書 8 の #9)。
const LINE_COUNT_WARNING_THRESHOLD = 300;

const DIRECTION_ITEMS: readonly (readonly [DirectionMarkerMode, string])[] = [
  ['none', '表示しない'], ['single', '1周に1つ'], ['many', '多数'],
];

// ---- 種類1行ぶんの構成 -------------------------------------------------------------------

// 種類1行(見出しトグル+設定パネル)。設定パネルは on の間だけ .hidden を外す。
interface KindRow {
  readonly root: HTMLElement;
  readonly heading: Button;
  readonly configPanel: HTMLElement;
  readonly rangeMaxRow: HTMLElement;
  readonly colorEndRow: HTMLElement;
  readonly reversedRow: HTMLElement;
  readonly countField: ValueField;
  readonly rangeMinField: ValueField;
  readonly rangeMaxField: ValueField;
  readonly colorStartInput: ValueInput;
  readonly colorEndInput: ValueInput;
  readonly reversedButton: Button;
  readonly opacityField: ValueField;
  readonly direction: SegmentedControl<DirectionMarkerMode>;
  readonly animateSwitch: ToggleSwitch;
  readonly stabilitySwitch: ToggleSwitch;
}

export class OrbitGuideTab {
  public readonly element: HTMLElement;
  public onSettingsChange: ((settings: OrbitGuideSettings) => void) | null = null;

  private current: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;
  private readonly kindDefs: ReadonlyMap<GuideGroupId, readonly KindDef[]>;
  private readonly kindRows = new Map<string, KindRow>();
  private readonly systemSwitches = new Map<CatalogSystemId, ToggleSwitch>();
  private readonly geostationaryButton: Button;
  private lissajousRow!: {
    readonly heading: Button;
    readonly configPanel: HTMLElement;
    readonly pointButtons: Map<'l1' | 'l2' | 'l3', Button>;
    readonly inPlaneField: ValueField;
    readonly outOfPlaneField: ValueField;
    readonly inPlanePhaseField: ValueField;
    readonly outOfPlanePhaseField: ValueField;
    readonly cyclesField: ValueField;
    readonly colorInput: ValueInput;
    readonly opacityField: ValueField;
    readonly direction: SegmentedControl<DirectionMarkerMode>;
    readonly animateSwitch: ToggleSwitch;
  };
  private readonly lineCountEl: HTMLElement;

  public constructor(availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]>) {
    this.kindDefs = buildKindDefs(availableFamilies);

    this.element = document.createElement('div');
    this.element.className = 'orbit-guide-tab';

    this.buildSystemRow(this.element);

    // 基本群: 静止軌道だけ。軸(系)を持たない。
    const basicShell = new PanelShell(this.element, 'orbit-guide-group-basic', '基本', false);
    const basicRow = document.createElement('div');
    basicRow.className = 'orbit-guide-kind-heading';
    this.geostationaryButton = new Button('静止軌道', () => {
      const on = !this.current.geostationary;
      this.geostationaryButton.setOn(on);
      this.commit({ ...this.current, geostationary: on });
    });
    basicRow.appendChild(this.geostationaryButton.element);
    basicShell.body.appendChild(basicRow);

    // 共線点/三角点/副天体周回/共鳴の4群。
    for (const group of GUIDE_GROUPS) {
      const shell = new PanelShell(this.element, `orbit-guide-group-${group}`, GROUP_LABEL[group], group !== 'collinear');
      for (const def of this.kindDefs.get(group) ?? []) this.buildKindRow(shell.body, def);
      if (group === 'collinear') this.lissajousRow = this.buildLissajousRow(shell.body);
    }

    this.lineCountEl = document.createElement('p');
    this.lineCountEl.className = 'orbit-guide-line-count-warning hidden';
    this.element.appendChild(this.lineCountEl);
  }

  // タブ上部に置く系トグル。全群に共通で効くので折りたたみは設けず7系すべてを並べる。
  private buildSystemRow(parent: HTMLElement): void {
    const row = document.createElement('div');
    row.className = 'orbit-guide-system-row';
    for (const system of ALL_SYSTEMS) {
      const sw = new ToggleSwitch(SYSTEM_LABEL[system], (on) => this.setSystem(system, on));
      row.appendChild(sw.element);
      this.systemSwitches.set(system, sw);
    }
    parent.appendChild(row);
  }

  private setSystem(system: CatalogSystemId, on: boolean): void {
    this.commit({ ...this.current, systems: { ...this.current.systems, [system]: on } });
  }

  // 種類1行(見出し+設定パネル)を組む。見出しの表示トグルが on のときだけ設定パネルを見せる。
  private buildKindRow(parent: HTMLElement, def: KindDef): void {
    const root = document.createElement('div');
    root.className = 'orbit-guide-kind-row';

    const heading = new Button(def.label, () => this.toggleKind(def.id));
    heading.element.classList.add('orbit-guide-kind-heading-btn');
    const headingRow = document.createElement('div');
    headingRow.className = 'orbit-guide-kind-heading';
    headingRow.appendChild(heading.element);
    root.appendChild(headingRow);

    const configPanel = document.createElement('div');
    configPanel.className = 'orbit-guide-kind-config hidden';
    root.appendChild(configPanel);

    const countField = buildValueField('本数', COUNT_MAPPING, (v) => this.commitKind(def.id, { count: Math.round(v) }));
    configPanel.appendChild(countField.row);
    const rangeMinField = buildValueField('族の下限', RANGE_MAPPING, (v) => this.commitKindRange(def.id, v, this.current.kinds[def.id]?.rangeMax ?? 1));
    configPanel.appendChild(rangeMinField.row);
    const rangeMaxField = buildValueField('族の上限', RANGE_MAPPING, (v) => this.commitKindRange(def.id, this.current.kinds[def.id]?.rangeMin ?? 0, v));
    configPanel.appendChild(rangeMaxField.row);

    const colorStart = buildColorField('色(始)', 0, (v) => this.commitKind(def.id, { colorStart: v }));
    configPanel.appendChild(colorStart.row);
    const colorEnd = buildColorField('色(終)', 0, (v) => this.commitKind(def.id, { colorEnd: v }));
    configPanel.appendChild(colorEnd.row);

    const reversedButton = new Button('反転', () => {
      const kind = this.current.kinds[def.id];
      const next = !(kind?.reversed ?? false);
      reversedButton.setOn(next);
      this.commitKind(def.id, { reversed: next });
    });
    const reversedRow = document.createElement('div');
    reversedRow.className = 'w-group orbit-guide-toggle-row';
    reversedRow.appendChild(reversedButton.element);
    configPanel.appendChild(reversedRow);

    const opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => this.commitKind(def.id, { opacity: v }));
    configPanel.appendChild(opacityField.row);

    const direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => this.commitKind(def.id, { direction: mode }));
    configPanel.appendChild(direction.element);

    const animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => this.commitKind(def.id, { animate: on }));
    configPanel.appendChild(animateSwitch.element);

    const stabilitySwitch = new ToggleSwitch('安定度を示す', (on) => this.commitKind(def.id, { showStability: on }));
    configPanel.appendChild(stabilitySwitch.element);

    const resetButton = new Button('色をリセット', () => {
      const count = this.kindDefs.get(def.group)?.length ?? 1;
      const colors = defaultColorsFor(def.group, def.index, count);
      this.commitKind(def.id, { colorStart: colors.start, colorEnd: colors.end });
    });
    const resetRow = document.createElement('div');
    resetRow.className = 'w-group orbit-guide-toggle-row';
    resetRow.appendChild(resetButton.element);
    configPanel.appendChild(resetRow);

    parent.appendChild(root);
    this.kindRows.set(def.id, {
      root, heading, configPanel, rangeMaxRow: rangeMaxField.row, colorEndRow: colorEnd.row, reversedRow,
      countField, rangeMinField, rangeMaxField, colorStartInput: colorStart.input, colorEndInput: colorEnd.input,
      reversedButton, opacityField, direction, animateSwitch, stabilitySwitch,
    });
  }

  private toggleKind(id: string): void {
    const kind = this.current.kinds[id] ?? this.defaultKindFor(id);
    this.commitKind(id, { on: !kind.on });
  }

  private defaultKindFor(id: string): GuideKindSettings {
    for (const [group, defs] of this.kindDefs) {
      const def = defs.find((d) => d.id === id);
      if (def !== undefined) {
        const colors = defaultColorsFor(group, def.index, defs.length);
        return defaultKindSettings(colors.start, colors.end);
      }
    }
    return defaultKindSettings(0x808080, 0xc0c0c0);
  }

  private commitKind(id: string, patch: Partial<GuideKindSettings>): void {
    const base = this.current.kinds[id] ?? this.defaultKindFor(id);
    this.commit({ ...this.current, kinds: { ...this.current.kinds, [id]: { ...base, ...patch } } });
  }

  private commitKindRange(id: string, min: number, max: number): void {
    const rangeMin = Math.min(min, max);
    const rangeMax = Math.max(min, max);
    this.commitKind(id, { rangeMin, rangeMax });
    const row = this.kindRows.get(id);
    if (row === undefined) return;
    syncValueField(row.rangeMinField, RANGE_MAPPING, rangeMin);
    syncValueField(row.rangeMaxField, RANGE_MAPPING, rangeMax);
  }

  // リサジュー軌道の行(族を持たないので専用の設定項目を並べる)。
  private buildLissajousRow(parent: HTMLElement): OrbitGuideTab['lissajousRow'] {
    const root = document.createElement('div');
    root.className = 'orbit-guide-kind-row';
    const heading = new Button('リサジュー軌道', () => {
      const on = !this.current.lissajous.on;
      this.commit({ ...this.current, lissajous: { ...this.current.lissajous, on } });
    });
    heading.element.classList.add('orbit-guide-kind-heading-btn');
    const headingRow = document.createElement('div');
    headingRow.className = 'orbit-guide-kind-heading';
    headingRow.appendChild(heading.element);
    root.appendChild(headingRow);

    const configPanel = document.createElement('div');
    configPanel.className = 'orbit-guide-kind-config hidden';
    root.appendChild(configPanel);

    const pointRow = document.createElement('div');
    pointRow.className = 'w-group orbit-guide-toggle-row';
    const pointHeading = document.createElement('span');
    pointHeading.className = 'w-group-title';
    pointHeading.textContent = '点';
    pointRow.appendChild(pointHeading);
    const pointButtons = new Map<'l1' | 'l2' | 'l3', Button>();
    for (const [key, label] of [['l1', 'L1'], ['l2', 'L2'], ['l3', 'L3']] as const) {
      const btn = new Button(label, () => this.commitLissajous({ [key]: !this.current.lissajous[key] } as Partial<LissajousSettings>));
      pointRow.appendChild(btn.element);
      pointButtons.set(key, btn);
    }
    configPanel.appendChild(pointRow);

    const inPlaneField = buildValueField('面内振幅', AMPLITUDE_MAPPING, (v) => this.commitLissajous({ inPlane: v }));
    configPanel.appendChild(inPlaneField.row);
    const outOfPlaneField = buildValueField('面外振幅', AMPLITUDE_MAPPING, (v) => this.commitLissajous({ outOfPlane: v }));
    configPanel.appendChild(outOfPlaneField.row);
    const inPlanePhaseField = buildValueField('面内位相', PHASE_MAPPING, (v) => this.commitLissajous({ inPlanePhase: v }));
    configPanel.appendChild(inPlanePhaseField.row);
    const outOfPlanePhaseField = buildValueField('面外位相', PHASE_MAPPING, (v) => this.commitLissajous({ outOfPlanePhase: v }));
    configPanel.appendChild(outOfPlanePhaseField.row);
    const cyclesField = buildValueField('周回数', CYCLES_MAPPING, (v) => this.commitLissajous({ cycles: Math.round(v) }));
    configPanel.appendChild(cyclesField.row);

    const colorField = buildColorField('色', 0, (v) => this.commitLissajous({ colorStart: v }));
    configPanel.appendChild(colorField.row);
    const opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => this.commitLissajous({ opacity: v }));
    configPanel.appendChild(opacityField.row);
    const direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => this.commitLissajous({ direction: mode }));
    configPanel.appendChild(direction.element);
    const animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => this.commitLissajous({ animate: on }));
    configPanel.appendChild(animateSwitch.element);

    parent.appendChild(root);
    return {
      heading, configPanel, pointButtons, inPlaneField, outOfPlaneField, inPlanePhaseField, outOfPlanePhaseField,
      cyclesField, colorInput: colorField.input, opacityField, direction, animateSwitch,
    };
  }

  private commitLissajous(patch: Partial<LissajousSettings>): void {
    this.commit({ ...this.current, lissajous: { ...this.current.lissajous, ...patch } });
  }

  // 正本を差し替え、見た目を鏡映しへ合わせて呼び出し側へ通知する。
  private commit(next: OrbitGuideSettings): void {
    this.current = next;
    this.syncAll();
    this.onSettingsChange?.(this.current);
  }

  private syncAll(): void {
    this.geostationaryButton.setOn(this.current.geostationary);
    for (const [system, sw] of this.systemSwitches) sw.setOn(this.current.systems[system] ?? false);
    for (const [id, row] of this.kindRows) {
      const kind = this.current.kinds[id] ?? this.defaultKindFor(id);
      row.heading.setOn(kind.on);
      row.configPanel.classList.toggle('hidden', !kind.on);
      syncValueField(row.countField, COUNT_MAPPING, kind.count);
      syncValueField(row.rangeMinField, RANGE_MAPPING, kind.rangeMin);
      syncValueField(row.rangeMaxField, RANGE_MAPPING, kind.rangeMax);
      row.colorStartInput.setValue(hexColorString(kind.colorStart));
      row.colorEndInput.setValue(hexColorString(kind.colorEnd));
      row.reversedButton.setOn(kind.reversed);
      syncValueField(row.opacityField, OPACITY_MAPPING, kind.opacity);
      row.direction.setSelected(kind.direction);
      row.animateSwitch.setOn(kind.animate);
      row.stabilitySwitch.setOn(kind.showStability);
      // 本数が1のときは族範囲の上限・色(終)・反転が意味を持たないので隠す。
      const single = kind.count <= 1;
      row.rangeMaxRow.classList.toggle('hidden', single);
      row.colorEndRow.classList.toggle('hidden', single);
      row.reversedRow.classList.toggle('hidden', single);
    }
    const lissajous = this.current.lissajous;
    const lr = this.lissajousRow;
    lr.heading.setOn(lissajous.on);
    lr.configPanel.classList.toggle('hidden', !lissajous.on);
    lr.pointButtons.get('l1')?.setOn(lissajous.l1);
    lr.pointButtons.get('l2')?.setOn(lissajous.l2);
    lr.pointButtons.get('l3')?.setOn(lissajous.l3);
    syncValueField(lr.inPlaneField, AMPLITUDE_MAPPING, lissajous.inPlane);
    syncValueField(lr.outOfPlaneField, AMPLITUDE_MAPPING, lissajous.outOfPlane);
    syncValueField(lr.inPlanePhaseField, PHASE_MAPPING, lissajous.inPlanePhase);
    syncValueField(lr.outOfPlanePhaseField, PHASE_MAPPING, lissajous.outOfPlanePhase);
    syncValueField(lr.cyclesField, CYCLES_MAPPING, lissajous.cycles);
    lr.colorInput.setValue(hexColorString(lissajous.colorStart));
    syncValueField(lr.opacityField, OPACITY_MAPPING, lissajous.opacity);
    lr.direction.setSelected(lissajous.direction);
    lr.animateSwitch.setOn(lissajous.animate);
  }

  // 正本からの鏡映し反映。
  public setSettings(settings: OrbitGuideSettings): void {
    this.current = settings;
    this.syncAll();
  }

  // 描いている線の総数。閾値を超えたら控えめな警告を出す(指定は曲げない)。
  public setLineCount(total: number): void {
    const over = total > LINE_COUNT_WARNING_THRESHOLD;
    this.lineCountEl.classList.toggle('hidden', !over);
    if (over) this.lineCountEl.textContent = `線の本数が多くなっています(${total}本)。描画が重くなる場合があります。`;
  }
}

const GROUP_LABEL: Readonly<Record<GuideGroupId, string>> = {
  collinear: '共線点', triangular: '三角点', secondary: '副天体周回', resonant: '共鳴',
};

const ALL_SYSTEMS: readonly CatalogSystemId[] = [
  'earth-moon', 'sun-earth', 'sun-mars', 'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];
const SYSTEM_LABEL: Readonly<Record<CatalogSystemId, string>> = {
  'earth-moon': '地球-月系', 'sun-earth': '太陽-地球系', 'sun-mars': '太陽-火星系',
  'jupiter-europa': '木星-エウロパ系', 'saturn-titan': '土星-タイタン系',
  'saturn-enceladus': '土星-エンケラドス系', 'mars-phobos': '火星-フォボス系',
};

// ゼロ速度曲線(ガイドタブ側)が使う質量比。焼き込みカタログの mu をそのまま使う——
// L1〜L5 のヤコビ定数は系ごとの mu で決まるため、ここだけ例外的にカタログを import する。
export function zeroVelocityMu(system: 'earth-moon' | 'sun-earth'): number {
  const catalog = lagrangeOrbits as OrbitCatalog;
  return catalog.systems[system]?.mu ?? (system === 'earth-moon' ? 0.012150585 : 3.003e-6);
}

export function lagrangePointJacobi(system: 'earth-moon' | 'sun-earth', point: LagrangeLabel): number {
  return lagrangeJacobi(zeroVelocityMu(system), point);
}

export { JACOBI_MAPPING, type ValueMapping, buildValueField, syncValueField };
