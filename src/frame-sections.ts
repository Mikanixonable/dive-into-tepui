// 1フレームの update を区間へ分け、区間ごとの所要時間 [ms] を溜める。
// 区間は数値インデックスで指す(`SECTION` の各値)。有効な間だけ時計を読む。

// 区間の識別子。並びは update での呼び出し順。
export const SECTION = {
  input: 0,
  player: 1,
  stage: 2,
  integrate: 3,
  orbit: 4,
  contact: 5,
  attitude: 6,
  predict: 7,
  effects: 8,
  plan: 9,
  mapPick: 10,
  camera: 11,
  pointer: 12,
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

// 表示名。並びは SECTION の値の順。積分の内訳3区間は、合計が親を成さないことを崩さないまま
// 並びだけ字下げする。
export const SECTION_LABELS: readonly string[] = [
  '入力', '自機', 'ステージ', '積分',
  '　軌道積分', '　接触', '　姿勢',
  '予測', '演出', '計画', 'マップ候補', 'カメラ', 'ポインタ',
];

export const SECTION_COUNT = SECTION_LABELS.length;

export class FrameSections {
  // 計測の可否。偽の間は enter/exit が時計を読まない。
  enabled = false;
  private readonly elapsedMs = new Float64Array(SECTION_COUNT);
  private readonly enteredAt = new Float64Array(SECTION_COUNT);
  private frameStart = 0;
  private frameMs = 0;

  // フレーム頭で呼び、前フレームの累積を捨てる。
  beginFrame(): void {
    if (!this.enabled) return;
    this.elapsedMs.fill(0);
    this.frameStart = performance.now();
    this.frameMs = 0;
  }

  // 区間へ入る。同じ区間の enter/exit は入れ子にしないこと。
  enter(id: SectionId): void {
    if (!this.enabled) return;
    this.enteredAt[id] = performance.now();
  }

  // 区間から出る。同じ区間へ何度出入りしても所要時間は積み上がる。
  exit(id: SectionId): void {
    if (!this.enabled) return;
    this.elapsedMs[id] = this.elapsedMs[id]! + (performance.now() - this.enteredAt[id]!);
  }

  // フレーム末で呼び、update 全体の所要時間 [ms] を確定させる。
  endFrame(): void {
    if (!this.enabled) return;
    this.frameMs = performance.now() - this.frameStart;
  }

  // 区間 id の所要時間 [ms]。
  msOf(id: SectionId): number { return this.elapsedMs[id]!; }

  // どの区間にも属さなかった時間 [ms]。積分の内訳は積分の中で計るので、二重に引かない。
  otherMs(): number {
    let sum = 0;
    for (let i = 0; i < SECTION_COUNT; i++) {
      if (i === SECTION.orbit || i === SECTION.contact || i === SECTION.attitude) continue;
      sum += this.elapsedMs[i]!;
    }
    return Math.max(0, this.frameMs - sum);
  }
}
