// ランの起動を段へ分け、段の切れ目でブラウザへ描画を明け渡しながら進捗を報告する。
// 段の中は同期処理なので、そこで進捗だけを書いてもゲージは描き変わらない —
// 動くのは enter() が挟む1フレームだけである。

// 起動の段。並びは実行順。
export type LoadingPhase = 'system' | 'bodies' | 'run';

// 段ごとの所要時間の割合。合計 1。
// 実測(2026-09-03・Windows 10 / headless Chrome / localhost 配信・?stage=1):
// 星系 981ms(うち暦packの受信 501ms・展開 357ms・天体運動の構築 122ms)/
// 天体の実体化 156ms / ランの組み立て 233ms。
export const LOADING_PHASE_WEIGHTS: Readonly<Record<LoadingPhase, number>> = {
  system: 0.72,
  bodies: 0.11,
  run: 0.17,
};

export class LoadingProgress {
  // ここまでに終えた段の重みの合計。
  private completed = 0;
  private currentWeight = 0;

  public constructor(private readonly report: (ratio: number) => void) {}

  // 直前の段までを完了として報告し、ブラウザへ描画を1回明け渡してから phase へ入る。
  // requestAnimationFrame のコールバックは描画の**前**に走るので、そこで解決すると
  // 続きの同期処理が同じフレームへ入り込み、報告した値が一度も描かれないまま次へ進む。
  // 描画のあとのタスクへ渡すために、フレームの中でさらに setTimeout を挟む。
  public async enter(phase: LoadingPhase): Promise<void> {
    this.completed += this.currentWeight;
    this.currentWeight = LOADING_PHASE_WEIGHTS[phase];
    this.report(this.completed);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => { setTimeout(resolve, 0); });
    });
  }

  // いまの段の中の進捗 [0,1]。段の中で待ちが入る処理(取得など)だけが呼ぶ。
  public within(ratio: number): void {
    this.report(this.completed + this.currentWeight * Math.min(1, Math.max(0, ratio)));
  }
}
