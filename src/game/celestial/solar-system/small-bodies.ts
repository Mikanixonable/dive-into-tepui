// 彗星核・小惑星・太陽系外縁天体の見た目。physics 側 small-bodies.ts の運動の名前付き
// フィールドと写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import type { SmallBodyMotions } from '../../../physics/solar-system/small-bodies';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { SphereEntity } from '../sphere-entity';

// 彗星核・小惑星・太陽系外縁天体の表示名。
export const SMALL_BODY_NAMES: { readonly [K in keyof SmallBodyMotions]: string } = {
  halley: 'ハレー彗星',
  encke: 'エンケ彗星',
  sedna: 'セドナ',
  quaoar: 'クワオアー',
  weywot: 'ウェイウォット',
  chariklo: 'カリクロー',
  hygiea: 'ヒギエア',
  eros: 'エロス',
  ryugu: 'リュウグウ',
  bennu: 'ベンヌ',
  orcus: 'オルクス',
  vanth: 'ヴァンス',
  gonggong: 'ゴンゴン',
  salacia: 'サラキア',
  varuna: 'ヴァルナ',
  ixion: 'イクシオン',
  arrokoth: 'アロコス',
  chiron: 'キロン',
  interamnia: 'インテラムニア',
  europa52: 'エウロパ (52)',
  davida: 'ダビダ',
  juno: 'ジュノー',
  psyche: 'プシケ',
  eunomia: 'エウノミア',
  sylvia: 'シルビア',
  apophis: 'アポフィス',
  didymos: 'ディディモス',
  tempel1: 'テンペル第1彗星',
  wild2: 'ワイルド第2彗星',
  hartley2: 'ハートレー第2彗星',
  cruithne: 'クルースン',
  kamooalewa: 'カモオアレワ',
  tk7: '2010 TK7',
  eureka: 'エウレカ',
};

// 彗星核・小惑星・太陽系外縁天体の運動に見た目を対応づける。
export function smallBodyEntities(
  m: SmallBodyMotions,
): { readonly [K in keyof SmallBodyMotions]: CelestialEntity } {
  const names = SMALL_BODY_NAMES;
  return {
    // ハレー彗星 A_B=0.016(幾何 0.04 x q=0.393)
    halley: new SphereEntity(m.halley, names.halley, 'smallBody', CelestialSurface.solid([0.0160, 0.0160, 0.0160])),
    // エンケ彗星 A_B=0.02(幾何 0.05 x q=0.393)
    encke: new SphereEntity(m.encke, names.encke, 'smallBody', CelestialSurface.solid([0.0200, 0.0200, 0.0200])),
    // セドナ A_B=0.15(幾何 0.32 x q=0.461)
    sedna: new SphereEntity(m.sedna, names.sedna, 'dwarf', CelestialSurface.solid([0.1759, 0.1453, 0.1203])),
    // クワオアー A_B=0.05(幾何 0.109 x q=0.461)
    quaoar: new SphereEntity(m.quaoar, names.quaoar, 'dwarf', CelestialSurface.solid([0.0616, 0.0479, 0.0363])),
    // ウェイウォット A_B=0.046(分類既定 幾何 0.10 x q=0.461)
    weywot: new SphereEntity(m.weywot, names.weywot, 'satellite', CelestialSurface.solid([0.0527, 0.0447, 0.0389])),
    // カリクロー A_B=0.014(幾何 0.035 x q=0.393)
    chariklo: new SphereEntity(m.chariklo, names.chariklo, 'smallBody', CelestialSurface.solid([0.0161, 0.0137, 0.0108])),
    // ヒギエア A_B=0.028(幾何 0.072 x q=0.393)
    hygiea: new SphereEntity(m.hygiea, names.hygiea, 'smallBody', CelestialSurface.solid([0.0301, 0.0278, 0.0239])),
    // エロス A_B=0.115(幾何 0.25 x q=0.461)
    eros: new SphereEntity(m.eros, names.eros, 'smallBody', CelestialSurface.solid([0.1367, 0.1129, 0.0718])),
    // リュウグウ A_B=0.018(幾何 0.045 x q=0.393)
    ryugu: new SphereEntity(m.ryugu, names.ryugu, 'smallBody', CelestialSurface.solid([0.0212, 0.0174, 0.0141])),
    // ベンヌ A_B=0.017(幾何 0.044 x q=0.393)
    bennu: new SphereEntity(m.bennu, names.bennu, 'smallBody', CelestialSurface.solid([0.0196, 0.0166, 0.0138])),
    // オルクス A_B=0.106(幾何 0.23 x q=0.461)
    orcus: new SphereEntity(m.orcus, names.orcus, 'dwarf', CelestialSurface.solid([0.1053, 0.1053, 0.1146])),
    // ヴァンス A_B=0.031(幾何 0.08 x q=0.393)
    vanth: new SphereEntity(m.vanth, names.vanth, 'satellite', CelestialSurface.solid([0.0355, 0.0301, 0.0262])),
    // ゴンゴン A_B=0.065(幾何 0.14 x q=0.461)
    gonggong: new SphereEntity(m.gonggong, names.gonggong, 'dwarf', CelestialSurface.solid([0.1126, 0.0540, 0.0336])),
    // サラキア A_B=0.017(幾何 0.042 x q=0.393)
    salacia: new SphereEntity(m.salacia, names.salacia, 'dwarf', CelestialSurface.solid([0.0151, 0.0171, 0.0216])),
    // ヴァルナ A_B=0.059(幾何 0.127 x q=0.461)
    varuna: new SphereEntity(m.varuna, names.varuna, 'dwarf', CelestialSurface.solid([0.0645, 0.0585, 0.0476])),
    // イクシオン A_B=0.05(幾何 0.108 x q=0.461)
    ixion: new SphereEntity(m.ixion, names.ixion, 'dwarf', CelestialSurface.solid([0.0589, 0.0485, 0.0392])),
    // アロコス A_B=0.065(幾何 0.165 x q=0.393)
    arrokoth: new SphereEntity(m.arrokoth, names.arrokoth, 'smallBody', CelestialSurface.solid([0.1783, 0.0365, 0.0135])),
    // キロン A_B=0.063(幾何 0.16 x q=0.393)
    chiron: new SphereEntity(m.chiron, names.chiron, 'smallBody', CelestialSurface.solid([0.0695, 0.0623, 0.0512])),
    // インテラムニア A_B=0.029(幾何 0.074 x q=0.393)
    interamnia: new SphereEntity(
      m.interamnia, names.interamnia, 'smallBody', CelestialSurface.solid([0.0308, 0.0288, 0.0251]),
    ),
    // エウロパ (52) A_B=0.023(幾何 0.058 x q=0.393)
    europa52: new SphereEntity(m.europa52, names.europa52, 'smallBody', CelestialSurface.solid([0.0251, 0.0228, 0.0192])),
    // ダビダ A_B=0.021(幾何 0.054 x q=0.393)
    davida: new SphereEntity(m.davida, names.davida, 'smallBody', CelestialSurface.solid([0.0230, 0.0208, 0.0173])),
    // ジュノー A_B=0.11(幾何 0.238 x q=0.461)
    juno: new SphereEntity(m.juno, names.juno, 'smallBody', CelestialSurface.solid([0.1285, 0.1070, 0.0849])),
    // プシケ A_B=0.055(幾何 0.12 x q=0.461)
    psyche: new SphereEntity(m.psyche, names.psyche, 'smallBody', CelestialSurface.solid([0.0606, 0.0540, 0.0479])),
    // エウノミア A_B=0.096(幾何 0.209 x q=0.461)
    eunomia: new SphereEntity(m.eunomia, names.eunomia, 'smallBody', CelestialSurface.solid([0.1125, 0.0942, 0.0654])),
    // シルビア A_B=0.018(幾何 0.045 x q=0.393)
    sylvia: new SphereEntity(m.sylvia, names.sylvia, 'smallBody', CelestialSurface.solid([0.0198, 0.0177, 0.0157])),
    // アポフィス A_B=0.161(幾何 0.35 x q=0.461)
    apophis: new SphereEntity(m.apophis, names.apophis, 'smallBody', CelestialSurface.solid([0.1698, 0.1595, 0.1496])),
    // ディディモス A_B=0.069(幾何 0.15 x q=0.461)
    didymos: new SphereEntity(m.didymos, names.didymos, 'smallBody', CelestialSurface.solid([0.0733, 0.0685, 0.0616])),
    // テンペル第1彗星 A_B=0.016(幾何 0.04 x q=0.393)
    tempel1: new SphereEntity(m.tempel1, names.tempel1, 'smallBody', CelestialSurface.solid([0.0160, 0.0160, 0.0160])),
    // ワイルド第2彗星 A_B=0.012(幾何 0.03 x q=0.393)
    wild2: new SphereEntity(m.wild2, names.wild2, 'smallBody', CelestialSurface.solid([0.0120, 0.0120, 0.0120])),
    // ハートレー第2彗星 A_B=0.011(幾何 0.028 x q=0.393)
    hartley2: new SphereEntity(
      m.hartley2, names.hartley2, 'smallBody', CelestialSurface.solid([0.0110, 0.0110, 0.0110]),
    ),
    // クルースン A_B=0.069(分類既定 幾何 0.15 x q=0.461)
    cruithne: new SphereEntity(m.cruithne, names.cruithne, 'smallBody', CelestialSurface.solid([0.0763, 0.0682, 0.0557])),
    // カモオアレワ A_B=0.111(幾何 0.24 x q=0.461)
    kamooalewa: new SphereEntity(
      m.kamooalewa, names.kamooalewa, 'smallBody', CelestialSurface.solid([0.1394, 0.1073, 0.0643]),
    ),
    // 2010 TK7 A_B=0.039(分類既定 幾何 0.10 x q=0.393)
    tk7: new SphereEntity(m.tk7, names.tk7, 'smallBody', CelestialSurface.solid([0.0432, 0.0383, 0.0337])),
    // エウレカ A_B=0.18(幾何 0.39 x q=0.461)
    eureka: new SphereEntity(m.eureka, names.eureka, 'smallBody', CelestialSurface.solid([0.2377, 0.1718, 0.0912])),
  };
}
