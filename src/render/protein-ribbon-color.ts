// タンパク質 Ribbon の二次構造分類と頂点色を決定する。
import * as THREE from 'three/webgpu';
import type { ProteinRibbonColorMode } from '../game/protein/protein-display';
import type { ProteinRenderSource } from './protein-ribbon';

export type ProteinSecondaryKind = 'coil' | 'helix' | 'sheet';

const CHAIN_PALETTE = [
  0x66c2a5, 0xfc8d62, 0x8da0cb, 0xe78ac3,
  0xa6d854, 0xffd92f, 0xe5c494, 0xb3b3b3,
] as const;
// 連続する整数を掛けても隣接するインデックスの色相が近づかない無理数刻み。
const GOLDEN_ANGLE_CONJUGATE = 0.6180339887498949;
const bFactorRanges = new WeakMap<object, { min: number; max: number }>();
const componentLookups = new WeakMap<object, {
  byEntity: ReadonlyMap<number, number>;
  byChain: ReadonlyMap<string, number>;
}>();

/** 三角形の3頂点が指す成分から多数決で1つを選ぶ。頂点の成分がすべて異なる場合は最初を採る。 */
export function triangleComponent(components: readonly string[], a: number, b: number, c: number): string {
  const first = components[a] ?? 'A';
  const second = components[b] ?? first;
  const third = components[c] ?? first;
  if (first === second || first === third) return first;
  if (second === third) return second;
  return first;
}

/** PDB の二次構造表記を Ribbon の3分類へ正規化する。 */
export function proteinSecondaryKind(value: string | undefined): ProteinSecondaryKind {
  const normalized = value?.toLowerCase();
  if (normalized === 'helix' || normalized === 'h' || normalized === 'alpha-helix') return 'helix';
  if (normalized === 'sheet' || normalized === 'e' || normalized === 'beta-sheet') return 'sheet';
  return 'coil';
}

/** 残基順を青から赤へ写像する。 */
function rainbowColor(t: number): THREE.Color {
  return new THREE.Color().setHSL(0.66 * (1 - Math.max(0, Math.min(1, t))), 0.86, 0.56);
}

/** 鎖 ID を Set2 の固定位置へ決定的に写像する。 */
function chainPaletteIndex(chain: string): number {
  if (/^[A-Za-z]$/.test(chain)) {
    return (chain.toUpperCase().charCodeAt(0) - 65) % CHAIN_PALETTE.length;
  }
  let hash = 2166136261;
  for (const character of chain) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % CHAIN_PALETTE.length;
}

/** 構成要素の役割を asset 内で安定した色へ写像する。 */
function componentColor(source: ProteinRenderSource, index: number): THREE.Color {
  let lookup = componentLookups.get(source);
  // 役割の宣言順を entity／chain の検索表へ一度だけ展開する。
  if (!lookup) {
    const roles = [...new Set(source.semantic.components.map((component) => component.role))];
    const byEntity = new Map<number, number>();
    const byChain = new Map<string, number>();
    for (const component of source.semantic.components) {
      const roleIndex = Math.max(0, roles.indexOf(component.role));
      for (const entity of component.entities ?? []) byEntity.set(entity, roleIndex);
      for (const chain of component.chains) byChain.set(chain, roleIndex);
    }
    lookup = { byEntity, byChain };
    componentLookups.set(source, lookup);
  }
  const entity = source.backbone.backboneEntities[index];
  const chain = source.backbone.backboneChains[index];
  const roleIndex = (entity === undefined ? undefined : lookup.byEntity.get(entity))
    ?? (chain === undefined ? undefined : lookup.byChain.get(chain))
    ?? 0;
  return new THREE.Color().setHSL((roleIndex * GOLDEN_ANGLE_CONJUGATE) % 1, 0.78, 0.56);
}

/** 指定した着色方式で残基の頂点色を返す。 */
export function proteinRibbonColor(
  source: ProteinRenderSource,
  index: number,
  mode: ProteinRibbonColorMode,
): THREE.Color {
  const backbone = source.backbone;
  if (mode === 'rainbow') return rainbowColor(index / Math.max(1, backbone.backboneCount - 1));
  if (mode === 'secondary-structure') {
    const kind = proteinSecondaryKind(backbone.backboneSecondary[index]);
    return new THREE.Color(kind === 'helix' ? 0xe85d75 : kind === 'sheet' ? 0xf2c14e : 0x8fa7bd);
  }
  // B-factor は asset 内の実測範囲を虹色の両端へ正規化する。
  if (mode === 'b-factor') {
    let range = bFactorRanges.get(backbone);
    if (!range) {
      range = { min: Math.min(...backbone.backboneBFactors), max: Math.max(...backbone.backboneBFactors) };
      bFactorRanges.set(backbone, range);
    }
    return rainbowColor(
      ((backbone.backboneBFactors[index] ?? range.min) - range.min) / Math.max(1e-6, range.max - range.min),
    );
  }
  if (mode === 'component') return componentColor(source, index);
  const chain = backbone.backboneChains[index] ?? 'A';
  return new THREE.Color(CHAIN_PALETTE[chainPaletteIndex(chain)]!);
}
