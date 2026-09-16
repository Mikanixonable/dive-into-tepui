// src/ の import グラフを層の対応表へ当て、境界の規則に反する辺と、禁止パターンに当たる行を
// 数える。判定は DEVELOP/CODING-RULE.md の層の規則が正本で、ここにあるのはその機械判定。
//
// 同名の .claude/hooks/check-boundaries.mjs は別物で、あちらは編集直後に1ファイルだけ見る。
//
// 例外の置き場は2つあり、混ぜない。**恒久の例外はこのファイルへコメント付きで書き、段の途中で
// 消える残りは tools/boundary-allowlist.json へ書く。** 混ぜると、段の終わりに許可リストを
// 空にできたかどうかで「規則をコードが満たしたか」を判定できなくなる。
//
//   node tools/check-boundaries.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SRC = 'src';
const ALLOWLIST = 'tools/boundary-allowlist.json';

const DEFINITION = '定義';
const TIME = '時刻';
const DEVICE = '装置';

// 層の対応表。前方一致で当てるので、長い接頭辞を先に置く。ここに当たらないパスが src/ に
// 現れたらエラーにする — 新しいフォルダが、層の判定から黙って抜けるのを防ぐ。
const LAYER_TABLE = [
  ['src/math/', DEFINITION],
  ['src/theme.ts', DEFINITION],
  ['src/assets/', DEFINITION], // 焼き込みアセット。実行中に値が変わらない
  ['src/types/', DEFINITION], // 型宣言
  ['src/hackgen-400.css', DEFINITION], // 書体
  ['src/physics/', TIME],
  ['src/render/', DEVICE],
  ['src/marker/', DEVICE],
  ['src/audio/', DEVICE],
  ['src/input/', DEVICE],
  ['src/hud/', '表示の導出'],
  ['src/game/', '表示の導出'],
  ['src/settings/', 'アプリ寿命の正本'],
  ['src/launcher/', 'アプリの組み立て'],
  ['src/main.ts', 'アプリの組み立て'],
];

// src/hud/ が import してはならない先。hud/ が装置になったときの規則を、いま 0 件である
// うちにパスで先取りする(層の対応表では hud/ も game/ も表示の導出なので、層では出ない)。
const HUD_FORBIDDEN_ROOTS = ['src/game/', 'src/settings/', 'src/launcher/'];

const RULES = {
  deviceOut: '装置の出ていく import',
  deviceToDevice: '装置どうしの相互 import',
  timeOut: '時刻層の出ていく import',
  definitionOut: '定義層の出ていく import',
  hudOut: 'src/hud/ の出ていく import',
};

// 禁止パターンの表。段ごとに行を足す。exempt は恒久の例外で、理由は各行のコメントに書く。
const FORBIDDEN = [
  {
    name: '命令 API の禁止',
    pattern: /ensureStarted|\.unlock\(|setThrust|setRcs|applyGraphics|setFixedBrightnessScale|MarkerSlots/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    // R5 の「実時刻はフレームの先頭で1度だけ読み、入力として配る」を導出層へ当てたもの。
    name: '導出層の壁時計の禁止',
    pattern: /performance\.now|Date\.now/g,
    targets: ['src/render/', 'src/marker/', 'src/hud/', 'src/game/hud/'],
    // 自分の処理にかかった時間を測るための壁時計は、表示する時刻ではないので恒久の例外にする。
    exempt: [
      'src/render/protein/protein-runtime.ts',
      'src/render/dynamic/dynamic-entity/protein-enemy-view.ts',
    ],
  },
  {
    name: '保存先を直に触る禁止',
    pattern: /localStorage/g,
    targets: ['src/game/', 'src/theme.ts'],
    exempt: [],
  },
  {
    name: '書き換えられる設定の受け渡しの禁止',
    pattern: /RunSetting/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    name: 'HUD のモデル丸受けの禁止',
    pattern: /import .*\bGame\b/g,
    targets: ['src/game/hud/'],
    exempt: [],
  },
  {
    // モジュール直下の可変値は、定義層では R1 に、導出層では R5 に反する。判定を src/game/
    // 全体へ広げると段 3 以降で直すぶんまで許可リストへ載るので、段 2 で消す2つだけを当てる。
    name: 'モジュール直下の可変値の禁止',
    pattern: /^let |^export let /gm,
    targets: ['src/theme.ts', 'src/game/hud/panel-shell.ts'],
    exempt: [],
  },
  {
    name: '二段初期化の禁止',
    pattern: /setInput\(|setHandlers\(|setOpenAnalysisHandler\(/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    // 生の入力エッジを取るのは adapter 1つだけで、ほかは router が配る命令で受ける。
    name: '生の入力エッジの受けの禁止',
    pattern: /\binput\.take(?:Key|Keys)\s*\(/g,
    targets: ['src/game/', 'src/hud/', 'src/launcher/'],
    exempt: ['src/game/input/raw-game-input-adapter.ts'],
  },
  {
    // 層の対応表はパッケージの import を解決できないので、定義層・時刻層の three をパスで止める。
    name: '定義層・時刻層からの three の禁止',
    pattern: /'three(?:\/[^']*)?'/g,
    targets: ['src/math/', 'src/physics/'],
    exempt: [],
  },
  {
    // 表示の選択が進行へ効いてよいのは需要だけ、という R4 を当てたもの。予測の有無と表示窓の
    // 長さは「どこまで計算するか」ではなく「何を見るか」なので、進行が読めば違反になる。
    // (暫定 — 段 5 で層の規則が覆うので、そのとき外す)
    name: '表示の選択が進行へ漏れる禁止',
    pattern: /predictsFuture|display-window-duration/g,
    targets: ['src/game/dynamic/'],
    exempt: [],
  },
  {
    // 生の入力を読むのは入力の解釈の位相だけ、という R8 を当てたもの。進行へは操作量と命令で届く。
    // (暫定 — 段 5 で層の規則が覆うので、そのとき外す)
    name: 'モデル層が生の入力を読む禁止',
    pattern: /from '.*input\/input'/g,
    targets: ['src/game/dynamic/', 'src/game/player/', 'src/game/stages/'],
    exempt: [],
  },
  {
    // 一回きりの出来事は進行が記録し、表示の導出が読んで装置へ渡す(R7・R8)。進行が音・通知・
    // 画面効果の装置を持てば、この経路を飛ばして直に鳴らせてしまう。
    // (暫定 — 段 5 で層の規則が覆うので、そのとき外す)
    name: 'モデル層が出来事の装置を持つ禁止',
    pattern: /WorldSfx|UiSfx|Notifier|FlashEffects/g,
    targets: [
      'src/game/dynamic/',
      'src/game/player/',
      'src/game/stages/',
      'src/game/save/',
      'src/game/protein/',
      'src/game/control-selection.ts',
      'src/game/creative/manual-spawn.ts',
      'src/game/creative/object-placement.ts',
      'src/game/plan/plan-guide.ts',
    ],
    exempt: [],
  },
];

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|(?:^|\n)\s*import\s+)['"]([^'"]+)['"]/g;

function walk(dir, out = []) {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

function tableLayer(file) {
  const hit = LAYER_TABLE.find(([prefix]) => file.startsWith(prefix));
  return hit === undefined ? null : hit[1];
}

function deviceRootOf(file) {
  return LAYER_TABLE.find(([prefix, layer]) => layer === DEVICE && file.startsWith(prefix))?.[0];
}

// import 先を実ファイルへ解決する。返り値が src/ の外を指すこと、パッケージで null になる
// ことのどちらも起こりうる — 呼び出し側が層の判定から外す。
function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base];
  return candidates.find((c) => existsSync(path.join(root, c))) ?? null;
}

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

// 実行中に値が変わる印。トップレベルの let/var と class 宣言を見る。
const MUTABLE_SIGNS = [/^\s*(?:export\s+|default\s+|abstract\s+)*class\b/m, /^(?:export\s+)?(?:let|var)\s/m];

// どのフォルダにあっても定義層として扱えるのは、union や定数だけの語彙に限る(R2)。
// import の本数は語彙かどうかの代理にしかならず、可変な状態を持つモジュールまで定義層へ
// 落とすと、それを引く装置の import が検査を素通りする。
function isVocabulary(text, hasImports) {
  if (hasImports) return false;
  return text === undefined || !MUTABLE_SIGNS.some((re) => re.test(text));
}

// src/ 配下の全ファイルの層と、.ts/.tsx から出ていく辺を組む。辺は import type も動的 import も
// 区別せず数える。読む側から見れば、どの書き方でも相手のモジュールを引き込むことに変わりがない。
function buildGraph() {
  const files = walk(SRC);
  const unclassified = files.filter((f) => tableLayer(f) === null);
  const sources = files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const edges = [];
  const unresolved = [];
  const texts = new Map();
  for (const f of sources) {
    const text = readFileSync(path.join(root, f), 'utf8');
    texts.set(f, text);
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      const to = resolveSpec(f, spec);
      if (spec.startsWith('.') && to === null) unresolved.push({ file: f, spec, line: lineAt(text, m.index) });
      // src/ の外の資源(public/ の画像、パッケージ)は層を持たないので、辺としては数えるが
      // 層の判定からは外す。外した辺も「import を1本も持たない」の判定には効かせる。
      edges.push({ from: f, to: to !== null && to.startsWith(`${SRC}/`) ? to : null, line: lineAt(text, m.index) });
    }
  }
  const withImports = new Set(edges.map((e) => e.from));
  const layerOf = (f) => (isVocabulary(texts.get(f), withImports.has(f)) ? DEFINITION : tableLayer(f));
  return { files, sources, texts, edges, layerOf, unclassified, unresolved };
}

function findImportViolations({ edges, layerOf }) {
  const found = [];
  for (const e of edges) {
    if (e.to === null) continue;
    const from = layerOf(e.from);
    const to = layerOf(e.to);
    const selfRoot = from === DEVICE ? deviceRootOf(e.from) : null;
    const inSelf = selfRoot !== null && e.to.startsWith(selfRoot);
    if (from === DEVICE && !inSelf && to === DEVICE) {
      found.push({ rule: RULES.deviceToDevice, file: e.from, id: e.to, line: e.line });
    } else if (from === DEVICE && !inSelf && to !== DEFINITION && to !== TIME) {
      found.push({ rule: RULES.deviceOut, file: e.from, id: e.to, line: e.line });
    }
    if (from === TIME && to !== DEFINITION && to !== TIME) {
      found.push({ rule: RULES.timeOut, file: e.from, id: e.to, line: e.line });
    }
    if (from === DEFINITION && to !== DEFINITION) {
      found.push({ rule: RULES.definitionOut, file: e.from, id: e.to, line: e.line });
    }
    if (e.from.startsWith('src/hud/') && HUD_FORBIDDEN_ROOTS.some((r) => e.to.startsWith(r))) {
      found.push({ rule: RULES.hudOut, file: e.from, id: e.to, line: e.line });
    }
  }
  return found;
}

function findPatternViolations({ sources, texts }) {
  const found = [];
  for (const row of FORBIDDEN) {
    for (const f of sources) {
      if (!row.targets.some((t) => f.startsWith(t)) || row.exempt.includes(f)) continue;
      for (const m of texts.get(f).matchAll(row.pattern)) {
        found.push({ rule: row.name, file: f, id: m[0], line: lineAt(texts.get(f), m.index) });
      }
    }
  }
  return found;
}

// 違反の同一性は「ファイル + 違反の識別子」で、行番号は持たない — 行番号は後続の編集で
// すぐ嘘になる。同じ識別子が同じファイルに複数行あるときは、全部消えるまで1件として残る。
function group(found) {
  const byKey = new Map();
  for (const v of found) {
    const key = keyOf(v);
    const known = byKey.get(key);
    if (known === undefined) byKey.set(key, { ...v, lines: [v.line] });
    else known.lines.push(v.line);
  }
  return [...byKey.values()];
}

function readAllowlist() {
  const raw = JSON.parse(readFileSync(path.join(root, ALLOWLIST), 'utf8'));
  const listed = [];
  for (const [rule, byFile] of Object.entries(raw)) {
    for (const [file, ids] of Object.entries(byFile)) {
      for (const id of ids) listed.push({ rule, file, id });
    }
  }
  return listed;
}

function keyOf(v) {
  return JSON.stringify([v.rule, v.file, v.id]);
}

function report(violations, listed) {
  const ruleNames = [...Object.values(RULES), ...FORBIDDEN.map((r) => r.name)];
  const allowed = new Set(listed.map(keyOf));
  const unlisted = violations.filter((v) => !allowed.has(keyOf(v)));
  const live = new Set(violations.map(keyOf));
  const stale = listed.filter((v) => !live.has(keyOf(v)));
  for (const rule of ruleNames) {
    const mine = unlisted.filter((v) => v.rule === rule);
    const allowedCount = violations.filter((v) => v.rule === rule && allowed.has(keyOf(v))).length;
    console.log(`${rule} — 違反 ${mine.length} 件 / 許可リスト ${allowedCount} 件`);
    for (const v of mine.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  ${v.file}:${v.lines.join(',')} → ${v.id}`);
    }
  }
  if (stale.length > 0) {
    console.log(`\nもう消えた違反が許可リストに残っている — ${stale.length} 件`);
    for (const v of stale) console.log(`  [${v.rule}] ${v.file} → ${v.id}`);
  }
  return unlisted.length === 0 && stale.length === 0;
}

const graph = buildGraph();
let ok = true;
if (graph.unclassified.length > 0) {
  console.log(`層の対応表に無いパス — ${graph.unclassified.length} 件`);
  for (const f of graph.unclassified) console.log(`  ${f}`);
  console.log('  tools/check-boundaries.mjs の LAYER_TABLE へ層を足すこと。');
  ok = false;
}
if (graph.unresolved.length > 0) {
  console.log(`解決できない相対 import — ${graph.unresolved.length} 件`);
  for (const u of graph.unresolved) console.log(`  ${u.file}:${u.line} → ${u.spec}`);
  ok = false;
}
if (!report(group([...findImportViolations(graph), ...findPatternViolations(graph)]), readAllowlist())) ok = false;
console.log(ok ? '\n境界の検査を通った。' : '\n境界の検査に落ちた。');
process.exit(ok ? 0 : 1);
