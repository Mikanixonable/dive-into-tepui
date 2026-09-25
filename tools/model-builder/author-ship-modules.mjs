// 船モジュールの原型 GLB(assets-src/ship-modules/*.glb)を Blender で作り直す。
// 寸法の正本(カタログの長さ・砲口、展開パネルの枚数・寸法)を manifest に書き出して Blender へ渡す。
//
// 実行: npm run ship-modules:author(Blender の場所は BLENDER、既定は PATH と macOS の標準位置)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceModules } from '../compile-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAC_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';

// 使う Blender 実行ファイル。見つからなければ投げる。
function blenderPath() {
  if (process.env.BLENDER !== undefined) return process.env.BLENDER;
  const which = spawnSync('which', ['blender'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim() !== '') return which.stdout.trim();
  if (existsSync(MAC_BLENDER)) return MAC_BLENDER;
  throw new Error('Blender was not found; set BLENDER to its executable');
}

// Blender スクリプトが読む寸法表。ベクトルは [x, y, z] [m]。
function buildManifest() {
  const source = loadSourceModules(['game/ship/ship-module-catalog', 'physics/player-shape']);
  try {
    const { SHIP_MODULE_CATALOG } = source.shipModuleCatalog;
    const shape = source.playerShape;
    const modules = {};
    for (const definition of SHIP_MODULE_CATALOG.all()) {
      modules[definition.modelId] ??= {
        kind: definition.kind,
        length: definition.length,
        muzzles: definition.muzzles.map(muzzle => [muzzle.x, muzzle.y, muzzle.z]),
      };
    }
    return {
      modules,
      deployables: {
        solar_panel: {
          count: shape.SOLAR_PANEL_COUNT, length: shape.SOLAR_PANEL_WIDTH, span: shape.SOLAR_PANEL_SPAN,
          thickness: shape.SOLAR_PANEL_THICKNESS, normalAxis: [0, 1, 0],
        },
        radiator: {
          count: shape.RADIATOR_FOLD_COUNT, length: shape.RADIATOR_SEGMENT_LENGTH, span: shape.RADIATOR_PANEL_WIDTH,
          thickness: shape.RADIATOR_PANEL_THICKNESS, normalAxis: [1, 0, 0],
        },
      },
    };
  } finally {
    source.dispose();
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'tepui-ship-modules-'));
try {
  const manifestPath = join(workDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(buildManifest(), null, 2));
  const result = spawnSync(blenderPath(), [
    '--background', '--factory-startup', '--python', join(__dirname, 'blender', 'build-ship-modules.py'),
    '--', manifestPath,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Blender exited with status ${result.status}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
