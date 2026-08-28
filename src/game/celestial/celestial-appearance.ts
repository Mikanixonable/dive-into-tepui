// 天体の見た目: id から表示名・表示クラスと CelestialEntity の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
//
// 見た目そのもの(アルベド・テクスチャ)は render/ が持つ(celestial-albedo.ts /
// celestial-textures.ts)。ここに残るのは id・表示名・表示クラス・どの entity クラスを
// 使うかの選択だけ。
import { CelestialMotion, OrbitingMotion, PlanetMotion, StarMotion } from '../../physics/celestial-motion';
import { SolarSystemId } from '../../physics/solar-system/solar-system';
import { CelestialSurface } from '../../render/celestial-surface';
import { albedoOf, DEFAULT_ALBEDO } from '../../render/celestial-albedo';
import { textureOf } from '../../render/celestial-textures';
import { MoonSurfaceMarkings } from '../../render/moon-surface-markings';
import { atmosphereOpticsOf } from '../../render/atmosphere';
import { BodyClass, bodyClassOfKind, solarSystemBodyClass } from './body-class';
import { CelestialEntity } from './celestial-entity';
import { Earth } from './earth';
import { SphereEntity } from './sphere-entity';
import { PointEntity } from './point-entity';
import { Sun } from './sun';

// 表の項が期待するクラスの運動として motion を読む。項は現実の太陽系の天体1体に対応するので、
// 同じ id を別の分類で定義したレジストリを渡さない限り一致する。
function motionAs<T extends CelestialMotion>(
  motion: CelestialMotion, cls: Function & { readonly prototype: T },
): T {
  if (!(motion instanceof cls)) throw new Error(`${motion.id} の運動が ${cls.name} ではない`);
  return motion as T;
}

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

// テクスチャ付き惑星の項を表示名から組む。**惑星は戦闘ビューでは常に輝点スプライトとして
// 描かれる**(PointEntity)— 見えるかどうかはその天体が届ける光の量が決める。
function planetEntry(id: SolarSystemId, name: string): CelestialAppearance {
  const bodyClass = solarSystemBodyClass(id);
  return {
    name,
    bodyClass,
    create: (motion) => new PointEntity(motionAs(motion, OrbitingMotion), name, bodyClass, texturedSurface(id), atmosphereOpticsOf(id)),
  };
}

// テクスチャを持たない天体(衛星・準惑星・大型小惑星・彗星核)の項を表示名から組む。
function solidEntry(id: SolarSystemId, name: string): CelestialAppearance {
  const bodyClass = solarSystemBodyClass(id);
  return {
    name,
    bodyClass,
    create: (motion) => new SphereEntity(motionAs(motion, OrbitingMotion), name, bodyClass, solidSurface(id)),
  };
}

// テクスチャ付き衛星の項を表示名から組む(実写の全球モザイクが入手できた衛星のみ;
// それ以外は solidEntry の単色のまま)。
function texturedSatelliteEntry(id: SolarSystemId, name: string): CelestialAppearance {
  const bodyClass = solarSystemBodyClass(id);
  return {
    name,
    bodyClass,
    create: (motion) => new SphereEntity(motionAs(motion, OrbitingMotion), name, bodyClass, texturedSurface(id)),
  };
}

// 実半径・歪みの形状・環は create が受け取る motion の定義から引く。
export type CelestialAppearance = {
  readonly name: string;
  readonly bodyClass: BodyClass;
  create(motion: CelestialMotion): CelestialEntity;
};

export const CELESTIAL_APPEARANCES: Record<SolarSystemId, CelestialAppearance> = {
  earth: {
    name: '地球',
    bodyClass: solarSystemBodyClass('earth'),
    create: (motion) => new Earth(motionAs(motion, PlanetMotion), '地球', 0, atmosphereOpticsOf('earth')),
  },
  moon: {
    name: '月',
    bodyClass: solarSystemBodyClass('moon'),
    create: (motion) => new SphereEntity(
      motionAs(motion, OrbitingMotion), '月', solarSystemBodyClass('moon'),
      texturedSurface('moon'), null, () => new MoonSurfaceMarkings(),
    ),
  },
  mercury: planetEntry('mercury', '水星'),
  venus: planetEntry('venus', '金星'),
  mars: planetEntry('mars', '火星'),
  phobos: texturedSatelliteEntry('phobos', 'フォボス'),
  deimos: solidEntry('deimos', 'ダイモス'),
  jupiter: planetEntry('jupiter', '木星'),
  metis: solidEntry('metis', 'メティス'),
  adrastea: solidEntry('adrastea', 'アドラステア'),
  amalthea: solidEntry('amalthea', 'アマルテア'),
  thebe: solidEntry('thebe', 'テーベ'),
  io: texturedSatelliteEntry('io', 'イオ'),
  europa: texturedSatelliteEntry('europa', 'エウロパ'),
  ganymede: texturedSatelliteEntry('ganymede', 'ガニメデ'),
  callisto: texturedSatelliteEntry('callisto', 'カリスト'),
  himalia: solidEntry('himalia', 'ヒマリア'),
  elara: solidEntry('elara', 'エララ'),
  ananke: solidEntry('ananke', 'アナンケ'),
  carme: solidEntry('carme', 'カルメ'),
  pasiphae: solidEntry('pasiphae', 'パシファエ'),
  sinope: solidEntry('sinope', 'シノーペ'),
  saturn: planetEntry('saturn', '土星'),
  pan: solidEntry('pan', 'パン'),
  daphnis: solidEntry('daphnis', 'ダフニス'),
  prometheus: solidEntry('prometheus', 'プロメテウス'),
  pandora: solidEntry('pandora', 'パンドラ'),
  epimetheus: solidEntry('epimetheus', 'エピメテウス'),
  janus: solidEntry('janus', 'ヤヌス'),
  mimas: solidEntry('mimas', 'ミマス'),
  enceladus: solidEntry('enceladus', 'エンケラドゥス'),
  tethys: solidEntry('tethys', 'テティス'),
  dione: solidEntry('dione', 'ディオネ'),
  rhea: solidEntry('rhea', 'レア'),
  titan: texturedSatelliteEntry('titan', 'タイタン'),
  hyperion: solidEntry('hyperion', 'ヒペリオン'),
  iapetus: solidEntry('iapetus', 'イアペトゥス'),
  phoebe: solidEntry('phoebe', 'フェーベ'),
  uranus: planetEntry('uranus', '天王星'),
  puck: solidEntry('puck', 'パック'),
  miranda: solidEntry('miranda', 'ミランダ'),
  ariel: solidEntry('ariel', 'アリエル'),
  umbriel: solidEntry('umbriel', 'ウンブリエル'),
  titania: solidEntry('titania', 'チタニア'),
  oberon: solidEntry('oberon', 'オベロン'),
  neptune: planetEntry('neptune', '海王星'),
  triton: solidEntry('triton', 'トリトン'),
  nereid: solidEntry('nereid', 'ネレイド'),
  ceres: solidEntry('ceres', 'ケレス'),
  vesta: solidEntry('vesta', 'ベスタ'),
  pallas: solidEntry('pallas', 'パラス'),
  pluto: solidEntry('pluto', '冥王星'),
  charon: solidEntry('charon', 'カロン'),
  styx: solidEntry('styx', 'ステュクス'),
  nix: solidEntry('nix', 'ニクス'),
  kerberos: solidEntry('kerberos', 'ケルベロス'),
  hydra: solidEntry('hydra', 'ヒドラ'),
  haumea: solidEntry('haumea', 'ハウメア'),
  hiiaka: solidEntry('hiiaka', 'ヒイアカ'),
  namaka: solidEntry('namaka', 'ナマカ'),
  makemake: solidEntry('makemake', 'マケマケ'),
  eris: solidEntry('eris', 'エリス'),
  dysnomia: solidEntry('dysnomia', 'ディスノミア'),
  halley: solidEntry('halley', 'ハレー彗星'),
  encke: solidEntry('encke', 'エンケ彗星'),
  sedna: solidEntry('sedna', 'セドナ'),
  quaoar: solidEntry('quaoar', 'クワオアー'),
  weywot: solidEntry('weywot', 'ウェイウォット'),
  chariklo: solidEntry('chariklo', 'カリクロー'),
  hygiea: solidEntry('hygiea', 'ヒギエア'),
  eros: solidEntry('eros', 'エロス'),
  ryugu: solidEntry('ryugu', 'リュウグウ'),
  bennu: solidEntry('bennu', 'ベンヌ'),
  orcus: solidEntry('orcus', 'オルクス'),
  vanth: solidEntry('vanth', 'ヴァンス'),
  gonggong: solidEntry('gonggong', 'ゴンゴン'),
  salacia: solidEntry('salacia', 'サラキア'),
  varuna: solidEntry('varuna', 'ヴァルナ'),
  ixion: solidEntry('ixion', 'イクシオン'),
  arrokoth: solidEntry('arrokoth', 'アロコス'),
  chiron: solidEntry('chiron', 'キロン'),
  interamnia: solidEntry('interamnia', 'インテラムニア'),
  europa52: solidEntry('europa52', 'エウロパ (52)'),
  davida: solidEntry('davida', 'ダビダ'),
  juno: solidEntry('juno', 'ジュノー'),
  psyche: solidEntry('psyche', 'プシケ'),
  eunomia: solidEntry('eunomia', 'エウノミア'),
  sylvia: solidEntry('sylvia', 'シルビア'),
  apophis: solidEntry('apophis', 'アポフィス'),
  didymos: solidEntry('didymos', 'ディディモス'),
  tempel1: solidEntry('tempel1', 'テンペル第1彗星'),
  wild2: solidEntry('wild2', 'ワイルド第2彗星'),
  hartley2: solidEntry('hartley2', 'ハートレー第2彗星'),
  cruithne: solidEntry('cruithne', 'クルースン'),
  kamooalewa: solidEntry('kamooalewa', 'カモオアレワ'),
  tk7: solidEntry('tk7', '2010 TK7'),
  eureka: solidEntry('eureka', 'エウレカ'),
  sun: {
    name: '太陽',
    bodyClass: solarSystemBodyClass('sun'),
    create: (motion) => new Sun(motionAs(motion, StarMotion), '太陽'),
  },
};

// CELESTIAL_APPEARANCES に手作りエントリを持たない天体(カスタムレジストリの架空天体)向けの
// 見た目。恒星は Sun、それ以外は単色球にする。表示名には id をそのまま使う。
export function fallbackCelestialAppearance(motion: CelestialMotion): CelestialEntity {
  if (motion instanceof StarMotion) return new Sun(motion, motion.id);
  return new SphereEntity(
    motionAs(motion, OrbitingMotion),
    motion.id,
    bodyClassOfKind(motion.kind),
    CelestialSurface.solid(DEFAULT_ALBEDO),
  );
}
