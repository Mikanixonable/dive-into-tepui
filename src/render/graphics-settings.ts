// 描画の品質設定。値の正本と localStorage への永続を持つ。
//
// **項目を1つ足すときに書き足すのは GRAPHICS_OPTIONS の記述1つだけ。** 設定値の型・品質プリセット
// 3面・保存値の検証・設定パネルの並びは、すべてこの表から導く。
//
// 表へ載せてよいのは、切り替えた結果が絵か負荷で分かる項目だけ。真偽で持つものは「切れば
// その要素が絵から消える」もの — 単独のメッシュ/描画物として存在しない要素は切れない。
// 選択肢で持つものは、品質と負荷を刻んで釣り合わせる値。

const STORAGE_KEY = 'tepui.settings.graphics';

export type QualityPreset = 'low' | 'medium' | 'high';

// 設定パネルが群を並べる順と、その見出し。項目は自分の group でここへ割り振られる。
export const GRAPHICS_GROUPS = [
  ['basic', '基本'],
  ['element', '表示する要素'],
  ['light', '光源'],
  ['shadow', '影の詳細'],
] as const;
export type GraphicsGroup = (typeof GRAPHICS_GROUPS)[number][0];

type PresetValues<V> = Readonly<Record<QualityPreset, V>>;

// 真偽の項目。オフにするとその要素が絵から消える。
type ToggleOption = {
  readonly kind: 'toggle';
  readonly group: GraphicsGroup;
  readonly label: string;
  readonly presets: PresetValues<boolean>;
};

// 数値の選択肢を持つ項目。items は [値, 表示ラベル] を、値の小さいほうから順に並べる。
type ChoiceOption = {
  readonly kind: 'choice';
  readonly group: GraphicsGroup;
  readonly label: string;
  readonly items: readonly (readonly [number, string])[];
  readonly presets: PresetValues<number>;
};

export type GraphicsOption = ToggleOption | ChoiceOption;

export const GRAPHICS_OPTIONS = {
  // devicePixelRatio へ掛ける描画解像度の倍率。
  resolutionScale: {
    kind: 'choice', group: 'basic', label: '解像度',
    items: [[0.5, '50%'], [0.75, '75%'], [1, '100%']],
    presets: { low: 0.5, medium: 0.75, high: 1 },
  },
  // 見かけ直径へ掛ける詳細度の倍率。1 より小さいほど粗い LOD 段が選ばれ、球体を諦める距離も
  // 手前になる。
  lodBias: {
    kind: 'choice', group: 'basic', label: '描画詳細度',
    items: [[0.5, '低'], [1, '標準'], [2, '高']],
    presets: { low: 0.5, medium: 1, high: 2 },
  },
  // 露出へ掛ける倍率。1 段が EV 1 段(明るさ 2 倍)。
  exposureCompensation: {
    kind: 'choice', group: 'basic', label: '露出補正',
    items: [[0.25, '−2'], [0.5, '−1'], [1, '±0'], [2, '+1'], [4, '+2']],
    presets: { low: 1, medium: 1, high: 1 },
  },
  // マルチサンプリング。レンダラ生成時にしか渡せないので、変更は次回起動から効く。
  antialias: {
    kind: 'toggle', group: 'basic', label: 'アンチエイリアス(次回起動から)',
    presets: { low: false, medium: true, high: true },
  },
  // 小惑星帯・カイパー帯などの点群。
  pointField: {
    kind: 'toggle', group: 'element', label: '小天体の点群',
    presets: { low: false, medium: true, high: true },
  },
  // 惑星の環。
  rings: {
    kind: 'toggle', group: 'element', label: '惑星の環',
    presets: { low: false, medium: true, high: true },
  },
  // 地球のオーロラ。
  aurora: {
    kind: 'toggle', group: 'element', label: 'オーロラ',
    presets: { low: false, medium: false, high: true },
  },
  // 地球の大気。
  atmosphere: {
    kind: 'toggle', group: 'element', label: '大気',
    presets: { low: false, medium: true, high: true },
  },
  // レンズ効果(滲み・条・ゴースト)。
  lens: {
    kind: 'toggle', group: 'element', label: 'レンズ効果',
    presets: { low: false, medium: true, high: true },
  },
  // タンパク質型の敵の構造の揺らぎ。
  proteinVibration: {
    kind: 'toggle', group: 'element', label: 'タンパク質の敵の揺らぎ',
    presets: { low: false, medium: true, high: true },
  },
  // 太陽の光源モデル。球光源では明暗の終端が視半径ぶん柔らかくなり、粗さの小さい金属面に
  // 太陽の円盤が映る。
  sunLightModel: {
    kind: 'choice', group: 'light', label: '太陽の光源モデル',
    items: [[0, '点光源'], [1, '球光源']],
    presets: { low: 0, medium: 1, high: 1 },
  },
  // 同時に照らす天体の数。1 本が描画命令 1 本。「なし」では影の中が太陽の直射だけになり、
  // 減らすと光源になる天体の入れ替わりが絵に出うる。最大値は MAX_PLANET_LIGHT_SLOTS。
  planetLightCount: {
    kind: 'choice', group: 'light', label: '天体照の光源の数',
    items: [[0, 'なし'], [1, '1'], [2, '2']],
    presets: { low: 0, medium: 2, high: 2 },
  },
  // 面の向きによらない一様な環境光を、マップビューで足すか。読みやすさのため強い。
  overviewAmbient: {
    kind: 'toggle', group: 'light', label: '環境光(マップビュー)',
    presets: { low: true, medium: true, high: true },
  },
  // 同じく戦闘ビューで足すか。物理に近い暗さのため弱い。
  combatAmbient: {
    kind: 'toggle', group: 'light', label: '環境光(戦闘ビュー)',
    presets: { low: true, medium: true, high: true },
  },
  // 艦艇・基地・デブリなどのメッシュが落とす影。天体の球と環が落とす影はこれでは消えない。
  meshShadow: {
    kind: 'toggle', group: 'shadow', label: 'メッシュの影',
    presets: { low: false, medium: true, high: true },
  },
  // 細かい影を同時に落とせる箇所の数。減らすほど影パスの描画命令が減り、要求の緩い受け手から
  // 粗い影で妥協させられる。**上限は受け手が引くグラフの形が決めるので、増やす段は無い。**
  shadowSlotCount: {
    kind: 'choice', group: 'shadow', label: '影の枠の数',
    items: [[1, '1'], [2, '2'], [4, '4']],
    presets: { low: 2, medium: 4, high: 4 },
  },
  // 1 箇所あたりの影の解像度 [texel]。確保する深度マップの実寸がこの2乗で決まる。
  shadowSlotSize: {
    kind: 'choice', group: 'shadow', label: '影の解像度',
    items: [[512, '512'], [1024, '1024'], [2048, '2048']],
    presets: { low: 512, medium: 1024, high: 1024 },
  },
  // 画面 1 px あたり何 texel の細かさを影へ要求するか。大きいほど枠が狭く細かくなり、
  // 1 枚の枠で覆える受け手が減る。
  shadowTexelsPerPixel: {
    kind: 'choice', group: 'shadow', label: '影の精細さ',
    items: [[0.5, '粗'], [1, '標準'], [2, '精細']],
    presets: { low: 0.5, medium: 1, high: 1 },
  },
} as const satisfies Readonly<Record<string, GraphicsOption>>;

export type GraphicsOptionKey = keyof typeof GRAPHICS_OPTIONS;

// 項目1つが取る値の型。選択肢の項目は items に並べた値そのものへ絞る — こう書いておくと、
// プリセットへ選択肢に無い値を書いた時点で型検査が落ちる。
type OptionValue<O> =
  O extends { readonly kind: 'toggle' } ? boolean
    : O extends { readonly items: readonly (readonly [infer V, string])[] } ? V
      : never;

export type GraphicsSettingsData = {
  readonly [K in GraphicsOptionKey]: OptionValue<(typeof GRAPHICS_OPTIONS)[K]>;
};

// 表に並ぶ全項目のキーを、書いた順で返す。
function optionKeys(): readonly GraphicsOptionKey[] {
  return Object.keys(GRAPHICS_OPTIONS) as GraphicsOptionKey[];
}

// 表のプリセット値を1面ぶん集める。**表そのものが GraphicsSettingsData の導出元**なので、
// キーの過不足も値の型違いも起こりえない — アサーションはその保証の上に立っている。
function presetData(preset: QualityPreset): GraphicsSettingsData {
  const entries = optionKeys().map((key) => [key, GRAPHICS_OPTIONS[key].presets[preset]] as const);
  return Object.fromEntries(entries) as GraphicsSettingsData;
}

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, GraphicsSettingsData>> = {
  low: presetData('low'),
  medium: presetData('medium'),
  high: presetData('high'),
};

const DEFAULTS: GraphicsSettingsData = QUALITY_PRESETS.high;

// 表の外から来た値を受け入れるか決める。真偽の項目は型だけ、選択肢の項目は現在の候補に
// 含まれるかまで見て、外れていれば fallback を返す。
function acceptValue(option: GraphicsOption, value: unknown, fallback: boolean | number): boolean | number {
  if (option.kind === 'toggle') return typeof value === 'boolean' ? value : fallback;
  return option.items.some(([candidate]) => candidate === value) ? value as number : fallback;
}

// 保存値は利用者がいつ書いたか分からないので、既知の項目だけを既定の上へ重ねる。
function loadStored(): GraphicsSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    // 表に無いキーは読まず、表にあって保存に無いキーは既定で埋まる。
    const entries = optionKeys().map(
      (key) => [key, acceptValue(GRAPHICS_OPTIONS[key], saved[key], DEFAULTS[key])] as const,
    );
    return Object.fromEntries(entries) as GraphicsSettingsData;
  } catch {
    return DEFAULTS;
  }
}

// 設定値の押し出し先。**値が変わった瞬間に何かを作り直す必要がある項目**(描画解像度、GPU
// 資源の確保を伴う項目)はここで受け取る。毎フレームの分岐で足りる項目は current を読む。
export interface GraphicsTarget {
  applyGraphics(graphics: GraphicsSettingsData): void;
}

export class GraphicsSettings {
  private data: GraphicsSettingsData = loadStored();
  private readonly targets: GraphicsTarget[] = [];

  public get current(): GraphicsSettingsData { return this.data; }

  // 押し出し先を登録し、現在値を一度反映する。
  public bind(target: GraphicsTarget): void {
    this.targets.push(target);
    target.applyGraphics(this.data);
  }

  // 項目1つを差し替える。
  public setOption(key: GraphicsOptionKey, value: boolean | number): void {
    this.apply(withGraphicsOption(this.data, key, value));
  }

  // プリセットの各項目へ丸ごと揃える。
  public applyPreset(preset: QualityPreset): void {
    this.apply(QUALITY_PRESETS[preset]);
  }

  // 新しい値一式を正本にし、押し出しと保存まで行う。
  private apply(data: GraphicsSettingsData): void {
    this.data = data;
    for (const target of this.targets) target.applyGraphics(data);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // 保存できなくてもこのセッションの設定は生きている。
    }
  }

  // 現在値と全項目が一致するプリセット。どれとも一致しなければ null。
  public matchingPreset(): QualityPreset | null {
    const keys = optionKeys();
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      if (keys.every((key) => preset[key] === this.data[key])) return name as QualityPreset;
    }
    return null;
  }
}

// 項目1つを差し替えた値一式を返す。**操作する UI は項目名を実行時に持つ**ので、キーと値の
// 対応を型では結べない — 表の選択肢に含まれない値はここで捨てる。
export function withGraphicsOption(
  data: GraphicsSettingsData, key: GraphicsOptionKey, value: boolean | number,
): GraphicsSettingsData {
  return { ...data, [key]: acceptValue(GRAPHICS_OPTIONS[key], value, data[key]) } as GraphicsSettingsData;
}

// 群1つに属する項目を、表へ書いた順で返す。設定パネルの並びはこれが決める。
export function graphicsOptionKeys(group: GraphicsGroup): readonly GraphicsOptionKey[] {
  return optionKeys().filter((key) => GRAPHICS_OPTIONS[key].group === group);
}
