// 天体の表示上の重要度。solar-system.ts の kind(恒星/惑星/衛星)が「中心天体が何か」という
// 力学上の分類であるのに対し、こちらは「マップで既定でも見せるか、絞り込みの対象にするか」
// という編集上の判断で、同じ kind: 'planet' の中から準惑星・小天体を分ける。
// メッシュ構築(THREE 依存)と分けてあるのは、可視性の規則を DOM もレンダラも無しに
// 評価できるようにするため。
import { AttractorId } from '../../physics/attractor';
import { CelestialRegistry, SolarSystemId } from '../../physics/solar-system';

export type BodyClass = 'star' | 'planet' | 'dwarf' | 'satellite' | 'smallBody';

// 現実の太陽系(SOLAR_SYSTEM)の各天体の重要度。天体を登録すると Record の網羅性検査が
// ここを要求する。
const BODY_CLASSES: Record<SolarSystemId, BodyClass> = {
  sun: 'star',
  mercury: 'planet',
  venus: 'planet',
  earth: 'planet',
  mars: 'planet',
  jupiter: 'planet',
  saturn: 'planet',
  uranus: 'planet',
  neptune: 'planet',
  moon: 'satellite',
  phobos: 'satellite',
  deimos: 'satellite',
  metis: 'satellite',
  adrastea: 'satellite',
  amalthea: 'satellite',
  thebe: 'satellite',
  io: 'satellite',
  europa: 'satellite',
  ganymede: 'satellite',
  callisto: 'satellite',
  himalia: 'satellite',
  elara: 'satellite',
  ananke: 'satellite',
  carme: 'satellite',
  pasiphae: 'satellite',
  sinope: 'satellite',
  pan: 'satellite',
  daphnis: 'satellite',
  prometheus: 'satellite',
  pandora: 'satellite',
  epimetheus: 'satellite',
  janus: 'satellite',
  mimas: 'satellite',
  enceladus: 'satellite',
  tethys: 'satellite',
  dione: 'satellite',
  rhea: 'satellite',
  titan: 'satellite',
  hyperion: 'satellite',
  iapetus: 'satellite',
  phoebe: 'satellite',
  triton: 'satellite',
  nereid: 'satellite',
  ceres: 'dwarf',
  pluto: 'dwarf',
  haumea: 'dwarf',
  makemake: 'dwarf',
  eris: 'dwarf',
  vesta: 'smallBody',
  pallas: 'smallBody',
  halley: 'smallBody',
  encke: 'smallBody',
  sedna: 'dwarf',
  quaoar: 'dwarf',
  chariklo: 'smallBody',
  hygiea: 'smallBody',
  eros: 'smallBody',
  ryugu: 'smallBody',
  bennu: 'smallBody',
  churyumov: 'smallBody',
  orcus: 'dwarf',
  gonggong: 'dwarf',
  salacia: 'dwarf',
  varuna: 'dwarf',
  ixion: 'dwarf',
  arrokoth: 'smallBody',
  chiron: 'smallBody',
  interamnia: 'smallBody',
  europa52: 'smallBody',
  davida: 'smallBody',
  juno: 'smallBody',
  psyche: 'smallBody',
  eunomia: 'smallBody',
  sylvia: 'smallBody',
  itokawa: 'smallBody',
  apophis: 'smallBody',
  didymos: 'smallBody',
  tempel1: 'smallBody',
  wild2: 'smallBody',
  hartley2: 'smallBody',
  cruithne: 'smallBody',
  kamooalewa: 'smallBody',
  tk7: 'smallBody',
  eureka: 'smallBody',
};

// 登録天体の表示クラス。BODY_CLASSES に項が無い id(カスタムレジストリの架空天体)は、
// 力学上の分類をそのまま重要度として使う。
export function bodyClassOf(registry: CelestialRegistry, id: AttractorId): BodyClass {
  const cls = (BODY_CLASSES as Record<string, BodyClass | undefined>)[id];
  if (cls !== undefined) return cls;
  const kind = registry[id]?.kind;
  return kind === 'star' ? 'star' : kind === 'satellite' ? 'satellite' : 'planet';
}
