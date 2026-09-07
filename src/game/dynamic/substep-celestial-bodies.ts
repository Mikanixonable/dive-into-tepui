// サブステップの天体の窓。重力源・表面/遮蔽体・大気天体を1組だけ組み、「どの天体が引くか」
// 「どの大気が抗力を及ぼすか」という個体ごとの絞り込みをその上で答える — 分類を多数の
// 問い合わせ位置で使い回すことが、絞り込みが得になる条件そのものだから。
//
// **顔ぶれはフレームに1組、位置を厳密に引く pivot はサブステップごと。** 顔ぶれの判定は
// 距離の比較でしかないので、判定距離へフレームの移動ぶんを織り込めばフレーム全体で使い回せる。
// 物理が読む位置はサブステップの中点から引くので、外挿の幅は今までどおり subDt/2 に収まる。
import { nearestAtmosphereBody } from '../../physics/attractor';
import { CelestialMotion, CelestialMotions } from '../../physics/celestial-motion';
import { Vec3 } from '../../math/vec3';
import { ClassifiedAttractors, attractorsNearInto, classifyAttractors } from './attractors';

export class SubstepCelestialBodies {
  private classified: ClassifiedAttractors = classifyAttractors([], 0, 0, 0);
  private _gravitySourceCount = 0;
  private _surface: readonly CelestialMotion[] = [];
  private _atmosphere: readonly CelestialMotion[] = [];
  private _star: CelestialMotion | null = null;
  private readonly nearScratch: CelestialMotion[] = [];
  // 天体の位置を厳密に引く時刻。区間の中点に取るので、区間の両端までの外挿幅が dt/2 に収まる。
  private _pivot = 0;
  // 顔ぶれを組んだフレームの中点。
  private _framePivot = 0;

  // フレームの時間送り dt ぶんの区間 [simTime, simTime + dt] で使う顔ぶれを組む。重力源の分類も
  // 大気・表面・遮蔽体の一覧も、この区間のどのサブステップからも使い回せる。
  resetFrame(windows: CelestialMotions, simTime: number, dt: number): void {
    this._framePivot = simTime + dt / 2;
    const sources = windows.gravityMotions;
    this._gravitySourceCount = sources.length;
    this.classified = classifyAttractors(sources, this._framePivot, simTime, simTime + dt);
    this._surface = windows.celestialMotions;
    this._atmosphere = windows.atmosphereMotions;
    this._star = this._surface.find((b) => b.kind === 'star') ?? null;
  }

  // 区間 [simTime, simTime + dt] のサブステップへ進み、天体の位置を厳密に引く時刻をその中点に取る。
  beginSubstep(simTime: number, dt: number): void {
    this._pivot = simTime + dt / 2;
  }

  // 天体の位置を厳密に引いた時刻。
  get pivot(): number { return this._pivot; }

  // 顔ぶれを組んだフレームの中点。表面候補の粗い絞り込みもこの時刻で組む。
  get framePivot(): number { return this._framePivot; }

  // 表面を持ち、かつ太陽を隠しうる相手。半径と位置の幾何だけで決まるので、登録天体の全数。
  get surface(): readonly CelestialMotion[] { return this._surface; }

  // 大気を持つ天体の全数。抗力を及ぼす1体は個体ごとに選ぶ。
  get atmosphere(): readonly CelestialMotion[] { return this._atmosphere; }

  // 日照と受熱の光源になる恒星。無ければ null。
  get star(): CelestialMotion | null { return this._star; }

  // この区間の重力源の本数。
  get gravitySourceCount(): number { return this._gravitySourceCount; }

  // 位置 r へ効く重力源。返る配列は次の呼び出しで上書きされるので、その場で使い切る。
  attractorsNear(r: Vec3): readonly CelestialMotion[] {
    return attractorsNearInto(r, this.classified, this.nearScratch);
  }

  // 位置 r に抗力を及ぼすただ1体の大気天体。無ければ null。
  atmosphereBodyNear(r: Vec3): CelestialMotion | null {
    return nearestAtmosphereBody(r, this._atmosphere, this._pivot);
  }
}
