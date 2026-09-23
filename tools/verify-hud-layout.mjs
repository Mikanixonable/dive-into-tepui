import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const hudRoots = ['src/game/hud', 'src/hud'];
const layoutTokensFile = path.normalize('src/game/hud/style/layout-tokens.ts');
const skeletonFile = path.normalize('src/game/hud/style/skeleton-style.ts');

function filesUnder(relativeRoot) {
  const absolute = path.join(root, relativeRoot);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return filesUnder(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

function cssTemplateBodies(text) {
  return [...text.matchAll(/(?:export\s+const\s+\w+|const\s+STYLE)\s*=\s*`([\s\S]*?)`;/g)]
    .map((match) => match[1]);
}

const violations = [];
const files = hudRoots.flatMap(filesUnder);
const layoutTokens = fs.readFileSync(path.join(root, layoutTokensFile), 'utf8');
const skeleton = fs.readFileSync(path.join(root, skeletonFile), 'utf8');

// 中央HUDの配置契約。初期描画はCSS fallback、描画後は hud-root.ts が実寸へ上書きする。
for (const token of ['--hud-chrome-h', '--hud-left-rail-occupied', '--hud-right-rail-occupied']) {
  if (!layoutTokens.includes(`${token}:`)) violations.push(`${layoutTokensFile}: missing layout contract token ${token}`);
}

// rail-w はレール自身の寸法を決める実装詳細。中央・下部HUDが直接参照すると収納時に空白が残る。
for (const relative of files) {
  if (relative === layoutTokensFile || relative === skeletonFile) continue;
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const match of text.matchAll(/var\(--rail-w-(?:left|right)\)/g)) {
    const line = text.slice(0, match.index).split('\n').length;
    violations.push(`${relative}:${line}: use --hud-*-rail-occupied instead of --rail-w-* outside rail layout`);
  }
}

// rail自身が唯一の通常スクロール所有者であることをソースでも保証する。
// 大量リスト等の内部スクロールは panel root ではなく、その本文要素が所有する。
if (!/#hud \.hud-rail\s*\{[\s\S]*?overflow-y:\s*auto/.test(skeleton)) {
  violations.push(`${skeletonFile}: .hud-rail must own vertical scrolling`);
}
for (const relative of files) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const css of cssTemplateBodies(text)) {
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = rule[1].trim();
      const body = rule[2];
      if (!selector.includes('.hud-rail') || !selector.includes('>')) continue;
      if (/overflow-y:\s*(?:auto|scroll)\b/.test(body)) {
        violations.push(`${relative}: direct rail child must not own vertical scrolling: ${selector.replace(/\s+/g, ' ')}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`HUD layout contract verification passed (${files.length} source files scanned).`);
