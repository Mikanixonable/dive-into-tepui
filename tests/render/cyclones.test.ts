// 低気圧の谷(render/cloud/cyclones.ts)の回帰テスト。期待値の正本は `DEVELOP/SPEC/RENDERING.md`
// 「雲の描画」— 眼を持つのは熱帯低気圧だけで、中緯度の低気圧は眼を持たず、熱帯低気圧は温帯化で
// 眼を失う。配置は cyclone-tracks から引き、一生の各時刻の深さ・半径・緯度が眼の門のどちら側に
// 落ちるかを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { LOW_COUNT, lowPlacementAt, tropicalPlacementAt } from '../../src/render/cloud/cyclone-tracks';
import { eyeStrengthOf } from '../../src/render/cloud/cyclones';
import type { CyclonePlacement } from '../../src/render/cloud/cyclone-tracks';

const HOUR = 3600; // [s]
const DAY = 24 * HOUR; // [s]

// 標本の刻み [s]。熱帯低気圧の一生(7 日以上)を百数十点で追える細かさ。
const STEP = HOUR;
// 温帯化して眼を失っているべき、一生の中の位置(0 で生まれ、1 で消える)の下限。
const EXTRATROPICAL_LIFE = 0.9;

// 配置の眼の濃さ 0..1。
function eyeStrengthAt(placement: CyclonePlacement): number {
  return eyeStrengthOf(placement.depth, placement.radius, placement.latitude);
}

// 熱帯低気圧を 0 から days 日ぶん STEP 刻みで辿り、生まれてから消えるまでを丸ごと含む一生(null に
// 挟まれた non-null の連なり)に分けたもの。標本の端で切れている一生は含めない。
function completeTropicalLives(days: number): readonly (readonly CyclonePlacement[])[] {
  const lives: CyclonePlacement[][] = [];
  let current: CyclonePlacement[] = [];
  // 最初の null を見るまでは、標本の頭で切れた一生の途中なので集めない。
  let bornInside = false;
  for (let seconds = 0; seconds <= days * DAY; seconds += STEP) {
    const sample = tropicalPlacementAt(seconds);
    if (sample === null) {
      if (current.length > 0) lives.push(current);
      current = [];
      bornInside = true;
    } else if (bornInside) {
      current.push(sample);
    }
  }
  return lives;
}

// この層の回帰テストを登録する。
export function register(): void {
  test('cyclones: 中緯度の低気圧は眼を持たない', () => {
    // 3 年ぶん。生まれる緯度も深さも半径も低気圧ごとに違うので、世代を重ねて幅の端まで踏む。
    for (let seconds = 0; seconds <= 3 * 365 * DAY; seconds += STEP) {
      for (let index = 0; index < LOW_COUNT; index++) {
        const placement = lowPlacementAt(index, seconds);
        if (placement === null) continue;
        const strength = eyeStrengthAt(placement);
        assert.equal(strength, 0, `${seconds / DAY} 日目に低気圧 ${index} の眼が ${strength}`);
      }
    }
  });

  test('cyclones: 熱帯低気圧は最盛期に眼を持ち、温帯化で失う', () => {
    const lives = completeTropicalLives(170);
    assert.ok(lives.length >= 10, `170 日の中に丸ごと入る一生が ${lives.length} しかない`);
    for (const [n, life] of lives.entries()) {
      // 深さが最大の標本で眼が全開。
      let deepest = life[0];
      assert.ok(deepest !== undefined, `一生 ${n} が空`);
      for (const sample of life) {
        if (sample.depth > deepest.depth) deepest = sample;
      }
      const peakStrength = eyeStrengthAt(deepest);
      assert.equal(peakStrength, 1, `一生 ${n} の最盛期(深さ ${deepest.depth} hPa)で眼が ${peakStrength}`);
      // 一生の 9 割以降では眼が消えている。
      for (let i = Math.ceil(EXTRATROPICAL_LIFE * (life.length - 1)); i < life.length; i++) {
        const sample = life[i];
        assert.ok(sample !== undefined);
        const strength = eyeStrengthAt(sample);
        assert.equal(strength, 0, `一生 ${n} の ${i}/${life.length - 1} 時間目で眼が ${strength}`);
      }
    }
  });
}
