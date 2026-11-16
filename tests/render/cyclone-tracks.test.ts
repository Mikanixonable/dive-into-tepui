// 低気圧の谷の配置(render/earth-weather/low-tracks.ts・tropical-tracks.ts)の回帰テスト。期待値の正本は
// `DEVELOP/SPEC/RENDERING.md`「雲の描画」の、中緯度の低気圧の一生と熱帯低気圧の進路の記述。
// 調整値そのものは固定せず、どの時刻でも成り立つべき性質(決定性・連続性・単調性・緯度の幅・
// 隣どうしの分離)を書く。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { LOW_COUNT, lowPlacementAt } from '../../src/render/earth-weather/low-tracks';
import { TROPICAL_COUNT, tropicalPlacementAt } from '../../src/render/earth-weather/tropical-tracks';
import { EARTH_SURFACE_RADIUS, SAMPLE_STEP, completeLives, sampled } from './cyclone-samples';
import type { CyclonePlacement } from '../../src/render/earth-weather/cyclone-tracks';
import type { Placements } from './cyclone-samples';

const HOUR = 3600; // [s]
const DAY = 24 * HOUR; // [s]
const DEGREE = Math.PI / 180; // [rad]

// 1 刻みで中心が動いてよい上限 [m] と、深さが変わってよい上限 [hPa]。若い低気圧の速さ(20 m/s)で
// 1 時間に 72 km、最深 70 hPa の山を 7 日で登り降りしても 1 時間に 2 hPa 弱なので、どちらも
// 生まれ・消えるときに谷が跳んで現れれば超える。
const STEP_DISTANCE_LIMIT = 300e3;
const STEP_DEPTH_LIMIT = 4;
// 隣の谷と溶けないことを見るときの、谷が居るとみなす深さ [hPa]。
const PRESENT_DEPTH = 5;

// 低気圧と熱帯低気圧の系列。名前は失敗の報告に出す。
const SERIES: readonly { readonly name: string; readonly at: Placements }[] = [
  ...Array.from({ length: LOW_COUNT }, (_, index) => ({
    name: `低気圧 ${index}`,
    at: (seconds: number) => lowPlacementAt(index, seconds, EARTH_SURFACE_RADIUS),
  })),
  ...Array.from({ length: TROPICAL_COUNT }, (_, index) => ({
    name: `熱帯低気圧 ${index}`,
    at: (seconds: number) => tropicalPlacementAt(index, seconds),
  })),
];

// 2 つの配置の中心の大圏距離 [m]。
function greatCircleDistance(a: CyclonePlacement, b: CyclonePlacement): number {
  const cosAngle = Math.sin(a.latitude) * Math.sin(b.latitude)
    + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.cos(a.longitude - b.longitude);
  return EARTH_SURFACE_RADIUS * Math.acos(Math.min(Math.max(cosAngle, -1), 1));
}

// 一生の最初の標本と最後の標本。
function endpoints(life: readonly CyclonePlacement[]): readonly [CyclonePlacement, CyclonePlacement] {
  const first = life[0];
  const last = life[life.length - 1];
  assert.ok(first !== undefined && last !== undefined, '空の一生');
  return [first, last];
}

// この層の回帰テストを登録する。
export function register(): void {
  test('cyclone-tracks: 同じ時刻の配置はいつ呼んでも同じ', () => {
    for (let seconds = 0; seconds <= 60 * DAY; seconds += 5 * HOUR) {
      for (const series of SERIES) {
        assert.deepEqual(series.at(seconds), series.at(seconds), `${series.name} が ${seconds} s で揺れる`);
      }
    }
  });

  test('cyclone-tracks: 中心も深さも跳ばない', () => {
    for (const series of SERIES) {
      const samples = sampled(series.at, 60);
      for (let i = 1; i < samples.length; i++) {
        const previous = samples[i - 1] ?? null;
        const sample = samples[i] ?? null;
        if (previous !== null && sample !== null) {
          const distance = greatCircleDistance(previous, sample);
          assert.ok(distance < STEP_DISTANCE_LIMIT, `${series.name} が ${i} 時間目に ${distance / 1e3} km 跳ぶ`);
        }
        const depthChange = Math.abs((sample?.depth ?? 0) - (previous?.depth ?? 0));
        assert.ok(depthChange < STEP_DEPTH_LIMIT, `${series.name} の深さが ${i} 時間目に ${depthChange} hPa 跳ぶ`);
        assert.ok((sample?.depth ?? 0) >= 0, `${series.name} の深さが ${i} 時間目に負`);
      }
    }
  });

  test('cyclone-tracks: 低気圧は一生のあいだ極側へ進み続ける', () => {
    for (let index = 0; index < LOW_COUNT; index++) {
      for (const life of completeLives(sampled((seconds) => lowPlacementAt(index, seconds, EARTH_SURFACE_RADIUS), 60))) {
        for (let i = 1; i < life.length; i++) {
          const previous = life[i - 1];
          const sample = life[i];
          assert.ok(previous !== undefined && sample !== undefined);
          assert.ok(Math.abs(sample.latitude) >= Math.abs(previous.latitude),
            `低気圧 ${index} が ${i} 時間目に赤道側へ戻る`);
        }
      }
    }
  });

  test('cyclone-tracks: 低気圧は亜熱帯の縁に生まれ、暴風帯の極側で消える', () => {
    let counted = 0;
    for (let index = 0; index < LOW_COUNT; index++) {
      for (const life of completeLives(sampled((seconds) => lowPlacementAt(index, seconds, EARTH_SURFACE_RADIUS), 60))) {
        const [born, dying] = endpoints(life);
        const bornLatitude = Math.abs(born.latitude) / DEGREE;
        const dyingLatitude = Math.abs(dying.latitude) / DEGREE;
        // 道のり半ばの点の混ざり(ベジエの曲がり)で標本は幅の端をわずかに越えうる — 越える側の
        // 端へ 1° の余裕を取る。
        assert.ok(bornLatitude >= 30 && bornLatitude <= 46, `低気圧 ${index} が ${bornLatitude}° に生まれる`);
        assert.ok(dyingLatitude >= 54 && dyingLatitude <= 68, `低気圧 ${index} が ${dyingLatitude}° で消える`);
        counted++;
      }
    }
    assert.ok(counted >= LOW_COUNT, `60 日の中に丸ごと入る一生が ${counted} しかない`);
  });

  test('cyclone-tracks: 熱帯低気圧は熱帯に生まれ、直進するか転向して温帯化する', () => {
    let counted = 0;
    for (let index = 0; index < TROPICAL_COUNT; index++) {
      for (const life of completeLives(sampled((seconds) => tropicalPlacementAt(index, seconds), 60))) {
        const [born, dying] = endpoints(life);
        const bornLatitude = Math.abs(born.latitude) / DEGREE;
        // 発生点は |緯度| 8〜16° — 道のり半ばの点の混ざりで標本はその幅の端をわずかに越えうる。
        assert.ok(bornLatitude >= 7 && bornLatitude <= 17, `${bornLatitude}° に生まれる`);
        assert.equal(born.elongation, 1, '生まれたときに丸くない');
        if (dying.elongation > 1) {
          // 転向した渦は温帯化して緩く大きくなり、中緯度で消える。
          const dyingLatitude = Math.abs(dying.latitude) / DEGREE;
          assert.ok(dyingLatitude >= 20 && dyingLatitude <= 45, `転向して ${dyingLatitude}° で消える`);
          assert.ok(dying.radius >= 2 * born.radius,
            `半径が ${born.radius} m から ${dying.radius} m にしか広がらない`);
        }
        counted++;
      }
    }
    assert.ok(counted >= 3, `60 日の中に丸ごと入る一生が ${counted} しかない`);
  });

  test('cyclone-tracks: 同じ半球の低気圧は互いに溶けない', () => {
    // 3 年ぶん。偶数番が北、奇数番が南なので、同じ半球の組は番号の偶奇が揃う。
    for (let seconds = 0; seconds <= 3 * 365 * DAY; seconds += SAMPLE_STEP) {
      const placements = Array.from(
        { length: LOW_COUNT }, (_, index) => lowPlacementAt(index, seconds, EARTH_SURFACE_RADIUS));
      for (let a = 0; a < LOW_COUNT; a++) {
        for (let b = a + 2; b < LOW_COUNT; b += 2) {
          const p = placements[a] ?? null;
          const q = placements[b] ?? null;
          if (p === null || q === null || p.depth < PRESENT_DEPTH || q.depth < PRESENT_DEPTH) continue;
          const distance = greatCircleDistance(p, q);
          assert.ok(distance >= p.radius + q.radius,
            `${seconds / DAY} 日目に低気圧 ${a} と ${b} が ${distance / 1e3} km(半径の和 ${(p.radius + q.radius) / 1e3} km)`);
        }
      }
    }
  });

  test('cyclone-tracks: 熱帯低気圧の数は 0 から複数まで増減する', () => {
    // 1 年ぶん。全球に 1 つも居ない期間と、海域をまたいで複数並ぶ期間の両方がある。
    let empty = 0;
    let most = 0;
    for (let seconds = 0; seconds <= 365 * DAY; seconds += SAMPLE_STEP) {
      let count = 0;
      for (let index = 0; index < TROPICAL_COUNT; index++) {
        if (tropicalPlacementAt(index, seconds) !== null) count++;
      }
      if (count === 0) empty++;
      most = Math.max(most, count);
    }
    assert.ok(empty > 0, '1 年のあいだ熱帯低気圧の居ない時刻がない');
    assert.ok(most >= 2, `1 年のあいだ同時に並ぶのが高々 ${most} つ`);
  });
}
