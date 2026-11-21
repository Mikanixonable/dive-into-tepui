import { readJson } from './reflection-level-simulator.mjs';
import path from 'node:path';

export function curveRatio(curve, n8, candidateS) {
  if (!(n8 > 0) || !(candidateS > 0)) return null;
  const ordered = [...curve].sort((first, second) => first.N8 - second.N8);
  for (let index = 1; index < ordered.length; index++) {
    const first = ordered[index - 1];
    const second = ordered[index];
    if (n8 < first.N8 || n8 > second.N8) continue;
    if (first.N8 === second.N8) return candidateS / first.S;
    const amount = (Math.log(n8) - Math.log(first.N8)) / (Math.log(second.N8) - Math.log(first.N8));
    const curveS = Math.exp(Math.log(first.S) + amount * (Math.log(second.S) - Math.log(first.S)));
    return candidateS / curveS;
  }
  return null;
}

export function ratiosFor(candidateMetrics, baseDir) {
  const scatter = readJson(path.join(baseDir, 'analysis', 'scatter.json'));
  const width = scatter.series.find((series) => series.key === 'width')?.points ?? [];
  const real = scatter.series.find((series) => series.key === 'real')?.points ?? [];
  const points = [...width.filter((point) => Number(point.key) <= 1), ...real];
  const result = {};
  for (const [group, metric] of Object.entries(candidateMetrics)) {
    const curve = points.map((point) => point.metrics[group]).filter((item) => item?.N8 > 0 && item.S > 0);
    result[group] = curveRatio(curve, metric.N8, metric.S);
  }
  return result;
}
