// 船モジュールの原型 GLB(assets-src/ship-modules/*.glb)を Blender で作り直す。
// 寸法の正本(カタログの長さ・砲口、展開パネルの枚数・寸法)を manifest に書き出して Blender へ渡す。
//
// 実行: npm run ship-modules:author(Blender の場所は BLENDER、既定は PATH と macOS の標準位置)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadSourceModules } from '../compile-source.mjs';
import { CASING_DISPLAY_COLOR, CASING_DISPLAY_METALNESS, CASING_DISPLAY_ROUGHNESS } from './materials.mjs';
import { buildCasingMesh, buildMagazineMesh } from './gun-parts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAC_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';

// 実際に出力するマガジンと、表示時の長さ補正をかけた薬莢の外形を Blender へ渡す。
function ammunitionDimensions() {
  const magazine = buildMagazineMesh();
  magazine.updateMatrixWorld(true);
  const magazineSize = new THREE.Box3().setFromObject(magazine).getSize(new THREE.Vector3());

  const casing = buildCasingMesh();
  casing.scale.y = 2;
  casing.updateMatrixWorld(true);
  const casingSize = new THREE.Box3().setFromObject(casing).getSize(new THREE.Vector3());
  const casingColor = new THREE.Color(CASING_DISPLAY_COLOR);
  return {
    magazineCrossSection: [magazineSize.y, magazineSize.z],
    casingDiameter: Math.max(casingSize.x, casingSize.z),
    casingLength: casingSize.y,
    casingColorLinear: casingColor.toArray().slice(0, 3),
    casingMetalness: CASING_DISPLAY_METALNESS,
    casingRoughness: CASING_DISPLAY_ROUGHNESS,
  };
}

// 使う Blender 実行ファイル。見つからなければ投げる。
function blenderPath() {
  if (process.env.BLENDER !== undefined) return process.env.BLENDER;
  const which = spawnSync('which', ['blender'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim() !== '') return which.stdout.trim();
  if (existsSync(MAC_BLENDER)) return MAC_BLENDER;
  throw new Error('Blender was not found; set BLENDER to its executable');
}

// Blender スクリプトが読む寸法表。ベクトルは [x, y, z] [m]、推力は [N](推力を持たない module は null)。
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
        diameter: definition.diameter,
        muzzles: definition.muzzles.map(muzzle => [muzzle.x, muzzle.y, muzzle.z]),
        feedPort: [definition.feedPort.x, definition.feedPort.y, definition.feedPort.z],
        ejectionPort: [definition.ejectionPort.x, definition.ejectionPort.y, definition.ejectionPort.z],
        linkExitPort: [definition.linkExitPort.x, definition.linkExitPort.y, definition.linkExitPort.z],
        thrust: definition.abilities.thrust ?? null,
      };
    }
    return {
      modules,
      ammunition: ammunitionDimensions(),
      cockpitHull: {
        profile: source.shipModuleCatalog.COCKPIT_HULL_PROFILE,
        sectionIndentFraction: source.shipModuleCatalog.COCKPIT_SECTION_INDENT_FRACTION,
      },
      deployables: {
        solar_panel: {
          count: shape.SOLAR_PANEL_COUNT, columns: shape.SOLAR_PANEL_COLUMNS,
          length: shape.SOLAR_PANEL_LENGTH, span: shape.SOLAR_PANEL_SPAN,
          panelPitch: shape.SOLAR_PANEL_PANEL_PITCH, faceScale: shape.SOLAR_PANEL_FACE_SCALE,
          stageScales: shape.SOLAR_PANEL_STAGE_SCALES,
          centerlineClearance: shape.SOLAR_PANEL_CENTERLINE_CLEARANCE,
          thickness: shape.SOLAR_PANEL_THICKNESS, normalAxis: [0, 1, 0],
        },
        radiator: {
          count: shape.RADIATOR_FOLD_COUNT, length: shape.RADIATOR_SEGMENT_LENGTH, span: shape.RADIATOR_PANEL_WIDTH,
          thickness: shape.RADIATOR_PANEL_THICKNESS, normalAxis: [0, 1, 0],
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
