// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import { bodyDef, CelestialRegistry, RingSystemDef, ShapeDef, SOLAR_SYSTEM, SolarSystemId } from '../../physics/solar-system';
import { AttractorId } from '../../physics/attractor';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialSurface } from '../../render/celestial-surface';
import { SphereLodLevel } from '../../render/screen-lod';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { SphereBody } from './sphere-body';
import { PointBody, PointBrightness } from './point-body';
import { SunBody } from './sun-body';

import mercuryTextureUrl from '../../assets/2k_mercury.jpg';
import venusTextureUrl from '../../assets/2k_venus_atmosphere.jpg';
import marsTextureUrl from '../../assets/2k_mars.jpg';
import jupiterTextureUrl from '../../assets/2k_jupiter.jpg';
import saturnTextureUrl from '../../assets/2k_saturn.jpg';
import uranusTextureUrl from '../../assets/2k_uranus.jpg';
import neptuneTextureUrl from '../../assets/2k_neptune.jpg';
import phobosTextureUrl from '../../assets/2k_phobos.jpg';
import ioTextureUrl from '../../assets/2k_io.jpg';
import europaTextureUrl from '../../assets/2k_europa.jpg';
import ganymedeTextureUrl from '../../assets/2k_ganymede.jpg';
import callistoTextureUrl from '../../assets/2k_callisto.jpg';
import titanTextureUrl from '../../assets/2k_titan.jpg';

const PLANET_VIS_DIST = 5e7;

// テクスチャ付き惑星のレジストリ項を、表示名とテクスチャ URL から組む。rings(bodyDef から
// そのまま渡す)があれば環付きになる。pointBrightness を渡すと戦闘ビューでの表示が
// PointBody の輝点スプライトになる(省略時は SphereBody の視距離圧縮球のまま)。
function planetEntry(id: SolarSystemId, name: string, textureUrl: string, pointBrightness?: PointBrightness): CelestialView {
  const buildSurface = (level: SphereLodLevel) => CelestialSurface.textured(textureUrl, level.widthSegments, level.heightSegments);
  const def = bodyDef(SOLAR_SYSTEM, id);
  return {
    name,
    create: () =>
      pointBrightness === undefined
        ? new SphereBody(id, buildSurface, def.radius, PLANET_VIS_DIST, shapeOf(id), ringsOf(id))
        : new PointBody(id, buildSurface, def.radius, pointBrightness, shapeOf(id), ringsOf(id)),
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

// 単色の衛星のレジストリ項を、表示名と色から組む。表示距離は月と揃える。
function satelliteEntry(id: SolarSystemId, name: string, color: number): CelestialView {
  return {
    name,
    create: () => new SphereBody(
      id,
      (level) => CelestialSurface.solid(color, level.widthSegments, level.heightSegments),
      bodyDef(SOLAR_SYSTEM, id).radius,
      MOON_VIS_DIST,
      shapeOf(id),
    ),
  };
}

// テクスチャ付き衛星のレジストリ項を、表示名とテクスチャ URL から組む(実写の全球モザイクが
// 入手できた衛星のみ; それ以外は satelliteEntry の単色のまま)。表示距離は月と揃える。
function texturedSatelliteEntry(id: SolarSystemId, name: string, textureUrl: string): CelestialView {
  const buildSurface = (level: SphereLodLevel) => CelestialSurface.textured(textureUrl, level.widthSegments, level.heightSegments);
  return { name, create: () => new SphereBody(id, buildSurface, bodyDef(SOLAR_SYSTEM, id).radius, MOON_VIS_DIST, shapeOf(id)) };
}

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。表示距離は
// テクスチャ付き惑星と揃える。
function solidPlanetEntry(id: SolarSystemId, name: string, color: number): CelestialView {
  return {
    name,
    create: () => new SphereBody(
      id,
      (level) => CelestialSurface.solid(color, level.widthSegments, level.heightSegments),
      bodyDef(SOLAR_SYSTEM, id).radius,
      PLANET_VIS_DIST,
      shapeOf(id),
      ringsOf(id),
    ),
  };
}

export type CelestialView = { readonly name: string; create(): CelestialBody };

export const CELESTIAL_BODIES: Record<SolarSystemId, CelestialView> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef(SOLAR_SYSTEM, 'moon').radius, MOON_VIS_DIST) },
  mercury: planetEntry('mercury', '水星', mercuryTextureUrl, 'medium'),
  venus: planetEntry('venus', '金星', venusTextureUrl, 'bright'),
  mars: planetEntry('mars', '火星', marsTextureUrl, 'medium'),
  phobos: texturedSatelliteEntry('phobos', 'フォボス', phobosTextureUrl),
  deimos: satelliteEntry('deimos', 'ダイモス', 0x9a8a7a),
  jupiter: planetEntry('jupiter', '木星', jupiterTextureUrl, 'bright'),
  metis: satelliteEntry('metis', 'メティス', 0x6a6058),
  adrastea: satelliteEntry('adrastea', 'アドラステア', 0x6a6058),
  amalthea: satelliteEntry('amalthea', 'アマルテア', 0x8a5a4a),
  thebe: satelliteEntry('thebe', 'テーベ', 0x6a6058),
  io: texturedSatelliteEntry('io', 'イオ', ioTextureUrl),
  europa: texturedSatelliteEntry('europa', 'エウロパ', europaTextureUrl),
  ganymede: texturedSatelliteEntry('ganymede', 'ガニメデ', ganymedeTextureUrl),
  callisto: texturedSatelliteEntry('callisto', 'カリスト', callistoTextureUrl),
  himalia: satelliteEntry('himalia', 'ヒマリア', 0x7a6f60),
  elara: satelliteEntry('elara', 'エララ', 0x8f7c6a),
  ananke: satelliteEntry('ananke', 'アナンケ', 0x746a5e),
  carme: satelliteEntry('carme', 'カルメ', 0x6a6058),
  pasiphae: satelliteEntry('pasiphae', 'パシファエ', 0x807264),
  sinope: satelliteEntry('sinope', 'シノーペ', 0x756658),
  saturn: planetEntry('saturn', '土星', saturnTextureUrl, 'medium'),
  pan: satelliteEntry('pan', 'パン', 0x6a6058),
  daphnis: satelliteEntry('daphnis', 'ダフニス', 0x6a6058),
  prometheus: satelliteEntry('prometheus', 'プロメテウス', 0x7a7068),
  pandora: satelliteEntry('pandora', 'パンドラ', 0x7a7068),
  epimetheus: satelliteEntry('epimetheus', 'エピメテウス', 0x8a8078),
  janus: satelliteEntry('janus', 'ヤヌス', 0x8a8078),
  mimas: satelliteEntry('mimas', 'ミマス', 0xc8c4bc),
  enceladus: satelliteEntry('enceladus', 'エンケラドゥス', 0xe8e6e2),
  tethys: satelliteEntry('tethys', 'テティス', 0xcfcbc3),
  dione: satelliteEntry('dione', 'ディオネ', 0xc4c0b8),
  rhea: satelliteEntry('rhea', 'レア', 0xd0ccc4),
  titan: texturedSatelliteEntry('titan', 'タイタン', titanTextureUrl),
  hyperion: satelliteEntry('hyperion', 'ヒペリオン', 0x9a8f7c),
  iapetus: satelliteEntry('iapetus', 'イアペトゥス', 0x9c968c),
  phoebe: satelliteEntry('phoebe', 'フェーベ', 0x6a625a),
  uranus: planetEntry('uranus', '天王星', uranusTextureUrl, 'faint'),
  puck: satelliteEntry('puck', 'パック', 0xa8a49c),
  miranda: satelliteEntry('miranda', 'ミランダ', 0xc4c0ba),
  ariel: satelliteEntry('ariel', 'アリエル', 0xd8d6d2),
  umbriel: satelliteEntry('umbriel', 'ウンブリエル', 0xc0bcb8),
  titania: satelliteEntry('titania', 'チタニア', 0xd0cec8),
  oberon: satelliteEntry('oberon', 'オベロン', 0xc8c4bc),
  neptune: planetEntry('neptune', '海王星', neptuneTextureUrl),
  triton: satelliteEntry('triton', 'トリトン', 0xd8ccc0),
  nereid: satelliteEntry('nereid', 'ネレイド', 0x9a8f82),
  ceres: solidPlanetEntry('ceres', 'ケレス', 0x9a938c),
  vesta: solidPlanetEntry('vesta', 'ベスタ', 0x8a8378),
  pallas: solidPlanetEntry('pallas', 'パラス', 0x7a7a72),
  pluto: solidPlanetEntry('pluto', '冥王星', 0xc9b29a),
  charon: satelliteEntry('charon', 'カロン', 0xd4d0ca),
  styx: satelliteEntry('styx', 'ステュクス', 0x8a8078),
  nix: satelliteEntry('nix', 'ニクス', 0x8a8078),
  kerberos: satelliteEntry('kerberos', 'ケルベロス', 0x8a8078),
  hydra: satelliteEntry('hydra', 'ヒドラ', 0x8a8078),
  haumea: solidPlanetEntry('haumea', 'ハウメア', 0xcccccc),
  hiiaka: satelliteEntry('hiiaka', 'ヒイアカ', 0x8a8078),
  namaka: satelliteEntry('namaka', 'ナマカ', 0x8a8078),
  makemake: solidPlanetEntry('makemake', 'マケマケ', 0xb08a6a),
  eris: solidPlanetEntry('eris', 'エリス', 0xd8d8d8),
  dysnomia: satelliteEntry('dysnomia', 'ディスノミア', 0x8a8078),
  halley: solidPlanetEntry('halley', 'ハレー彗星', 0x666666),
  encke: solidPlanetEntry('encke', 'エンケ彗星', 0x666666),
  sedna: solidPlanetEntry('sedna', 'セドナ', 0x8f8378),
  quaoar: solidPlanetEntry('quaoar', 'クワオアー', 0xa89684),
  weywot: satelliteEntry('weywot', 'ウェイウォット', 0x8a8078),
  chariklo: solidPlanetEntry('chariklo', 'カリクロー', 0x9a8f80),
  hygiea: solidPlanetEntry('hygiea', 'ヒギエア', 0x8c877e),
  eros: solidPlanetEntry('eros', 'エロス', 0x9c8f74),
  ryugu: solidPlanetEntry('ryugu', 'リュウグウ', 0x585048),
  bennu: solidPlanetEntry('bennu', 'ベンヌ', 0x686058),
  churyumov: solidPlanetEntry('churyumov', 'チュリュモフ・ゲラシメンコ彗星', 0x666666),
  orcus: solidPlanetEntry('orcus', 'オルクス', 0x9a9aa0),
  vanth: satelliteEntry('vanth', 'ヴァンス', 0x8a8078),
  gonggong: solidPlanetEntry('gonggong', 'ゴンゴン', 0xa87860),
  salacia: solidPlanetEntry('salacia', 'サラキア', 0x8890a0),
  varuna: solidPlanetEntry('varuna', 'ヴァルナ', 0x8a8478),
  ixion: solidPlanetEntry('ixion', 'イクシオン', 0x8c8074),
  arrokoth: solidPlanetEntry('arrokoth', 'アロコス', 0xa85030),
  chiron: solidPlanetEntry('chiron', 'キロン', 0x787268),
  interamnia: solidPlanetEntry('interamnia', 'インテラムニア', 0x848078),
  europa52: solidPlanetEntry('europa52', 'エウロパ (52)', 0x8a847a),
  davida: solidPlanetEntry('davida', 'ダビダ', 0x827c72),
  juno: solidPlanetEntry('juno', 'ジュノー', 0x968a7c),
  psyche: solidPlanetEntry('psyche', 'プシケ', 0x726c66),
  eunomia: solidPlanetEntry('eunomia', 'エウノミア', 0x9a8e78),
  sylvia: solidPlanetEntry('sylvia', 'シルビア', 0x76706a),
  itokawa: solidPlanetEntry('itokawa', 'イトカワ', 0xa89476),
  apophis: solidPlanetEntry('apophis', 'アポフィス', 0x8e8a86),
  didymos: solidPlanetEntry('didymos', 'ディディモス', 0x827e78),
  dimorphos: satelliteEntry('dimorphos', 'ディモルフォス', 0x8a8078),
  tempel1: solidPlanetEntry('tempel1', 'テンペル第1彗星', 0x666666),
  wild2: solidPlanetEntry('wild2', 'ワイルド第2彗星', 0x666666),
  hartley2: solidPlanetEntry('hartley2', 'ハートレー第2彗星', 0x666666),
  cruithne: solidPlanetEntry('cruithne', 'クルースン', 0x746e64),
  kamooalewa: solidPlanetEntry('kamooalewa', 'カモオアレワ', 0xa08e70),
  tk7: solidPlanetEntry('tk7', '2010 TK7', 0x6c6660),
  eureka: solidPlanetEntry('eureka', 'エウレカ', 0x907c5c),
  sun: { name: '太陽', create: () => new SunBody() },
};

// CELESTIAL_BODIES に手作りエントリを持たない id(カスタムレジストリの架空天体)向けの見た目。
// 恒星は SunBody を汎用の id/半径で構築し、それ以外は単色球にする。表示名は呼び出し側
// (frame-labels.ts の celestialBodyName)が id からフォールバックする。
export function fallbackCelestialView(registry: CelestialRegistry, id: AttractorId): CelestialBody {
  const def = bodyDef(registry, id);
  return def.kind === 'star'
    ? new SunBody(id, def.radius)
    : new SphereBody(
      id,
      (level) => CelestialSurface.solid(0x888888, level.widthSegments, level.heightSegments),
      def.radius,
      def.kind === 'satellite' ? MOON_VIS_DIST : PLANET_VIS_DIST,
    );
}
