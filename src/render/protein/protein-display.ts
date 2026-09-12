// タンパク質の表示の語彙。表現形態・配色・構造フェーズ・詳細度の値と、その組み合わせの検証を定める。
export type ProteinRepresentation = 'molecular' | 'ribbon' | 'silhouette';

type ProteinMolecularColorMode = 'element';
export type ProteinRibbonColorMode =
  | 'chain'
  | 'b-factor'
  | 'rainbow'
  | 'secondary-structure'
  | 'component';
export type ProteinSilhouetteColorMode = 'surface-charge' | 'hydrophobicity';
export type ProteinColorMode = ProteinMolecularColorMode | ProteinRibbonColorMode | ProteinSilhouetteColorMode;

/** タンパク質の構造フェーズ。結合線の濃さと変形の強さを決める。 */
export type ProteinPhase = 'intact' | 'exposed' | 'dissociated' | 'critical';

export type ProteinDisplaySettings =
  | { readonly representation: 'molecular'; readonly colorMode: ProteinMolecularColorMode }
  | { readonly representation: 'ribbon'; readonly colorMode: ProteinRibbonColorMode }
  | { readonly representation: 'silhouette'; readonly colorMode: ProteinSilhouetteColorMode };

export const DEFAULT_PROTEIN_DISPLAY: ProteinDisplaySettings = {
  representation: 'ribbon',
  colorMode: 'chain',
};

export const PROTEIN_DISPLAY_LABELS: Readonly<Record<ProteinRepresentation, string>> = {
  molecular: '分子模型',
  ribbon: 'リボン',
  silhouette: 'シルエット',
};

export const PROTEIN_COLOR_LABELS: Readonly<Record<ProteinColorMode, string>> = {
  element: '元素',
  chain: 'Chain',
  'b-factor': 'B-Factor',
  rainbow: 'Rainbow',
  'secondary-structure': '二次構造',
  component: 'Component',
  'surface-charge': '表面電荷（近似）',
  hydrophobicity: '疎水性',
};

/** 残基変形の詳細度。 */
export type ProteinMotionLod = 'near' | 'medium' | 'far' | 'marker';

export const LODS_FINE_TO_COARSE: readonly ProteinMotionLod[] = ['near', 'medium', 'far', 'marker'];

/** そのフレームの残基変形を表示資源へ渡すための、確定済みの値。 */
export interface ProteinMotionDisplay {
  readonly active: boolean;
  readonly lod: ProteinMotionLod;
  /** 係数が表す量子化済みの表示時刻 [s]。 */
  readonly sampleTime: number;
  readonly phase: ProteinPhase;
  readonly coefficients: Float32Array;
}

/** 表示形態で選択できる着色を表示順に返す。 */
export function proteinColorModesFor(representation: ProteinRepresentation): readonly ProteinColorMode[] {
  if (representation === 'molecular') return ['element'];
  if (representation === 'silhouette') return ['surface-charge', 'hydrophobicity'];
  return ['chain', 'b-factor', 'rainbow', 'secondary-structure', 'component'];
}

/** 表示形態を選び直したときの新規設定を返す。 */
export function defaultProteinDisplayFor(representation: ProteinRepresentation): ProteinDisplaySettings {
  if (representation === 'molecular') return { representation, colorMode: 'element' };
  if (representation === 'silhouette') return { representation, colorMode: 'surface-charge' };
  return { representation, colorMode: 'chain' };
}

/** 表示形態と着色の組を設定にする。互換でない組なら null。 */
export function proteinDisplayWithColor(
  representation: ProteinRepresentation, colorMode: ProteinColorMode,
): ProteinDisplaySettings | null {
  if (representation === 'molecular' && colorMode === 'element') return { representation, colorMode };
  if (representation === 'ribbon' && proteinColorModesFor('ribbon').includes(colorMode)) {
    return { representation, colorMode: colorMode as ProteinRibbonColorMode };
  }
  if (representation === 'silhouette' && proteinColorModesFor('silhouette').includes(colorMode)) {
    return { representation, colorMode: colorMode as ProteinSilhouetteColorMode };
  }
  return null;
}

/** 外部入力が有効な表示形態と着色の組み合わせかを判定する。 */
export function isProteinDisplaySettings(value: unknown): value is ProteinDisplaySettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { representation?: unknown; colorMode?: unknown };
  if (candidate.representation === 'molecular') return candidate.colorMode === 'element';
  if (candidate.representation === 'ribbon') return proteinColorModesFor('ribbon').includes(candidate.colorMode as ProteinRibbonColorMode);
  if (candidate.representation === 'silhouette') return proteinColorModesFor('silhouette').includes(candidate.colorMode as ProteinSilhouetteColorMode);
  return false;
}
