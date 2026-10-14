// 鍵 tepui.settings.graphics に保存された平らな値一式を、同じ絵になる選び方へ読み替える。その保存値の意味は
// ここで凍結する — 既定・受け入れる候補・段の表はこのモジュールが写しとして持ち、本番の値が後で変わっても
// 読み替えた絵は変わらない。

import { FILM_LUT_ITEMS, FILM_LUT_NONE } from './pipeline/film-lut';
import { DEFAULT_GRAPHICS_SELECTION, selectionOfGraphics, type GraphicsSelection } from './graphics-selection';
import type { GraphicsSettingsData } from './graphics-settings';

// 保存された項目 1 つ。items が候補の並びならその候補だけを、null なら真偽だけを受け入れる。
// initial は保存に無い・受け入れられないときの値。
interface LegacyOption {
  readonly items: readonly (number | string)[] | null;
  readonly initial: boolean | number | string;
}

const LEGACY_OPTIONS = {
  resolutionScale: { items: [0.5, 0.75, 1], initial: 1 },
  lodBias: { items: [0.5, 1, 2], initial: 2 },
  exposureCompensation: { items: [0.25, 0.5, 1, 2, 4], initial: 1 },
  // ルックの候補は同梱の .cube で決まる。消えた .cube を指す保存値は「なし」へ落ちる。
  filmLut: { items: FILM_LUT_ITEMS.map(([id]) => id), initial: FILM_LUT_NONE },
  antialias: { items: [0, 1, 2], initial: 2 },
  pointField: { items: null, initial: true },
  rings: { items: null, initial: true },
  aurora: { items: null, initial: true },
  atmosphere: { items: [0, 1, 2, 3], initial: 3 },
  airglow: { items: null, initial: true },
  clouds: { items: null, initial: true },
  cloudFieldSource: { items: ['observed', 'generated'], initial: 'generated' },
  cirrus: { items: null, initial: true },
  translucentCumulus: { items: null, initial: true },
  cumulusDetail: { items: [0, 1, 2, 3], initial: 2 },
  lens: { items: null, initial: true },
  proteinVibration: { items: null, initial: true },
  sunLightModel: { items: [0, 1], initial: 1 },
  planetLightModel: { items: [0, 1], initial: 1 },
  planetLightCount: { items: [0, 1, 2], initial: 2 },
  ambient: { items: null, initial: true },
  screenSpaceDiffuse: { items: [0, 1, 2], initial: 2 },
  screenSpaceQuality: { items: [0, 1, 2], initial: 1 },
  screenSpaceSpecular: { items: null, initial: true },
  screenSpaceSpecularQuality: { items: [0, 1, 2], initial: 1 },
  screenSpaceSpecularDenoise: { items: null, initial: true },
  meshShadow: { items: null, initial: true },
  cumulusShadow: { items: null, initial: true },
  shadowSlotCount: { items: [1, 2, 4], initial: 4 },
  shadowSlotSize: { items: [512, 1024, 2048], initial: 1024 },
  shadowTexelsPerPixel: { items: [0.5, 1, 2], initial: 1 },
} as const satisfies Readonly<Record<string, LegacyOption>>;

type LegacyKey = keyof typeof LEGACY_OPTIONS;
type LegacyValue<O> = O extends { readonly items: readonly (infer V)[] } ? V : boolean;
type LegacyValues = { readonly [K in LegacyKey]: LegacyValue<(typeof LEGACY_OPTIONS)[K]> };

// 積雲の精細さの段ごとの、雲頂を探す刻みの数と縁を締める二分の回数。段 0 はオフ。
const SAMPLING_OF_DETAIL = {
  0: { march: 0, refine: 0 },
  1: { march: 1, refine: 5 },
  2: { march: 6, refine: 3 },
  3: { march: 12, refine: 3 },
} as const;
const CUMULUS_DETAIL_OFF = 0;
const CUMULUS_DETAIL_STANDARD = 2;

// 大気の段ごとの、大気ぜんぶへ配るサンプル点の合計。段 0 はオフ。
const TOTAL_SAMPLES_OF_QUALITY = { 0: 0, 1: 8, 2: 16, 3: 24 } as const;
const ATMOSPHERE_OFF = 0;

// 遮蔽と照り返しの精細さの段ごとの、走査のスライス数と片側の歩数。
const SCAN_TIERS = {
  0: { sliceCount: 2, stepCount: 3 },
  1: { sliceCount: 4, stepCount: 5 },
  2: { sliceCount: 4, stepCount: 6 },
} as const;
const SCREEN_SPACE_DIFFUSE_OFF = 0;
const SCREEN_SPACE_DIFFUSE_INDIRECT = 2;

// 映り込みの精細さの段ごとの、追跡の解像度と歩数。
const TRACE_TIERS = {
  0: { scale: 0.5, stepCount: 16 },
  1: { scale: 0.5, stepCount: 32 },
  2: { scale: 1, stepCount: 48 },
} as const;

// value が保存値として重ねられるオブジェクトか。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 保存された値一式 saved を既定の上へ重ねる。表に無いキーは読まず、候補外の値は既定にする。LegacyValues は
// 表から導いた型で、候補の検査がそれを保証するので as での断定は安全。
function acceptedLegacyValues(saved: Record<string, unknown>): LegacyValues {
  const options: Readonly<Record<string, LegacyOption>> = LEGACY_OPTIONS;
  return Object.fromEntries(Object.entries(options).map(([key, option]) => {
    const value = saved[key];
    const accepted = option.items === null
      ? typeof value === 'boolean'
      : option.items.some((candidate) => candidate === value);
    return [key, accepted ? value : option.initial];
  })) as LegacyValues;
}

// 保存された値一式を、段を表どおりのノブの値へ展開した平らな値一式にする。積雲の精細さのオフは積雲の立体の
// オフと標準の刻み・二分に、遮蔽と照り返しの方式は有無と照り返しの真偽になる。
function expandedValues(legacy: LegacyValues): GraphicsSettingsData {
  // 段の表を引く。
  const sampling = SAMPLING_OF_DETAIL[
    legacy.cumulusDetail === CUMULUS_DETAIL_OFF ? CUMULUS_DETAIL_STANDARD : legacy.cumulusDetail];
  const scan = SCAN_TIERS[legacy.screenSpaceQuality];
  const trace = TRACE_TIERS[legacy.screenSpaceSpecularQuality];
  // 分野の順に、そのまま写す値と段から展開した値を並べる。
  return {
    resolutionScale: legacy.resolutionScale,
    antialias: legacy.antialias,
    lodBias: legacy.lodBias,
    sunLightModel: legacy.sunLightModel,
    planetLightModel: legacy.planetLightModel,
    planetLightCount: legacy.planetLightCount,
    ambient: legacy.ambient,
    meshShadow: legacy.meshShadow,
    shadowSlotCount: legacy.shadowSlotCount,
    shadowSlotSize: legacy.shadowSlotSize,
    shadowTexelsPerPixel: legacy.shadowTexelsPerPixel,
    clouds: legacy.clouds,
    cloudFieldSource: legacy.cloudFieldSource,
    cirrus: legacy.cirrus,
    translucentCumulus: legacy.translucentCumulus,
    cumulus: legacy.cumulusDetail !== CUMULUS_DETAIL_OFF,
    cumulusMarchSteps: sampling.march,
    cumulusRefineSteps: sampling.refine,
    cumulusShadow: legacy.cumulusShadow,
    atmosphere: legacy.atmosphere !== ATMOSPHERE_OFF,
    atmosphereSampleBudget: TOTAL_SAMPLES_OF_QUALITY[legacy.atmosphere],
    airglow: legacy.airglow,
    aurora: legacy.aurora,
    screenSpaceOcclusion: legacy.screenSpaceDiffuse !== SCREEN_SPACE_DIFFUSE_OFF,
    screenSpaceIndirect: legacy.screenSpaceDiffuse === SCREEN_SPACE_DIFFUSE_INDIRECT,
    screenSpaceSliceCount: scan.sliceCount,
    screenSpaceStepCount: scan.stepCount,
    screenSpaceTimeConstant: 8,
    screenSpaceSpecular: legacy.screenSpaceSpecular,
    screenSpaceSpecularScale: trace.scale,
    screenSpaceSpecularStepCount: trace.stepCount,
    screenSpaceSpecularDenoise: legacy.screenSpaceSpecularDenoise,
    pointField: legacy.pointField,
    rings: legacy.rings,
    lens: legacy.lens,
    proteinVibration: legacy.proteinVibration,
    exposureCompensation: legacy.exposureCompensation,
    filmLut: legacy.filmLut,
  };
}

// 保存された文字列を、同じ絵になる選び方へ読み替える。壊れた文字列と null は保存が無いときの選び方。
export function parseLegacyGraphics(text: string | null): GraphicsSelection {
  if (text === null) return DEFAULT_GRAPHICS_SELECTION;
  try {
    const saved: unknown = JSON.parse(text);
    if (!isRecord(saved)) return DEFAULT_GRAPHICS_SELECTION;
    // 既定の上へ重ね、段を展開してから、同じ絵になる選び方を当てる。
    return selectionOfGraphics(expandedValues(acceptedLegacyValues(saved)));
  } catch {
    return DEFAULT_GRAPHICS_SELECTION;
  }
}
