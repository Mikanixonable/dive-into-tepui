// 準惑星・大型小惑星とその衛星の見た目。physics 側 dwarf-planets.ts の運動の名前付き
// フィールドと写像型で1:1 に対応し、天体を足して見た目を書き忘れるとコンパイルエラーになる。
import type { DwarfPlanetMotions } from '../../../physics/solar-system/dwarf-planets';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity';
import { SphereEntity } from '../sphere-entity';

// 準惑星・大型小惑星とその衛星の表示名。
export const DWARF_PLANET_NAMES: { readonly [K in keyof DwarfPlanetMotions]: string } = {
  ceres: 'ケレス',
  vesta: 'ベスタ',
  pallas: 'パラス',
  pluto: '冥王星',
  charon: 'カロン',
  styx: 'ステュクス',
  nix: 'ニクス',
  kerberos: 'ケルベロス',
  hydra: 'ヒドラ',
  haumea: 'ハウメア',
  hiiaka: 'ヒイアカ',
  namaka: 'ナマカ',
  makemake: 'マケマケ',
  eris: 'エリス',
  dysnomia: 'ディスノミア',
};

// 準惑星・大型小惑星とその衛星の運動に見た目を対応づける。
export function dwarfPlanetEntities(
  m: DwarfPlanetMotions,
): { readonly [K in keyof DwarfPlanetMotions]: CelestialEntity } {
  const names = DWARF_PLANET_NAMES;
  return {
    ceres: new SphereEntity(
      m.ceres, names.ceres, 'dwarf',
      // A_B=0.035(幾何 0.090 x q=0.393)
      CelestialSurface.solid([0.0382, 0.0345, 0.0310]),
    ),
    vesta: new SphereEntity(
      m.vesta, names.vesta, 'smallBody',
      // A_B=0.195(幾何 0.423 x q=0.461)
      CelestialSurface.solid([0.2156, 0.1925, 0.1593]),
    ),
    pallas: new SphereEntity(
      m.pallas, names.pallas, 'smallBody',
      // A_B=0.061(幾何 0.155 x q=0.393)
      CelestialSurface.solid([0.0616, 0.0616, 0.0533]),
    ),
    pluto: new SphereEntity(
      m.pluto, names.pluto, 'dwarf',
      // A_B=0.72(公表ボンド 0.72(NASA Pluto Fact Sheet。幾何は 0.52))
      CelestialSurface.solid([0.9026, 0.6880, 0.4994]),
    ),
    charon: new SphereEntity(
      m.charon, names.charon, 'satellite',
      // A_B=0.21(幾何 0.38 x q=0.564)
      CelestialSurface.solid([0.2182, 0.2090, 0.1957]),
    ),
    styx: new SphereEntity(
      m.styx, names.styx, 'satellite',
      // A_B=0.37(幾何 0.65 x q=0.564)
      CelestialSurface.solid([0.4236, 0.3598, 0.3131]),
    ),
    nix: new SphereEntity(
      m.nix, names.nix, 'satellite',
      // A_B=0.32(幾何 0.56 x q=0.564)
      CelestialSurface.solid([0.3664, 0.3112, 0.2708]),
    ),
    kerberos: new SphereEntity(
      m.kerberos, names.kerberos, 'satellite',
      // A_B=0.32(幾何 0.56 x q=0.564)
      CelestialSurface.solid([0.3664, 0.3112, 0.2708]),
    ),
    hydra: new SphereEntity(
      m.hydra, names.hydra, 'satellite',
      // A_B=0.47(幾何 0.83 x q=0.564)
      CelestialSurface.solid([0.5381, 0.4570, 0.3977]),
    ),
    haumea: new SphereEntity(
      m.haumea, names.haumea, 'dwarf',
      // A_B=0.29(幾何 0.51 x q=0.564)
      CelestialSurface.solid([0.2900, 0.2900, 0.2900]),
    ),
    hiiaka: new SphereEntity(
      m.hiiaka, names.hiiaka, 'satellite',
      // A_B=0.28(分類既定 幾何 0.5 x q=0.564(母天体ハウメアと同じ氷質を仮定))
      CelestialSurface.solid([0.3206, 0.2723, 0.2369]),
    ),
    namaka: new SphereEntity(
      m.namaka, names.namaka, 'satellite',
      // A_B=0.28(分類既定 幾何 0.5 x q=0.564(母天体ハウメアと同じ氷質を仮定))
      CelestialSurface.solid([0.3206, 0.2723, 0.2369]),
    ),
    makemake: new SphereEntity(
      m.makemake, names.makemake, 'dwarf',
      // A_B=0.46(幾何 0.81 x q=0.564)
      CelestialSurface.solid([0.7020, 0.4110, 0.2331]),
    ),
    eris: new SphereEntity(
      m.eris, names.eris, 'dwarf',
      // A_B=0.54(幾何 0.96 x q=0.564)
      CelestialSurface.solid([0.5400, 0.5400, 0.5400]),
    ),
    dysnomia: new SphereEntity(
      m.dysnomia, names.dysnomia, 'satellite',
      // A_B=0.016(幾何 0.04 x q=0.393)
      CelestialSurface.solid([0.0183, 0.0156, 0.0135]),
    ),
  };
}
