// 表面へ触れうる天体の絞り込み(game/simulation/surface-candidates.ts)の回帰テスト。
// **絞り込みは判定器の答えを変えてはならない** — 触れうる相手を1つも落とさないことだけが
// 正しさの条件で、これを破ると判定器そのものが呼ばれなくなる。つまり sphere-contact.test.ts の
// ような判定器のテストでは絶対に見えない。総当たり(窓をそのまま渡す)と絞り込んだ窓とで
// firstSurfaceContact の答えが一致することを、ここで固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { CelestialBody } from '../../src/physics/celestial-body';
import { firstSurfaceContact } from '../../src/physics/surface-contact';
import { kinematicState } from '../../src/physics/kinematic-state';
import { mulberry32, randSym } from '../../src/physics/random';
import { Vec3, v3 } from '../../src/physics/vec3';
import {
  SurfaceCandidates, type SurfaceParticipant,
} from '../../src/game/simulation/surface-candidates';

// 位置・速度・半径だけを持つ天体。重力も大気も表面判定には効かない。
function body(id: string, r: Vec3, v: Vec3, radius: number): CelestialBody {
  return {
    id, mu: 0, radius, state: kinematicState(0, r, v), accel: v3(),
    degree2: null, atmosphere: null, isStar: false,
  };
}

// 区間 [0, dt] を、始点の位置・速度と一定加速度で渡る参加者。加速度があるぶん曲線は弦から
// 離れるので、絞り込みが弦だけで測っていれば落としうる。
function participant(r0: Vec3, v0: Vec3, a: Vec3, dt: number, radius: number): SurfaceParticipant {
  return {
    prevState: kinematicState(0, r0, v0),
    state: kinematicState(
      dt,
      v3(
        r0.x + v0.x * dt + 0.5 * a.x * dt * dt,
        r0.y + v0.y * dt + 0.5 * a.y * dt * dt,
        r0.z + v0.z * dt + 0.5 * a.z * dt * dt,
      ),
      v3(v0.x + a.x * dt, v0.y + a.y * dt, v0.z + a.z * dt),
    ),
    radius,
  };
}

// 絞り込んだ窓と総当たりとで firstSurfaceContact の答えを突き合わせ、到達した件数を返す。
function assertAgreement(
  label: string, participants: readonly SurfaceParticipant[], bodies: readonly CelestialBody[],
): number {
  const candidates = new SurfaceCandidates();
  candidates.reset(participants, bodies);
  const out: CelestialBody[] = [];
  let reached = 0;
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i]!;
    const full = firstSurfaceContact(p.prevState, p.state, p.radius, bodies);
    const narrowed = firstSurfaceContact(p.prevState, p.state, p.radius, candidates.into(p, out));
    assert.equal(
      narrowed?.body.id ?? null, full?.body.id ?? null,
      `${label} 参加者 ${i}: 総当たり ${full?.body.id ?? 'なし'} に対し`
      + ` 絞り込み後は ${narrowed?.body.id ?? 'なし'}`,
    );
    if (full !== null) reached++;
  }
  return reached;
}

export function register(): void {
  test('surface-candidates: 無作為な配置で、絞り込んだ窓は総当たりと同じ到達を返す', () => {
    const rand = mulberry32(20260822);
    const dt = 1;
    let reached = 0;
    let placements = 0;
    for (let trial = 0; trial < 200; trial++) {
      const bodies: CelestialBody[] = [];
      for (let i = 0; i < 8; i++) {
        bodies.push(body(
          `b${i}`,
          v3(randSym(1000, rand), randSym(1000, rand), randSym(1000, rand)),
          v3(randSym(100, rand), randSym(100, rand), randSym(100, rand)),
          50 + rand() * 250,
        ));
      }
      const participants: SurfaceParticipant[] = [];
      for (let i = 0; i < 16; i++) {
        const r0 = v3(randSym(800, rand), randSym(800, rand), randSym(800, rand));
        const a = v3(randSym(3000, rand), randSym(3000, rand), randSym(3000, rand));
        // 半数は始点と終点がほぼ重なる往復にする。弦の長さでは覆えない大きな膨らみを持つので、
        // 曲線が弦から離れうる距離の上限を見ていなければ、ここで落としてしまう。
        const v0 = i % 2 === 0
          ? v3(randSym(400, rand), randSym(400, rand), randSym(400, rand))
          : v3(-0.5 * a.x * dt + randSym(40, rand), -0.5 * a.y * dt + randSym(40, rand),
            -0.5 * a.z * dt + randSym(40, rand));
        participants.push(participant(r0, v0, a, dt, rand() * 30));
      }
      reached += assertAgreement(`trial ${trial}`, participants, bodies);
      placements += participants.length;
    }
    // 負例しか見ていなければ、絞り込みが全部落としても通ってしまう。
    assert.ok(reached > 0, `正例が1件も無い(${placements} 件すべて未到達)— 配置が試験になっていない`);
  });

  test('surface-candidates: 弦から離れる曲線でも、跨ぐ天体を落とさない', () => {
    // 掃引が解くのは端点の速度を接線に取る三次曲線であって、始点と終点を結ぶ弦ではない。
    // 弦は原点から 650m 離れたまま素通りするのに、曲線は原点まで潜り込む配置を作る。
    const target = body('bulge', v3(), v3(), 150);
    const p = {
      prevState: kinematicState(0, v3(-20, 650, 0), v3(40, -3000, 0)),
      state: kinematicState(1, v3(20, 650, 0), v3(40, 3000, 0)),
      radius: 0,
    };
    // 前提が崩れていればこのテストは何も試験していないので、両方を明示的に確かめる。
    assert.ok(firstSurfaceContact(p.prevState, p.state, p.radius, [target]) !== null, '前提: 曲線は表面を跨ぐ');
    const chordDistance = 650; // 弦は y=650 の直線で、半径 150 の球には触れない
    assert.ok(chordDistance > target.radius, '前提: 弦は表面に触れない');

    const candidates = new SurfaceCandidates();
    candidates.reset([p], [target]);
    assert.deepEqual(candidates.into(p, []).map((b) => b.id), ['bulge']);
  });

  test('surface-candidates: 触れようのない天体は1段目で落ちる', () => {
    // 落とさないことだけでなく、実際に落としていることも見る — 全部通す実装でも
    // 「答えが一致する」ほうのテストは通ってしまう。
    const near = body('near', v3(0, 500, 0), v3(), 100);
    const far: CelestialBody[] = [];
    for (let i = 0; i < 7; i++) far.push(body(`far${i}`, v3(1e9 * (i + 1), 0, 0), v3(), 100));
    const p = participant(v3(), v3(0, 400, 0), v3(), 1, 1);

    const candidates = new SurfaceCandidates();
    candidates.reset([p], [near, ...far]);
    assert.equal(candidates.count, 1, '1段目を通るのは near だけ');
    assert.deepEqual(candidates.into(p, []).map((b) => b.id), ['near']);
  });
}
