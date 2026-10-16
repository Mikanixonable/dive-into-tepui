// 描画の品質設定の表。分野ごとの詳細の値(ノブ)とその分野のプリセット、分野のプリセットを持たない
// 表示する要素、プリセットの外にある好み、全体のプリセットが各分野で選ぶものを持ち、描画側が読む
// 平らな値一式の型をそこから導く。項目を足すときは表へ書き足せば、型・解き方・保存値の検証・
// 設定パネルの並びがそこから導かれる。

import { CLOUD_FIELD_SOURCE_KIND } from './cloud/cloud-presentation';
import { FILM_LUT_ITEMS, FILM_LUT_NONE } from './pipeline/film-lut';

// 全体のプリセットにも分野のプリセットにも使う段の名前。
export type QualityPreset = 'low' | 'medium' | 'high';

type PresetValues<V> = Readonly<Record<QualityPreset, V>>;

// 選択肢の項目が取りうる値。数値は段の大小に意味があり、文字列は名前で選ぶもの。
export type ChoiceValue = number | string;

// 真偽のノブ。
interface ToggleKnob {
  readonly kind: 'toggle';
  readonly label: string;
  readonly presets: PresetValues<boolean>;
}

// 候補から選ぶノブ。items は [値, 表示ラベル] を、数値なら小さいほうから順に並べる。'choice' は短い候補
// (2 候補ならオンの側を items[1] に置き、ラベルはオンの側が何かを言う)、'select' は名前で選ぶ多数の候補。
interface ChoiceKnob {
  readonly kind: 'choice' | 'select';
  readonly label: string;
  readonly items: readonly (readonly [ChoiceValue, string])[];
  readonly presets: PresetValues<ChoiceValue>;
}

// 整数を範囲から選ぶノブ。受け入れるのは min から step 刻みで max 以下の整数だけ。
interface SliderKnob {
  readonly kind: 'slider';
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly presets: PresetValues<number>;
}

export type GraphicsKnob = ToggleKnob | ChoiceKnob | SliderKnob;

// 好みの項目。プリセットを持たず、保存が無いときの値 initial だけを持つ。
export interface GraphicsPreference {
  readonly kind: 'choice' | 'select';
  readonly label: string;
  readonly items: readonly (readonly [ChoiceValue, string])[];
  readonly initial: ChoiceValue;
}

// 分野。enabled は、消せる分野で平らな値一式がその分野の有無を持つ真偽のキーの名前。消せない分野は null。
interface GraphicsField {
  readonly label: string;
  readonly enabled: string | null;
  readonly knobs: Readonly<Record<string, GraphicsKnob>>;
}

export const GRAPHICS_FIELDS = {
  screen: {
    label: '画面', enabled: null,
    knobs: {
      // devicePixelRatio へ掛ける描画解像度の倍率。
      resolutionScale: {
        kind: 'choice', label: '解像度',
        items: [[0.5, '50%'], [0.75, '75%'], [1, '100%']],
        presets: { low: 0.5, medium: 0.75, high: 1 },
      },
      // 描画の最終段で、物体の縁と 3D UI の線のギザギザを均す方式。
      antialias: {
        kind: 'choice', label: 'アンチエイリアス',
        items: [[0, 'なし'], [1, 'FXAA'], [2, 'SMAA']],
        presets: { low: 0, medium: 1, high: 2 },
      },
      // 見かけ直径へ掛ける詳細度の倍率。1 より小さいほど粗い LOD 段が選ばれ、球体を諦める距離も手前になる。
      lodBias: {
        kind: 'choice', label: '描画詳細度',
        items: [[0.5, '低'], [1, '標準'], [2, '高']],
        presets: { low: 0.5, medium: 1, high: 2 },
      },
    },
  },
  light: {
    label: '光源', enabled: null,
    knobs: {
      // 球光源では明暗の終端が視半径ぶん柔らかくなり、粗さの小さい金属面に太陽の円盤が映る。
      sunLightModel: {
        kind: 'choice', label: '太陽を球光源で照らす',
        items: [[0, '点光源'], [1, '球光源']],
        presets: { low: 0, medium: 1, high: 1 },
      },
      // テクスチャでは、粗さの小さい面にその天体の地表と昼夜の明暗が映る。
      planetLightModel: {
        kind: 'choice', label: '天体照にその天体の見た目を映す',
        items: [[0, '一様球'], [1, 'テクスチャ']],
        presets: { low: 0, medium: 0, high: 1 },
      },
      // 同時に照らす天体の数。1 体につき描画命令 1 本。最大値は MAX_PLANET_LIGHT_SLOTS。
      planetLightCount: {
        kind: 'choice', label: '天体照の光源の数',
        items: [[0, 'なし'], [1, '1'], [2, '2']],
        presets: { low: 0, medium: 2, high: 2 },
      },
      // 面の向きによらない一様な環境光を足すか。
      ambient: {
        kind: 'toggle', label: '環境光',
        presets: { low: true, medium: true, high: true },
      },
    },
  },
  // 艦艇・基地・デブリなどのメッシュが落とす影。天体の球と環が落とす影はこれでは消えない。
  shadow: {
    label: '影', enabled: 'meshShadow',
    knobs: {
      // 細かい影を同時に落とせる箇所の数。減らすほど影パスの描画命令が減り、要求の緩い受け手から
      // 粗い影で妥協させられる。最大値は MAX_SHADOW_SLOTS。
      shadowSlotCount: {
        kind: 'choice', label: '影マップの枠の数',
        items: [[1, '1'], [2, '2'], [4, '4']],
        presets: { low: 2, medium: 4, high: 4 },
      },
      // 1 箇所あたりの影の解像度 [texel]。確保する深度マップの実寸がこの2乗で決まる。
      shadowSlotSize: {
        kind: 'choice', label: '影マップの解像度',
        items: [[512, '512'], [1024, '1024'], [2048, '2048']],
        presets: { low: 512, medium: 1024, high: 1024 },
      },
      // 画面 1 px あたり何 texel の細かさを影へ要求するか。大きいほど枠が狭く細かくなり、1 枚の枠で
      // 覆える受け手が減る。
      shadowTexelsPerPixel: {
        kind: 'choice', label: '影マップの精細さ',
        items: [[0.5, '粗'], [1, '標準'], [2, '精細']],
        presets: { low: 0.5, medium: 1, high: 1 },
      },
    },
  },
  // 地表へ合成する雲と、雲が地表へ落とす影。
  cloud: {
    label: '雲', enabled: 'clouds',
    knobs: {
      // 雲の分布の出どころ。生成は気候から時々刻々焼く雲、実写は衛星写真から取った止まった雲。
      // どちらも同じ cap へ焼くが、実写は画像を 1 回読むだけなので天気の式より桁で軽い。
      cloudFieldSource: {
        kind: 'choice', label: '雲の分布を気候から生成する',
        items: [[CLOUD_FIELD_SOURCE_KIND.observed, '実写'], [CLOUD_FIELD_SOURCE_KIND.generated, '生成']],
        presets: {
          low: CLOUD_FIELD_SOURCE_KIND.observed,
          medium: CLOUD_FIELD_SOURCE_KIND.generated,
          high: CLOUD_FIELD_SOURCE_KIND.generated,
        },
      },
      // 圏界面付近に薄く張る巻雲の層。
      cirrus: {
        kind: 'toggle', label: '巻雲',
        presets: { low: true, medium: true, high: true },
      },
      // 積雲のうち、不透明な雲頂のまわりを埋める半透明の広がり。
      translucentCumulus: {
        kind: 'toggle', label: '半透明の積雲',
        presets: { low: true, medium: true, high: true },
      },
      // 積雲の球殻を不透明な雲頂として描くか。オフでは殻も、殻が落とす影も消える。
      cumulus: {
        kind: 'toggle', label: '積雲の立体',
        presets: { low: true, medium: true, high: true },
      },
      // 殻の中を等間隔にたどって雲頂を探す刻みの数。プリセットは 1 本か 6 本以上を選ぶ — 2〜3 本では
      // 手前と奥で拾った雲頂が 2 枚の層に重なって見える。
      cumulusMarchSteps: {
        kind: 'slider', label: '雲頂を探す刻みの数',
        min: 1, max: 16, step: 1,
        presets: { low: 1, medium: 6, high: 6 },
      },
      // 雲頂をまたいだ区間を締める二分の回数。
      cumulusRefineSteps: {
        kind: 'slider', label: '縁を締める二分の回数',
        min: 0, max: 8, step: 1,
        presets: { low: 5, medium: 3, high: 3 },
      },
      // 積雲が地表・艦艇へ落とす影。積雲の立体を描かないときは、この値によらず影は落ちない。
      cumulusShadow: {
        kind: 'toggle', label: '積雲の影',
        presets: { low: false, medium: true, high: true },
      },
    },
  },
  atmosphere: {
    label: '大気', enabled: 'atmosphere',
    knobs: {
      // 大気ぜんぶへ配れるサンプル点の合計。
      atmosphereSampleBudget: {
        kind: 'slider', label: '大気の標本数',
        min: 4, max: 32, step: 2,
        presets: { low: 8, medium: 16, high: 24 },
      },
      // 夜側の縁に淡く光る大気発光。**負荷を下げる設定ではない** — 積分の範囲も刻みも変わらず、
      // 消えるのは発光の項だけで、大気の他の項と切り分けるためにある。
      airglow: {
        kind: 'toggle', label: 'エアグロー',
        presets: { low: true, medium: true, high: true },
      },
      // 地球のオーロラ。
      aurora: {
        kind: 'toggle', label: 'オーロラ',
        presets: { low: false, medium: false, high: true },
      },
    },
  },
  // 天体照と一様な環境光を、近くの構造の塞がり方で弱める。
  screenSpace: {
    label: '遮蔽と照り返し', enabled: 'screenSpaceOcclusion',
    knobs: {
      // 明るい面と自己発光する面が近くの面を照らし返す項を足すか。
      screenSpaceIndirect: {
        kind: 'toggle', label: '照り返し',
        presets: { low: false, medium: false, high: true },
      },
      // 走査のスライスの数。
      screenSpaceSliceCount: {
        kind: 'slider', label: '走査のスライス数',
        min: 1, max: 8, step: 1,
        presets: { low: 2, medium: 4, high: 4 },
      },
      // スライス 1 本の片側の歩数。
      screenSpaceStepCount: {
        kind: 'slider', label: '片側の歩数',
        min: 1, max: 12, step: 1,
        presets: { low: 3, medium: 5, high: 5 },
      },
      // 静止した場面で積む履歴の上限 [フレーム]。1 なら前のフレームを引き継がない。
      screenSpaceHistoryCap: {
        kind: 'slider', label: '履歴の上限',
        min: 1, max: 32, step: 1,
        presets: { low: 8, medium: 8, high: 8 },
      },
    },
  },
  // 滑らかな面へ、反射方向にある近くの物体を映す。
  reflection: {
    label: '映り込み', enabled: 'screenSpaceSpecular',
    knobs: {
      // 追跡する深度の解像度の、描画バッファに対する比。
      screenSpaceSpecularScale: {
        kind: 'choice', label: '映り込みを全解像度で追跡する',
        items: [[0.5, '1/2'], [1, '1']],
        presets: { low: 0.5, medium: 0.5, high: 0.5 },
      },
      // ray 1 本の歩数。
      screenSpaceSpecularStepCount: {
        kind: 'slider', label: '追跡の歩数',
        min: 8, max: 64, step: 4,
        presets: { low: 16, medium: 32, high: 32 },
      },
      // 映り込みを粗さに応じて均すか。オフでは粗い面の映り込みが画素ごとの点描のまま見える。
      screenSpaceSpecularDenoise: {
        kind: 'toggle', label: 'ぼかし',
        presets: { low: false, medium: false, high: true },
      },
    },
  },
} as const satisfies Readonly<Record<string, GraphicsField>>;

// 表示する要素。分野のプリセットを持たない項目の群で、presets は全体のプリセットが選ぶ値。
export const GRAPHICS_ELEMENTS = {
  // 小惑星帯・カイパー帯などの点群。
  pointField: {
    kind: 'toggle', label: '小天体の点群',
    presets: { low: false, medium: true, high: true },
  },
  // 惑星の環。
  rings: {
    kind: 'toggle', label: '惑星の環',
    presets: { low: false, medium: true, high: true },
  },
  // レンズ効果(ブルーム・光条・ゴースト)。
  lens: {
    kind: 'toggle', label: 'レンズ効果',
    presets: { low: false, medium: true, high: true },
  },
  // タンパク質型の敵の構造の揺らぎ。
  proteinVibration: {
    kind: 'toggle', label: 'タンパク質の敵の揺らぎ',
    presets: { low: false, medium: true, high: true },
  },
} as const satisfies Readonly<Record<string, ToggleKnob | ChoiceKnob>>;

// 好み。品質と負荷の引き換えではないので、どのプリセットにも含まれない。
export const GRAPHICS_PREFERENCES = {
  // 露出へ掛ける倍率。1 段が EV 1 段(明るさ 2 倍)。
  exposureCompensation: {
    kind: 'choice', label: '露出補正',
    items: [[0.25, '−2'], [0.5, '−1'], [1, '±0'], [2, '+1'], [4, '+2']],
    initial: 1,
  },
  // トーンマッピング後の色へ当てるフィルムのルック。値はルックの名前で、候補は同梱の .cube から
  // 起動時に決まる。
  filmLut: {
    kind: 'select', label: 'フィルムのルック',
    items: FILM_LUT_ITEMS,
    initial: FILM_LUT_NONE,
  },
} as const satisfies Readonly<Record<string, GraphicsPreference>>;

export type GraphicsFieldKey = keyof typeof GRAPHICS_FIELDS;
export type GraphicsElementKey = keyof typeof GRAPHICS_ELEMENTS;
export type GraphicsPreferenceKey = keyof typeof GRAPHICS_PREFERENCES;

type FieldDef<F extends GraphicsFieldKey> = (typeof GRAPHICS_FIELDS)[F];
type FieldKnobKey<F extends GraphicsFieldKey> = keyof FieldDef<F>['knobs'] & string;

// 分野のプリセットとして選べるもの。消せる分野だけが 'off' を持つ。F が分野の union なら、分野ごとの型の union。
export type FieldPreset<F extends GraphicsFieldKey> =
  F extends unknown ? (FieldDef<F>['enabled'] extends string ? 'off' | QualityPreset : QualityPreset) : never;

// 項目 1 つが取る値の型。候補から選ぶ項目は items に並べた値へ絞る。
type KnobValue<K> =
  K extends { readonly kind: 'toggle' } ? boolean
    : K extends { readonly kind: 'slider' } ? number
      : K extends { readonly items: readonly (readonly [infer V, string])[] } ? V
        : never;

// 分野 F のノブの値一式。F が分野の union なら、分野ごとの値一式の union。
export type FieldKnobValues<F extends GraphicsFieldKey> = F extends unknown ? {
  readonly [K in FieldKnobKey<F>]: KnobValue<FieldDef<F>['knobs'][K]>;
} : never;
export type GraphicsElementValues = {
  readonly [K in GraphicsElementKey]: KnobValue<(typeof GRAPHICS_ELEMENTS)[K]>;
};
export type GraphicsPreferenceValues = {
  readonly [K in GraphicsPreferenceKey]: KnobValue<(typeof GRAPHICS_PREFERENCES)[K]>;
};

// 全体のプリセットが各分野で選ぶもの。
export const OVERALL_FIELD_PRESETS: Readonly<Record<QualityPreset, {
  readonly [F in GraphicsFieldKey]: FieldPreset<F>;
}>> = {
  low: {
    screen: 'low', light: 'low', shadow: 'off', cloud: 'off', atmosphere: 'low', screenSpace: 'off', reflection: 'off',
  },
  medium: {
    screen: 'medium', light: 'medium', shadow: 'medium', cloud: 'medium', atmosphere: 'medium',
    screenSpace: 'medium', reflection: 'off',
  },
  high: {
    screen: 'high', light: 'high', shadow: 'high', cloud: 'high', atmosphere: 'high', screenSpace: 'high',
    reflection: 'high',
  },
};

// 平らな値一式のキー。分野の有無・全分野のノブ・表示する要素・好み。
type EnabledKey = {
  [F in GraphicsFieldKey]: FieldDef<F>['enabled'] extends string ? FieldDef<F>['enabled'] : never;
}[GraphicsFieldKey];
export type GraphicsKnobKey = { [F in GraphicsFieldKey]: FieldKnobKey<F> }[GraphicsFieldKey];
type KnobAt<K extends GraphicsKnobKey> = {
  [F in GraphicsFieldKey]: FieldDef<F>['knobs'][Extract<K, FieldKnobKey<F>>];
}[GraphicsFieldKey];
export type GraphicsKey = EnabledKey | GraphicsKnobKey | GraphicsElementKey | GraphicsPreferenceKey;
type GraphicsValue<K extends GraphicsKey> =
  K extends EnabledKey ? boolean
    : K extends GraphicsKnobKey ? KnobValue<KnobAt<K>>
      : K extends GraphicsElementKey ? KnobValue<(typeof GRAPHICS_ELEMENTS)[K]>
        : K extends GraphicsPreferenceKey ? KnobValue<(typeof GRAPHICS_PREFERENCES)[K]>
          : never;

// 描画側が読む平らな値一式。キーと値の型は表から導く。
export type GraphicsSettingsData = { readonly [K in GraphicsKey]: GraphicsValue<K> };

// 分野を、表へ書いた順で返す。
export function graphicsFieldKeys(): readonly GraphicsFieldKey[] {
  return Object.keys(GRAPHICS_FIELDS) as GraphicsFieldKey[];
}

// 分野 field のノブのキーを、表へ書いた順で返す。
export function fieldKnobKeys(field: GraphicsFieldKey): readonly GraphicsKnobKey[] {
  return Object.keys(GRAPHICS_FIELDS[field].knobs) as GraphicsKnobKey[];
}

// 分野 field のノブ key の定義。その分野に無いキーなら null。
export function fieldKnob(field: GraphicsFieldKey, key: string): GraphicsKnob | null {
  const knobs: Readonly<Record<string, GraphicsKnob>> = GRAPHICS_FIELDS[field].knobs;
  return knobs[key] ?? null;
}

// 分野 field のノブを、分野のプリセット preset の値で揃えた一式。FieldKnobValues は表から導いた型なので、
// as での断定は安全。
export function fieldPresetValues<F extends GraphicsFieldKey>(field: F, preset: QualityPreset): FieldKnobValues<F> {
  const knobs: Readonly<Record<string, GraphicsKnob>> = GRAPHICS_FIELDS[field].knobs;
  return Object.fromEntries(
    Object.entries(knobs).map(([key, knob]) => [key, knob.presets[preset]]),
  ) as FieldKnobValues<F>;
}

// 表示する要素のキーを、表へ書いた順で返す。
export function graphicsElementKeys(): readonly GraphicsElementKey[] {
  return Object.keys(GRAPHICS_ELEMENTS) as GraphicsElementKey[];
}

// 表示する要素を、全体のプリセット preset が選ぶ値で揃えた一式。
export function elementPresetValues(preset: QualityPreset): GraphicsElementValues {
  return Object.fromEntries(
    graphicsElementKeys().map((key) => [key, GRAPHICS_ELEMENTS[key].presets[preset]]),
  ) as GraphicsElementValues;
}

// 好みのキーを、表へ書いた順で返す。
export function graphicsPreferenceKeys(): readonly GraphicsPreferenceKey[] {
  return Object.keys(GRAPHICS_PREFERENCES) as GraphicsPreferenceKey[];
}

// 保存が無いときの好み。
export function initialPreferenceValues(): GraphicsPreferenceValues {
  return Object.fromEntries(
    graphicsPreferenceKeys().map((key) => [key, GRAPHICS_PREFERENCES[key].initial]),
  ) as GraphicsPreferenceValues;
}
