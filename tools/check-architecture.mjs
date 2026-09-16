import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(root, 'src');

const restrictedLayers = {
  game: new Set(['launcher']),
  hud: new Set(['game', 'launcher']),
  input: new Set(['game', 'hud', 'launcher']),
  math: new Set(['game', 'physics', 'render']),
  physics: new Set(['game', 'render']),
};

const importRe = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const sideEffectImportRe = /\bimport\s*['"]([^'"]+)['"]/g;

function sourceFilesIn(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) files.push(...sourceFilesIn(file));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(file);
  }
  return files;
}

function layerOf(file) {
  const relative = path.relative(srcRoot, file);
  return relative.split(path.sep)[0];
}

function relativeSourcePath(file) {
  return path.relative(srcRoot, file).split(path.sep).join('/');
}

function isCloudRenderFile(file) {
  return relativeSourcePath(file).startsWith('render/cloud/');
}

function resolveSourceImport(file, specifier) {
  const base = path.resolve(path.dirname(file), specifier);
  const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function importsIn(source) {
  const imports = new Map();
  for (const match of source.matchAll(importRe)) imports.set(`${match.index}:${match[1]}`, { specifier: match[1], index: match.index });
  for (const match of source.matchAll(sideEffectImportRe)) imports.set(`${match.index}:${match[1]}`, { specifier: match[1], index: match.index });
  return [...imports.values()];
}

function sourceWithoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const violations = [];
for (const file of sourceFilesIn(srcRoot)) {
  const source = readFileSync(file, 'utf8');
  const sourceLayer = layerOf(file);
  const relative = relativeSourcePath(file);
  const restricted = restrictedLayers[sourceLayer];

  // raw edge の消費は game/input の adapter だけに閉じる。コメント中の例示は除いて検査する。
  if ((sourceLayer === 'game' || sourceLayer === 'hud' || sourceLayer === 'launcher')
    && relative !== 'game/input/raw-game-input-adapter.ts') {
    const rawEdge = /\b(?:this\.)?input\.take(?:Key|Keys)\s*\(/;
    if (rawEdge.test(sourceWithoutComments(source))) {
      violations.push(`${path.relative(root, file)}: raw Input edge must be consumed by game/input/raw-game-input-adapter.ts`);
    }
  }

  for (const { specifier, index } of importsIn(source)) {
    if ((sourceLayer === 'math' || sourceLayer === 'physics') && (specifier === 'three' || specifier.startsWith('three/'))) {
      violations.push(`${path.relative(root, file)}:${lineAt(source, index)} imports ${specifier}; ${sourceLayer}/ は THREE.js に依存してはならない`);
      continue;
    }

    if (!specifier.startsWith('/') && !specifier.startsWith('.')) continue;
    const target = resolveSourceImport(file, specifier);
    if (target === undefined || !target.startsWith(`${srcRoot}${path.sep}`)) continue;
    const targetLayer = layerOf(target);
    if (restricted?.has(targetLayer)) {
      violations.push(`${path.relative(root, file)}:${lineAt(source, index)} imports ${targetLayer}/; ${sourceLayer}/ からの依存は禁止`);
    }

    // render/ はゲーム状態を知らない。雲の気候・雲場経路だけは、既存の移行計画で
    // 明示的に対象外としているため、この検査から除く。
    if (sourceLayer === 'render' && !isCloudRenderFile(file) && targetLayer === 'game') {
      violations.push(`${path.relative(root, file)}:${lineAt(source, index)} imports game/; cloud 以外の render/ からの依存は禁止`);
    }

    // ゲーム固有 HUD は Game 全体を探索せず、機能ごとの read model を受け取る。
    if (relativeSourcePath(file).startsWith('game/hud/') && target === path.join(srcRoot, 'game', 'game.ts')) {
      violations.push(`${path.relative(root, file)}:${lineAt(source, index)} imports game/game.ts; game/hud/ からの依存は禁止`);
    }

    // セーブの永続化・一覧表示はランの状態機械から独立している。
    if ((relativeSourcePath(file).startsWith('launcher/save/')
      || relativeSourcePath(file).startsWith('launcher/save-browser/'))
      && target === path.join(srcRoot, 'game', 'game.ts')) {
      violations.push(`${path.relative(root, file)}:${lineAt(source, index)} imports game/game.ts; launcher の保存層からの依存は禁止`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('architecture: no restricted dependencies');
}
