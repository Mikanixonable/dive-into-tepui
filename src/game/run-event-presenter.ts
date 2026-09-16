// 直近の進行が記録した出来事を読み、そのフレームに鳴らす音と出す通知の宣言を作る。
// 文面とキーのラベルはここで組む。これは表示の導出で、段 7 で presentation/ へ移る。
import { KEY_MAPPING as K } from '../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from './dynamic/sim-speed-manager';
import type { Notifier } from '../hud/notifier';
import type { UiSfx } from '../audio/sfx/ui-sfx';
import type { Attitude } from '../physics/attitude';
import type { KinematicState } from '../physics/kinematic-state';
import type { RunEvent, RunEventBody } from './run-events';

// 内部エラーの告知を出しておく時間 [ms]。読み落とさないよう、通常の告知より長く置く。
const CORRUPTION_TOAST_MS = 60000;

// 位置・速度を告知の文言用の文字列にする。
function describeState(state: KinematicState): string {
  const { r, v } = state;
  return `r=(${r.x},${r.y},${r.z}) v=(${v.x},${v.y},${v.z})`;
}

// 姿勢を告知の文言用の文字列にする。
function describeAttitude(attitude: Attitude): string {
  const { q, w } = attitude;
  return `q=(${q.x},${q.y},${q.z},${q.w}) w=(${w.x},${w.y},${w.z})`;
}

// 汚染の告知の本文。detail には壊れていた対象とその値を渡す。
function corruptionMessage(phase: string, dt: number, simDt: number, detail: string): string {
  return `シミュレーション状態が壊れました(NaN/Infinity)。phase=${phase} dt=${dt} simDt=${simDt} — ${detail}`;
}

export class RunEventPresenter {
  // 最後に写した出来事の通し番号。同じ出来事を二度鳴らさないために持つ。
  private lastSeq = -1;

  public constructor(
    private readonly uiSfx: UiSfx,
    private readonly notifier: Notifier,
  ) { }

  // 記録された出来事のうち、まだ写していないものを音と通知へ写す。
  public present(events: readonly RunEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.show(event.body);
    }
  }

  // 出来事1件を、その出来事が伴う音と通知へ写す。
  private show(body: RunEventBody): void {
    switch (body.kind) {
      case 'simSpeedChanged': {
        this.uiSfx.warp();
        // 操作できない倍率へ上げたときは、自機の操作が効かなくなったことを併記する。
        const gated = body.shipActs ? '' : `(自機の操作はワープ ×${MAX_PHYS_SIM_SPEED} 以下でのみ可能)`;
        this.notifier.hint(`時間加速 ×${body.speed}${gated}`);
        return;
      }
      case 'autoWarpStarted':
        this.notifier.hint('ノードへ自動ワープ開始');
        return;
      case 'autoWarpCancelled':
        this.notifier.hint('自動ワープ解除');
        return;
      case 'autoWarpUnavailable':
        this.notifier.hint(body.reason === 'noNode'
          ? `マニューバノードがありません ([${K.toggleMapMode.label}] で計画)`
          : 'ノード時刻を通過しています');
        return;
      case 'controlledStateCorrupted': {
        const detail = `controlled ${describeState(body.state)} ${describeAttitude(body.attitude)} simTime=${body.simTime}`;
        this.showCorruption(corruptionMessage(body.phase, body.dt, body.simDt, detail));
        return;
      }
      case 'entityStateCorrupted': {
        const detail = `${body.subject} ${describeState(body.state)}`;
        this.showCorruption(corruptionMessage(body.phase, body.dt, body.simDt, detail));
        return;
      }
    }
  }

  // 汚染の告知を、読み落とされない長さで画面へ出す。
  private showCorruption(message: string): void {
    this.notifier.toast(`<b>内部エラー: ${message}</b>`, CORRUPTION_TOAST_MS);
  }
}
