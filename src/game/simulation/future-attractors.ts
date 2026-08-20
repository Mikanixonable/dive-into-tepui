// 計画・予測の積分が引きうる天体の候補一覧と、そのうち1体を時刻ごとに解決する窓口。
// 世代値(revision)が、答える内容を変えうる入力(計画の編集)の変化を呼び出し側の
// 再積分キャッシュへ伝える。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Attractor, AttractorId } from '../../physics/attractor';
import type { FutureAttractorProvider, FutureBodyCandidate } from './arc-bodies';

export class FutureAttractors implements FutureAttractorProvider {
  private revisionValue = 0;
  // 天体暦のレジストリから組んだ候補一覧。
  private readonly candidateList: readonly FutureBodyCandidate[];

  constructor(private readonly ephemeris: Ephemeris) {
    this.candidateList = Object.values(ephemeris.registry).map(
      (def) => ({ id: def.id, mu: def.mu, radius: def.radius }));
  }

  get revision(): number { return this.revisionValue; }

  // 候補の顔ぶれは天体暦のレジストリで決まるので、世代値は構築時の1つだけ。
  get candidateRevision(): number { return 0; }

  candidates(): readonly FutureBodyCandidate[] { return this.candidateList; }

  resolve(planRevision: number): void {
    this.revisionValue = planRevision;
  }

  // 候補1体の時刻 t での状態。
  bodyAt(id: AttractorId, t: number): Attractor {
    return this.ephemeris.attractorAt(id, t);
  }
}
