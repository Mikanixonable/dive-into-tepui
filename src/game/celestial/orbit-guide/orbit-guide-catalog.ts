// CR3BP 周期軌道カタログの読み込み。族の点列は系ごとに1ファイルへ分かれていて、その系が
// 初めて必要になったときに動的 import で取りに行く(webpack が自動でコード分割する)。
// 起動時から同期で要る族 id 一覧と系の素性だけは、軽い索引を静的に読む。
import { lagrangeJacobi } from '../../../physics/zero-velocity';
import type { LagrangeLabel } from '../../../physics/lagrange';
import type {
  CatalogSystem, CatalogSystemId, CatalogSystemScale, OrbitCatalog, OrbitCatalogIndex,
} from '../../../physics/orbit-catalog';
import indexTable from '../../../assets/orbits/lagrange-orbits-index.json';

const CATALOG_INDEX = indexTable as unknown as OrbitCatalogIndex;

// 系の質量比・単位。族の点列を待たずに引ける。
export function catalogSystemScale(id: CatalogSystemId): CatalogSystemScale | null {
  return CATALOG_INDEX.scales[id] ?? null;
}

// L1〜L5 のヤコビ定数は系ごとの mu で決まる。
export function lagrangePointJacobi(system: 'earth-moon' | 'sun-earth', point: LagrangeLabel): number {
  const fallback = system === 'earth-moon' ? 0.012150585 : 3.003e-6;
  return lagrangeJacobi(catalogSystemScale(system)?.mu ?? fallback, point);
}

// 系ごとの取得関数。系ごとに1個の別ファイルを充てる。
const LAZY_IMPORTS: Readonly<Record<CatalogSystemId, () => Promise<{ readonly default: unknown }>>> = {
  'earth-moon': () => import('../../../assets/orbits/lagrange-orbits-earth-moon.json'),
  'sun-earth': () => import('../../../assets/orbits/lagrange-orbits-sun-earth.json'),
  'sun-mars': () => import('../../../assets/orbits/lagrange-orbits-sun-mars.json'),
  'jupiter-europa': () => import('../../../assets/orbits/lagrange-orbits-jupiter-europa.json'),
  'saturn-titan': () => import('../../../assets/orbits/lagrange-orbits-saturn-titan.json'),
  'saturn-enceladus': () => import('../../../assets/orbits/lagrange-orbits-saturn-enceladus.json'),
  'mars-phobos': () => import('../../../assets/orbits/lagrange-orbits-mars-phobos.json'),
};

type LoadState = 'loading' | 'loaded' | 'failed';

// 焼き込みが持つ系ごとの族 id 一覧。まだ読み込んでいない系のぶんも索引に入っているので、
// 起動直後から全系の選択肢を組める。
export function catalogFamilyIndex(): ReadonlyMap<CatalogSystemId, readonly string[]> {
  const out = new Map<CatalogSystemId, readonly string[]>();
  for (const [id, families] of Object.entries(CATALOG_INDEX.familyIndex)) {
    if (families !== undefined) out.set(id as CatalogSystemId, families);
  }
  return out;
}

// 系ごとの軌道族カタログを保持し、未読み込みの系は取得しつつ null を返す。同じ系を
// 二重に読み込まない。取得に失敗した系は一度だけログへ残し、以後は諦めて null を返し続ける。
export class OrbitGuideCatalog {
  private readonly systems: Partial<Record<CatalogSystemId, CatalogSystem>> = {};
  private readonly loadState = new Map<CatalogSystemId, LoadState>();
  // 系の読み込みが完了するたびに増える世代。呼び出し側はこれの変化を見て、通常の再計算間隔を
  // 待たずに読み込み完了した系をすぐ表示へ反映できる。
  public generation = 0;

  public systemFor(id: CatalogSystemId): CatalogSystem | null {
    const existing = this.systems[id];
    if (existing) return existing;
    if (!this.loadState.has(id)) this.startLoad(id);
    return null;
  }

  // その系にその族があるか。索引を見るので、族の点列を読み込む前でも判定できる。
  public hasFamily(system: CatalogSystemId, familyId: string): boolean {
    return CATALOG_INDEX.familyIndex[system]?.includes(familyId) ?? false;
  }

  private startLoad(id: CatalogSystemId): void {
    this.loadState.set(id, 'loading');
    LAZY_IMPORTS[id]()
      .then((mod) => {
        const catalog = mod.default as unknown as OrbitCatalog;
        const system = catalog.systems[id];
        this.loadState.set(id, system ? 'loaded' : 'failed');
        if (system) this.systems[id] = system;
        this.generation++;
      })
      .catch((err: unknown) => {
        this.loadState.set(id, 'failed');
        console.error(`軌道ガイド: 系 ${id} のカタログ読み込みに失敗しました`, err);
        this.generation++;
      });
  }
}
