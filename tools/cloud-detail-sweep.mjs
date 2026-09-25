// render-lab の残差タイルを 5 波長×4方向で撮り、高解像参照との応答を再現可能に集計する。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const shot = 'cloud-detail-residual-200km-north-diagnostic';
const stem = `earth-${shot}`;
const wavelengths = [1, 1.5, 2, 3, 4];
const directions = [0, 45, 90, 135];
const results = [];
for (const wavelength of wavelengths) {
  for (const direction of directions) {
    for (const mode of ['wave-residual', 'wave-residual-invert']) {
      for (const scale of [null, 1.5]) {
        const args = ['tools/render-lab-native-shot.mjs', 'earth', shot,
          mode, String(wavelength), String(direction)];
        if (scale !== null) args.push(String(scale));
        execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
      }
    }
  }
  const output = execFileSync(process.execPath,
    ['tools/cloud-detail-response.mjs', stem, String(wavelength)],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const rows = output.trim().split('\n').map((line) => JSON.parse(line));
  if (rows.length !== directions.length) throw new Error(`incomplete ${wavelength} km response`);
  results.push(...rows);
  console.log(`${wavelength} km: ${rows.map((row) => row.retainedAmplitude.toFixed(3)).join(', ')}`);
}
const output = path.join(root, '.render-lab', 'cloud-detail-sweep.json');
writeFileSync(output, JSON.stringify({ shot, internalRaster: [720, 405], highRaster: [1440, 810], results }, null, 2));
console.log(output);
