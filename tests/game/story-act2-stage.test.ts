// ストーリー第2幕: 敵の配置表・拠点の初期軌道・規模ゲートの格対応と、キャンペーンの
// 幕から入場ステージへの振り分け(GAME.md 11.2)を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { qFromAxisAngle } from '../../src/math/quat';
import { len, sub, v3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import { ConstructionScaleGate } from '../../src/game/campaign/construction-scale-gate';
import { isInOrbitAround, STORY_LUNAR_BASE_ID } from '../../src/game/stages/stage-story-lunar';
import {
  storyEarthObservationPostState, storyLunarOrbitDockState,
  STORY_ACT2_ENEMIES, STORY_ACT2_ENEMY_COUNT, STORY_ACT2_FACILITY_TIERS,
  STORY_EARTH_OBSERVATION_POST_ID, STORY_LUNAR_ORBIT_DOCK_ID,
} from '../../src/game/stages/stage-story-act2';
import { storyStageClassForAct } from '../../src/game/stages/stage-dictionary';
import { StageStoryLunar } from '../../src/game/stages/stage-story-lunar';
import { StageStoryAct2 } from '../../src/game/stages/stage-story-act2';
import { StageStoryAct3 } from '../../src/game/stages/stage-story-act3';
import { StageStoryAct4 } from '../../src/game/stages/stage-story-act4';

// 位置が固定で z 軸まわりに一定速度で自転する、テスト用の天体。
const BODY_POSITION = v3(1e8, 2e8, 0);
const BODY_VELOCITY = v3(0, 1e3, 0);
const SPIN_RATE = 2.7e-6;

function fakeBody(id: string, radius: number, mu: number): CelestialBody {
  return {
    id,
    kind: 'satellite',
    def: { id, mu, radius },
    primary: null,
    stateAt: (pivot) => kinematicState<'eci'>(pivot, BODY_POSITION, BODY_VELOCITY),
    positionAt: () => BODY_POSITION,
    atmosphereAt: () => null,
    degree2At: () => null,
    orientationAt: (t) => ({ axis: v3(0, 0, 1), spinAngle: SPIN_RATE * t }),
    spinRotationAt: (t) => ({
      q: qFromAxisAngle(v3(0, 0, 1), SPIN_RATE * t),
      omega: v3(0, 0, SPIN_RATE),
    }),
    spinRate: SPIN_RATE,
  };
}

export function register(): void {
  test('story act2: 敵の配置表は金属機6機で、総数の宣言と一致する', () => {
    // GAME.md 11.2: 第2幕の敵は金属機6機。配置表の生成器はすべて金属機を出す。
    assert.equal(STORY_ACT2_ENEMIES.length, STORY_ACT2_ENEMY_COUNT);
    assert.equal(STORY_ACT2_ENEMY_COUNT, 6);
    assert.equal(new Set(STORY_ACT2_ENEMIES.map((spec) => spec.name)).size, 6);
    // 撃破の不可逆化のため、敵 id は重複しない安定した識別子である。
    assert.equal(new Set(STORY_ACT2_ENEMIES.map((spec) => spec.id)).size, 6);
  });

  test('story act2: 中継ドックは月の高度100kmの円軌道にあり、軌道投入の判定を通る', () => {
    const moon = fakeBody('moon', 1.7374e6, 4.905e12);
    const dockState = storyLunarOrbitDockState(moon, 0);
    assert.ok(Math.abs(len(sub(dockState.r, BODY_POSITION)) - (1.7374e6 + 100_000)) < 1e-6);
    assert.equal(isInOrbitAround(dockState, moon), true);
  });

  test('story act2: 観測拠点は地球の高度420kmの円軌道にある', () => {
    const earth = fakeBody('earth', 6.371e6, 3.986e14);
    const postState = storyEarthObservationPostState(earth, 0);
    const radius = 6.371e6 + 420_000;
    assert.ok(Math.abs(len(sub(postState.r, BODY_POSITION)) - radius) < 1e-6);
    // 円軌道の速さと一致する。
    const speed = len(sub(postState.v, BODY_VELOCITY));
    assert.ok(Math.abs(speed - Math.sqrt(3.986e14 / radius)) < 1e-6);
  });

  test('story act2: 拠点の規模ゲートは月面基地が地表基地、軌道上の2拠点が軌道ドック', () => {
    // GAME.md 11.2: 規模ゲートの格は地表基地・軌道ドック・軌道造船所の順に大きい。
    assert.equal(STORY_ACT2_FACILITY_TIERS[STORY_LUNAR_BASE_ID], 'surface-base');
    assert.equal(STORY_ACT2_FACILITY_TIERS[STORY_LUNAR_ORBIT_DOCK_ID], 'orbital-dock');
    assert.equal(STORY_ACT2_FACILITY_TIERS[STORY_EARTH_OBSERVATION_POST_ID], 'orbital-dock');
    const gate = new ConstructionScaleGate(STORY_ACT2_FACILITY_TIERS);
    assert.ok(
      (gate.massLimitKgOf(STORY_LUNAR_ORBIT_DOCK_ID) ?? 0)
      > (gate.massLimitKgOf(STORY_LUNAR_BASE_ID) ?? Number.POSITIVE_INFINITY),
    );
  });

  test('story act2: 入場の振り分けは幕ごとのステージへ向かう', () => {
    // GAME.md 11.2: ストーリー項目からはキャンペーンの現在の幕のステージへ入る。
    // 第4幕のステージは後続のスライスが持つため、当面は第2幕へ振り分ける。
    assert.equal(storyStageClassForAct(1), StageStoryLunar);
    assert.equal(storyStageClassForAct(2), StageStoryAct2);
    assert.equal(storyStageClassForAct(3), StageStoryAct3);
    assert.equal(storyStageClassForAct(4), StageStoryAct4);
  });
}
