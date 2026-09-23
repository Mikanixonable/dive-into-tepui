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
      initialLiquidMassKgM2: 0.00025, initialIceMassKgM2: 0.00075,
    },
  },
  c2: {
    operation: '下層を東向き10 m/s、上層を北向き10 m/sへ分離した二層風',
    controlledInputs: { lowerEastWindMps: 10, upperNorthWindMps: 10, source: 'same' },
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
      measurement('trajectory', '球面移流軌跡誤差', 'm', 'distance to analytic equatorial great-circle path', 'finite cloud mask', 0, '0.01 m 以下', 'analytic'),
      measurement('mass', '相対質量誤差', '1',
        'absolute difference between transported cohort mass and independently fixed initial mass, divided by initial mass',
        'finite cloud material cohorts', 0, '初期質量 0.001 kg m^-2 に対し 1% 以下', 'analytic'),
    ] },
  C2: { id: 'C2', label: '高度別の風向', ...CONTROLS.c2, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('layer-displacement', '解析解に対する高度別変位誤差', 'm', 'maximum distance error of lower/upper parcel tracks', 'lower and upper parcel tracks', 0, '各層の解析的大円移流に対し 0.05 m 以下', 'analytic'),
      measurement('released-ice-track', '代表放出氷の軌跡誤差', 'm',
        'distance from analytic lower-east-then-upper-north spherical transport',
        'surviving ice representative cohort', 0, '解析的な二高度の球面軌跡との差 0.05 m 以下', 'analytic'),
    ] },
  C3: { id: 'C3', label: '供給停止後のかなとこ', ...CONTROLS.c3, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 1_440, sampleIntervalMinutes: 10 }, measurements: [
      measurement('anvil-residual', '供給停止後の残存氷面密度', 'kg m^-2', 'released ice remaining at supply stop', 'controlled event', 0, '供給停止時に 0 kg m^-2 より大きい'),
      measurement('anvil-lifetime', 'かなとこ残存寿命', 'min', 'first-to-last valid anvil sample', 'anvil mask', 0, 'イベント寿命評価と独立観測基準がなく blocked', 'observationSeries'),
    ] },
  C4: { id: 'C4', label: '上層湿度と昇華', ...CONTROLS.c4, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('sublimation-loss', '乾燥時と湿潤時のイベント損失差', 'kg m^-2', 'dry loss minus moist loss at 6 h', 'controlled event', 0, '0 kg m^-2 より大きい。観測校正なしのモデル応答'),
      measurement('residual-lifetime', '残存氷寿命', 'min', 'mass threshold crossing time', 'ice support', 0, 'イベント lifetime 評価・観測校正がなく blocked'),
      measurement('residual-ice-difference', '乾燥時と湿潤時の残存氷差', 'kg m^-2', 'dry remaining ice minus moist remaining ice at 6 h', 'controlled event', 0, '0 kg m^-2 未満'),
    ] },
  C5: { id: 'C5', label: '逆転層による上昇抑制', ...CONTROLS.c5, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('convective-top', '正浮力parcelの最大高度差', 'm', 'strong minus weak inversion positive-buoyancy top', 'parcel profile', 0, '0 m 未満'),
      measurement('deep-penetration', '深い対流への貫通', '1', 'deep-convective connected-component share', 'convective support', 0, '連結雲形状がなく blocked'),
    ] },
  C6: { id: 'C6', label: '氷量・粒径・光学厚', ...CONTROLS.c6, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 1_440, sampleIntervalMinutes: 10 }, measurements: [
      measurement('supply-response', '供給率2倍時の面密度比', '1', 'mass at 2x supply / base-supply mass', 'same controlled event', 0, '2.0 ± 1e-12', 'analytic'),
      measurement('particle-size-response', '氷粒子数2倍時の有効半径比', '1', 'radius at 2x number / base-number radius', 'same ice mass and air density', 0, '2^(-1/3) ± 1e-12', 'analytic'),
      measurement('mass-balance', '物質収支相対残差', '1', 'abs(initial + supply - loss - current) / (initial + supply)', 'controlled event ledger', 0, '1e-12 以下', 'numeric'),
      measurement('non-negative', '水相の最小質量', 'kg m^-2', 'minimum of initial/supplied/lost/liquid/ice masses', 'controlled event ledger', 0, '0 kg m^-2 以上'),
      measurement('optical-closure', '粒径から光学厚への相対残差', '1', 'API tau versus geometric-optics equation', 'controlled ice column', 1e-12, '1e-12 以下', 'analytic'),
    ] },
  C7: { id: 'C7', label: '波源と物質風', ...CONTROLS.c7, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('wave-track', '分散関係による波の位相移動', 'm', 'linear Boussinesq phase speed times duration', 'prescribed wave mode', 0, '分散関係の解析値との差 1e-8 m 以下', 'analytic'),
      measurement('material-track', '上層風によるparcel移流', 'm', 'spherical parcel displacement', 'controlled parcel', 0, '一定風の解析的大円移流との差 0.05 m 以下', 'analytic'),
      measurement('wave-cloud-condensation', '湿潤制御の波状雲成立', '1', 'ice saturation after dry-adiabatic wave lift', 'wave source level', 0, '湿潤条件で 1'),
      measurement('dry-wave-cloud-control', '乾燥対照の波状雲不成立', '1', 'ice saturation after dry-adiabatic wave lift', 'wave source level', 0, '乾燥条件で 0'),
      measurement('directional-spectrum', '方向別パワー', '1', 'directional spatial spectrum', 'valid spectral band', 1e-3, '格子状密度場がなく blocked'),
    ] },
  C8: { id: 'C8', label: '海洋境界層セル', ...CONTROLS.c8, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: { startMinutes: 0, endMinutes: 360, sampleIntervalMinutes: 10 }, measurements: [
      measurement('hole-fraction', 'セルの穴率', '1', 'clear-area share within cell mask', 'ocean boundary-layer mask', 1e-3, '海洋境界層セル場がなく blocked', 'observationSeries'),
      measurement('cell-size', 'セル径', 'km', 'connected-cell equivalent diameter', 'ocean boundary-layer mask', 0, '海洋境界層セル場がなく blocked', 'observationSeries'),
      measurement('cell-lifetime', 'セル寿命', 'min', 'connected-cell persistence', 'ocean boundary-layer mask', 0, '海洋境界層イベントがなく blocked', 'observationSeries'),
    ] },
  C9: { id: 'C9', label: '二雲層の空隙と視差', ...CONTROLS.c9, atmosphericLayers: STANDARD_LAYERS,
    measurementWindow: COMMON_WINDOW, measurements: [
      measurement('layer-gap', '雲層間空隙', 'm', 'minimum density between layer supports', 'between-layer mask', 1e-3, '多層雲密度場がなく blocked'),
      measurement('parallax', '高度による視差', 'px', 'projected centroid separation by layer', 'both layer masks', 0, '多層投影形状がなく blocked'),
      measurement('shadow-support', '影の支持域', 'm2', 'shadow support from shared 3D field', 'shadow-valid mask', 1e-3, '共有3D密度と影形状がなく blocked'),
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
