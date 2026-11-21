// 雲の実効の精細さを決める自動適応。設定値は「上限」として扱い、フットプリント上限
// (直下点で1画素が張る実寸から解像できない段を削る)と予算上限(フレーム時間と雲の
// GPU 時間から段を締める)の小さい方を実効段とする。

// 精細さの段の番号。0 が最も粗く、DETAIL_TIERS-1 が最も精細。積雲・巻雲どちらの段名とも
// 粗→精細の順で対応するので、上限はこの番号で持ち、段名への写しは呼び出し側で行う。
export const DETAIL_TIERS = 3;

// フレームの時間枠 [ms](60fps の満幅)。
const FRAME_BUDGET_MS = 16.7;
// 雲3パス(表面雲・大気(雲あり)・雲影)の合計がフレームへ占める割合の下限。これを下回る
// 枠超過は雲以外が原因なので、雲の段を下げても解消しない。
const CLOUD_SHARE_MIN = 0.25;
// 枠超過と雲の占有がこの時間だけ続いたら1段下げる [ms]。
const OVER_BUDGET_MS = 500;
// 枠内の余裕がこの時間だけ続いたら1段戻す [ms]。
const HEADROOM_MS = 5000;
// 余裕があると見なすフレーム時間の上限 [ms]。降格の枠より余裕を持たせて段の往復を防ぐ。
const RECOVER_FRAME_MS = FRAME_BUDGET_MS * 0.85;
// 段を変えたあと、次の変更を許すまでの冷却 [ms]。
const CHANGE_COOLDOWN_MS = 2000;

// 直下点で1画素が張る実寸 spanMin [m] から、その実寸で解像できる段の番号を返す。
// 段を削れる条件は、その段より細い側のオクターブが全部 fadeOf の 0 側(波長 ≤ 2·spanMin)
// にあること — 直下点は画素の張る実寸が最も小さい点なので、そこで消えるオクターブは
// 画面上のどこでも消えている。**wavelengths にはその種類が使う段の波長だけを渡す**
// (巻雲は 32・16 km の段を持たない)。live 数を下回る段数の段は、解像できない段を
// 抱えているので使わない。
export function footprintLevel(
  spanMin: number, levelOctaves: readonly number[], wavelengths: readonly number[],
): number {
  let live = 0;
  for (const wavelength of wavelengths) {
    if (wavelength > 2 * spanMin) live++;
  }
  for (let level = 0; level < levelOctaves.length; level++) {
    if (levelOctaves[level]! >= live) return level;
  }
  return levelOctaves.length - 1;
}

// フレーム時間と雲の GPU 時間から、予算が許す最も精細な段を維持する状態機械。
// 枠を超えるフレームが雲の占有とともに続くと1段ずつ下げ、余裕が続くと1段ずつ戻す。
// 変更後の冷却と戻しの長い窓で、段の往復を抑える。
export class CloudQualityGovernor {
  // 予算が許す最も精細な段の番号。
  private level = DETAIL_TIERS - 1;
  // 枠超過(雲の占有を伴う)の連続した積算 [ms]。枠内のフレームで割り引く。
  private overMs = 0;
  // 余裕の続いた積算 [ms]。余裕でないフレームで 0 に戻る。
  private underMs = 0;
  private cooldownMs = 0;

  // 1フレームぶんの計測を入れる。frameMs はフレーム間の経過 [ms](描画の待ち時間込み)、
  // cloudGpuMs は雲3パスの合計 GPU 時間 [ms]。**時刻印が取れない環境では null を渡す** —
  // 予算上限は働かせず、設定とフットプリント上限だけが効く。active が偽の間は判定窓を
  // 進めない(ポーズ・マップ・時間加速中はフレーム時間が雲の費用と関係なく歪むため)。
  public update(frameMs: number, cloudGpuMs: number | null, active: boolean): void {
    this.cooldownMs = Math.max(0, this.cooldownMs - frameMs);
    if (!active || cloudGpuMs === null || !(frameMs > 0)) return;
    if (frameMs > FRAME_BUDGET_MS && cloudGpuMs >= frameMs * CLOUD_SHARE_MIN) {
      this.overMs += frameMs;
      this.underMs = 0;
      if (this.overMs >= OVER_BUDGET_MS && this.cooldownMs <= 0 && this.level > 0) {
        this.level -= 1;
        this.overMs = 0;
        this.cooldownMs = CHANGE_COOLDOWN_MS;
      }
      return;
    }
    // 枠内のフレームは超過の積算を速く割り引く — 散発・交互の遅れは連続超過に数えない。
    this.overMs = Math.max(0, this.overMs - frameMs * 2);
    if (frameMs <= RECOVER_FRAME_MS && this.level < DETAIL_TIERS - 1) {
      this.underMs += frameMs;
      if (this.underMs >= HEADROOM_MS && this.cooldownMs <= 0) {
        this.level += 1;
        this.underMs = 0;
        this.cooldownMs = CHANGE_COOLDOWN_MS;
      }
    } else {
      this.underMs = 0;
    }
  }

  // 予算が許す最も精細な段の番号(0 が最も粗い)。
  public get levelCap(): number { return this.level; }
}

// 実効の精細さの決定の読み出し。setting・effective は段の番号(0 が最も粗い)。
// limiter は実効段を決めた上限 — 設定値がそのまま出ているなら 'setting'、それより
// 下なら footprint(画素で解像できない)か budget(フレーム時間の実績)。
export interface CloudQualityReading {
  readonly setting: number;
  readonly effective: number;
  readonly limiter: 'setting' | 'footprint' | 'budget';
}
