// 生成画像・参照画像・GPU manifest を一つの human-review 用 report にまとめる。画像の自動合否は行わない。
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('usage: node tools/cloud-lab/compare-report.mjs input.json output.json');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const report = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  reference: input.reference ?? null,
  generated: input.generated ?? null,
  metrics: input.metrics ?? null,
  performance: input.performance ?? null,
  review: 'human-side-by-side-required',
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
