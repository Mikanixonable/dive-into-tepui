// 1フレーム分の「いつを見るか」(表示時刻窓)と「どの重力源を見るか」(解析天体と重力を持つ
// エンティティの合流窓)を1回だけ確定させ、update と sync の全消費者で共有する。どちらも
// 求め直しが高価なわりに、入力が変わらない限り同じ答えになる。
import { DisplayTimeManager, type DisplayWindow } from './display-time-manager';
import type { Attractor } from '../physics/attractor';
import { strongestAttractor } from '../physics/attractor';
import { mergeAttractors } from './simulation/attractors';
import type { Ephemeris } from '../physics/ephemeris';
import type { EntityManager } from './simulation/entity-manager';
import type { Simulator } from './simulation/simulator';
import type { ActivePlayerController } from './active-player-controller';
import type { Player } from './player/player';
import * as C from './const';

export class FrameWindow {
  private _current: DisplayWindow = {
    simTime: 0, referencePeriod: NaN, duration: C.APERIODIC_ARC_DURATION, displayTime: 0,
  };
  private lastSimTime = NaN;
  private lastDisplayRevision = -1;
  private lastPlayer: Player | null = null;
  private lastPlayerState: Player['state'] | null = null;

  private attractorsSimTime = NaN;
  private attractorsBodies: readonly Attractor[] | null = null;
  private attractorsDynamic: readonly Attractor[] | null = null;
  private attractorsCache: readonly Attractor[] = [];

  constructor(
    private readonly ephemeris: Ephemeris,
    private readonly entities: EntityManager,
    private readonly simulator: Simulator,
    private readonly displayTimeManager: DisplayTimeManager,
    private readonly activePlayers: ActivePlayerController,
  ) {}

  get current(): DisplayWindow { return this._current; }

  // 表示時刻窓を確定させて返す。currentOrbitPeriod() は登録天体全体を組んで strongestAttractor を
  // 回す重い計算なので、simTime・表示設定・操作艦の状態のいずれも動いていなければ組み直さない。
  resolve(): DisplayWindow {
    const player = this.activePlayers.current;
    const playerState = player?.state ?? null;
    if (this.lastSimTime !== this.simulator.simTime
      || this.lastDisplayRevision !== this.displayTimeManager.revision
      || this.lastPlayer !== player
      || this.lastPlayerState !== playerState) {
      this._current = this.displayTimeManager.window(this.simulator.simTime, this.currentOrbitPeriod());
      this.lastSimTime = this.simulator.simTime;
      this.lastDisplayRevision = this.displayTimeManager.revision;
      this.lastPlayer = player;
      this.lastPlayerState = playerState;
    }
    return this._current;
  }

  // 表示側の重力源窓: 解析天体に、重力を持つ生存中の GameEntity(小惑星)を合流させたもの。
  // 返す配列は読み取り専用として扱う。
  attractorsAt(simTime: number): readonly Attractor[] {
    const bodies = this.ephemeris.attractorsAt(simTime);
    const dynamic = this.entities.attractors();
    if (this.attractorsSimTime === simTime
      && this.attractorsBodies === bodies
      && this.attractorsDynamic === dynamic) {
      return this.attractorsCache;
    }
    this.attractorsSimTime = simTime;
    this.attractorsBodies = bodies;
    this.attractorsDynamic = dynamic;
    this.attractorsCache = mergeAttractors(bodies, dynamic);
    return this.attractorsCache;
  }

  // 操作艦の予測軌道が表示期間のどこまで届いているかの割合(0..1)。スライダーがまだ積分の
  // 届いていない未来を指しうることをスクラバー上で示すのに使う。届き具合を警告すべき相手が
  // いない(艦・予測・表示期間のいずれかが無い)間は 1(全域到達済み扱い)。
  predictionCoverageRatio(): number {
    const end = this.activePlayers.current?.predictedTrajectory?.state.t;
    if (end === undefined || this._current.duration <= 0) return 1;
    return Math.max(0, Math.min(1, (end - this._current.simTime) / this._current.duration));
  }

  // 操作艦の現在軌道の周期 [s]。艦がいない、または有限な周期が求まらない間は NaN —
  // DisplayTimeManager.durationSec 側のフォールバックに委ねる。
  private currentOrbitPeriod(): number {
    const player = this.activePlayers.current;
    if (!player) return NaN;
    const center = strongestAttractor(player.state.r, this.ephemeris.attractorsAt(this.simulator.simTime));
    return player.orbitalElementsAround(center)?.period ?? NaN;
  }
}
