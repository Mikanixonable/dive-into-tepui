#!/usr/bin/env node
// Run a protein-builder action for every protein definition in the repository.
import { access, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const proteinRoot = join(repositoryRoot, 'assets-src/proteins');
const builderRoot = scriptDirectory;
const supportedActions = new Set(['generate', 'validate', 'generate-motion', 'validate-motion', 'generate-structure', 'validate-structure']);
const [action = 'validate', ...extraArguments] = process.argv.slice(2);

if (!supportedActions.has(action)) {
  console.error(`usage: node tools/protein-builder/run-all.mjs ${[...supportedActions].join('|')} [script options]`);
  process.exitCode = 2;
} else {
  async function configFiles() {
    const entries = await readdir(proteinRoot, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const configPath = join(proteinRoot, entry.name, 'protein.config.json');
      try {
        await access(configPath);
        files.push(configPath);
      } catch {
        // A protein directory without a config is not a build target.
      }
    }
    return files;
  }

  function commandFor(config, configPath) {
    const relativeConfigPath = relative(repositoryRoot, configPath);
    switch (action) {
      case 'generate': return ['generate-protein-asset.mjs', relativeConfigPath, ...extraArguments];
      case 'validate': return ['validate-protein.mjs', config.semanticAsset, ...extraArguments];
      case 'generate-motion': return ['generate-protein-motion.py', relativeConfigPath, ...extraArguments];
      case 'validate-motion': return ['validate-protein-motion.mjs', config.motionAsset, relativeConfigPath, ...extraArguments];
      case 'generate-structure': return ['generate-protein-structure.mjs', relativeConfigPath, ...extraArguments];
      case 'validate-structure': return ['validate-protein-structure.mjs', config.structureAsset, ...extraArguments];
      default: throw new Error(`unsupported action: ${action}`);
    }
  }

  const configs = await configFiles();
  if (configs.length === 0) {
    console.error(`[protein-runner] no protein.config.json files found below ${proteinRoot}`);
    process.exitCode = 1;
  } else {
    let failed = 0;
    for (const configPath of configs) {
      const label = relative(repositoryRoot, configPath);
      try {
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        const [script, ...argumentsForScript] = commandFor(config, configPath);
        console.log(`[protein-runner] ${action}: ${label}`);
        const localPython = join(repositoryRoot, '.venv-protein-builder/bin/python');
        const executable = script.endsWith('.py') ? (process.env.PROTEIN_PYTHON ?? (existsSync(localPython) ? localPython : 'python3')) : process.execPath;
        const result = spawnSync(executable, [join(builderRoot, script), ...argumentsForScript], {
          cwd: repositoryRoot,
          stdio: 'inherit',
        });
        if (result.error || result.status !== 0) {
          failed += 1;
          const detail = result.error?.message ?? `exit code ${result.status ?? 'unknown'}`;
          console.error(`[protein-runner] FAILED ${label}: ${detail}`);
        }
      } catch (error) {
        failed += 1;
        console.error(`[protein-runner] FAILED ${label}: ${error.message}`);
      }
    }
    if (failed > 0) {
      console.error(`[protein-runner] ${failed}/${configs.length} config(s) failed for ${action}`);
      process.exitCode = 1;
    } else {
      console.log(`[protein-runner] ${configs.length} config(s) completed for ${action}`);
    }
  }
}
