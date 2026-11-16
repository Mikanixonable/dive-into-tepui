// 比較道具が残す最新の評価値の要約(cloud-lab:compare が吐く compare/latest.json など)を
// 読んで 1 行の表示文へする。評価は撮影つきの比較が走ったときだけ更新されるので、画面に出る
// 値は「いま開いているパラメータの評価」ではなく「最後に測った評価」を指す — 日時と HEAD を
// 添えて出すのは、そのずれを読み手が見分けられるようにするため。

// latest.json の形。書き手(tools/cloud-lab-compare.mjs)が出す要約。
interface LatestReport {
  readonly generatedAt?: string;
  readonly gitHead?: string;
  readonly index?: number;
}

// latest.json を読んで表示文を返す。無い・読めない・形が違うときは undefined(呼び出し側で
// 「未実行」の表示に分ける)。
export async function latestReportText(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const report = await response.json() as LatestReport;
    if (typeof report.index !== 'number') return undefined;
    const date = typeof report.generatedAt === 'string' ? report.generatedAt.slice(0, 10) : '?';
    const head = typeof report.gitHead === 'string' ? report.gitHead : '?';
    return `評価 ${report.index.toFixed(3)} (${date} ${head})`;
  } catch {
    return undefined;
  }
}
