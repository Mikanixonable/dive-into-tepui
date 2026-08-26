import type { ProteinBackboneAsset } from '../../render/protein-enemy-ship';
import { assertProteinDisplayAsset, type ProteinDisplayAsset } from './protein-display-asset';
import {
  validateProteinAsset, validateProteinMotionAsset, type ProteinAssetDefinition, type ProteinMotionAsset,
} from './protein-schema';
import { PROTEIN_ASSET_SOURCES } from './protein-asset-catalog.generated';

export { PROTEIN_ASSET_SOURCES };

// 生成カタログ1体分。semantic・backbone はバンドルへ静的 import 済みの小さい定義、
// structure・motion は数十MBあるため URL だけを持ち、実データは fetch で取りに行く。
export interface ProteinAssetSource {
  readonly semantic: ProteinAssetDefinition;
  readonly backbone: ProteinBackboneAsset;
  readonly structureUrl: string;
  readonly motionUrl: string;
  readonly expectedId: string;
  readonly expectedPdbId: string;
}

export interface ProteinAssetBundle {
  readonly semantic: ProteinAssetDefinition;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
  readonly motion: ProteinMotionAsset;
}

export const PROTEIN_ASSETS = Object.fromEntries(
  Object.entries(PROTEIN_ASSET_SOURCES).map(([id, source]) => [id, source.semantic]),
) as { readonly [Id in keyof typeof PROTEIN_ASSET_SOURCES]: ProteinAssetDefinition };

export type ProteinAssetId = keyof typeof PROTEIN_ASSETS;
export const PROTEIN_ASSET_IDS: readonly ProteinAssetId[] = Object.freeze(Object.keys(PROTEIN_ASSETS) as ProteinAssetId[]);

export function proteinAssetFor(id: string): ProteinAssetDefinition | null {
  return PROTEIN_ASSETS[id as ProteinAssetId] ?? null;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch protein asset payload: ${url} (${response.status})`);
  return response.json();
}

// 生成済みの semantic/backbone と、fetch 済みの structure/motion を突き合わせて検証する
// (テストは実ファイルの内容を直接渡して同期的に呼べる)。
export function buildProteinAssetBundle(
  source: ProteinAssetSource, structureValue: unknown, motionValue: unknown,
): ProteinAssetBundle {
  const { semantic, backbone, expectedId, expectedPdbId } = source;
  const issues = validateProteinAsset(semantic);
  if (semantic.id !== expectedId) issues.unshift('id must be ' + expectedId);
  if (issues.length > 0) throw new Error('Invalid protein asset ' + expectedId + ': ' + issues.join('; '));

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
  const structureHash = (structure as ProteinDisplayAsset & { readonly generator?: { readonly contentHash?: string } }).generator?.contentHash;
  const backboneHash = (backbone as ProteinBackboneAsset & { readonly contentHash?: string }).contentHash;
  if (motion.source.structureHash !== structureHash) throw new Error('Protein motion ' + expectedId + ' structure hash mismatch');
  if (motion.source.backboneHash !== backboneHash) throw new Error('Protein motion ' + expectedId + ' backbone hash mismatch');
  return { semantic, backbone, structure, motion };
}

// structure・motion を fetch してから検証する(ブラウザ実行時の入口)。
async function loadProteinAssetBundle(source: ProteinAssetSource): Promise<ProteinAssetBundle> {
  const [structureValue, motionValue] = await Promise.all([
    fetchJson(source.structureUrl),
    fetchJson(source.motionUrl),
  ]);
  return buildProteinAssetBundle(source, structureValue, motionValue);
}

// id ごとに1回だけ fetch する。準備が整うまでは resolvedProteinAssetBundles に現れない。
const proteinAssetBundlePromises = new Map<ProteinAssetId, Promise<ProteinAssetBundle>>();
const resolvedProteinAssetBundles = new Map<ProteinAssetId, ProteinAssetBundle>();

// 全タンパク質アセットの fetch を非同期に開始し、全件が決着したときに解決する promise を返す。
// 失敗した asset は isProteinAssetReady が false のまま残り、それを使う敵の実体化だけが
// 止まり続ける。待たずに投げっぱなしにしてよい。
export function startProteinAssetPreload(): Promise<void> {
  const loads = PROTEIN_ASSET_IDS.map(
    (id) => loadProteinAssetBundlePromise(id).catch((error: unknown) => { console.error(error); }),
  );
  return Promise.all(loads).then(() => undefined);
}

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

// 敵の実体化を許してよいかどうか(SPEC/PROTEIN.md「出現」節)の判定に使う。
export function isProteinAssetReady(id: string): boolean {
  return resolvedProteinAssetBundles.has(id as ProteinAssetId);
}

// 準備が整っている bundle だけを同期的に返す。未取得・取得中は null。
export function proteinAssetBundleFor(id: string): ProteinAssetBundle | null {
  return resolvedProteinAssetBundles.get(id as ProteinAssetId) ?? null;
}
