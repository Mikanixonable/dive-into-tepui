// マーカーの見分けを決める字形と識別色。読み手が最初に判断するのは「その記号は物を指すのか、
// 向きを指すのか、軌道上の特異点を指すのか」なので、塗りつぶし=実体・矢=方向・中空=軌道上の点、と
// 字形の族をその区別に対応させる。
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';

// 陣営・対象ごとの識別色。軌道3軸の色は Δv 編集の 3D ギズモと同じ軸を指すので、theme.ts の
// AXIS_* を共有する。
export const COLOR_MARKER_ALLY = '#ffffff';
export const COLOR_MARKER_ENEMY = '#ffffff';
// 敵マーカーが損傷したとき、残 HP が尽きるほど寄っていく色。
const COLOR_MARKER_ENEMY_DAMAGED = '#ff4f5e';
export const COLOR_MARKER_NODE = '#8b93a0';
export const COLOR_MARKER_FUEL = '#ffcf70';
// 拠点(味方施設)。落ち着いた緑がかった色で他の軌道線と区別する。マーカーと軌道線に共通。
export const COLOR_BASE = '#4f8f7d';

// 3D 空間に実在する物。
export const ENTITY_GLYPH = {
  ship: '▲',
  enemyShip: '△',
  base: '⬡',
  body: '●',
  star: '⊚',
  satellite: '○',
  lagrange: '✦',
  ghost: '⬢',
  ammo: '▣',
  fuel: '◈',
  preview: '▷',
} as const;

// 向き。画面外の対象を指す方位矢印もここに含む。
export const DIRECTION_GLYPH = {
  prograde: '⊙',
  retrograde: '⊗',
  normal: '⇧',
  antinormal: '⇩',
  radialOut: '◎',
  radialIn: '◉',
  target: '⇨',
  antiTarget: '⇦',
  bearing: '↑',
  allyBearing: '▲',
  axis: '⇕',
} as const;

// 軌道上の点。
export const ORBIT_POINT_GLYPH = {
  apsis: '◇',
  ascendingNode: '△',
  descendingNode: '▽',
  maneuverNode: '◈',
  burnPoint: '⬡',
  impact: '✕',
  closestApproach: '✧',
  orbitSlot: '⌾',
} as const;

// 残 HP 比(0..1)に応じた敵マーカーの色。満身なら COLOR_MARKER_ENEMY、残 HP が尽きるほど損傷色へ寄る。
export function enemyMarkerColor(hpRatio: number): string {
  const damage = 1 - Math.max(0, Math.min(1, hpRatio));
  const from = parseHexColor(COLOR_MARKER_ENEMY);
  const to = parseHexColor(COLOR_MARKER_ENEMY_DAMAGED);
  const channel = (i: number): string => Math.round(from[i]! + (to[i]! - from[i]!) * damage).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

// '#rrggbb' を各成分 0..255 の列へ分ける。
function parseHexColor(hex: string): readonly [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// 天体クラスに対応する ENTITY_GLYPH。恒星・衛星だけ他の分類と見分けやすい専用字形を持つ。
export function bodyEntityGlyph(cls: CelestialClass): string {
  if (cls === 'star') return ENTITY_GLYPH.star;
  if (cls === 'satellite') return ENTITY_GLYPH.satellite;
  return ENTITY_GLYPH.body;
}
