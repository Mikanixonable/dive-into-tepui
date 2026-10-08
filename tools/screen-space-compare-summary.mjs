// 候補比較の数値の要約(markdown)。ケースごとに、条件・ROI・帯の大きさ・帯和の不変条件・A の検査値の表を並べる。
import { table } from './screen-space-lab.mjs';

// scenes は { name, conditions, roiTables, bandTables, invariantTables, alphaTable } の並び。
export function summaryMarkdown(scenes, runs) {
  const lines = ['# 8-15 候補比較の要約', '', `候補: ${runs.join(', ')}`, ''];
  const section = ({ title, header, rows }) => [`#### ${title}`, '', ...table(header, rows), ''];
  for (const scene of scenes) {
    lines.push(`## ${scene.name}`, '', '### 条件', '', ...table(['条件', '値'], scene.conditions.fixed), '',
      ...section(scene.conditions.differing), '### ROI', '', ...scene.roiTables.flatMap(section),
      '### 帯の大きさ', '', ...scene.bandTables.flatMap(section),
      '### 帯和の不変条件', '', ...scene.invariantTables.flatMap(section), '### A', '', ...section(scene.alphaTable));
  }
  return lines.join('\n');
}
