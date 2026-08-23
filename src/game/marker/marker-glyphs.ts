// マーカー字形の族。読み手が最初に判断するのは「その記号は物を指すのか、向きを指すのか、
// 軌道上の特異点を指すのか」なので、塗りつぶし=実体・矢=方向・中空=軌道上の点、と
// 字形の族をその区別に対応させる。どの字形を使うかは各マーカーの所有者が選ぶので、
// ここが持つのは族ごとの選択肢だけで、キーとマーカーの対応は持たない。
import type { BodyClass } from '../celestial/body-class';

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
export function bodyEntityGlyph(cls: BodyClass): string {
  if (cls === 'star') return ENTITY_GLYPH.star;
  if (cls === 'satellite') return ENTITY_GLYPH.satellite;
  return ENTITY_GLYPH.body;
}
