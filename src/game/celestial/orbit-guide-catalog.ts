// CR3BP 周期軌道カタログの読み込み。地球-月・太陽-地球はバンドルへ静的 import 済み、残り5系は
// その系が初めて必要になったときに動的 import で取りに行く(webpack が自動でコード分割する)。
import type { CatalogSystem, CatalogSystemId, OrbitCatalog } from '../../physics/orbit-catalog';
import staticTable from '../../assets/orbits/lagrange-orbits.json';

const STATIC_CATALOG = staticTable as unknown as OrbitCatalog;

// 遅延ロード対象の系と、その取得関数。系ごとに1個の別ファイルを充てる。
const LAZY_IMPORTS: Readonly<Partial<Record<CatalogSystemId, () => Promise<{ readonly default: unknown }>>>> = {
  'sun-mars': () => import('../../assets/orbits/lagrange-orbits-sun-mars.json'),
  'jupiter-europa': () => import('../../assets/orbits/lagrange-orbits-jupiter-europa.json'),
  'saturn-titan': () => import('../../assets/orbits/lagrange-orbits-saturn-titan.json'),
  'saturn-enceladus': () => import('../../assets/orbits/lagrange-orbits-saturn-enceladus.json'),
  'mars-phobos': () => import('../../assets/orbits/lagrange-orbits-mars-phobos.json'),
};

type LoadState = 'loading' | 'loaded' | 'failed';

// 焼き込みが持つ系ごとの族 id 一覧。遅延ロードする系のぶんも索引に入っているので、起動直後から
// 全系の選択肢を組める。
export function catalogFamilyIndex(): ReadonlyMap<CatalogSystemId, readonly string[]> {
  const out = new Map<CatalogSystemId, readonly string[]>();
  for (const [id, families] of Object.entries(STATIC_CATALOG.familyIndex)) {
    if (families !== undefined) out.set(id as CatalogSystemId, families);
  }
  return out;
}

// 系ごとの軌道族カタログを保持し、未読み込みの系は取得しつつ null を返す。同じ系を
// 二重に読み込まない。取得に失敗した系は一度だけログへ残し、以後は諦めて null を返し続ける。
export class OrbitGuideCatalog {
  private readonly systems: Partial<Record<CatalogSystemId, CatalogSystem>>;
  private readonly loadState = new Map<CatalogSystemId, LoadState>();
  // 系の読み込みが完了するたびに増える世代。呼び出し側はこれの変化を見て、通常の再計算間隔を
  // 待たずに読み込み完了した系をすぐ表示へ反映できる。
  public generation = 0;

  public constructor() {
    this.systems = { ...STATIC_CATALOG.systems };
    for (const id of Object.keys(this.systems) as CatalogSystemId[]) this.loadState.set(id, 'loaded');
  }

  public systemFor(id: CatalogSystemId): CatalogSystem | null {
    const existing = this.systems[id];
    if (existing) return existing;
    if (!this.loadState.has(id)) this.startLoad(id);
    return null;
  }

  private startLoad(id: CatalogSystemId): void {
    const loader = LAZY_IMPORTS[id];
    if (!loader) {
      this.loadState.set(id, 'failed');
      return;
    }
    this.loadState.set(id, 'loading');
    loader()
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
