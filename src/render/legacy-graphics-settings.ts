// 鍵 tepui.settings.graphics に保存された平らな値一式を、同じ絵になる選び方へ読み替える。その保存値の意味は
// ここで凍結する — 既定・受け入れる候補・段の表はこのモジュールが写しとして持ち、本番の値が後で変わっても
// 読み替えた絵は変わらない。

import { FILM_LUT_ITEMS, FILM_LUT_NONE } from './pipeline/film-lut';
import {
  DEFAULT_GRAPHICS_SELECTION, firstRunGraphicsSelection, resolveGraphics, selectionOfGraphics,
  type GraphicsSelection,
} from './graphics-selection';
import type { GraphicsSettingsData } from './graphics-settings';

// 保存された項目 1 つ。items が候補の並びならその候補だけを、null なら真偽だけを受け入れる。
// initial は保存に無い・受け入れられないときの値。
interface LegacyOption {
  readonly items: readonly (number | string)[] | null;
  readonly initial: boolean | number | string;
}

// 初期値は、この形式で最後に保存が無かったときの値(当時の品質プリセット「中」)。
const LEGACY_OPTIONS = {
  resolutionScale: { items: [0.5, 0.75, 1], initial: 0.5 },
  lodBias: { items: [0.5, 1, 2], initial: 0.5 },
  exposureCompensation: {
    items: [0.25, 0.5, 0.7071067811865476, 1, 1.4142135623730951, 2, 4], initial: 1,
  },
  hitShake: { items: null, initial: true },
  // ルックの候補は同梱の .cube で決まる。消えた .cube を指す保存値は「なし」へ落ちる。
  filmLut: { items: FILM_LUT_ITEMS.map(([id]) => id), initial: FILM_LUT_NONE },
  antialias: { items: [0, 1, 2], initial: 1 },
  frameRateCap: { items: [0, 30, 60], initial: 60 },
  uiBlur: { items: null, initial: true },
  textureResolution: { items: [0, 1, 2], initial: 1 },
  pointField: { items: null, initial: true },
  rings: { items: null, initial: true },
  aurora: { items: null, initial: false },
  atmosphere: { items: [0, 1, 2, 3], initial: 1 },
  airglow: { items: null, initial: true },
  clouds: { items: null, initial: true },
  cloudFieldSource: { items: ['observed', 'generated'], initial: 'generated' },
  cumulus: { items: null, initial: true },
  cirrus: { items: null, initial: true },
  cumulusDetail: { items: [1, 2, 3], initial: 1 },
  cirrusDetail: { items: [0, 1, 2], initial: 0 },
  lens: { items: null, initial: true },
  thrustPlume: { items: ['simple', 'volume'], initial: 'volume' },
  sunLightModel: { items: [0, 1], initial: 1 },
  planetLightModel: { items: [0, 1], initial: 0 },
  planetLightCount: { items: [0, 1, 2], initial: 2 },
  ambient: { items: null, initial: true },
  nightObservation: { items: null, initial: false },
  constructionWorkLight: { items: null, initial: true },
  meshShadow: { items: null, initial: true },
  cloudShadow: { items: null, initial: true },
  shadowSlotCount: { items: [1, 2, 4], initial: 4 },
  shadowSlotSize: { items: [512, 1024, 2048], initial: 1024 },
  shadowTexelsPerPixel: { items: [0.5, 1, 2], initial: 0.5 },
} as const satisfies Readonly<Record<string, LegacyOption>>;

type LegacyKey = keyof typeof LEGACY_OPTIONS;
type LegacyValue<O> = O extends { readonly items: readonly (infer V)[] } ? V : boolean;
type LegacyValues = { readonly [K in LegacyKey]: LegacyValue<(typeof LEGACY_OPTIONS)[K]> };

// 積雲の精細さの段ごとの、雲頂を探す刻みの数・縁を締める二分の回数・細部の段数。
const SAMPLING_OF_DETAIL = {
  1: { march: 1, refine: 5, octaves: 4 },
  2: { march: 6, refine: 3, octaves: 6 },
  3: { march: 12, refine: 3, octaves: 8 },
} as const;
// 積雲の精細さにオフ(0)があった形式の、オフの値。
const CUMULUS_DETAIL_OFF = 0;

// 大気の段ごとの、大気ぜんぶへ配るサンプル点の合計。段 0 はオフで、そのときの標本数は使われない。
const TOTAL_SAMPLES_OF_QUALITY = { 0: 8, 1: 8, 2: 16, 3: 24 } as const;
const ATMOSPHERE_OFF = 0;

// この形式が値を持たない分野。読み替えでは比べず、既定の全体のプリセットが選ぶものにする。
const UNKNOWN_FIELDS = ['screenSpace', 'reflection'] as const;

// value が保存値として重ねられるオブジェクトか。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 保存された値一式 saved を既定の上へ重ねる。表に無いキーは読まず、候補外の値は既定にする。積雲の精細さに
// オフがあり、積雲の表示を別に持たなかった形式は、積雲を消したものとして読む。LegacyValues は表から導いた型で、
// 候補の検査がそれを保証するので as での断定は安全。
function acceptedLegacyValues(saved: Record<string, unknown>): LegacyValues {
  const options: Readonly<Record<string, LegacyOption>> = LEGACY_OPTIONS;
  const cumulusOff = saved['cumulus'] === undefined && saved['cumulusDetail'] === CUMULUS_DETAIL_OFF;
  return Object.fromEntries(Object.entries(options).map(([key, option]) => {
    const value = key === 'cumulus' && cumulusOff ? false : saved[key];
    const accepted = option.items === null
      ? typeof value === 'boolean'
      : option.items.some((candidate) => candidate === value);
    return [key, accepted ? value : option.initial];
  })) as LegacyValues;
}

// 保存された値一式を、段を表どおりのノブの値へ展開した平らな値一式にする。この形式が値を持たない分野
// (UNKNOWN_FIELDS)は、既定の選び方の値で埋める。
function expandedValues(legacy: LegacyValues): GraphicsSettingsData {
  const sampling = SAMPLING_OF_DETAIL[legacy.cumulusDetail];
  const unknown = resolveGraphics(DEFAULT_GRAPHICS_SELECTION);
  return {
    ...unknown,
    resolutionScale: legacy.resolutionScale,
    antialias: legacy.antialias,
    lodBias: legacy.lodBias,
    frameRateCap: legacy.frameRateCap,
    uiBlur: legacy.uiBlur,
    textureResolution: legacy.textureResolution,
    thrustPlume: legacy.thrustPlume,
    sunLightModel: legacy.sunLightModel,
    planetLightModel: legacy.planetLightModel,
    planetLightCount: legacy.planetLightCount,
    ambient: legacy.ambient,
    nightObservation: legacy.nightObservation,
    constructionWorkLight: legacy.constructionWorkLight,
    meshShadow: legacy.meshShadow,
    shadowSlotCount: legacy.shadowSlotCount,
    shadowSlotSize: legacy.shadowSlotSize,
    shadowTexelsPerPixel: legacy.shadowTexelsPerPixel,
    clouds: legacy.clouds,
    cloudFieldSource: legacy.cloudFieldSource,
    cirrus: legacy.cirrus,
    cumulus: legacy.cumulus,
    cumulusMarchSteps: sampling.march,
    cumulusRefineSteps: sampling.refine,
    cumulusOctaves: sampling.octaves,
    cirrusDetail: legacy.cirrusDetail,
    cloudShadow: legacy.cloudShadow,
    atmosphere: legacy.atmosphere !== ATMOSPHERE_OFF,
    atmosphereSampleBudget: TOTAL_SAMPLES_OF_QUALITY[legacy.atmosphere],
    airglow: legacy.airglow,
    aurora: legacy.aurora,
    pointField: legacy.pointField,
    rings: legacy.rings,
    lens: legacy.lens,
    exposureCompensation: legacy.exposureCompensation,
    filmLut: legacy.filmLut,
    hitShake: legacy.hitShake,
  };
}

// 保存された文字列を、同じ絵になる選び方へ読み替える。壊れた文字列は保存が無いときの選び方、null は
// coarsePointer で選ぶ初回の選び方。
export function parseLegacyGraphics(text: string | null, coarsePointer = false): GraphicsSelection {
  if (text === null) return firstRunGraphicsSelection(coarsePointer);
  try {
    const saved: unknown = JSON.parse(text);
    if (!isRecord(saved)) return DEFAULT_GRAPHICS_SELECTION;
    // 既定の上へ重ね、段を展開してから、同じ絵になる選び方を当てる。
    return selectionOfGraphics(expandedValues(acceptedLegacyValues(saved)), UNKNOWN_FIELDS);
  } catch {
    return DEFAULT_GRAPHICS_SELECTION;
  }
}
