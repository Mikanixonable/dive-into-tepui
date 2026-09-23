#!/usr/bin/env node
// Blender で ship module の GLB を再生成し、その結果をゲーム用 JSON asset へ焼き込む。
// BLENDER_BIN があればそれを優先し、macOS の標準配置、PATH 上の blender の順で探す。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const blenderScript = join(scriptDirectory, 'blender', 'build-ship-modules.py');
const macOsBlender = '/Applications/Blender.app/Contents/MacOS/Blender';

function blenderCandidates() {
  const candidates = [];
  if (process.env.BLENDER_BIN) candidates.push(process.env.BLENDER_BIN);
  if (existsSync(macOsBlender)) candidates.push(macOsBlender);
  candidates.push('blender');
  return [...new Set(candidates)];
}

function resolveBlender() {
  for (const candidate of blenderCandidates()) {
    const probe = spawnSync(candidate, ['--version'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function run(executable, argumentsForCommand, label) {
  console.log(`[ship-modules] ${label}`);
  const result = spawnSync(executable, argumentsForCommand, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit code ${result.status ?? 'unknown'}`;
    throw new Error(`${label} failed: ${detail}`);
  }
}

const blender = resolveBlender();
if (blender === null) {
  console.error(
    '[ship-modules] Blender was not found. Install Blender, put it on PATH, '
    + 'or set BLENDER_BIN to the Blender executable.',
  );
  process.exitCode = 1;
} else {
  try {
    run(blender, ['--background', '--python', blenderScript], 'generate GLB modules');
    run(process.execPath, [join(scriptDirectory, 'export-models.mjs')], 'bake JSON assets');
    console.log('[ship-modules] GLB generation and JSON asset bake completed');
  } catch (error) {
    console.error(`[ship-modules] ${error.message}`);
    process.exitCode = 1;
  }
}
