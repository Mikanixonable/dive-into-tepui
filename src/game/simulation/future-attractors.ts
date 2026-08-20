// 天体暦のレジストリを、積分弧が引ける候補一覧の形へ見せる。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import type { FutureAttractorProvider, FutureBodyCandidate } from './arc-bodies';

export class FutureAttractors implements FutureAttractorProvider {
  private readonly candidateList: readonly FutureBodyCandidate[];

  // レジストリの全天体から候補一覧を組み、以後はその同じ一覧を返す。
  constructor(private readonly ephemeris: Ephemeris) {
    this.candidateList = Object.values(ephemeris.registry).map(
      (def) => ({ id: def.id, mu: def.mu, radius: def.radius }));
  }

  candidates(): readonly FutureBodyCandidate[] { return this.candidateList; }

  // 候補1体の時刻 t での状態。
  bodyAt(id: AttractorId, t: number): Attractor {
    return this.ephemeris.attractorAt(id, t);
  }
}
