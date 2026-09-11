// タンパク質アセットの取得・検証と、準備が整った体の同期的な引き当て。
import { assertProteinDisplayAsset } from '../../render/protein/protein-display-asset';
import { createProteinRenderDefinition } from '../../render/protein/protein-render-definition';
import {
  validateProteinAsset, validateProteinMotionAsset, type ProteinAssetDefinition, type ProteinMotionAsset,
} from './protein-schema';
import { PROTEIN_ASSET_SOURCES } from './protein-asset-catalog.generated';
import type { ProteinDisplayAsset } from '../../render/protein/protein-display-asset';
import type {
  ProteinBackboneAsset, ProteinRenderDefinition, ProteinRenderSource,
} from '../../render/protein/protein-render-definition';

// 生成カタログ1体分。semantic はバンドルに含め、主鎖・構造・モーションは URL から取得する。
export interface ProteinAssetSource {
  readonly semantic: ProteinAssetDefinition;
  readonly backboneUrl: string;
  readonly structureUrl: string;
  readonly motionUrl: string;
  readonly expectedId: string;
  readonly expectedPdbId: string;
}

/** 意味論と判定形状が読む、1体ぶんの定義。 */
export interface ProteinSemanticSource {
  readonly asset: ProteinAssetDefinition;
  readonly motion: ProteinMotionAsset;
  readonly backbone: ProteinBackboneAsset;
}

/** 検証済みの1体ぶんを、意味論・判定が読む面と表示が読む面へ分けて束ねたもの。 */
export interface ProteinAssetBundle {
  readonly semantic: ProteinSemanticSource;
  readonly render: ProteinRenderSource;
}

const PROTEIN_ASSETS = Object.fromEntries(
  Object.entries(PROTEIN_ASSET_SOURCES).map(([id, source]) => [id, source.semantic]),
) as { readonly [Id in keyof typeof PROTEIN_ASSET_SOURCES]: ProteinAssetDefinition };

export type ProteinAssetId = keyof typeof PROTEIN_ASSETS;
export const PROTEIN_ASSET_IDS: readonly ProteinAssetId[] = Object.freeze(Object.keys(PROTEIN_ASSETS) as ProteinAssetId[]);

// id の意味論定義。カタログに同梱されているので取得を待たずに引ける。未登録の id なら null。
export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return PROTEIN_ASSETS[id as ProteinAssetId] ?? null;
}

// url の JSON を取得する。HTTP エラーは例外にする。
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch protein asset payload: ${url} (${response.status})`);
  return response.json();
}

// semantic と取得済みの主鎖・構造・モーションを突き合わせて検証し、束ねる。不整合があれば
// 例外を投げる。
export function buildProteinAssetBundle(
  source: ProteinAssetSource, backboneValue: unknown, structureValue: unknown, motionValue: unknown,
): ProteinAssetBundle {
  // 意味論定義
  const { semantic, expectedId, expectedPdbId } = source;
  const issues = validateProteinAsset(semantic);
  if (semantic.id !== expectedId) issues.unshift('id must be ' + expectedId);
  if (issues.length > 0) throw new Error('Invalid protein asset ' + expectedId + ': ' + issues.join('; '));

  // 構造と、それに残基数を合わせたモーション
  const backbone = backboneValue as ProteinBackboneAsset;
  const structure = structureValue as ProteinDisplayAsset;
  assertProteinDisplayAsset(structure, expectedPdbId);
  const motion = motionValue as ProteinMotionAsset;
  const motionIssues = validateProteinMotionAsset(motion, expectedPdbId, {
    atomResidues: structure.atoms.count,
    backboneResidues: backbone.backboneCount,
    surfaceResidues: structure.surface.mesh.position.length / 3,
    ribbonResidues: structure.ribbon.mesh.position.length / 3,
    siteResidues: semantic.sites.length,
    modificationResidues: semantic.modificationSlots.length,
  });
  if (motionIssues.length > 0) throw new Error('Invalid protein motion asset ' + expectedId + ': ' + motionIssues.join('; '));
  // モーションが同じ構造・主鎖から生成されたかをハッシュで確かめる
  const structureHash = structure.generator.contentHash;
  const backboneHash = (backbone as ProteinBackboneAsset & { readonly contentHash?: string }).contentHash;
  if (motion.source.structureHash !== structureHash) throw new Error('Protein motion ' + expectedId + ' structure hash mismatch');
  if (motion.source.backboneHash !== backboneHash) throw new Error('Protein motion ' + expectedId + ' backbone hash mismatch');
  return {
    semantic: { asset: semantic, motion, backbone },
    render: { semantic, motion, backbone, structure },
  };
}

// 主鎖・構造・モーションを取得してから検証する。
async function loadProteinAssetBundle(source: ProteinAssetSource): Promise<ProteinAssetBundle> {
  const [backboneValue, structureValue, motionValue] = await Promise.all([
    fetchJson(source.backboneUrl),
    fetchJson(source.structureUrl),
    fetchJson(source.motionUrl),
  ]);
  return buildProteinAssetBundle(source, backboneValue, structureValue, motionValue);
}

// id ごとに1回だけ fetch する。準備が整うまでは resolvedProteinAssetBundles に現れない。
const proteinAssetBundlePromises = new Map<ProteinAssetId, Promise<ProteinAssetBundle>>();
const resolvedProteinAssetBundles = new Map<ProteinAssetId, ProteinAssetBundle>();

// この体の取得を始め、決着したときに解決する promise を返す(拒否はしない)。同じ体を
// 何度要求しても fetch は1回。**待たずに投げっぱなしにしてよい** — 準備が整ったかは
// isProteinAssetReady が答え、失敗した asset は false のまま残る。
export function requestProteinAsset(id: ProteinAssetId): Promise<void> {
  return loadProteinAssetBundlePromise(id)
    .then(() => undefined)
    .catch((error: unknown) => { console.error(error); });
}

// id の取得・検証の promise。同じ id には同じ promise を返し、成功したら
// resolvedProteinAssetBundles へ登録する。
function loadProteinAssetBundlePromise(id: ProteinAssetId): Promise<ProteinAssetBundle> {
  let promise = proteinAssetBundlePromises.get(id);
  if (promise) return promise;
  promise = loadProteinAssetBundle(PROTEIN_ASSET_SOURCES[id]).then((bundle) => {
    resolvedProteinAssetBundles.set(id, bundle);
    return bundle;
  });
  proteinAssetBundlePromises.set(id, promise);
  return promise;
}

// id のアセットが取得・検証を終え、同期的に引ける状態か。
export function isProteinAssetReady(id: string): boolean {
  return resolvedProteinAssetBundles.has(id as ProteinAssetId);
}

// この体の取得を起こし(副作用)、それが揃ったかを答える述語を返す。
export function proteinAssetGate(id: ProteinAssetId): () => boolean {
  void requestProteinAsset(id);
  return () => isProteinAssetReady(id);
}

// 準備が整っている bundle だけを同期的に返す。未取得・取得中は null。
export function proteinAssetBundleFor(id: string): ProteinAssetBundle | null {
  return resolvedProteinAssetBundles.get(id as ProteinAssetId) ?? null;
}

// id ごとに1度組んだ表示定義。束ねたアセットと同じ寿命で使い回す。
const proteinRenderDefinitions = new Map<ProteinAssetId, ProteinRenderDefinition>();

/** id の表示定義。アセットが未取得なら null。 */
export function proteinRenderDefinitionFor(id: string): ProteinRenderDefinition | null {
  const assetId = id as ProteinAssetId;
  const cached = proteinRenderDefinitions.get(assetId);
  if (cached) return cached;
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) return null;
  const definition = createProteinRenderDefinition(bundle.render);
  proteinRenderDefinitions.set(assetId, definition);
  return definition;
}
