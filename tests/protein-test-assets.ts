// テストは webpack の asset/resource 変換(URL 文字列化)を経ずに直接 tsc/node で走るため、
// 生成カタログの structureUrl/motionUrl には実データそのものが入っている。それを使って
// production の非同期 fetch 経路を経ずに bundle を組み立てる。
import {
  buildProteinAssetBundle, PROTEIN_ASSET_IDS, PROTEIN_ASSET_SOURCES, type ProteinAssetBundle, type ProteinAssetId,
} from '../src/game/protein/protein-asset-loader';

const bundleCache = new Map<ProteinAssetId, ProteinAssetBundle>();

export function testProteinAssetBundleFor(id: ProteinAssetId): ProteinAssetBundle {
  const cached = bundleCache.get(id);
  if (cached) return cached;
  const source = PROTEIN_ASSET_SOURCES[id];
  const bundle = buildProteinAssetBundle(source, source.structureUrl, source.motionUrl);
  bundleCache.set(id, bundle);
  return bundle;
}

export function testProteinAssetBundles(): readonly ProteinAssetBundle[] {
  return PROTEIN_ASSET_IDS.map(testProteinAssetBundleFor);
}
