export type ProteinRepresentation = 'molecular' | 'ribbon' | 'silhouette';

export type ProteinMolecularColorMode = 'element';
export type ProteinRibbonColorMode =
  | 'publication'
  | 'chain'
  | 'b-factor'
  | 'entity'
  | 'rainbow'
  | 'secondary-structure'
  | 'component-role';
export type ProteinSilhouetteColorMode = 'surface-charge' | 'hydrophobicity';
export type ProteinColorMode = ProteinMolecularColorMode | ProteinRibbonColorMode | ProteinSilhouetteColorMode;

export type ProteinDisplaySettings =
  | { readonly representation: 'molecular'; readonly colorMode: ProteinMolecularColorMode }
  | { readonly representation: 'ribbon'; readonly colorMode: ProteinRibbonColorMode }
  | { readonly representation: 'silhouette'; readonly colorMode: ProteinSilhouetteColorMode };

export const DEFAULT_PROTEIN_DISPLAY: ProteinDisplaySettings = {
  representation: 'ribbon',
  colorMode: 'publication',
};

export const PROTEIN_DISPLAY_LABELS: Readonly<Record<ProteinRepresentation, string>> = {
  molecular: '分子模型',
  ribbon: 'リボン',
  silhouette: 'シルエット',
};

export const PROTEIN_COLOR_LABELS: Readonly<Record<ProteinColorMode, string>> = {
  element: '元素',
  publication: '論文調（鎖別）',
  chain: 'Chain',
  'b-factor': 'B-Factor',
  entity: 'Entity',
  rainbow: 'Rainbow',
  'secondary-structure': '二次構造',
  'component-role': '構成要素',
  'surface-charge': '表面電荷（近似）',
  hydrophobicity: '疎水性',
};

/** 表示形態で選択できる着色を表示順に返す。 */
export function proteinColorModesFor(representation: ProteinRepresentation): readonly ProteinColorMode[] {
  if (representation === 'molecular') return ['element'];
  if (representation === 'silhouette') return ['surface-charge', 'hydrophobicity'];
  return ['publication', 'chain', 'b-factor', 'entity', 'rainbow', 'secondary-structure', 'component-role'];
}

/** 表示形態を選び直したときの新規設定を返す。 */
export function defaultProteinDisplayFor(representation: ProteinRepresentation): ProteinDisplaySettings {
  if (representation === 'molecular') return { representation, colorMode: 'element' };
  if (representation === 'silhouette') return { representation, colorMode: 'surface-charge' };
  return { representation, colorMode: 'publication' };
}

/** 表示形態を持たない保存値を互換な表示設定へ変換する。 */
export function proteinDisplayFromLegacyColorMode(colorMode: ProteinColorMode | undefined): ProteinDisplaySettings {
  // 表示形態を推定できる固有モードを先に分岐し、残りを Ribbon として復元する。
  if (colorMode === 'element') return { representation: 'molecular', colorMode };
  if (colorMode === 'surface-charge' || colorMode === 'hydrophobicity') return { representation: 'silhouette', colorMode };
  return {
    representation: 'ribbon',
    colorMode: colorMode === 'publication' || colorMode === 'chain' || colorMode === 'b-factor'
      || colorMode === 'entity' || colorMode === 'rainbow' || colorMode === 'secondary-structure'
      || colorMode === 'component-role'
      ? colorMode
      : 'chain',
  };
}

/** 現在の表示形態と互換な着色だけを反映する。 */
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
