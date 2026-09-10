import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scanRoots = ['src/hud', 'src/game/hud', 'src/launcher'];
const commonStyle = path.normalize('src/hud/style/common-ui-style.ts');
const allowedVisualLines = new Set([
  "content: ''; position: absolute; left: 0; right: 0; top: 5px; border-top: 1px solid var(--text-dim);",
  'position: absolute; top: 1px; height: 9px; border-left: 1px solid var(--text);',
]);

function filesUnder(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (relative.endsWith('/marker-style.ts') || relative.endsWith('/node-gizmo.ts')) return [];
    return [relative];
  });
}

const files = scanRoots.flatMap(filesUnder);
const violations = [];
const surfaceDefinitionFiles = new Set();

for (const relative of files) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const declarations = [...trimmed.matchAll(/\b(border(?:-(?:top|right|bottom|left|width|color|style))?)\s*:\s*([^;}`]+)/g)];
    for (const [, property, rawValue] of declarations) {
      const value = rawValue.trim();
      const isZeroOrAbsent = /^(?:0|none|transparent)(?:\s|$)/.test(value);
      const isAllowedVisualLine = allowedVisualLines.has(trimmed);
      if (!isZeroOrAbsent && !isAllowedVisualLine) {
        violations.push(`${relative}:${index + 1}: decorative border declaration: ${property}: ${value}`);
      }
    }
    if (
      trimmed.includes('linear-gradient(145deg, var(--glass-highlight), transparent 42%), var(--glass-quiet)') ||
      trimmed.includes('linear-gradient(145deg, var(--glass-highlight), transparent 42%), var(--glass-focus)') ||
      trimmed.includes('backdrop-filter: blur(var(--glass-blur-')
    ) {
      surfaceDefinitionFiles.add(relative);
    }
  });
}

if (surfaceDefinitionFiles.size !== 1 || !surfaceDefinitionFiles.has(commonStyle)) {
  violations.push(
    `glass surface definitions must be centralized in ${commonStyle}; found ${[...surfaceDefinitionFiles].join(', ') || 'none'}`,
  );
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`UI style verification passed (${files.length} source files scanned).`);
