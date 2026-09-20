// cloud-lab の cheap metrics。入力は { frames: [{ coverage, scale, displacement }] } の JSON。
// 科学的な pass/fail はせず、side-by-side 調整の補助値だけを出す。
import { readFileSync } from 'node:fs';

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metricReport(input) {
  const frames = Array.isArray(input.frames) ? input.frames : [];
  const coverage = frames.map((frame) => Number(frame.coverage)).filter(Number.isFinite);
  const scale = frames.map((frame) => Number(frame.scale)).filter(Number.isFinite);
  const displacement = frames.map((frame) => Number(frame.displacement)).filter(Number.isFinite);
  const correlations = [];
  for (let i = 1; i < frames.length; i += 1) {
    const correlation = Number(frames[i].temporalCorrelation);
    if (Number.isFinite(correlation)) correlations.push(correlation);
  }
  return {
    schema: 1,
    samples: frames.length,
    cloudFraction: mean(coverage),
    characteristicScale: mean(scale),
    advectionSpeed: mean(displacement),
    temporalCorrelation: mean(correlations),
    qualification: 'diagnostic-only',
  };
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error('usage: node tools/cloud-lab/metrics.mjs input.json');
process.stdout.write(`${JSON.stringify(metricReport(JSON.parse(readFileSync(inputPath, 'utf8'))), null, 2)}\n`);
