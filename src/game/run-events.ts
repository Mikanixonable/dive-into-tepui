// 直近の進行で起きた一回きりの出来事の記録。進行の位相が起きたことを領域の言葉で積み、
// 表示の導出が通し番号を鍵に読んで、音・通知・閃光の宣言へ写す(R7)。
import type { Attitude } from '../physics/attitude';
import type { KinematicState } from '../physics/kinematic-state';

// 出来事1件の中身。
export type RunEventBody =
  // 時間加速の段が変わった。speed は変わったあとの倍率、shipActs はその倍率で自機が行動できるか。
  | { readonly kind: 'simSpeedChanged'; readonly speed: number; readonly shipActs: boolean }
  // 直近ノードの実行時刻までの自動ワープが始まった。
  | { readonly kind: 'autoWarpStarted' }
  // 進行中の自動ワープが解除された。
  | { readonly kind: 'autoWarpCancelled' }
  // 自動ワープを起こせなかった。理由は、計画にノードが1件も無い('noNode')か、
  // 直近ノードの実行時刻を既に通過している('nodePassed')か。
  | { readonly kind: 'autoWarpUnavailable'; readonly reason: 'noNode' | 'nodePassed' }
  // 操作対象の状態が非有限値に汚染された。
  | {
    readonly kind: 'controlledStateCorrupted';
    readonly phase: string; // 汚染を捕まえた時点で直前に走っていた段
    readonly state: KinematicState;
    readonly attitude: Attitude;
    readonly simTime: number; // 検査した進行の先端時刻 [sim s]。これ自体も検査の対象
    readonly dt: number; // そのフレームの実時間の経過 [s]
    readonly simDt: number; // そのフレームで進めたシミュレーション時間 [sim s]
  }
  // 操作対象以外の個体の状態が非有限値に汚染された。
  | {
    readonly kind: 'entityStateCorrupted';
    readonly phase: string;
    readonly subject: string; // 汚染された個体の呼び名
    readonly state: KinematicState;
    readonly dt: number;
    readonly simDt: number;
  };

// 記録された出来事1件。
export interface RunEvent {
  readonly seq: number; // 通し番号。表示の導出が同じ出来事を二度扱わないための鍵
  readonly body: RunEventBody;
}

// 出来事を記録する口。
export interface RunEventSink {
  // 起きたことを1件記録する。
  record(body: RunEventBody): void;
}

// 1ランぶんの出来事の記録。通し番号はランの中で単調増加する。
export class RunEventLog implements RunEventSink {
  private readonly events: RunEvent[] = [];
  private nextSeq = 0;

  // 直近の進行で記録された出来事を、記録した順に返す。
  public get recent(): readonly RunEvent[] {
    return this.events;
  }

  // 進行の位相の先頭で呼び、前のフレームの出来事を捨てる。
  public beginStep(): void {
    this.events.length = 0;
  }

  // 起きたことを1件、次の通し番号を付けて積む。
  public record(body: RunEventBody): void {
    this.events.push({ seq: this.nextSeq++, body });
  }
}
