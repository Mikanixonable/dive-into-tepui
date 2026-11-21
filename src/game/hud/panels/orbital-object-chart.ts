// 軌道物体パネルの路線図と軌道図に置くデータを組み立てる。
import { strongestAttractor } from '../../../physics/attractor';
import { eciToEcl } from '../../../physics/ecliptic';
import { len, sub } from '../../../math/vec3';
import { fmtMarkerDist } from '../../../hud/format';
import type { Vec3 } from '../../../math/vec3';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { ListedObject } from '../../pickable/listed-object';
import type { OrbitingObject } from '../../dynamic/dynamic-entity/orbiting-object';

// 図に出す種類の選択の単位。
export type ChartKind = 'body' | 'craft' | 'supply' | 'slot' | 'lagrange';

// 図の上での意味の色分け(UI-DESIGN.md「HUD の色は意味で引く」)。
export type ChartRole = 'own' | 'target' | 'caution' | 'data';

export const CHART_KINDS: readonly (readonly [ChartKind, string])[] = [
  ['body', '天体'],
  ['craft', '艦'],
  ['supply', '補給'],
  ['slot', '標識'],
  ['lagrange', 'L点'],
];

// 路線図の駅1つ。
export interface ChartStation {
  readonly item: ListedObject;
  // 系(衛星の系を含む)にいる艦の数。
  readonly crafts: number;
  // 系に接近中の敵がいるか。
  readonly caution: boolean;
  // 主星から、いま軌道図に出している系までの経路上にあるか。
  readonly onRoute: boolean;
}

// 軌道図の記号1つ。重なり合う物体は1つに束ね、members の先頭が代表になる。
export interface ChartMark {
  readonly members: readonly ListedObject[];
  // 図の正方形の左上を原点、一辺を 1 とした位置。
  readonly x: number;
  readonly y: number;
  readonly role: ChartRole;
  // 添える名前。間引いたときは null。
  readonly label: string | null;
}

export interface OrbitalObjectChart {
  readonly center: ListedObject | null;
  readonly stations: readonly ChartStation[];
  // 円の半径。図の一辺を 1 とした値。
  readonly rings: readonly number[];
  readonly marks: readonly ChartMark[];
}

const RING_INNER = 0.13; // 最も内側の円の半径(一辺比)
const RING_OUTER = 0.47; // 最も外側の円の半径(一辺比)
const RING_MERGE = 0.012; // これより近い半径の円は1本にまとめる(一辺比)
const BUNDLE_GAP = 0.065; // 記号の中心がこれより近ければ束ねる(一辺比)。記号 24 px ÷ 図 ~300 px 程度
const LABEL_CHAR_W = 0.026; // ラベル1文字ぶんの幅の見積り(一辺比)
const LABEL_H = 0.05; // ラベル1行ぶんの高さの見積り(一辺比)

// item の図に出す種類。天体の区画にいて天体として登録されていないものはラグランジュ点。
export function chartKindOf(item: ListedObject, bodies: CelestialBodies): ChartKind {
  // 天体区画に属する未登録 ID はラグランジュ点として分類する。
  switch (item.listSection) {
    case 'body': return bodies.has(item.id) ? 'body' : 'lagrange';
    case 'player':
    case 'enemy':
    case 'base': return 'craft';
    case 'ammo':
    case 'fuel': return 'supply';
    case 'orbitSlot': return 'slot';
    case null: throw new Error(`一覧に載らない対象は図にも載らない: ${item.id}`);
  }
}

// item が接近中の敵か。敵の区画では「数える」が接近を意味する。
export function isApproachingEnemy(item: ListedObject, viewer: OrbitingObject | null, displayTime: number): boolean {
  return item.listSection === 'enemy' && item.listCounted(viewer, displayTime);
}

// 今フレームの候補から、路線図と軌道図の中身を組む。focusId はマップ視点のフォーカス、
// hidden は図に出さない種類。
export function buildOrbitalObjectChart(
  candidates: readonly ListedObject[], focusId: string | null, targetId: string | null,
  viewer: OrbitingObject | null, hidden: ReadonlySet<ChartKind>, bodies: CelestialBodies, displayTime: number,
): OrbitalObjectChart {
  // 一覧の区画を持たない対象(マーカー)は物体ではないので載せない。
  const items = candidates.filter((item) => item.listSection !== null);
  const byId = new Map<string, ListedObject>();
  for (const item of items) byId.set(item.id, item);
  const homes = new Map<string, string | null>();
  for (const item of items) homes.set(item.id, homeOf(item, byId, bodies, displayTime));

  const rootId = bodies.starId ?? bodies.originId;
  const center = byId.get(centerIdOf(focusId, homes, rootId)) ?? null;
  const stations = buildStations(items, byId, homes, center, rootId, viewer, bodies, displayTime);
  if (center === null) return { center, stations, rings: [], marks: [] };

  const centerPos = center.posAt(displayTime);
  const placed: Placed[] = [];
  if (centerPos !== null) {
    for (const item of items) {
      if (homes.get(item.id) !== center.id || hidden.has(chartKindOf(item, bodies))) continue;
      const pos = item.posAt(displayTime);
      if (pos === null) continue;
      placed.push({ item, rel: sub(pos, centerPos), distance: len(sub(pos, centerPos)), radius: 0 });
    }
  }
  assignRadii(placed);
  const role = (item: ListedObject): ChartRole => roleOf(item, targetId, viewer, displayTime);
  const marks = bundle(placed, focusId, role, bodies);
  return { center, stations, rings: ringsOf(placed), marks: labelled(marks, focusId, viewer, displayTime, bodies) };
}

// item が載る系の中心天体の id。天体は主天体、それ以外は最も強く重力を受ける天体の系に載る。
// その天体が候補に無ければ(未解放・表示の規則で外れた)、候補にある祖先まで遡る。根は null。
function homeOf(
  item: ListedObject, byId: ReadonlyMap<string, ListedObject>, bodies: CelestialBodies, displayTime: number,
): string | null {
  let home: string | null;
  if (bodies.has(item.id)) {
    home = bodies.bodyParentId(item.id);
  } else {
    const pos = item.posAt(displayTime);
    if (pos === null) return null;
    home = strongestAttractor(pos, bodies.celestialMotions, displayTime).id;
  }
  // 候補に無い天体の系には何も描けないので、候補にある祖先の系へ載せる。
  while (home !== null && !byId.has(home)) home = bodies.bodyParentId(home);
  return home;
}

// 軌道図に出す系の中心。フォーカス対象を周回する物体があればその対象、なければフォーカス対象の
// 載る系、フォーカスが無ければ根。
function centerIdOf(focusId: string | null, homes: ReadonlyMap<string, string | null>, rootId: string): string {
  if (focusId === null || !homes.has(focusId)) return rootId;
  for (const home of homes.values()) if (home === focusId) return focusId;
  return homes.get(focusId) ?? focusId;
}

// 根と、根を直接周回する惑星(恒星の無い星系では根を直接周回する天体)を、根からの近い順に並べる。
function buildStations(
  items: readonly ListedObject[], byId: ReadonlyMap<string, ListedObject>,
  homes: ReadonlyMap<string, string | null>, center: ListedObject | null, rootId: string,
  viewer: OrbitingObject | null, bodies: CelestialBodies, displayTime: number,
): ChartStation[] {
  const root = byId.get(rootId);
  if (root === undefined) return [];
  const rootPos = root.posAt(displayTime);
  const lines = items.filter((item) => homes.get(item.id) === rootId && bodies.has(item.id)
    && (bodies.starId === null || bodies.bodyClassOf(item.id) === 'planet'));
  const distance = (item: ListedObject): number => {
    const pos = item.posAt(displayTime);
    return pos === null || rootPos === null ? Infinity : len(sub(pos, rootPos));
  };
  lines.sort((a, b) => distance(a) - distance(b));
  // 経路は、軌道図の中心から主星までの系の鎖に載る駅。
  const route = center === null ? [] : bodies.chainFrom(center.id);
  const stops = [root, ...lines];
  return stops.map((item) => {
    let crafts = 0;
    let caution = false;
    for (const other of items) {
      if (chartKindOf(other, bodies) !== 'craft' || !inSystemOf(other, item.id, homes, bodies, rootId)) continue;
      crafts++;
      if (isApproachingEnemy(other, viewer, displayTime)) caution = true;
    }
    return { item, crafts, caution, onRoute: item.id === rootId || route.includes(item.id) };
  });
}

// other が系 systemId(その衛星の系を含む)に載っているか。根の系は、どの惑星の系にも
// 載っていないものだけを数える。
function inSystemOf(
  other: ListedObject, systemId: string, homes: ReadonlyMap<string, string | null>,
  bodies: CelestialBodies, rootId: string,
): boolean {
  const home = homes.get(other.id) ?? null;
  if (home === null) return false;
  if (systemId === rootId) return home === rootId;
  return bodies.chainFrom(home).includes(systemId);
}

interface Placed {
  readonly item: ListedObject;
  readonly rel: Vec3;
  readonly distance: number;
  radius: number;
}

// 中心からの距離の順を保ったまま、距離の対数を内側の円〜外側の円へ写す。縮尺は持たない。
function assignRadii(placed: readonly Placed[]): void {
  const logs = placed.map((p) => Math.log(Math.max(p.distance, 1)));
  const lo = Math.min(...logs);
  const hi = Math.max(...logs);
  placed.forEach((p, i) => {
    const t = hi > lo ? (logs[i]! - lo) / (hi - lo) : 0.5;
    p.radius = RING_INNER + (RING_OUTER - RING_INNER) * t;
  });
}

// 物体が載る円の半径を、近いものを1本にまとめて内側から並べる。
function ringsOf(placed: readonly Placed[]): number[] {
  const radii = placed.map((p) => p.radius).sort((a, b) => a - b);
  const rings: number[] = [];
  for (const r of radii) if (rings.length === 0 || r - rings[rings.length - 1]! > RING_MERGE) rings.push(r);
  return rings;
}

// 黄道の北から見下ろした方向へ置き、重なり合うものを束ねる。束の代表は優先度の高いものから選ぶ。
function bundle(
  placed: readonly Placed[], focusId: string | null, role: (item: ListedObject) => ChartRole,
  bodies: CelestialBodies,
): { members: ListedObject[]; x: number; y: number; role: ChartRole }[] {
  const ordered = [...placed].sort((a, b) => markPriority(a.item, focusId, role, bodies)
    - markPriority(b.item, focusId, role, bodies));
  const marks: { members: ListedObject[]; x: number; y: number; role: ChartRole }[] = [];
  for (const p of ordered) {
    // 黄道座標の x-y 面で見た向きを、画面の右=+x・上=+y に取る。
    const ecl = eciToEcl(p.rel);
    const angle = Math.atan2(ecl.y, ecl.x);
    const x = 0.5 + p.radius * Math.cos(angle);
    const y = 0.5 - p.radius * Math.sin(angle);
    const near = marks.find((m) => Math.hypot(m.x - x, m.y - y) < BUNDLE_GAP);
    if (near !== undefined) near.members.push(p.item);
    else marks.push({ members: [p.item], x, y, role: role(p.item) });
  }
  return marks;
}

// 束の代表・名前を残す順の優先度。小さいほど先。
function markPriority(
  item: ListedObject, focusId: string | null, role: (item: ListedObject) => ChartRole, bodies: CelestialBodies,
): number {
  if (item.id === focusId) return 0;
  switch (role(item)) {
    case 'own': return 1;
    case 'target': return 2;
    case 'caution': return 3;
    case 'data': return chartKindOf(item, bodies) === 'body' ? 4 : 5;
  }
}

// item の図の上での意味の色分け。
function roleOf(
  item: ListedObject, targetId: string | null, viewer: OrbitingObject | null, displayTime: number,
): ChartRole {
  // 操作対象かつターゲットのときはターゲットの色を優先する(MARKERS.md「記号の体系」)。
  if (item.id === targetId) return 'target';
  if (viewer !== null && item.id === viewer.id) return 'own';
  if (isApproachingEnemy(item, viewer, displayTime)) return 'caution';
  return 'data';
}

// 名前を添える。束は件数を、接近中の敵は距離を添え、重なる名前は優先度の低いほうを間引く。
function labelled(
  marks: readonly { members: ListedObject[]; x: number; y: number; role: ChartRole }[],
  focusId: string | null, viewer: OrbitingObject | null, displayTime: number, bodies: CelestialBodies,
): ChartMark[] {
  // 優先度の高い順に並んでいるので、先に置いた名前の箱と重なる名前を落とせば低いほうが消える。
  const boxes: { l: number; r: number; t: number; b: number }[] = [];
  return marks.map((mark) => {
    const lead = mark.members[0]!;
    const named = lead.id === focusId || mark.role !== 'data' || mark.members.length > 1
      || chartKindOf(lead, bodies) === 'body' || chartKindOf(lead, bodies) === 'slot';
    let label: string | null = null;
    if (named) {
      const text = labelText(mark.members, mark.role, viewer, displayTime);
      const w = text.length * LABEL_CHAR_W;
      const box = mark.x > 0.6
        ? { l: mark.x - 0.05 - w, r: mark.x - 0.05, t: mark.y - LABEL_H / 2, b: mark.y + LABEL_H / 2 }
        : { l: mark.x + 0.05, r: mark.x + 0.05 + w, t: mark.y - LABEL_H / 2, b: mark.y + LABEL_H / 2 };
      const collides = boxes.some((o) => box.l < o.r && o.l < box.r && box.t < o.b && o.t < box.b);
      if (!collides || lead.id === focusId) {
        boxes.push(box);
        label = text;
      }
    }
    return { members: mark.members, x: mark.x, y: mark.y, role: mark.role, label };
  });
}

// 記号に添える文字列。束は件数、接近中の敵は操作対象からの距離、それ以外は名前。
function labelText(
  members: readonly ListedObject[], role: ChartRole, viewer: OrbitingObject | null, displayTime: number,
): string {
  const lead = members[0]!;
  if (members.length > 1) return `×${members.length}`;
  if (role !== 'caution' || viewer === null) return lead.name;
  const pos = lead.posAt(displayTime);
  return pos === null ? `△ ${lead.name}` : `△ ${fmtMarkerDist(len(sub(pos, viewer.motion.state.r)))}`;
}
