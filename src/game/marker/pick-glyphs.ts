// MapPickKind → 一覧・プロパティウィンドウで添える形態記号の唯一の対応表。
// 記号そのものの定義は marker-identity.ts(文字)と marker-shapes.ts(SVG)が持ち、ここは
// 「どの種別にどれを使うか」だけを決める — 一覧パネルとプロパティウィンドウで同じ種別が
// 別の形に見えないようにするため、両者はこの関数だけを通す。
import { isLagrangeId } from '../celestial/lagrange-id';
import { bodyEntityGlyph, ENTITY_GLYPH, ORBIT_POINT_GLYPH } from './marker-identity';
import { baseMarkerSvg, shipMarkerSvg } from './marker-shapes';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { MapPickKind } from '../pickable/map-pickable';

// 文字グリフを使う種別。body は恒星・衛星・ラグランジュ点で字形が変わるため、この表ではなく
// pickGlyph() の中で bodyEntityGlyph() から選ぶ。
const TEXT_GLYPHS: Readonly<Record<Exclude<MapPickKind, 'body'>, string>> = {
  player: ENTITY_GLYPH.ship,
  enemy: ENTITY_GLYPH.enemyShip,
  ammo: ENTITY_GLYPH.ammo,
  fuel: ENTITY_GLYPH.fuel,
  base: ENTITY_GLYPH.base,
  apsis: ORBIT_POINT_GLYPH.apsis,
  relnode: ORBIT_POINT_GLYPH.ascendingNode,
  eqnode: ORBIT_POINT_GLYPH.descendingNode,
  'empty-space': '·',
};

// player/enemy/base はマップ実マーカーと同じ SVG 形状を凡例にも使う。
const SVG_GLYPHS: Partial<Readonly<Record<MapPickKind, string>>> = {
  player: shipMarkerSvg(true),
  enemy: shipMarkerSvg(false),
  base: baseMarkerSvg(),
};

// kind/id に対応する SVG マークアップ。文字グリフで表す種別なら null。
export function pickGlyphSvg(kind: MapPickKind): string | null {
  return SVG_GLYPHS[kind] ?? null;
}

// kind/id に対応する文字グリフ。SVG を持つ種別でも、SVG を描けない場所のために必ず返る。
export function pickGlyphText(kind: MapPickKind, id: string, celestialSystem: CelestialSystem): string {
  if (kind !== 'body') return TEXT_GLYPHS[kind];
  if (isLagrangeId(id)) return ENTITY_GLYPH.lagrange;
  return bodyEntityGlyph(celestialSystem.find(id)?.bodyClass ?? 'planet');
}

// SVG を描ける場所向けに、SVG があればそれを、無ければ文字グリフを返す。空域は記号を持たない。
export function pickGlyph(kind: MapPickKind, id: string, celestialSystem: CelestialSystem): string | undefined {
  if (kind === 'empty-space') return undefined;
  return pickGlyphSvg(kind) ?? pickGlyphText(kind, id, celestialSystem);
}
