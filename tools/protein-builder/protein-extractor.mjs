// 構造解析を担う Python を起動し、その中間生成物をアセットとして確定させる。
// 内容ハッシュはこの層が与える。生成物の同一性の基準をひとつに保つため。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serializeProteinAsset } from './protein-asset-format.mjs';

const builderRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(builderRoot, '../..');

// 構造解析に使う Python。取り込み済みの依存を持つ仮想環境を優先する。
export function pythonExecutable() {
  const local = join(repositoryRoot, '.venv-protein-builder/bin/python');
  return process.env.PROTEIN_PYTHON ?? (existsSync(local) ? local : 'python3');
}

// 抽出スクリプトを走らせ、その出力を読み取って返す。失敗すれば例外を投げる。
export async function extract(script, configFile) {
  const directory = await mkdtemp(join(tmpdir(), 'protein-extract-'));
  const outputFile = join(directory, 'asset.json');
  try {
    const result = spawnSync(pythonExecutable(), [join(builderRoot, script), configFile, `--output=${outputFile}`], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${script} exited with code ${result.status}`);
    return JSON.parse(await readFile(outputFile, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// アセットを書き出す。checkOnly のときは書かず、既存と一致しなければ終了コードを立てる。
export async function writeAsset(outputFile, asset, checkOnly) {
  const serialized = serializeProteinAsset(asset);
  if (!checkOnly) {
    await writeFile(outputFile, serialized);
    return true;
  }
  const existing = await readFile(outputFile, 'utf8').catch(() => null);
  if (existing === serialized) return true;
  console.error(`${outputFile}: generated asset differs from the committed one`);
  process.exitCode = 1;
  return false;
}
