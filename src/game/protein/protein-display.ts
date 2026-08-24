export type ProteinRepresentation = 'molecular' | 'ribbon' | 'silhouette';

export type ProteinMolecularColorMode = 'element';
export type ProteinRibbonColorMode = 'chain' | 'b-factor' | 'entity' | 'rainbow' | 'secondary-structure' | 'component-role';
export type ProteinSilhouetteColorMode = 'surface-charge' | 'hydrophobicity';
export type Pdb5i4rColorMode = ProteinMolecularColorMode | ProteinRibbonColorMode | ProteinSilhouetteColorMode;

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

export const PROTEIN_COLOR_LABELS: Readonly<Record<Pdb5i4rColorMode, string>> = {
  element: '元素',
  chain: 'Chain',
  'b-factor': 'B-Factor',
  entity: 'Entity',
  rainbow: 'Rainbow',
  'secondary-structure': '二次構造',
  'component-role': '構成要素',
  'surface-charge': '表面電荷（近似）',
  hydrophobicity: '疎水性',
};

export function proteinColorModesFor(representation: ProteinRepresentation): readonly Pdb5i4rColorMode[] {
  if (representation === 'molecular') return ['element'];
  if (representation === 'silhouette') return ['surface-charge', 'hydrophobicity'];
  return ['chain', 'b-factor', 'entity', 'rainbow', 'secondary-structure', 'component-role'];
}

export function defaultProteinDisplayFor(representation: ProteinRepresentation): ProteinDisplaySettings {
  if (representation === 'molecular') return { representation, colorMode: 'element' };
  if (representation === 'silhouette') return { representation, colorMode: 'surface-charge' };
  return { representation, colorMode: 'chain' };
}

export function proteinDisplayFromLegacyColorMode(colorMode: Pdb5i4rColorMode | undefined): ProteinDisplaySettings {
  if (colorMode === 'element') return { representation: 'molecular', colorMode };
  if (colorMode === 'surface-charge' || colorMode === 'hydrophobicity') return { representation: 'silhouette', colorMode };
  return {
    representation: 'ribbon',
    colorMode: colorMode === 'rainbow' || colorMode === 'secondary-structure' || colorMode === 'component-role'
      ? colorMode
      : 'chain',
  };
}

export function proteinDisplayWithColor(
  representation: ProteinRepresentation, colorMode: Pdb5i4rColorMode,
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

export function isProteinDisplaySettings(value: unknown): value is ProteinDisplaySettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { representation?: unknown; colorMode?: unknown };
  if (candidate.representation === 'molecular') return candidate.colorMode === 'element';
  if (candidate.representation === 'ribbon') return proteinColorModesFor('ribbon').includes(candidate.colorMode as ProteinRibbonColorMode);
  if (candidate.representation === 'silhouette') return proteinColorModesFor('silhouette').includes(candidate.colorMode as ProteinSilhouetteColorMode);
  return false;
}
