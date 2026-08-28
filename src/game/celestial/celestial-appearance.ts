// 天体の見た目: id から表示名と CelestialView の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
//
// 見た目そのもの(アルベド・テクスチャ)は render/ が持つ(celestial-albedo.ts /
// celestial-textures.ts)。ここに残るのは id・表示名・どの view クラスを使うかの選択だけ。
import { bodyDef, CelestialRegistry, RingSystemDef, ShapeDef, SOLAR_SYSTEM, SolarSystemId } from '../../physics/solar-system';
import { CelestialBodyId } from '../../physics/celestial-body';
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
function texturedSurface(id: SolarSystemId): CelestialSurface {
  const texture = textureOf(id);
  if (texture === null) throw new Error(`no texture registered for ${id}`);
  return CelestialSurface.textured(texture);
}

// id のアルベドを与えた単色球面。
function solidSurface(id: SolarSystemId): CelestialSurface {
  return CelestialSurface.solid(albedoOf(id));
}

// テクスチャ付き惑星のレジストリ項を表示名から組む。rings(bodyDef からそのまま渡す)が
// あれば環付きになる。**惑星は戦闘ビューでは常に輝点スプライトとして描かれる**(PointView)—
// 見えるかどうかはその天体が届ける光の量が決める。
function planetEntry(id: SolarSystemId, name: string): CelestialAppearance {
  const def = bodyDef(SOLAR_SYSTEM, id);
  return {
    name,
    create: (sunOcclusion, sunLight) => new PointView(
      id, texturedSurface(id), sunOcclusion, sunLight, def.radius, shapeOf(id), ringsOf(id),
    ),
  };
}

// id の環(恒星と衛星は持たない)。shape と同じく、判別を1箇所に閉じる。
function ringsOf(id: SolarSystemId): RingSystemDef | undefined {
  const def = bodyDef(SOLAR_SYSTEM, id);
  return def.kind === 'planet' ? def.rings : undefined;
}

// id の shape(星は持たない)。SOLAR_SYSTEM を引く箇所が皆この判別をせずに済むよう1箇所に閉じる。
function shapeOf(id: SolarSystemId): ShapeDef | undefined {
  const def = bodyDef(SOLAR_SYSTEM, id);
  return def.kind === 'star' ? undefined : def.shape;
}

// 単色の衛星のレジストリ項を表示名から組む。
function satelliteEntry(id: SolarSystemId, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      id, solidSurface(id), sunOcclusion, sunLight, bodyDef(SOLAR_SYSTEM, id).radius, shapeOf(id),
    ),
  };
}

// テクスチャ付き衛星のレジストリ項を表示名から組む(実写の全球モザイクが入手できた衛星のみ;
// それ以外は satelliteEntry の単色のまま)。
function texturedSatelliteEntry(id: SolarSystemId, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      id, texturedSurface(id), sunOcclusion, sunLight, bodyDef(SOLAR_SYSTEM, id).radius, shapeOf(id),
    ),
  };
}

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。
function solidPlanetEntry(id: SolarSystemId, name: string): CelestialAppearance {
  return {
    name,
    create: (sunOcclusion, sunLight) => new SphereView(
      id, solidSurface(id), sunOcclusion, sunLight, bodyDef(SOLAR_SYSTEM, id).radius, shapeOf(id), ringsOf(id),
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
      bodyDef(SOLAR_SYSTEM, 'moon').radius, shapeOf('moon'),
      undefined, () => new MoonSurfaceMarkings(),
    ),
  },
  mercury: planetEntry('mercury', '水星'),
  venus: planetEntry('venus', '金星'),
  mars: planetEntry('mars', '火星'),
  phobos: texturedSatelliteEntry('phobos', 'フォボス'),
  deimos: satelliteEntry('deimos', 'ダイモス'),
  jupiter: planetEntry('jupiter', '木星'),
  metis: satelliteEntry('metis', 'メティス'),
  adrastea: satelliteEntry('adrastea', 'アドラステア'),
  amalthea: satelliteEntry('amalthea', 'アマルテア'),
  thebe: satelliteEntry('thebe', 'テーベ'),
  io: texturedSatelliteEntry('io', 'イオ'),
  europa: texturedSatelliteEntry('europa', 'エウロパ'),
  ganymede: texturedSatelliteEntry('ganymede', 'ガニメデ'),
  callisto: texturedSatelliteEntry('callisto', 'カリスト'),
  himalia: satelliteEntry('himalia', 'ヒマリア'),
  elara: satelliteEntry('elara', 'エララ'),
  ananke: satelliteEntry('ananke', 'アナンケ'),
  carme: satelliteEntry('carme', 'カルメ'),
  pasiphae: satelliteEntry('pasiphae', 'パシファエ'),
  sinope: satelliteEntry('sinope', 'シノーペ'),
  saturn: planetEntry('saturn', '土星'),
  pan: satelliteEntry('pan', 'パン'),
  daphnis: satelliteEntry('daphnis', 'ダフニス'),
  prometheus: satelliteEntry('prometheus', 'プロメテウス'),
  pandora: satelliteEntry('pandora', 'パンドラ'),
  epimetheus: satelliteEntry('epimetheus', 'エピメテウス'),
  janus: satelliteEntry('janus', 'ヤヌス'),
  mimas: satelliteEntry('mimas', 'ミマス'),
  enceladus: satelliteEntry('enceladus', 'エンケラドゥス'),
  tethys: satelliteEntry('tethys', 'テティス'),
  dione: satelliteEntry('dione', 'ディオネ'),
  rhea: satelliteEntry('rhea', 'レア'),
  titan: texturedSatelliteEntry('titan', 'タイタン'),
  hyperion: satelliteEntry('hyperion', 'ヒペリオン'),
  iapetus: satelliteEntry('iapetus', 'イアペトゥス'),
  phoebe: satelliteEntry('phoebe', 'フェーベ'),
  uranus: planetEntry('uranus', '天王星'),
  puck: satelliteEntry('puck', 'パック'),
  miranda: satelliteEntry('miranda', 'ミランダ'),
  ariel: satelliteEntry('ariel', 'アリエル'),
  umbriel: satelliteEntry('umbriel', 'ウンブリエル'),
  titania: satelliteEntry('titania', 'チタニア'),
  oberon: satelliteEntry('oberon', 'オベロン'),
  neptune: planetEntry('neptune', '海王星'),
  triton: satelliteEntry('triton', 'トリトン'),
  nereid: satelliteEntry('nereid', 'ネレイド'),
  ceres: solidPlanetEntry('ceres', 'ケレス'),
  vesta: solidPlanetEntry('vesta', 'ベスタ'),
  pallas: solidPlanetEntry('pallas', 'パラス'),
  pluto: solidPlanetEntry('pluto', '冥王星'),
  charon: satelliteEntry('charon', 'カロン'),
  styx: satelliteEntry('styx', 'ステュクス'),
  nix: satelliteEntry('nix', 'ニクス'),
  kerberos: satelliteEntry('kerberos', 'ケルベロス'),
  hydra: satelliteEntry('hydra', 'ヒドラ'),
  haumea: solidPlanetEntry('haumea', 'ハウメア'),
  hiiaka: satelliteEntry('hiiaka', 'ヒイアカ'),
  namaka: satelliteEntry('namaka', 'ナマカ'),
  makemake: solidPlanetEntry('makemake', 'マケマケ'),
  eris: solidPlanetEntry('eris', 'エリス'),
  dysnomia: satelliteEntry('dysnomia', 'ディスノミア'),
  halley: solidPlanetEntry('halley', 'ハレー彗星'),
  encke: solidPlanetEntry('encke', 'エンケ彗星'),
  sedna: solidPlanetEntry('sedna', 'セドナ'),
  quaoar: solidPlanetEntry('quaoar', 'クワオアー'),
  weywot: satelliteEntry('weywot', 'ウェイウォット'),
  chariklo: solidPlanetEntry('chariklo', 'カリクロー'),
  hygiea: solidPlanetEntry('hygiea', 'ヒギエア'),
  eros: solidPlanetEntry('eros', 'エロス'),
  ryugu: solidPlanetEntry('ryugu', 'リュウグウ'),
  bennu: solidPlanetEntry('bennu', 'ベンヌ'),
  orcus: solidPlanetEntry('orcus', 'オルクス'),
  vanth: satelliteEntry('vanth', 'ヴァンス'),
  gonggong: solidPlanetEntry('gonggong', 'ゴンゴン'),
  salacia: solidPlanetEntry('salacia', 'サラキア'),
  varuna: solidPlanetEntry('varuna', 'ヴァルナ'),
  ixion: solidPlanetEntry('ixion', 'イクシオン'),
  arrokoth: solidPlanetEntry('arrokoth', 'アロコス'),
  chiron: solidPlanetEntry('chiron', 'キロン'),
  interamnia: solidPlanetEntry('interamnia', 'インテラムニア'),
  europa52: solidPlanetEntry('europa52', 'エウロパ (52)'),
  davida: solidPlanetEntry('davida', 'ダビダ'),
  juno: solidPlanetEntry('juno', 'ジュノー'),
  psyche: solidPlanetEntry('psyche', 'プシケ'),
  eunomia: solidPlanetEntry('eunomia', 'エウノミア'),
  sylvia: solidPlanetEntry('sylvia', 'シルビア'),
  apophis: solidPlanetEntry('apophis', 'アポフィス'),
  didymos: solidPlanetEntry('didymos', 'ディディモス'),
  tempel1: solidPlanetEntry('tempel1', 'テンペル第1彗星'),
  wild2: solidPlanetEntry('wild2', 'ワイルド第2彗星'),
  hartley2: solidPlanetEntry('hartley2', 'ハートレー第2彗星'),
  cruithne: solidPlanetEntry('cruithne', 'クルースン'),
  kamooalewa: solidPlanetEntry('kamooalewa', 'カモオアレワ'),
  tk7: solidPlanetEntry('tk7', '2010 TK7'),
  eureka: solidPlanetEntry('eureka', 'エウレカ'),
  sun: { name: '太陽', create: () => new SunView() },
};

// CELESTIAL_APPEARANCES に手作りエントリを持たない id(カスタムレジストリの架空天体)向けの見た目。
// 恒星は SunView を汎用の id/半径で構築し、それ以外は単色球にする。表示名は呼び出し側
// (frame-labels.ts の celestialBodyName)が id からフォールバックする。
export function fallbackCelestialAppearance(
  registry: CelestialRegistry, id: CelestialBodyId, sunOcclusion: SunOcclusion, sunLight: SunLight,
): CelestialView {
  const def = bodyDef(registry, id);
  return def.kind === 'star'
    ? new SunView(id, def.radius)
    : new SphereView(
      id,
      CelestialSurface.solid(DEFAULT_ALBEDO),
      sunOcclusion,
      sunLight,
      def.radius,
    );
}
