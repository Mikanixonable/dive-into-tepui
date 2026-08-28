// 天体の見た目: id から表示名と CelestialView の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
//
// 見た目そのもの(アルベド・テクスチャ)は render/ が持つ(celestial-albedo.ts /
// celestial-textures.ts)。ここに残るのは id・表示名・どの view クラスを使うかの選択だけ。
import type { CelestialMotion, PlanetDef, SatelliteDef } from '../../physics/celestial-motion';
import { MOON } from '../../physics/solar-system/earth-system';
import {
  MERCURY, VENUS,
} from '../../physics/solar-system/inner-planets';
import {
  MARS, PHOBOS, DEIMOS,
} from '../../physics/solar-system/mars-system';
import {
  JUPITER, METIS, ADRASTEA, AMALTHEA, THEBE, IO, EUROPA, GANYMEDE, CALLISTO, HIMALIA, ELARA, ANANKE, CARME,
  PASIPHAE, SINOPE,
} from '../../physics/solar-system/jupiter-system';
import {
  SATURN, PAN, DAPHNIS, PROMETHEUS, PANDORA, EPIMETHEUS, JANUS, MIMAS, ENCELADUS, TETHYS, DIONE, RHEA, TITAN,
  HYPERION, IAPETUS, PHOEBE,
} from '../../physics/solar-system/saturn-system';
import {
  URANUS, PUCK, MIRANDA, ARIEL, UMBRIEL, TITANIA, OBERON,
} from '../../physics/solar-system/uranus-system';
import {
  NEPTUNE, TRITON, NEREID,
} from '../../physics/solar-system/neptune-system';
import {
  CERES, VESTA, PALLAS, PLUTO, CHARON, STYX, NIX, KERBEROS, HYDRA, HAUMEA, HIIAKA, NAMAKA, MAKEMAKE, ERIS,
  DYSNOMIA,
} from '../../physics/solar-system/dwarf-planets';
import {
  HALLEY, ENCKE, SEDNA, QUAOAR, WEYWOT, CHARIKLO, HYGIEA, EROS, RYUGU, BENNU, ORCUS, VANTH, GONGGONG, SALACIA,
  VARUNA, IXION, ARROKOTH, CHIRON, INTERAMNIA, EUROPA52, DAVIDA, JUNO, PSYCHE, EUNOMIA, SYLVIA, APOPHIS, DIDYMOS,
  TEMPEL1, WILD2, HARTLEY2, CRUITHNE, KAMOOALEWA, TK7, EUREKA,
} from '../../physics/solar-system/small-bodies';
import { SolarSystemId } from '../../physics/solar-system/solar-system';
import { CelestialSurface } from '../../render/celestial-surface';
import type { SunLight } from '../../render/pipeline/sun-light';
import type { SunOcclusion } from '../../render/pipeline/sun-occlusion';
import { albedoOf, DEFAULT_ALBEDO } from '../../render/celestial-albedo';
import { textureOf } from '../../render/celestial-textures';
import { MoonSurfaceMarkings } from '../../render/moon-surface-markings';
import { CelestialView } from './celestial-view';
import { EarthView } from './earth-view';
import { SphereView } from './sphere-view';
import { PointView } from './point-view';
import { SunView } from './sun-view';

// id のテクスチャを貼った球面。テクスチャ表に無い id を渡すと投げる(テクスチャ付きとして
// 登録した天体の表が欠けているということなので、黙って単色へ落とさない)。
function texturedSurface(id: string): CelestialSurface {
  const texture = textureOf(id);
  if (texture === null) throw new Error(`no texture registered for ${id}`);
  return CelestialSurface.textured(texture);
}

// id のアルベドを与えた単色球面。
function solidSurface(id: string): CelestialSurface {
  return CelestialSurface.solid(albedoOf(id));
}

// テクスチャ付き惑星のレジストリ項を表示名から組む。rings があれば環付きになる。
// **惑星は戦闘ビューでは常に輝点スプライトとして描かれる**(PointView)— 見えるかどうかは
// その天体が届ける光の量が決める。
function planetEntry(def: PlanetDef, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new PointView(
      def.id, texturedSurface(def.id), sunOcclusion, sunLight, def.radius, def.shape, def.rings,
    ),
  };
}

// 単色の衛星のレジストリ項を表示名から組む。
function satelliteEntry(def: SatelliteDef, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      def.id, solidSurface(def.id), sunOcclusion, sunLight, def.radius, def.shape,
    ),
  };
}

// テクスチャ付き衛星のレジストリ項を表示名から組む(実写の全球モザイクが入手できた衛星のみ;
// それ以外は satelliteEntry の単色のまま)。
function texturedSatelliteEntry(def: SatelliteDef, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      def.id, texturedSurface(def.id), sunOcclusion, sunLight, def.radius, def.shape,
    ),
  };
}

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。
function solidPlanetEntry(def: PlanetDef, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      def.id, solidSurface(def.id), sunOcclusion, sunLight, def.radius, def.shape, def.rings,
    ),
  };
}

// create が恒星光と遮蔽を受けるのは、環がそこから明るさと直射散乱の遮蔽を引くため。**引数を
// 使わない closure(太陽・地球)も受け取れてしまうが、環を持ちうる SphereView / PointView が
// これを必須の構築引数にしているので、渡し忘れは型検査で落ちる。**
export type CelestialAppearance = {
  readonly name: string;
  create(sunOcclusion: SunOcclusion, sunLight: SunLight): CelestialView;
};

export const CELESTIAL_APPEARANCES: Record<SolarSystemId, CelestialAppearance> = {
  earth: { name: '地球', create: () => new EarthView() },
  moon: {
    name: '月',
    create: (sunOcclusion, sunLight) => new SphereView(
      'moon', texturedSurface('moon'), sunOcclusion, sunLight,
      MOON.radius, MOON.shape,
      undefined, () => new MoonSurfaceMarkings(),
    ),
  },
  mercury: planetEntry(MERCURY, '水星'),
  venus: planetEntry(VENUS, '金星'),
  mars: planetEntry(MARS, '火星'),
  phobos: texturedSatelliteEntry(PHOBOS, 'フォボス'),
  deimos: satelliteEntry(DEIMOS, 'ダイモス'),
  jupiter: planetEntry(JUPITER, '木星'),
  metis: satelliteEntry(METIS, 'メティス'),
  adrastea: satelliteEntry(ADRASTEA, 'アドラステア'),
  amalthea: satelliteEntry(AMALTHEA, 'アマルテア'),
  thebe: satelliteEntry(THEBE, 'テーベ'),
  io: texturedSatelliteEntry(IO, 'イオ'),
  europa: texturedSatelliteEntry(EUROPA, 'エウロパ'),
  ganymede: texturedSatelliteEntry(GANYMEDE, 'ガニメデ'),
  callisto: texturedSatelliteEntry(CALLISTO, 'カリスト'),
  himalia: satelliteEntry(HIMALIA, 'ヒマリア'),
  elara: satelliteEntry(ELARA, 'エララ'),
  ananke: satelliteEntry(ANANKE, 'アナンケ'),
  carme: satelliteEntry(CARME, 'カルメ'),
  pasiphae: satelliteEntry(PASIPHAE, 'パシファエ'),
  sinope: satelliteEntry(SINOPE, 'シノーペ'),
  saturn: planetEntry(SATURN, '土星'),
  pan: satelliteEntry(PAN, 'パン'),
  daphnis: satelliteEntry(DAPHNIS, 'ダフニス'),
  prometheus: satelliteEntry(PROMETHEUS, 'プロメテウス'),
  pandora: satelliteEntry(PANDORA, 'パンドラ'),
  epimetheus: satelliteEntry(EPIMETHEUS, 'エピメテウス'),
  janus: satelliteEntry(JANUS, 'ヤヌス'),
  mimas: satelliteEntry(MIMAS, 'ミマス'),
  enceladus: satelliteEntry(ENCELADUS, 'エンケラドゥス'),
  tethys: satelliteEntry(TETHYS, 'テティス'),
  dione: satelliteEntry(DIONE, 'ディオネ'),
  rhea: satelliteEntry(RHEA, 'レア'),
  titan: texturedSatelliteEntry(TITAN, 'タイタン'),
  hyperion: satelliteEntry(HYPERION, 'ヒペリオン'),
  iapetus: satelliteEntry(IAPETUS, 'イアペトゥス'),
  phoebe: satelliteEntry(PHOEBE, 'フェーベ'),
  uranus: planetEntry(URANUS, '天王星'),
  puck: satelliteEntry(PUCK, 'パック'),
  miranda: satelliteEntry(MIRANDA, 'ミランダ'),
  ariel: satelliteEntry(ARIEL, 'アリエル'),
  umbriel: satelliteEntry(UMBRIEL, 'ウンブリエル'),
  titania: satelliteEntry(TITANIA, 'チタニア'),
  oberon: satelliteEntry(OBERON, 'オベロン'),
  neptune: planetEntry(NEPTUNE, '海王星'),
  triton: satelliteEntry(TRITON, 'トリトン'),
  nereid: satelliteEntry(NEREID, 'ネレイド'),
  ceres: solidPlanetEntry(CERES, 'ケレス'),
  vesta: solidPlanetEntry(VESTA, 'ベスタ'),
  pallas: solidPlanetEntry(PALLAS, 'パラス'),
  pluto: solidPlanetEntry(PLUTO, '冥王星'),
  charon: satelliteEntry(CHARON, 'カロン'),
  styx: satelliteEntry(STYX, 'ステュクス'),
  nix: satelliteEntry(NIX, 'ニクス'),
  kerberos: satelliteEntry(KERBEROS, 'ケルベロス'),
  hydra: satelliteEntry(HYDRA, 'ヒドラ'),
  haumea: solidPlanetEntry(HAUMEA, 'ハウメア'),
  hiiaka: satelliteEntry(HIIAKA, 'ヒイアカ'),
  namaka: satelliteEntry(NAMAKA, 'ナマカ'),
  makemake: solidPlanetEntry(MAKEMAKE, 'マケマケ'),
  eris: solidPlanetEntry(ERIS, 'エリス'),
  dysnomia: satelliteEntry(DYSNOMIA, 'ディスノミア'),
  halley: solidPlanetEntry(HALLEY, 'ハレー彗星'),
  encke: solidPlanetEntry(ENCKE, 'エンケ彗星'),
  sedna: solidPlanetEntry(SEDNA, 'セドナ'),
  quaoar: solidPlanetEntry(QUAOAR, 'クワオアー'),
  weywot: satelliteEntry(WEYWOT, 'ウェイウォット'),
  chariklo: solidPlanetEntry(CHARIKLO, 'カリクロー'),
  hygiea: solidPlanetEntry(HYGIEA, 'ヒギエア'),
  eros: solidPlanetEntry(EROS, 'エロス'),
  ryugu: solidPlanetEntry(RYUGU, 'リュウグウ'),
  bennu: solidPlanetEntry(BENNU, 'ベンヌ'),
  orcus: solidPlanetEntry(ORCUS, 'オルクス'),
  vanth: satelliteEntry(VANTH, 'ヴァンス'),
  gonggong: solidPlanetEntry(GONGGONG, 'ゴンゴン'),
  salacia: solidPlanetEntry(SALACIA, 'サラキア'),
  varuna: solidPlanetEntry(VARUNA, 'ヴァルナ'),
  ixion: solidPlanetEntry(IXION, 'イクシオン'),
  arrokoth: solidPlanetEntry(ARROKOTH, 'アロコス'),
  chiron: solidPlanetEntry(CHIRON, 'キロン'),
  interamnia: solidPlanetEntry(INTERAMNIA, 'インテラムニア'),
  europa52: solidPlanetEntry(EUROPA52, 'エウロパ (52)'),
  davida: solidPlanetEntry(DAVIDA, 'ダビダ'),
  juno: solidPlanetEntry(JUNO, 'ジュノー'),
  psyche: solidPlanetEntry(PSYCHE, 'プシケ'),
  eunomia: solidPlanetEntry(EUNOMIA, 'エウノミア'),
  sylvia: solidPlanetEntry(SYLVIA, 'シルビア'),
  apophis: solidPlanetEntry(APOPHIS, 'アポフィス'),
  didymos: solidPlanetEntry(DIDYMOS, 'ディディモス'),
  tempel1: solidPlanetEntry(TEMPEL1, 'テンペル第1彗星'),
  wild2: solidPlanetEntry(WILD2, 'ワイルド第2彗星'),
  hartley2: solidPlanetEntry(HARTLEY2, 'ハートレー第2彗星'),
  cruithne: solidPlanetEntry(CRUITHNE, 'クルースン'),
  kamooalewa: solidPlanetEntry(KAMOOALEWA, 'カモオアレワ'),
  tk7: solidPlanetEntry(TK7, '2010 TK7'),
  eureka: solidPlanetEntry(EUREKA, 'エウレカ'),
  sun: { name: '太陽', create: () => new SunView() },
};

// CELESTIAL_APPEARANCES に手作りエントリを持たない id(カスタムレジストリの架空天体)向けの見た目。
// 恒星は SunView を汎用の id/半径で構築し、それ以外は単色球にする。表示名は呼び出し側
// (frame-labels.ts の celestialBodyName)が id からフォールバックする。
export function fallbackCelestialAppearance(
  motion: CelestialMotion, sunOcclusion: SunOcclusion, sunLight: SunLight,
): CelestialView {
  const def = motion.def;
  return motion.kind === 'star'
    ? new SunView(motion.id, def.radius)
    : new SphereView(
      motion.id,
      CelestialSurface.solid(DEFAULT_ALBEDO),
      sunOcclusion,
      sunLight,
      def.radius,
    );
}
