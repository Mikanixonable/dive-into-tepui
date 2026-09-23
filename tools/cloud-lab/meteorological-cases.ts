// C1〜C9 の制御実験と、雲ラボが撮影する固定系列の入力・観測演算子・独立基準・誤差床を宣言する。

export type MeteorologicalCaseId =
  | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9';

export type ReferenceKind = 'analytic' | 'numeric' | 'observationSeries';

export interface AtmosphericLayerInput {
  readonly bottomAltitudeM: number;
  readonly topAltitudeM: number;
  readonly temperatureK: number;
  readonly pressurePa: number;
  readonly specificHumidityKgPerKg: number;
  readonly eastWindMps: number;
  readonly northWindMps: number;
  readonly verticalVelocityMps: number;
}

export interface MeasurementContract {
  readonly id: string;
  readonly quantity: string;
  readonly unit: string;
  readonly operator: string;
  readonly mask: string;
  readonly independentReference: {
    readonly kind: ReferenceKind;
    readonly status: 'not-provided';
    readonly artifact: null;
  };
  readonly uncertaintyFloor: number;
  readonly acceptance: string;
}

export interface MeteorologicalCaseFixture {
  readonly id: MeteorologicalCaseId;
  readonly label: string;
  readonly operation: string;
  readonly controlledInputs: Readonly<Record<string, string | number | boolean>>;
  readonly atmosphericLayers: readonly AtmosphericLayerInput[];
  readonly measurementWindow: {
    readonly startMinutes: number;
    readonly endMinutes: number;
    readonly sampleIntervalMinutes: number;
  };
  readonly measurements: readonly MeasurementContract[];
}

const STANDARD_LAYERS: readonly AtmosphericLayerInput[] = [
  {
    bottomAltitudeM: 0,
    topAltitudeM: 2_000,
    temperatureK: 293,
    pressurePa: 101_325,
    specificHumidityKgPerKg: 0.012,
    eastWindMps: 8,
    northWindMps: 0,
    verticalVelocityMps: 0,
  },
  {
    bottomAltitudeM: 8_000,
    topAltitudeM: 12_000,
    temperatureK: 223,
    pressurePa: 26_500,
    specificHumidityKgPerKg: 0.0004,
    eastWindMps: 12,
    northWindMps: 0,
    verticalVelocityMps: 0,
  },
] as const;

const CONTROLS = {
  c1: {
    operation: '非発散の剛体回転風・無供給・無損失の有限雲塊',
    controlledInputs: {
      windField: 'solid-body spherical rotation', supply: 0, loss: 0,
    },
  },
  c2: {
    operation: '下層を東向き、上層を北向きへ分離した二層風',
    controlledInputs: { lowerWindDirection: 'east', upperWindDirection: 'north', source: 'same' },
  },
  c3: {
    operation: '発達した対流からの供給を指定時刻で停止',
    controlledInputs: { supplyBeforeMinutes: 60, supplyAfterMinutes: 0, transport: 'fixed' },
  },
  c4: {
    operation: '温度・輸送を固定し、上層湿度だけを下げる',
    controlledInputs: { fixed: 'temperature and transport', changed: 'upper humidity' },
  },
  c5: {
    operation: '地表供給を固定し、境界層上の逆転層を強める',
    controlledInputs: { fixed: 'surface supply', changed: 'inversion strength', deepConvectionBypass: false },
  },
  c6: {
    operation: '氷量・粒径・厚さを一因子ずつ変え、供給停止後を追跡',
    controlledInputs: { changedOneAtATime: true, supplyAfterMinutes: 0, phases: 'ice' },
  },
  c7: {
    operation: '波源・安定度・湿度・物質風を一因子ずつ変える',
    controlledInputs: { changedOneAtATime: true, waveAndMaterialTracks: 'separate' },
  },
  c8: {
    operation: '海洋境界層の冷却・降水・連行・地表供給を一因子ずつ変える',
    controlledInputs: { changedOneAtATime: true, surface: 'ocean boundary layer' },
  },
  c9: {
    operation: '低層と上層の二雲層を高度差を保って配置',
    controlledInputs: { lowerLayerAltitudeM: 1_000, upperLayerAltitudeM: 10_000, windDirections: 'different' },
  },
} as const;

const measurement = (
  id: string, quantity: string, unit: string, operator: string, mask: string,
  uncertaintyFloor: number, acceptance: string, kind: ReferenceKind = 'numeric',
): MeasurementContract => ({
  id, quantity, unit, operator, mask,
  independentReference: { kind, status: 'not-provided', artifact: null },
  uncertaintyFloor, acceptance,
});

const COMMON_WINDOW = { startMinutes: 0, endMinutes: 360, sampleIntervalMinutes: 10 } as const;

export const METEOROLOGICAL_CASES: Readonly<Record<MeteorologicalCaseId, MeteorologicalCaseFixture>> = {
  C1: { id: 'C1', label: '球面剛体回転', ...CONTROLS.c1, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('trajectory', '球面移流軌跡誤差', 'm', 'analytic spherical advection distance', 'finite cloud mask', 0, '標準近距離の最小標本間隔の 1/4 以下', 'analytic'),
      measurement('mass', '相対質量誤差', '1', 'abs(current - initial) / initial', 'finite cloud mask', 0, '1% 以下', 'analytic'),
    ] },
  C2: { id: 'C2', label: '高度別の風向', ...CONTROLS.c2, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('layer-displacement', '層別変位', 'm', 'centroid displacement by altitude layer', 'layer support', 0, '下層は東、上層は北の応答符号を保つ'),
      measurement('released-ice-track', '放出氷の移流方向', 'deg', 'wind-relative angular displacement', 'released ice mask', 0, '上層風下へ運ばれる'),
    ] },
  C3: { id: 'C3', label: '供給停止後のかなとこ', ...CONTROLS.c3, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 1_440, sampleIntervalMinutes: 10 }, measurements: [
      measurement('anvil-residual', '供給停止後の残存量', 'kg', 'integrated released ice mass', 'anvil mask', 0, '停止直後に同時消失しない'),
      measurement('anvil-lifetime', 'かなとこ残存寿命', 'min', 'first-to-last valid anvil sample', 'anvil mask', 0, '独立基準系列の分布内', 'observationSeries'),
    ] },
  C4: { id: 'C4', label: '上層湿度と昇華', ...CONTROLS.c4, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('sublimation-loss', '昇華損失', 'kg', 'integrated ice sublimation loss', 'ice support', 0, '湿度低下で増加'),
      measurement('residual-lifetime', '残存氷寿命', 'min', 'mass threshold crossing time', 'ice support', 0, '湿度低下で短縮'),
    ] },
  C5: { id: 'C5', label: '逆転層による上昇抑制', ...CONTROLS.c5, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('convective-top', '対流頂高度', 'm', 'maximum connected convective height', 'convective support', 0, '逆転層強化で低下'),
      measurement('deep-penetration', '深い対流への貫通', '1', 'deep-convective connected-component share', 'convective support', 0, '自動的に貫通しない'),
    ] },
  C6: { id: 'C6', label: '氷量・粒径・光学厚', ...CONTROLS.c6, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 1_440, sampleIntervalMinutes: 10 }, measurements: [
      measurement('mass-balance', '物質収支残差', '1', 'abs(initial + supply - loss - current) / (initial + supply)', 'all water phases', 0, '1% 以下'),
      measurement('non-negative', '水相非負性違反', '1', 'minimum phase mass', 'all water phases', 0, '負値を clamp せず 0 以上'),
      measurement('optical-closure', '粒径から光学厚への連鎖', '1', 'closed optical operator residual', 'ice support', 1e-3, '同じ粒径閉包と整合'),
    ] },
  C7: { id: 'C7', label: '波源と物質風', ...CONTROLS.c7, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('wave-track', '波の軌跡', 'm', 'phase-track displacement', 'wave cloud mask', 0, '波源なし・未飽和で同じ模様が残らない'),
      measurement('material-track', '物質の軌跡', 'm', 'cloud-mass centroid displacement', 'material mask', 0, '波の軌跡と独立に移動'),
      measurement('directional-spectrum', '方向別パワー', '1', 'directional spatial spectrum', 'valid spectral band', 1e-3, '方向別に比較可能'),
    ] },
  C8: { id: 'C8', label: '海洋境界層セル', ...CONTROLS.c8, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 360, sampleIntervalMinutes: 10 }, measurements: [
      measurement('hole-fraction', 'セルの穴率', '1', 'clear-area share within cell mask', 'ocean boundary-layer mask', 1e-3, '参照分布の許容域内', 'observationSeries'),
      measurement('cell-size', 'セル径', 'km', 'connected-cell equivalent diameter', 'ocean boundary-layer mask', 0, '参照分布の許容域内', 'observationSeries'),
      measurement('cell-lifetime', 'セル寿命', 'min', 'connected-cell persistence', 'ocean boundary-layer mask', 0, '参照分布の許容域内', 'observationSeries'),
    ] },
  C9: { id: 'C9', label: '二雲層の空隙と視差', ...CONTROLS.c9, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('layer-gap', '雲層間空隙', 'm', 'minimum density between layer supports', 'between-layer mask', 1e-3, '空隙を保持'),
      measurement('parallax', '高度による視差', 'px', 'projected centroid separation by layer', 'both layer masks', 0, '視点変更で高度差に応じて変化'),
      measurement('shadow-support', '影の支持域', 'm2', 'shadow support from shared 3D field', 'shadow-valid mask', 1e-3, '低層・上層を混同しない'),
    ] },
} as const;

export const METEOROLOGICAL_CASE_IDS: readonly MeteorologicalCaseId[] = [
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9',
];

export const METEOROLOGICAL_ERROR_FLOORS = {
  c1TrajectoryFractionOfMinimumSample: 0.25,
  relativeMass: 0.01,
  normalizedMassBalance: 0.01,
  normalizedDensity: 2e-3,
  gpuComponentLeakage: 1e-3,
  emptyCaseAbsolute: 1e-9,
} as const;

export type CloudReferenceSeriesId = 'marine-cell' | 'deep-convection' | 'wave-cloud' | 'midlatitude-front';

export interface CloudReferenceSeries {
  readonly id: CloudReferenceSeriesId;
  readonly label: string;
  readonly durationHours: number;
  readonly intervalMinutes: number;
  readonly extraDurationsHours: readonly number[];
  readonly visualModes: readonly string[];
  readonly nightVisible: false;
}

export const CLOUD_REFERENCE_SERIES: readonly CloudReferenceSeries[] = [
  { id: 'marine-cell', label: '海洋境界層セル', durationHours: 6, intervalMinutes: 10,
    extraDurationsHours: [], visualModes: ['nadir', 'oblique', 'limb'], nightVisible: false },
  { id: 'deep-convection', label: '深い対流とかなとこ', durationHours: 6, intervalMinutes: 10,
    extraDurationsHours: [12, 24], visualModes: ['nadir', 'oblique', 'limb'], nightVisible: false },
  { id: 'wave-cloud', label: '鱗状・波状雲', durationHours: 6, intervalMinutes: 10,
    extraDurationsHours: [], visualModes: ['nadir', 'oblique', 'limb'], nightVisible: false },
  { id: 'midlatitude-front', label: '中緯度前線と多層雲', durationHours: 6, intervalMinutes: 10,
    extraDurationsHours: [12], visualModes: ['nadir', 'oblique', 'limb'], nightVisible: false },
];

export const CLOUD_LAB_SERIES_TIMES_HOURS: readonly number[] = [0, 1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6, 1, 2, 4, 6, 12, 24];
