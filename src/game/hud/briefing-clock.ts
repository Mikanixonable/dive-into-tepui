// ブリーフィングのカードを出しておく時間の勘定。表示を始めた時刻は、出した次の同期の実時刻で確定する —
// 出した時点の時刻を持たない呼び手(読み込み中など)から出しても、時間が経った扱いにならない。

// ブリーフィングを出しておく時間 [ms]。
export const BRIEFING_VISIBLE_MS = 12000;

export class BriefingClock {
  // 表示を始めた時刻 [ms]。表示していなければ null。次の update で時刻を確定する間は 'pending'。
  private shownAt: number | 'pending' | null = null;

  // 表示を始める。時刻は次の update で確定する。
  public show(): void {
    this.shownAt = 'pending';
  }

  // 表示を終える。
  public fold(): void {
    this.shownAt = null;
  }

  // 実時刻 nowMs [ms] まで進める。警報が出ている(alarmActive)か時間が過ぎていれば畳み、畳んだなら true。
  public update(alarmActive: boolean, nowMs: number): boolean {
    if (this.shownAt === 'pending') this.shownAt = nowMs;
    if (this.shownAt === null || !(alarmActive || nowMs - this.shownAt > BRIEFING_VISIBLE_MS)) return false;
    this.shownAt = null;
    return true;
  }
}
