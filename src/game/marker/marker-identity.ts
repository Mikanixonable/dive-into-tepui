// マーカーの見分けを決める字形と識別色。読み手が最初に判断するのは「その記号は物を指すのか、
// 向きを指すのか、軌道上の特異点を指すのか」なので、塗りつぶし=実体・矢=方向・中空=軌道上の点、と
// 字形の族をその区別に対応させる。どの字形と色を使うかは各マーカーの所有者が選ぶので、
// ここが持つのは族ごとの選択肢だけで、キーとマーカーの対応は持たない。
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';

// 陣営・対象ごとの識別色。UI の色は theme.ts、「どう見えるか」だけを決めるエフェクトの色は
// render/vfx-style.ts が持つ。軌道3軸(prograde/normal/radial)は theme.ts の AXIS_* を使う —
// Δv 編集の 3D ギズモと方位マーカーは同じ軸を指すので、二系統の色を持たせない。
export const COLOR_MARKER_ALLY = '#ffffff';
export const COLOR_MARKER_ENEMY = '#ffffff';
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
} as const;

// 天体クラスに対応する ENTITY_GLYPH。恒星・衛星だけ他の分類と見分けやすい専用字形を持つ。
export function bodyEntityGlyph(cls: CelestialClass): string {
  if (cls === 'star') return ENTITY_GLYPH.star;
  if (cls === 'satellite') return ENTITY_GLYPH.satellite;
  return ENTITY_GLYPH.body;
}
