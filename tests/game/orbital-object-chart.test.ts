// 軌道物体パネルの図(SPEC/MAP.md「軌道物体パネル」)の回帰テスト。どの系を出し、何を駅にし、
// 何が内側・外側に載り、何を束ねるかを、現実の太陽系の天体位置と、地球近傍に置いた艦で固定する。
import { solarSystemParts } from '../physics/test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { buildOrbitalObjectChart } from '../../src/game/hud/panels/orbital-object-chart';
import { add, len, sub, v3, type Vec3 } from '../../src/math/vec3';
import type { ListedObject } from '../../src/game/pickable/listed-object';
import type { MapListSection } from '../../src/game/pickable/pickable-listing';
import type { ChartKind, OrbitalObjectChart } from '../../src/game/hud/panels/orbital-object-chart';

const SYSTEM = solarSystemParts().system;
const T = 0;

// 図が読む面だけを持つ候補。approaching は「数える」の答え(敵なら接近中)。
function listed(id: string, section: MapListSection, pos: Vec3, approaching = false): ListedObject {
  return {
    id, name: id, gone: false, orbitState: null, glyph: '●', glyphSvg: null,
    listSection: section, pickerGenre: null,
    posAt: () => pos,
    listDetail: () => '',
    listSearchText: () => '',
    listCounted: () => approaching,
  };
}

function bodyItem(id: string): ListedObject {
  return listed(id, 'body', SYSTEM.stateAt(id, T).r);
}

const EARTH = SYSTEM.stateAt('earth', T).r;
const NEAR_EARTH = add(EARTH, v3(7.0e6, 0, 0));

function items(...extra: ListedObject[]): ListedObject[] {
  return [bodyItem('sun'), bodyItem('mercury'), bodyItem('earth'), bodyItem('moon'), bodyItem('mars'), ...extra];
}

function chartOf(
  candidates: readonly ListedObject[], focusId: string | null, hidden: readonly ChartKind[] = [],
): OrbitalObjectChart {
  return buildOrbitalObjectChart(candidates, focusId, null, null, new Set(hidden), SYSTEM, T);
}

function markIds(chart: OrbitalObjectChart): string[] {
  return chart.marks.flatMap((mark) => mark.members.map((member) => member.id));
}

// 記号の図の中心からの距離(一辺比)。
function radiusOf(chart: OrbitalObjectChart, id: string): number {
  const mark = chart.marks.find((m) => m.members.some((member) => member.id === id));
  assert.ok(mark !== undefined, `${id} が図に無い`);
  return Math.hypot(mark.x - 0.5, mark.y - 0.5);
}

export function register(): void {
  test('orbital-object-chart: フォーカス対象を周回するものがあれば、その対象の系を出す', () => {
    const chart = chartOf(items(listed('ship', 'player', NEAR_EARTH)), 'earth');
    assert.equal(chart.center?.id, 'earth');
    assert.deepEqual(markIds(chart).sort(), ['moon', 'ship']);
  });

  test('orbital-object-chart: 周回するものが無い対象なら、その対象が周回している系を出す', () => {
    const candidates = items(listed('ship', 'player', NEAR_EARTH));
    assert.equal(chartOf(candidates, 'moon').center?.id, 'earth');
    assert.equal(chartOf(candidates, 'ship').center?.id, 'earth');
  });

  test('orbital-object-chart: フォーカスが無ければ主星の系を出す', () => {
    const chart = chartOf(items(), null);
    assert.equal(chart.center?.id, 'sun');
    assert.ok(markIds(chart).includes('earth') && !markIds(chart).includes('moon'));
  });

  test('orbital-object-chart: 駅は主星と惑星で、主星からの近い順に並ぶ', () => {
    const chart = chartOf(items(bodyItem('ceres')), null);
    assert.deepEqual(chart.stations.map((s) => s.item.id), ['sun', 'mercury', 'earth', 'mars']);
  });

  test('orbital-object-chart: 主星から表示中の系の駅までが経路になる', () => {
    const chart = chartOf(items(), 'moon');
    const onRoute = chart.stations.filter((s) => s.onRoute).map((s) => s.item.id);
    assert.deepEqual(onRoute, ['sun', 'earth']);
  });

  test('orbital-object-chart: 駅は衛星の系を含む艦の数と、接近中の敵がいることを示す', () => {
    const nearMoon = add(SYSTEM.stateAt('moon', T).r, v3(2.0e6, 0, 0));
    const chart = chartOf(items(
      listed('ship', 'player', NEAR_EARTH),
      listed('raider', 'enemy', nearMoon, true),
    ), null);
    const earth = chart.stations.find((s) => s.item.id === 'earth')!;
    const mars = chart.stations.find((s) => s.item.id === 'mars')!;
    assert.equal(earth.crafts, 2);
    assert.equal(earth.caution, true);
    assert.equal(mars.crafts, 0);
    assert.equal(mars.caution, false);
  });

  test('orbital-object-chart: 中心から近いものほど内側の円に載る', () => {
    const chart = chartOf(items(listed('ship', 'player', NEAR_EARTH)), 'earth');
    assert.ok(radiusOf(chart, 'ship') < radiusOf(chart, 'moon'));
    assert.ok(len(sub(NEAR_EARTH, EARTH)) < len(sub(SYSTEM.stateAt('moon', T).r, EARTH)));
  });

  test('orbital-object-chart: 図の上で重なるものは1つの束にまとめ、フォーカス対象を代表にする', () => {
    const chart = chartOf(items(
      listed('ship', 'player', NEAR_EARTH),
      listed('ammo', 'ammo', add(NEAR_EARTH, v3(1, 0, 0))),
    ), 'ammo');
    const bundle = chart.marks.find((m) => m.members.length > 1);
    assert.ok(bundle !== undefined);
    assert.equal(bundle.members[0]!.id, 'ammo');
    assert.equal(bundle.label, '×2');
  });

  test('orbital-object-chart: 図に出さない種類を選ぶと記号から消える', () => {
    const chart = chartOf(items(listed('ship', 'player', NEAR_EARTH)), 'earth', ['craft']);
    assert.deepEqual(markIds(chart), ['moon']);
  });
}
