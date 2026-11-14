// 雲の比較レポートの履歴と差分。比較道具(cloud-lab-compare・cloud-detail-compare)が出す
// 機械可読のレポートを、1 回の比較につき 1 ファイルで history ディレクトリへ残し、
// 直近のレポートを読み戻して数値の差分を取るための共有部品。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 差分の表示用の数値の整形。スペクトルのような小さな値と雲頂 [m] のような大きな値が混ざるので、
// 桁の端では指数表記へ倒し、それ以外は有効数字 6 桁で丸める。
export function formatDiffValue(value) {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3);
  return String(Number(value.toPrecision(6)));
}

// 2 つのレポートの sections を辿り、両方にある数値のリーフについて { path, before, after } を集める。
// 形が変わった(節やキーの増減)ものは数えない — 形の変更は差分でなく版の変更として扱う。
export function collectNumericDiffs(before, after, path, out) {
  if (typeof before === 'number' && typeof after === 'number') {
    out.compared++;
    if (before !== after) out.changed.push({ path, before, after });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      collectNumericDiffs(before[i], after[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    for (const key of Object.keys(before)) {
      if (key in after) collectNumericDiffs(before[key], after[key], path === '' ? key : `${path}.${key}`, out);
    }
  }
}

// レポートへ焼く、いまの HEAD の短い SHA。git が読めない環境では unknown として、比較自体は止めない。
export function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// 履歴の中でいちばん新しいレポートのファイル名。ディレクトリかレポートが無ければ undefined。
export function previousReportName(historyDir) {
  if (!existsSync(historyDir)) return undefined;
  return readdirSync(historyDir).filter((name) => name.endsWith('.json')).sort().at(-1);
}

// レポートを履歴へ書く。ファイル名は生成時刻と HEAD で一意にし、過去分は消さない。
// report.meta.generatedAt と report.meta.gitHead が入っていること。書いたファイル名を返す。
export function saveReport(historyDir, report) {
  mkdirSync(historyDir, { recursive: true });
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-');
  const name = `${stamp}-${report.meta.gitHead}.json`;
  writeFileSync(path.join(historyDir, name), `${JSON.stringify(report, null, 2)}\n`);
  return name;
}

// 履歴からレポートを読む。読めない(無い・壊れている)ときは null。
export function readReport(historyDir, name) {
  try {
    return JSON.parse(readFileSync(path.join(historyDir, name), 'utf8'));
  } catch {
    return null;
  }
}
