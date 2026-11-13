// ステージごとのベスト(生存時間・撃破数の最高)と連敗数を、ブラウザへ残す。セーブ枠には属さず、
// ランを跨いで保たれる(クリア回数と同じ保存の仕方)。
import { missionTimeText, type GamePhase, type RunStats, type StageId } from '../game/stages/stage';

const STORAGE_KEY = 'tepui.stageRecords';

// 連敗がこの数に達したら、次の周回のブリーフィングに波の予告を出す(SPEC GAME.md 6「連敗の予告」)。
export const FORECAST_LOSS_STREAK = 2;

interface StageRecord {
  readonly bestSurvivalSec: number;
  readonly bestKills: number;
  readonly lossStreak: number;
}

type RecordMap = Readonly<Record<string, StageRecord>>;

// localStorage から記録を読み込む。取得できなければ空を返す。
function loadRecords(): RecordMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// 記録を localStorage へ保存する。
function saveRecords(records: RecordMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    /* localStorage 不可なら保存しない(ベストと連敗は次の起動で空に戻る) */
  }
}

// 今回の成績を、それまでのベストと比べた結果。best が null なら、そのステージの初めての記録。
export interface BestComparison {
  readonly survival: { readonly best: number | null; readonly beaten: boolean };
  readonly kills: { readonly best: number | null; readonly beaten: boolean };
}

export class StageRecords {
  // 読み込んだ記録と、変えるたびに渡す保存の関数。省けばブラウザの保存を使う。
  public constructor(
    private records: RecordMap = loadRecords(),
    private readonly persist: (records: RecordMap) => void = saveRecords,
  ) {}

  // 今回の成績を、記録を変えずにベストと比べる。
  public compare(stage: StageId, stats: RunStats): BestComparison {
    const record = this.records[stage];
    const bestSurvival = record?.bestSurvivalSec ?? null;
    const bestKills = record?.bestKills ?? null;
    return {
      survival: { best: bestSurvival, beaten: bestSurvival === null || stats.survivalSec > bestSurvival },
      kills: { best: bestKills, beaten: bestKills === null || stats.kills > bestKills },
    };
  }

  // 決着を記録する。ベストは上回ったときだけ置き換え、連敗は敗北で 1 増え、それ以外の決着で止まる。
  public record(stage: StageId, phase: GamePhase, stats: RunStats): void {
    if (phase === 'playing') return;
    const previous = this.records[stage];
    const next: StageRecord = {
      bestSurvivalSec: Math.max(previous?.bestSurvivalSec ?? 0, stats.survivalSec),
      bestKills: Math.max(previous?.bestKills ?? 0, stats.kills),
      lossStreak: phase === 'lost' ? (previous?.lossStreak ?? 0) + 1 : 0,
    };
    this.records = { ...this.records, [stage]: next };
    this.persist(this.records);
  }

  // そのステージで続けて負けている数。
  public lossStreak(stage: StageId): number {
    return this.records[stage]?.lossStreak ?? 0;
  }
}

// 結果画面の本文に足す、ベストとの差の行。初めての記録なら「初回の記録」と出す。
// 生存時間と撃破数のそれぞれについて、更新済みか、ベストまでの差かを一行ずつ書く。
export function bestDetailHtml(stats: RunStats, comparison: BestComparison): string {
  const survival = comparison.survival.best === null
    ? '初回の記録'
    : comparison.survival.beaten
      ? 'ベスト更新'
      : `ベストまであと ${missionTimeText(comparison.survival.best - stats.survivalSec)}`;
  const kills = comparison.kills.best === null
    ? '初回の記録'
    : comparison.kills.beaten
      ? 'ベスト更新'
      : `ベストまであと ${comparison.kills.best - stats.kills} 機`;
  return `<br>生存時間 ${survival}<br>撃破数 ${kills}`;
}
