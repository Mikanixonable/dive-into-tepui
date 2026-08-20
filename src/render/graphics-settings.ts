// 描画の品質設定。値の正本と localStorage への永続を持つ。
//
// 描画要素を1つずつ切れるかどうかは、その要素が単独のメッシュ/描画物として存在するかで決まる。
// ここに並ぶのは、切れば実際にその要素が絵から消えるものだけ。

const STORAGE_KEY = 'tepui.settings.graphics';

// 詳細度の倍率。見かけ直径へ掛けてから LOD 段・球体表示の閾値判定へ渡すので、
// 1 より小さいほど粗い段が選ばれ、球体を諦める距離も手前になる。
export const LOD_BIAS = { low: 0.5, normal: 1, high: 2 } as const;
export type LodBias = (typeof LOD_BIAS)[keyof typeof LOD_BIAS];

export const RESOLUTION_SCALES = [0.5, 0.75, 1] as const;
export type ResolutionScale = (typeof RESOLUTION_SCALES)[number];

export type GraphicsSettingsData = {
  // devicePixelRatio へ掛ける描画解像度の倍率。
  readonly resolutionScale: ResolutionScale;
  // 見かけ直径へ掛ける詳細度の倍率。
  readonly lodBias: LodBias;
  // 小惑星帯・カイパー帯などの点群。
  readonly pointField: boolean;
  // 惑星の環。
  readonly rings: boolean;
  // 地球のオーロラ。
  readonly aurora: boolean;
  // 地球の大気リム光。
  readonly atmosphere: boolean;
  // マルチサンプリング。レンダラ生成時にしか渡せないので、変更は次回起動から効く。
  readonly antialias: boolean;
  // 艦の設計ツリー・当たり判定カプセルを線で示すデバッグ用ワイヤーフレーム。
  readonly wireframe: boolean;
};

// 真偽で持つ項目。オフにするとその要素が絵から消える。
export type GraphicsToggleKey = 'pointField' | 'rings' | 'aurora' | 'atmosphere' | 'antialias' | 'wireframe';

export type QualityPreset = 'low' | 'medium' | 'high';

export const QUALITY_PRESETS: Readonly<Record<QualityPreset, GraphicsSettingsData>> = {
  low: {
    resolutionScale: 0.5, lodBias: LOD_BIAS.low,
    pointField: false, rings: false, aurora: false, atmosphere: false, antialias: false, wireframe: false,
  },
  medium: {
    resolutionScale: 0.75, lodBias: LOD_BIAS.normal,
    pointField: true, rings: true, aurora: false, atmosphere: true, antialias: true, wireframe: false,
  },
  high: {
    resolutionScale: 1, lodBias: LOD_BIAS.high,
    pointField: true, rings: true, aurora: true, atmosphere: true, antialias: true, wireframe: false,
  },
};

const DEFAULTS: GraphicsSettingsData = QUALITY_PRESETS.high;

// 保存値は利用者がいつ書いたか分からないので、既知のキーだけを既定の上へ重ねる。
// 選択肢を持つ項目は現在の候補に含まれるかまで見て、消えた選択肢が残っていれば既定へ戻す。
function loadStored(): GraphicsSettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<GraphicsSettingsData>;
    return {
      resolutionScale: RESOLUTION_SCALES.find((s) => s === saved.resolutionScale) ?? DEFAULTS.resolutionScale,
      lodBias: Object.values(LOD_BIAS).find((b) => b === saved.lodBias) ?? DEFAULTS.lodBias,
      pointField: saved.pointField ?? DEFAULTS.pointField,
      rings: saved.rings ?? DEFAULTS.rings,
      aurora: saved.aurora ?? DEFAULTS.aurora,
      atmosphere: saved.atmosphere ?? DEFAULTS.atmosphere,
      antialias: saved.antialias ?? DEFAULTS.antialias,
      wireframe: saved.wireframe ?? DEFAULTS.wireframe,
    };
  } catch {
    return DEFAULTS;
  }
}

// 解像度倍率の反映先。描画解像度を持つのはレンダラだが、設定はレンダラ生成より前に要る。
export interface ResolutionTarget {
  setResolutionScale(scale: number): void;
}

export class GraphicsSettings {
  private data: GraphicsSettingsData = loadStored();
  private resolutionTarget: ResolutionTarget | null = null;

  get current(): GraphicsSettingsData { return this.data; }

  // 見かけ直径へ詳細度の倍率を掛ける。LOD 段と球体表示の閾値の両方がこの1つの値を通る。
  scaleApparentSize(apparentSizePx: number): number { return apparentSizePx * this.data.lodBias; }

  // 解像度の押し出し先を登録し、現在値を一度反映する。
  bindResolutionTarget(target: ResolutionTarget): void {
    this.resolutionTarget = target;
    target.setResolutionScale(this.data.resolutionScale);
  }

  // 一部の項目だけを差し替える。保存と解像度の反映まで行う。
  update(patch: Partial<GraphicsSettingsData>): void {
    this.data = { ...this.data, ...patch };
    this.resolutionTarget?.setResolutionScale(this.data.resolutionScale);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // 保存できなくてもこのセッションの設定は生きている。
    }
  }

  // プリセットの各項目へ丸ごと揃える。
  applyPreset(preset: QualityPreset): void {
    this.update(QUALITY_PRESETS[preset]);
  }

  // 現在値と全項目が一致するプリセット。どれとも一致しなければ null。
  matchingPreset(): QualityPreset | null {
    const keys = Object.keys(DEFAULTS) as (keyof GraphicsSettingsData)[];
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      if (keys.every((k) => preset[k] === this.data[k])) return name as QualityPreset;
    }
    return null;
  }
}
