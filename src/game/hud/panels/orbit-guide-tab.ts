// 表示パネル(マップモード左レール)の軌道ガイドタブ。CR3BP の周期軌道族(約37種、
// DEVELOP/SPEC/MAP.md 4.1 の表が正本)と地球専用の参照軌道4種を、基本/共線点/三角点/
// 副天体周回/共鳴の5群へ分け、群を横並びタブで切り替える(TabBar を流用)。種類の見出しは
// その種類の表示トグルを兼ね、ON の種類だけ設定行を下に出す。状態の正本は持たず、
// 操作のたびに現在の鏡映しから次の OrbitGuideSettings を組んで onSettingsChange へ渡す。
//
// 族 id(焼き込みカタログのキー)から画面に出す群・表示名を導く対応表は、実在する族を
// 呼び出し側から受け取った availableFamilies から作る——族の集合を推測でここへ書き写さない。
import type { CatalogSystemId } from '../../../physics/orbit-catalog';
import { Button, SegmentedControl, TabBar, ToggleSwitch, ValueInput } from '../widgets';
import {
  AMPLITUDE_MAPPING, COUNT_MAPPING, CYCLES_MAPPING, DIRECTION_ITEMS, OPACITY_MAPPING,
  PHASE_MAPPING, RANGE_MAPPING,
  buildColorField, buildKindRowHeading, buildValueField, hexColorString, syncValueField,
  type ValueField,
} from './guide-value-field';
import { buildKindDefs, defaultColorsFor, type CombinedKindDef, type KindDef } from './guide-kind-def';
import {
  buildCriticalInclinationRow, buildDawnDuskRow, buildSunSyncRow,
  syncCriticalInclinationRow, syncDawnDuskRow, syncSunSyncRow,
  type CriticalInclinationRow, type DawnDuskRow, type RepeatGroundTrackRow,
} from './reference-orbit-rows';
import {
  DEFAULT_ORBIT_GUIDE_SETTINGS,
  defaultCombinedKindSettings,
  defaultKindSettings,
  GUIDE_GROUPS,
  type CombinedKindSettings,
  type CriticalInclinationSettings,
  type DawnDuskSettings,
  type DirectionMarkerMode,
  type GuideGroupId,
  type GuideKindSettings,
  type GuideKindSharedSettings,
  type LissajousSettings,
  type OrbitGuideSettings,
  type SunSyncSettings,
} from '../../celestial/orbit-guide/orbit-guide-settings';

// 線数がこれを超えたら警告を出す(指定は曲げない)。
const LINE_COUNT_WARNING_THRESHOLD = 300;

// ---- 種類1行ぶんの構成 -------------------------------------------------------------------

// 本数・族範囲・色・進行方向・安定度の見せ方。種類1行(KindRow)と小題1行(CombinedKindRow)の
// 双方が持つ共有設定パネルのフィールド一式。
interface SharedKindFields {
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

// 種類1行(見出しトグル+設定パネル)。設定パネルは on の間だけ .hidden を外す。
interface KindRow extends SharedKindFields {
  readonly heading: Button;
  readonly configPanel: HTMLElement;
}

// 小題1行(軸ボタン+共有設定パネル)。設定パネルは軸値の組み合わせが1つでも表示中の間だけ
// .hidden を外す。
interface CombinedKindRow extends SharedKindFields {
  readonly configPanel: HTMLElement;
  readonly axisButtons: ReadonlyMap<string, Button>;
}

// SharedKindFields(種類1行・小題1行の共有設定パネル)を現在の設定値へ合わせる。見出しの
// 表示トグルと configPanel の hidden 判定は、行の種類ごとに条件が異なるため呼び出し側が持つ。
function syncSharedKindFields(row: SharedKindFields, settings: GuideKindSharedSettings): void {
  syncValueField(row.countField, COUNT_MAPPING, settings.count);
  syncValueField(row.rangeMinField, RANGE_MAPPING, settings.rangeMin);
  syncValueField(row.rangeMaxField, RANGE_MAPPING, settings.rangeMax);
  row.colorStartInput.setValue(hexColorString(settings.colorStart));
  row.colorEndInput.setValue(hexColorString(settings.colorEnd));
  row.reversedButton.setOn(settings.reversed);
  syncValueField(row.opacityField, OPACITY_MAPPING, settings.opacity);
  row.direction.setSelected(settings.direction);
  row.animateSwitch.setOn(settings.animate);
  row.stabilitySwitch.setOn(settings.showStability);
  // 本数が1のときは族範囲の上限・色(終)・反転が意味を持たないので隠す。
  const single = settings.count <= 1;
  row.rangeMaxRow.classList.toggle('hidden', single);
  row.colorEndRow.classList.toggle('hidden', single);
  row.reversedRow.classList.toggle('hidden', single);
}

// 軌道ガイドタブの群タブ。GuideGroupId(データ分類)に「基本」を加えた UI 専用の型。
type GroupTab = 'basic' | GuideGroupId;
const GROUP_TABS: readonly GroupTab[] = ['basic', ...GUIDE_GROUPS];
const GROUP_TAB_STORAGE_KEY = 'tepui.orbitGuideGroupTab';

// 直前に選んでいた群タブ。壊れた保存データ・localStorage 不可では 'basic' へ戻す。
function loadGroupTab(): GroupTab {
  try {
    const raw = localStorage.getItem(GROUP_TAB_STORAGE_KEY);
    if (raw !== null && (GROUP_TABS as readonly string[]).includes(raw)) return raw as GroupTab;
  } catch {
    /* localStorage 不可なら既定へ */
  }
  return 'basic';
}

// 選んだ群タブを保存する。localStorage 不可なら諦める。
function saveGroupTab(tab: GroupTab): void {
  try {
    localStorage.setItem(GROUP_TAB_STORAGE_KEY, tab);
  } catch {
    /* localStorage 不可なら保存しない */
  }
}

export class OrbitGuideTab {
  public readonly element: HTMLElement;
  public onSettingsChange: ((settings: OrbitGuideSettings) => void) | null = null;

  private current: OrbitGuideSettings = DEFAULT_ORBIT_GUIDE_SETTINGS;
  private readonly kindDefs: ReadonlyMap<GuideGroupId, readonly KindDef[]>;
  private readonly combinedDefs: ReadonlyMap<GuideGroupId, readonly CombinedKindDef[]>;
  private readonly kindRows = new Map<string, KindRow>();
  private readonly combinedRows = new Map<string, CombinedKindRow>();
  private readonly systemSwitches = new Map<CatalogSystemId, ToggleSwitch>();
  private readonly geostationaryButton: Button;
  private readonly lissajousRow: {
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
  private sunSyncRow!: RepeatGroundTrackRow;
  private dawnDuskRow!: DawnDuskRow;
  private molniyaRow!: CriticalInclinationRow;
  private tundraRow!: CriticalInclinationRow;
  private readonly groupTabBar: TabBar<GroupTab>;
  private readonly groupTabBodies: ReadonlyMap<GroupTab, HTMLElement>;
  private selectedGroupTab: GroupTab;
  private readonly lineCountEl: HTMLElement;

  // availableFamilies から種類・小題の定義一覧を組み、群タブと各行の DOM を組み立てる。
  public constructor(availableFamilies: ReadonlyMap<CatalogSystemId, readonly string[]>) {
    const defs = buildKindDefs(availableFamilies);
    this.kindDefs = defs.kinds;
    this.combinedDefs = defs.combined;

    this.element = document.createElement('div');
    this.element.className = 'orbit-guide-tab';

    this.buildSystemRow(this.element);

    this.groupTabBar = new TabBar<GroupTab>(
      GROUP_TABS.map((tab) => [tab, GROUP_TAB_LABEL[tab]] as const), (tab) => this.selectGroupTab(tab),
    );
    this.groupTabBar.element.setAttribute('aria-label', '軌道の種類の群');
    this.element.appendChild(this.groupTabBar.element);

    const groupTabBodies = new Map<GroupTab, HTMLElement>();

    // 基本群: 静止軌道と、地球専用の参照軌道4種。いずれも軸(系)を持たない。
    const basicBody = this.buildGroupTabBody('basic');
    const basicRow = document.createElement('div');
    basicRow.className = 'orbit-guide-kind-heading';
    this.geostationaryButton = new Button('静止軌道(geostationary)', () => {
      const on = !this.current.geostationary;
      this.geostationaryButton.setOn(on);
      this.commit({ ...this.current, geostationary: on });
    });
    basicRow.appendChild(this.geostationaryButton.element);
    basicBody.appendChild(basicRow);
    this.sunSyncRow = buildSunSyncRow(basicBody, () => this.commitSunSync({ on: !this.current.sunSync.on }), (patch) => this.commitSunSync(patch));
    this.dawnDuskRow = buildDawnDuskRow(basicBody, () => this.commitDawnDusk({ on: !this.current.dawnDusk.on }), (patch) => this.commitDawnDusk(patch));
    this.molniyaRow = buildCriticalInclinationRow(
      basicBody, 'モルニヤ軌道(Molniya)', () => this.commitMolniya({ on: !this.current.molniya.on }), (patch) => this.commitMolniya(patch),
    );
    this.tundraRow = buildCriticalInclinationRow(
      basicBody, 'ツンドラ軌道(Tundra)', () => this.commitTundra({ on: !this.current.tundra.on }), (patch) => this.commitTundra(patch),
    );
    groupTabBodies.set('basic', basicBody);

    // 共線点群: 小題(CombinedKindDef)・族idごとに独立した種類に続けて、族を持たないリサジュー
    // 軌道行を積む。リサジュー軌道は共線点にしか無い専用行なので、他の群と分けて直線的に組む。
    const collinearBody = this.buildGroupTabBody('collinear');
    for (const def of this.combinedDefs.get('collinear') ?? []) this.buildCombinedKindRow(collinearBody, def);
    for (const def of this.kindDefs.get('collinear') ?? []) this.buildKindRow(collinearBody, def);
    this.lissajousRow = this.buildLissajousRow(collinearBody);
    groupTabBodies.set('collinear', collinearBody);

    // 残りの群(三角点/副天体周回/共鳴)。小題(CombinedKindDef)を先に、族idごとに独立した
    // 種類(蝶形・トンボ形・共鳴・DRO)をその後に並べる。
    for (const group of GUIDE_GROUPS) {
      if (group === 'collinear') continue;
      const body = this.buildGroupTabBody(group);
      for (const def of this.combinedDefs.get(group) ?? []) this.buildCombinedKindRow(body, def);
      for (const def of this.kindDefs.get(group) ?? []) this.buildKindRow(body, def);
      groupTabBodies.set(group, body);
    }
    this.groupTabBodies = groupTabBodies;

    for (const tab of GROUP_TABS) this.groupTabBar.buttonFor(tab)?.setAttribute('aria-controls', `orbit-guide-group-${tab}`);
    this.selectedGroupTab = loadGroupTab();
    this.groupTabBar.setSelected(this.selectedGroupTab);
    this.applyGroupTabVisibility();

    this.lineCountEl = document.createElement('p');
    this.lineCountEl.className = 'orbit-guide-line-count-warning hidden';
    this.element.appendChild(this.lineCountEl);
  }

  // 群タブ1枚ぶんの本体。選択中の群だけが表示される。
  private buildGroupTabBody(tab: GroupTab): HTMLElement {
    const el = document.createElement('div');
    el.className = 'orbit-guide-group-body';
    el.id = `orbit-guide-group-${tab}`;
    el.setAttribute('role', 'tabpanel');
    this.element.appendChild(el);
    return el;
  }

  // 群タブを切り替え、選択を保存して表示を引き直す。
  private selectGroupTab(tab: GroupTab): void {
    this.selectedGroupTab = tab;
    saveGroupTab(tab);
    this.groupTabBar.setSelected(tab);
    this.applyGroupTabVisibility();
  }

  // 選択中の群タブの本体だけを表示し、他は隠す。
  private applyGroupTabVisibility(): void {
    for (const [tab, el] of this.groupTabBodies) el.classList.toggle('hidden', tab !== this.selectedGroupTab);
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

  // 系トグル1つぶんの ON/OFF を正本へ反映する。
  private setSystem(system: CatalogSystemId, on: boolean): void {
    this.commit({ ...this.current, systems: { ...this.current.systems, [system]: on } });
  }

  // 本数・族範囲・色・進行方向・安定度の見せ方を並べた共有設定パネル(種類1行・小題1行の
  // 双方が使う)。getCurrent は族範囲・反転ボタンが「今の値」を読むためのもの。
  private buildSharedKindFields(
    configPanel: HTMLElement, getCurrent: () => GuideKindSharedSettings,
    onCommit: (patch: Partial<GuideKindSharedSettings>) => void, onResetColor: () => void,
  ): SharedKindFields {
    // 本数・族範囲(下限/上限が互いを追い越さないよう commit 前に min/max で挟む)。
    const countField = buildValueField('本数', COUNT_MAPPING, (v) => onCommit({ count: Math.round(v) }));
    configPanel.appendChild(countField.row);
    const rangeMinField = buildValueField('族の下限', RANGE_MAPPING, (v) => {
      const rangeMax = getCurrent().rangeMax;
      onCommit({ rangeMin: Math.min(v, rangeMax), rangeMax: Math.max(v, rangeMax) });
    });
    configPanel.appendChild(rangeMinField.row);
    const rangeMaxField = buildValueField('族の上限', RANGE_MAPPING, (v) => {
      const rangeMin = getCurrent().rangeMin;
      onCommit({ rangeMin: Math.min(rangeMin, v), rangeMax: Math.max(rangeMin, v) });
    });
    configPanel.appendChild(rangeMaxField.row);

    // 色(始・終)・反転。
    const colorStart = buildColorField('色(始)', 0, (v) => onCommit({ colorStart: v }));
    configPanel.appendChild(colorStart.row);
    const colorEnd = buildColorField('色(終)', 0, (v) => onCommit({ colorEnd: v }));
    configPanel.appendChild(colorEnd.row);

    const reversedButton = new Button('反転', () => {
      const next = !getCurrent().reversed;
      reversedButton.setOn(next);
      onCommit({ reversed: next });
    });
    const reversedRow = document.createElement('div');
    reversedRow.className = 'w-group orbit-guide-toggle-row';
    reversedRow.appendChild(reversedButton.element);
    configPanel.appendChild(reversedRow);

    // 透明度・進行方向マーカー・安定度の見せ方。
    const opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => onCommit({ opacity: v }));
    configPanel.appendChild(opacityField.row);

    const direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => onCommit({ direction: mode }));
    configPanel.appendChild(direction.element);

    const animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => onCommit({ animate: on }));
    configPanel.appendChild(animateSwitch.element);

    const stabilitySwitch = new ToggleSwitch('安定度を示す', (on) => onCommit({ showStability: on }));
    configPanel.appendChild(stabilitySwitch.element);

    const resetButton = new Button('色をリセット', onResetColor);
    const resetRow = document.createElement('div');
    resetRow.className = 'w-group orbit-guide-toggle-row';
    resetRow.appendChild(resetButton.element);
    configPanel.appendChild(resetRow);

    return {
      rangeMaxRow: rangeMaxField.row, colorEndRow: colorEnd.row, reversedRow, countField, rangeMinField, rangeMaxField,
      colorStartInput: colorStart.input, colorEndInput: colorEnd.input, reversedButton, opacityField, direction,
      animateSwitch, stabilitySwitch,
    };
  }

  // 種類1行(見出し+設定パネル)を組む。見出しの表示トグルが on のときだけ設定パネルを見せる。
  private buildKindRow(parent: HTMLElement, def: KindDef): void {
    // 見出し(表示トグル)を先に組み、その ON/OFF を toggleKind へつなぐ。
    const { heading, configPanel } = buildKindRowHeading(
      parent, def.label, () => this.toggleKind(def.id),
      def.group === 'resonant' ? 'orbit-guide-kind-heading-btn-resonant' : undefined,
    );

    // 続けて共有設定パネル。色リセットは同じ群内での index/count から既定色を引き直す。
    const shared = this.buildSharedKindFields(
      configPanel, () => this.current.kinds[def.id] ?? this.defaultKindFor(def.id),
      (patch) => this.commitKind(def.id, patch),
      () => {
        const count = this.kindDefs.get(def.group)?.length ?? 1;
        const colors = defaultColorsFor(def.group, def.index, count);
        this.commitKind(def.id, { colorStart: colors.start, colorEnd: colors.end });
      },
    );

    this.kindRows.set(def.id, { heading, configPanel, ...shared });
  }

  // 種類の表示トグルを反転させる。
  private toggleKind(id: string): void {
    const kind = this.current.kinds[id] ?? this.defaultKindFor(id);
    this.commitKind(id, { on: !kind.on });
  }

  // 種類 id に対応する既定設定を組む。id が属する群での並び順(index)から既定色を引く。
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

  // 種類 id の設定へ patch を重ねて正本を更新する。
  private commitKind(id: string, patch: Partial<GuideKindSettings>): void {
    const base = this.current.kinds[id] ?? this.defaultKindFor(id);
    this.commit({ ...this.current, kinds: { ...this.current.kinds, [id]: { ...base, ...patch } } });
  }

  // 小題1行(軸ボタン+共有設定パネル)を組む。軸ボタンは表示ON/OFFの複数選択トグルで、押した
  // 軸値すべての積を満たす族だけが表示される。押されている組み合わせが1つも無い間は共有設定
  // パネルを隠す(種類1行が on の間だけ設定を見せるのと同じ考え方)。
  private buildCombinedKindRow(parent: HTMLElement, def: CombinedKindDef): void {
    const root = document.createElement('div');
    root.className = 'orbit-guide-kind-row';

    const heading = document.createElement('div');
    heading.className = 'orbit-guide-kind-heading orbit-guide-combined-heading';
    heading.textContent = def.label;
    root.appendChild(heading);

    // value は settings.combinedKinds[key].axisValues のキーと一致する point/branch/ew/区間の
    // 生値。displayLabel はボタンの表示文字列だけに使い、判定には使わない。
    const axisButtons = new Map<string, Button>();
    // 軸1つぶんのボタン行。def が持たない軸(entries が空)は行ごと出さない。
    const buildAxisRow = (label: string, entries: readonly (readonly [string, string])[]): void => {
      if (entries.length === 0) return;
      const row = document.createElement('div');
      row.className = 'w-group orbit-guide-toggle-row';
      const rowLabel = document.createElement('span');
      rowLabel.className = 'w-group-title';
      rowLabel.textContent = label;
      row.appendChild(rowLabel);
      for (const [value, displayLabel] of entries) {
        const btn = new Button(displayLabel, () => this.commitCombinedAxis(def.key, value, !this.isAxisValueOn(def.key, value)));
        row.appendChild(btn.element);
        axisButtons.set(value, btn);
      }
      root.appendChild(row);
    };
    buildAxisRow('点', def.pointValues.map((v) => [v, v] as const));
    buildAxisRow('南北', def.branchValues.map((v) => [v, v === 'N' ? '北' : '南'] as const));
    buildAxisRow('東西', def.ewValues.map((v) => [v, v === 'E' ? '東' : '西'] as const));
    buildAxisRow('区間', def.segmentValues.map((v) => [String(v), v === 0 ? '基本' : `区間${v}`] as const));

    const configPanel = document.createElement('div');
    configPanel.className = 'orbit-guide-kind-config hidden';
    root.appendChild(configPanel);

    const shared = this.buildSharedKindFields(
      configPanel, () => this.current.combinedKinds[def.key] ?? this.defaultCombinedFor(def),
      (patch) => this.commitCombined(def.key, patch),
      () => {
        const count = this.combinedDefs.get(def.group)?.length ?? 1;
        const colors = defaultColorsFor(def.group, def.index, count);
        this.commitCombined(def.key, { colorStart: colors.start, colorEnd: colors.end });
      },
    );

    parent.appendChild(root);
    this.combinedRows.set(def.key, { configPanel, axisButtons, ...shared });
  }

  // 軸値表示ラベル('北'/'南'/'区間1'/'基本' 等)と axisValues のキーは一致させている
  // (buildAxisRow が渡す value がそのままキーになる)。
  private isAxisValueOn(key: string, axisValue: string): boolean {
    return this.current.combinedKinds[key]?.axisValues[axisValue] ?? false;
  }

  // 小題 def に対応する既定設定を組む。def が見つからない(null)ときは無難な灰色を返す。
  private defaultCombinedFor(def: CombinedKindDef | null): CombinedKindSettings {
    if (def === null) return defaultCombinedKindSettings(0x808080, 0xc0c0c0);
    const count = this.combinedDefs.get(def.group)?.length ?? 1;
    const colors = defaultColorsFor(def.group, def.index, count);
    return defaultCombinedKindSettings(colors.start, colors.end);
  }

  // key(`${group}-${base}`)から小題定義を探す。見つからなければ null。
  private findCombinedDef(key: string): CombinedKindDef | null {
    for (const defs of this.combinedDefs.values()) {
      const def = defs.find((d) => d.key === key);
      if (def !== undefined) return def;
    }
    return null;
  }

  // 小題 key の軸値1つぶんの ON/OFF を正本へ反映する。
  private commitCombinedAxis(key: string, axisValue: string, on: boolean): void {
    const base = this.current.combinedKinds[key] ?? this.defaultCombinedFor(this.findCombinedDef(key));
    this.commit({
      ...this.current,
      combinedKinds: { ...this.current.combinedKinds, [key]: { ...base, axisValues: { ...base.axisValues, [axisValue]: on } } },
    });
  }

  // 小題 key の設定へ patch を重ねて正本を更新する。
  private commitCombined(key: string, patch: Partial<GuideKindSharedSettings>): void {
    const base = this.current.combinedKinds[key] ?? this.defaultCombinedFor(this.findCombinedDef(key));
    this.commit({ ...this.current, combinedKinds: { ...this.current.combinedKinds, [key]: { ...base, ...patch } } });
  }

  // リサジュー軌道の行(族を持たないので専用の設定項目を並べる)。
  private buildLissajousRow(parent: HTMLElement): OrbitGuideTab['lissajousRow'] {
    const { heading, configPanel } = buildKindRowHeading(parent, 'リサジュー軌道', () => {
      const on = !this.current.lissajous.on;
      this.commit({ ...this.current, lissajous: { ...this.current.lissajous, on } });
    });

    // 起動する共線点(L1〜L3)の複数選択トグル。
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

    // 振幅・位相・周回数。
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

    // 色・透明度・進行方向マーカー。族を持たないので色は単色(colorStart のみ)。
    const colorField = buildColorField('色', 0, (v) => this.commitLissajous({ colorStart: v }));
    configPanel.appendChild(colorField.row);
    const opacityField = buildValueField('透明度', OPACITY_MAPPING, (v) => this.commitLissajous({ opacity: v }));
    configPanel.appendChild(opacityField.row);
    const direction = new SegmentedControl<DirectionMarkerMode>('進行方向', DIRECTION_ITEMS, (mode) => this.commitLissajous({ direction: mode }));
    configPanel.appendChild(direction.element);
    const animateSwitch = new ToggleSwitch('進行方向のアニメーション', (on) => this.commitLissajous({ animate: on }));
    configPanel.appendChild(animateSwitch.element);

    return {
      heading, configPanel, pointButtons, inPlaneField, outOfPlaneField, inPlanePhaseField, outOfPlanePhaseField,
      cyclesField, colorInput: colorField.input, opacityField, direction, animateSwitch,
    };
  }

  // リサジュー軌道の設定へ patch を重ねて正本を更新する。
  private commitLissajous(patch: Partial<LissajousSettings>): void {
    this.commit({ ...this.current, lissajous: { ...this.current.lissajous, ...patch } });
  }

  // 太陽同期準回帰軌道の設定へ patch を重ねて正本を更新する。
  private commitSunSync(patch: Partial<SunSyncSettings>): void {
    this.commit({ ...this.current, sunSync: { ...this.current.sunSync, ...patch } });
  }

  // ドーンダスク軌道の設定へ patch を重ねて正本を更新する。
  private commitDawnDusk(patch: Partial<DawnDuskSettings>): void {
    this.commit({ ...this.current, dawnDusk: { ...this.current.dawnDusk, ...patch } });
  }

  // モルニヤ軌道の設定へ patch を重ねて正本を更新する。
  private commitMolniya(patch: Partial<CriticalInclinationSettings>): void {
    this.commit({ ...this.current, molniya: { ...this.current.molniya, ...patch } });
  }

  // ツンドラ軌道の設定へ patch を重ねて正本を更新する。
  private commitTundra(patch: Partial<CriticalInclinationSettings>): void {
    this.commit({ ...this.current, tundra: { ...this.current.tundra, ...patch } });
  }

  // 正本を差し替え、見た目を鏡映しへ合わせて呼び出し側へ通知する。
  private commit(next: OrbitGuideSettings): void {
    this.current = next;
    this.syncAll();
    this.onSettingsChange?.(this.current);
  }

  // 正本(this.current)から全ての行の見た目を引き直す。
  private syncAll(): void {
    this.geostationaryButton.setOn(this.current.geostationary);
    for (const [system, sw] of this.systemSwitches) sw.setOn(this.current.systems[system] ?? false);

    // 種類1行: 見出しの表示トグルと configPanel の表示有無は on 一本で決まる。
    for (const [id, row] of this.kindRows) {
      const kind = this.current.kinds[id] ?? this.defaultKindFor(id);
      row.heading.setOn(kind.on);
      row.configPanel.classList.toggle('hidden', !kind.on);
      syncSharedKindFields(row, kind);
    }

    // 小題1行: 軸ボタンの点灯を先に決め、押されている軸値が1つでもあれば configPanel を見せる。
    for (const [key, row] of this.combinedRows) {
      const combined = this.current.combinedKinds[key] ?? this.defaultCombinedFor(this.findCombinedDef(key));
      let anyOn = false;
      for (const [value, btn] of row.axisButtons) {
        const on = combined.axisValues[value] ?? false;
        btn.setOn(on);
        anyOn ||= on;
      }
      row.configPanel.classList.toggle('hidden', !anyOn);
      syncSharedKindFields(row, combined);
    }

    // リサジュー軌道行: 族を持たないので専用フィールドを個別に反映する。
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

    // 地球専用参照軌道4種(基本群)。
    syncSunSyncRow(this.sunSyncRow, this.current.sunSync);
    syncDawnDuskRow(this.dawnDuskRow, this.current.dawnDusk);
    syncCriticalInclinationRow(this.molniyaRow, this.current.molniya);
    syncCriticalInclinationRow(this.tundraRow, this.current.tundra);
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

const GROUP_TAB_LABEL: Readonly<Record<GroupTab, string>> = {
  basic: '基本', collinear: '共線点', triangular: '三角点', secondary: '副天体周回', resonant: '共鳴',
};

const ALL_SYSTEMS: readonly CatalogSystemId[] = [
  'earth-moon', 'sun-earth', 'sun-mars', 'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];
const SYSTEM_LABEL: Readonly<Record<CatalogSystemId, string>> = {
  'earth-moon': '地球-月系', 'sun-earth': '太陽-地球系', 'sun-mars': '太陽-火星系',
  'jupiter-europa': '木星-エウロパ系', 'saturn-titan': '土星-タイタン系',
  'saturn-enceladus': '土星-エンケラドス系', 'mars-phobos': '火星-フォボス系',
};
