// src/ の import グラフを層の対応表へ当て、境界の規則に反する辺と、禁止パターンに当たる行を
// 数える。判定は DEVELOP/ARCHITECTURE.md の規則が正本で、ここにあるのはその機械判定。
//
// 同名の .claude/hooks/check-boundaries.mjs は別物で、あちらは編集直後に1ファイルだけ見る。
//
// 検査を外す置き場は2つあり、混ぜない。**規則どおりに分けられない箇所の例外は exempt へ理由の
// コメント付きで書き、段の途中で消える残りは tools/boundary-allowlist.json へ書く。** 混ぜると、
// 段の終わりに許可リストを空にできたかどうかで「規則をコードが満たしたか」を判定できなくなる。
//
//   node tools/check-boundaries.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const SRC = 'src';
const ALLOWLIST = 'tools/boundary-allowlist.json';

const DEFINITION = '定義';
const TIME = '時刻';
const DEVICE = '装置';
const VIEWER = '視点';

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
  ['src/game/viewer/', VIEWER],
  ['src/game/', '表示の導出'],
  ['src/settings/', 'アプリ寿命の正本'],
  ['src/launcher/', 'アプリの組み立て'],
  ['src/run/', 'アプリの組み立て'],
  ['src/main.ts', 'アプリの組み立て'],
];

// src/hud/ が import してはならない先。hud/ が装置になったときの規則を、いま 0 件である
// うちにパスで先取りする(層の対応表では hud/ も game/ も表示の導出なので、層では出ない)。
const HUD_FORBIDDEN_ROOTS = ['src/game/', 'src/settings/', 'src/launcher/'];

// モデル層のうち進行の置き場(R4)。
const PROGRESS_ROOTS = [
  'src/game/dynamic/',
  'src/game/player/',
  'src/game/stages/',
  'src/game/plan/',
  'src/game/creative/',
  'src/game/protein/',
  'src/game/control-selection.ts',
];

// モデル層の置き場。進行と視点と、モデル層の根と、その両方が使う命令の列と出来事の記録。
const MODEL_ROOTS = [
  ...PROGRESS_ROOTS,
  'src/game/control-selection-commands.ts',
  'src/game/viewer/',
  'src/game/game.ts',
  'src/game/command-queue.ts',
  'src/game/run-events.ts',
];

// 表示の導出だが、置き場がまだ進行のフォルダか、モデル層の根の隣にあるファイル。動かしたらここも
// 直す — 存在しないパスが残ると検査が落ちる。(暫定 — 段 8 で presentation/ へ移すときに消える)
const MISPLACED_PRESENTATION_FILES = [
  'src/game/game-presentation.ts',
  'src/game/plan/plan-editor.ts',
  'src/game/plan/plan-path.ts',
  'src/game/plan/node-gizmo.ts',
  'src/game/plan/plan-panel.ts',
  'src/game/plan/plan-axis-drag.ts',
  'src/game/plan/plan-display.ts',
  'src/game/plan/plan-guide.ts',
  'src/game/creative/object-placer-panel.ts',
  'src/game/creative/slider-field.ts',
  'src/game/creative/stage-controls-panel.ts',
  'src/game/stages/stage-utils/status-panel.ts',
];

// src/game/ の中にある表示の導出の置き場(1.3)。
const PRESENTATION_ROOTS = [
  'src/game/hud/',
  'src/game/marker/',
  'src/game/view/',
  'src/game/pickable/',
  'src/game/map/',
  'src/game/lines/',
  'src/game/input/',
  'src/game/flash-presenter.ts',
  'src/game/run-event-presenter.ts',
];

// 判定の名前と、その目的を書いた規則(ref)。違反の行に ref を添え、読む先を示す。exempt は例外にする
// import の辺 [import する側, される側] で、理由は各辺のコメントに書く(ARCHITECTURE「規則に合わないとき」)。
const RULES = {
  // render はゲームの assembly・definition・instance を直接参照せず、表示契約だけを受け取る。
  deviceOut: { name: '装置の出ていく import', ref: 'ARCHITECTURE R2', exempt: [] },
  deviceToDevice: { name: '装置どうしの相互 import', ref: 'ARCHITECTURE R2', exempt: [] },
  timeOut: { name: '時刻層の出ていく import', ref: 'ARCHITECTURE R2', exempt: [] },
  definitionOut: { name: '定義層の出ていく import', ref: 'ARCHITECTURE R2', exempt: [] },
  hudOut: { name: 'src/hud/ の出ていく import', ref: 'ARCHITECTURE R2', exempt: [] },
  progressToViewer: { name: '進行から視点への import', ref: 'ARCHITECTURE R4', exempt: [] },
  settingsViewer: { name: '設定と視点の相互 import', ref: 'ARCHITECTURE R4', exempt: [] },
  serializationToPresentation: {
    name: '直列化の根の型から表示の導出への import', ref: 'ARCHITECTURE R11', exempt: [],
  },
};

// 構文木で当てる判定。名前ではなく形を見るので、名前を替えても外れない。exempt は例外にする
// [ファイル, 違反の識別子] で、理由は各行のコメントに書く(ARCHITECTURE「規則に合わないとき」)。
const SYNTAX_RULES = {
  // 識別子は「型名.欄名」。代入の形は命令であることを呼び手から隠し、書き手を1つに保てなくする。
  // 旧敵船の Part は PartInventory が唯一の所有者として損傷・燃料を更新し、Ship の
  // hp キャッシュは同じ所有者が assembly と同期する。型を readonly に分解すると敵の
  // 既存ダメージ経路が二重の adapter になり、移行中の一体性を失うためこの4欄を固定する。
  mutableField: { name: 'モデル層の可変な公開欄の禁止', ref: 'ARCHITECTURE R3', exempt: [
    ['src/game/dynamic/dynamic-entity/parts.ts', 'Part.hp'],
    ['src/game/dynamic/dynamic-entity/parts.ts', 'RcsTankPart.fuel'],
    ['src/game/dynamic/dynamic-entity/ship.ts', 'Ship.hp'],
    ['src/game/dynamic/dynamic-entity/ship.ts', 'Ship.maxHp'],
  ] },
  // 識別子は「型名.constructor(引数名)」。型の名前 Serialized* は直列化の語彙の行が保証する。不変な
  // 素の値の型をそのまま直列化の形に使うもの(R12)は、新しく作るときにも同じ型で受けるので当てない。
  serializedConstructorArg: {
    name: '直列化された形をコンストラクタで受ける禁止', ref: 'ARCHITECTURE R12', exempt: [],
  },
};

// 禁止パターンの表。段ごとに行を足す。exempt は例外で、理由は各行のコメントに書く
// (ARCHITECTURE「規則に合わないとき」)。
const FORBIDDEN = [
  {
    // R5 の「実時刻はフレームの先頭で1度だけ読み、入力として配る」を導出層へ当てたもの。
    name: '導出層の壁時計の禁止',
    ref: 'ARCHITECTURE R5',
    pattern: /performance\.now|Date\.now/g,
    targets: ['src/render/', 'src/marker/', 'src/hud/', 'src/game/hud/'],
    // 自分の処理にかかった時間を測るための壁時計は、表示する時刻ではないので例外にする。
    exempt: [
      'src/render/protein/protein-runtime.ts',
      'src/render/dynamic/dynamic-entity/protein-enemy-view.ts',
      'src/render/cloud/cloud-local-field-baker.ts',
      // 分割ジョブの step 予算・試行の壁時計を測るため — baker と同じ計測用途。
      'src/render/cloud/meteorological-cloud-field.ts',
    ],
  },
  {
    name: '保存先を直に触る禁止',
    ref: 'ARCHITECTURE R10',
    pattern: /localStorage/g,
    targets: ['src/game/', 'src/theme.ts'],
    exempt: [],
  },
  {
    name: '書き換えられる設定の受け渡しの禁止',
    ref: 'ARCHITECTURE R10',
    pattern: /RunSetting/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    name: 'HUD のモデル丸受けの禁止',
    ref: 'ARCHITECTURE R3',
    pattern: /import .*\bGame\b/g,
    targets: ['src/game/hud/'],
    exempt: [],
  },
  {
    // モジュール直下の可変値は、定義層では R1 に、導出層では R5 に反する。判定を src/game/
    // 全体へ広げると段 3 以降で直すぶんまで許可リストへ載るので、段 2 で消す2つだけを当てる。
    name: 'モジュール直下の可変値の禁止',
    ref: 'ARCHITECTURE R1・R5',
    pattern: /^let |^export let /gm,
    targets: ['src/theme.ts', 'src/game/hud/panel-shell.ts'],
    exempt: [],
  },
  {
    // 名前は形の代用にすぎないので、名前を替えた二段初期化は段の終わりの洗い出しで見る。
    name: '二段初期化の禁止',
    ref: 'CODING-RULE 1.11',
    pattern: /setInput\(|setHandlers\(|setOpenAnalysisHandler\(/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    // 生の入力エッジを取るのは adapter 1つだけで、ほかは router が配る命令で受ける。
    name: '生の入力エッジの受けの禁止',
    ref: 'ARCHITECTURE R8',
    pattern: /\binput\.take(?:Key|Keys)\s*\(/g,
    targets: ['src/game/', 'src/hud/', 'src/launcher/'],
    exempt: ['src/game/input/raw-game-input-adapter.ts'],
  },
  {
    // 層の対応表はパッケージの import を解決できないので、定義層・時刻層の three をパスで止める。
    name: '定義層・時刻層からの three の禁止',
    ref: 'ARCHITECTURE R2',
    pattern: /'three(?:\/[^']*)?'/g,
    targets: ['src/math/', 'src/physics/'],
    exempt: [],
  },
  {
    // 表示の選択が進行へ効いてよいのは需要だけ、という R4 を当てたもの。予測の有無と表示窓の
    // 長さは「どこまで計算するか」ではなく「何を見るか」なので、進行が読めば違反になる。
    // (暫定 — 段 6 で層の規則が覆うので、そのとき外す)
    name: '表示の選択が進行へ漏れる禁止',
    ref: 'ARCHITECTURE R4',
    pattern: /predictsFuture|display-window-duration/g,
    targets: ['src/game/dynamic/'],
    exempt: [],
  },
  {
    // 生の入力を読むのは入力の解釈の位相だけ、という R8 を当てたもの。進行へは操作量と命令で届く。
    // (暫定 — 段 6 で層の規則が覆うので、そのとき外す)
    name: 'モデル層が生の入力を読む禁止',
    ref: 'ARCHITECTURE R8',
    pattern: /from '.*input\/input'/g,
    targets: ['src/game/dynamic/', 'src/game/player/', 'src/game/stages/', 'src/game/viewer/'],
    exempt: [],
  },
  {
    // 一回きりの出来事は進行が記録し、表示の導出が読んで装置へ渡す(R7・R8)。進行が音・通知・
    // 画面効果の装置を持てば、この経路を飛ばして直に鳴らせてしまう。
    // (暫定 — 段 6 で層の規則が覆うので、そのとき外す)
    name: 'モデル層が出来事の装置を持つ禁止',
    ref: 'ARCHITECTURE R7',
    pattern: /WorldSfx|UiSfx|Notifier|FlashEffects/g,
    targets: [
      'src/game/dynamic/',
      'src/game/player/',
      'src/game/stages/',
      'src/game/protein/',
      'src/game/control-selection.ts',
      'src/game/creative/manual-spawn.ts',
      'src/game/creative/object-placement.ts',
      'src/game/plan/plan-node-rules.ts',
      'src/game/viewer/',
    ],
    exempt: [],
  },
  {
    // モデル層が知るのは直列化だけで、直列化された形は SerializedT と呼ぶ(R12)。
    name: '直列化の語彙の禁止',
    ref: 'ARCHITECTURE R12',
    pattern: /\b\w+SaveData\b|\bWeaponStateData\b|\bBoosterStackData\b|\bSAVE_VERSION\b/g,
    targets: ['src/'],
    exempt: [],
  },
  {
    // 復元は静的な deserialize が行い、構築した後で保存値を流し込まない(R12)。名前は形の代用に
    // すぎないので、名前を替えた流し込みは段の終わりの洗い出しで見る。
    name: '復元の流し込みの禁止',
    ref: 'ARCHITECTURE R12',
    pattern: /\brestore\w*\s*\(|\bimportData\s*\(|\bsaveState\b/g,
    targets: MODEL_ROOTS,
    exempt: [],
  },
  {
    // game.ts はモデル層の根で、表示の導出の根と並べて組むのはランの組み立て(R10・R13)。
    // ./hud/hud-layers の型だけは外す — ステージのパネルの置き場を Stage へ渡すため。
    // (暫定 — 段 6 の 6-5 で外す)
    name: 'モデル層の根が表示の導出を持つ禁止',
    ref: 'ARCHITECTURE R10・R13',
    pattern:
      /from '\.\/(?:hud\/(?!hud-layers')|(?:marker|view|pickable|map|lines|input|camera)\/)|from '\.\/(?:game-presentation|flash-presenter|run-event-presenter|controlled-loop-sfx|orbit-info)'|from '\.\.\/(?:audio|input|marker)\//g,
    targets: ['src/game/game.ts'],
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

// roots の各要素はフォルダ(末尾が /)かファイルのパスで、前方一致で当てる。
function isUnder(file, roots) {
  return roots.some((r) => file.startsWith(r));
}

// 進行のフォルダにあるファイルのうち、表示の導出を除いたものか。
function isProgress(file) {
  return isUnder(file, PROGRESS_ROOTS) && !MISPLACED_PRESENTATION_FILES.includes(file);
}

function findImportViolations({ edges, layerOf }) {
  const found = [];
  for (const e of edges) {
    if (e.to === null) continue;
    const flag = (rule) => {
      if (rule.exempt.some(([from, to]) => from === e.from && to === e.to)) return;
      found.push({ rule: rule.name, file: e.from, id: e.to, line: e.line });
    };
    const from = layerOf(e.from);
    const to = layerOf(e.to);
    const selfRoot = from === DEVICE ? deviceRootOf(e.from) : null;
    const inSelf = selfRoot !== null && e.to.startsWith(selfRoot);
    if (from === DEVICE && !inSelf && to === DEVICE) {
      flag(RULES.deviceToDevice);
    } else if (from === DEVICE && !inSelf && to !== DEFINITION && to !== TIME) {
      flag(RULES.deviceOut);
    }
    if (from === TIME && to !== DEFINITION && to !== TIME) flag(RULES.timeOut);
    if (from === DEFINITION && to !== DEFINITION) flag(RULES.definitionOut);
    if (e.from.startsWith('src/hud/') && isUnder(e.to, HUD_FORBIDDEN_ROOTS)) flag(RULES.hudOut);

    // 以下の3つは層でなくパスで当てる。import を持たない視点のモジュールも、層では定義層に落ちる(R2)。
    // 進行は視点を import しない、という R4 を当てたもの。
    // (暫定 — 段 6 で層の規則が覆うので外す)
    if (isProgress(e.from) && e.to.startsWith('src/game/viewer/')) flag(RULES.progressToViewer);
    // 視点の値を設定として持つ、またはその逆にすると、ここに辺が生える(R4)。視点 → 設定は段 6 の
    // モデル層の規則が、設定 → 視点は段 8 の settings/ の規則が覆うので、それぞれの段で外す。
    if (
      (e.from.startsWith('src/settings/') && e.to.startsWith('src/game/viewer/')) ||
      (e.from.startsWith('src/game/viewer/') && e.to.startsWith('src/settings/'))
    ) {
      flag(RULES.settingsViewer);
    }
    // スナップショットはモデル層の直列化で、表示の導出を含めない(R11)。実体の直列化の根の型を
    // 置く辞書へ当てる。(暫定 — 段 6 で層の規則が覆うので外す)
    if (e.from === 'src/game/dynamic/dynamic-entity/entity-dictionary.ts' && isUnder(e.to, PRESENTATION_ROOTS)) {
      flag(RULES.serializationToPresentation);
    }
  }
  return found;
}

function findPatternViolations({ sources, texts }) {
  const found = [];
  for (const row of FORBIDDEN) {
    for (const f of sources) {
      if (!isUnder(f, row.targets) || row.exempt.includes(f)) continue;
      for (const m of texts.get(f).matchAll(row.pattern)) {
        found.push({ rule: row.name, file: f, id: m[0], line: lineAt(texts.get(f), m.index) });
      }
    }
  }
  return found;
}

// モデル層のファイルか。表示の導出がまだ置かれているファイルを除く。
function isModel(file) {
  return isUnder(file, MODEL_ROOTS) && !MISPLACED_PRESENTATION_FILES.includes(file);
}

function modifiersOf(node) {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node, kind) {
  return modifiersOf(node).some((m) => m.kind === kind);
}

function isPublicMember(node) {
  if (node.name !== undefined && ts.isPrivateIdentifier(node.name)) return false;
  return !hasModifier(node, ts.SyntaxKind.PrivateKeyword) && !hasModifier(node, ts.SyntaxKind.ProtectedKeyword);
}

// export 宣言か、ファイル末尾の `export { … }` で export される名前。
function exportedNames(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause !== undefined && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add((el.propertyName ?? el.name).text);
    } else if (hasModifier(st, ts.SyntaxKind.ExportKeyword) && st.name !== undefined) {
      names.add(st.name.text);
    }
  }
  return names;
}

// 型の構文の中に、名前が Serialized で始まる型の参照があるか。
function mentionsSerialized(typeNode) {
  let found = false;
  const visit = (node) => {
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isQualifiedName(node.typeName) ? node.typeName.right.text : node.typeName.text;
      if (name.startsWith('Serialized')) found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

// 値の形を述べる型の構文を辿り、可変な欄を flag へ渡す。関数の型の引数と戻り値は、値が持つ欄では
// ないので辿らない。
function checkTypeShape(typeName, node, flag) {
  if (ts.isFunctionLike(node)) return;
  const readonly = hasModifier(node, ts.SyntaxKind.ReadonlyKeyword);
  if (ts.isPropertySignature(node) && !readonly) flag(SYNTAX_RULES.mutableField, node, `${typeName}.${node.name.getText()}`);
  if (ts.isIndexSignatureDeclaration(node) && !readonly) flag(SYNTAX_RULES.mutableField, node, `${typeName}[]`);
  if (ts.isMappedTypeNode(node) && node.readonlyToken === undefined) flag(SYNTAX_RULES.mutableField, node, `${typeName}[]`);
  ts.forEachChild(node, (child) => checkTypeShape(typeName, child, flag));
}

function checkClass(cls, flag) {
  const className = cls.name?.text ?? '(無名クラス)';
  for (const m of cls.members) {
    const mutable = !hasModifier(m, ts.SyntaxKind.ReadonlyKeyword);
    if (ts.isPropertyDeclaration(m) && isPublicMember(m) && mutable) {
      flag(SYNTAX_RULES.mutableField, m, `${className}.${m.name.getText()}`);
    }
    if (ts.isSetAccessorDeclaration(m)) flag(SYNTAX_RULES.mutableField, m, `${className}.${m.name.getText()}`);
    if (!ts.isConstructorDeclaration(m)) continue;
    for (const p of m.parameters) {
      const name = p.name.getText();
      if (hasModifier(p, ts.SyntaxKind.PublicKeyword) && !hasModifier(p, ts.SyntaxKind.ReadonlyKeyword)) {
        flag(SYNTAX_RULES.mutableField, p, `${className}.${name}`);
      }
      if (p.type !== undefined && mentionsSerialized(p.type)) {
        flag(SYNTAX_RULES.serializedConstructorArg, p, `${className}.constructor(${name})`);
      }
    }
  }
}

// モデル層のクラスの可変な公開欄と set アクセサ、export する型の可変な欄(R3)、コンストラクタが
// 受ける直列化された形(R12)を数える。
function findSyntaxViolations({ sources, texts }) {
  const found = [];
  for (const f of sources) {
    if (!isModel(f)) continue;
    const sf = ts.createSourceFile(f, texts.get(f), ts.ScriptTarget.Latest, true);
    const flag = (rule, node, id) => {
      if (rule.exempt.some(([file, exemptId]) => file === f && exemptId === id)) return;
      found.push({ rule: rule.name, file: f, id, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    };
    const exported = exportedNames(sf);
    const visit = (node) => {
      if (ts.isClassLike(node)) checkClass(node, flag);
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && exported.has(node.name.text)) {
        ts.forEachChild(node, (child) => checkTypeShape(node.name.text, child, flag));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
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
  const rules = [...Object.values(RULES), ...Object.values(SYNTAX_RULES), ...FORBIDDEN];
  const allowed = new Set(listed.map(keyOf));
  const unlisted = violations.filter((v) => !allowed.has(keyOf(v)));
  const live = new Set(violations.map(keyOf));
  const stale = listed.filter((v) => !live.has(keyOf(v)));
  for (const { name, ref } of rules) {
    const mine = unlisted.filter((v) => v.rule === name);
    const allowedCount = violations.filter((v) => v.rule === name && allowed.has(keyOf(v))).length;
    console.log(`${name}(${ref})— 違反 ${mine.length} 件 / 許可リスト ${allowedCount} 件`);
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
  console.log('  置き場を ARCHITECTURE R2 の対応表から選び直す。新しいフォルダが要るなら、その層をユーザーに問い、');
  console.log('  対応表と tools/check-boundaries.mjs の LAYER_TABLE へ一緒に足す。');
  ok = false;
}
const missingPresentation = MISPLACED_PRESENTATION_FILES.filter((f) => !graph.files.includes(f));
if (missingPresentation.length > 0) {
  console.log(`表示の導出として外す一覧に、存在しないパス — ${missingPresentation.length} 件`);
  for (const f of missingPresentation) console.log(`  ${f}`);
  console.log('  tools/check-boundaries.mjs の MISPLACED_PRESENTATION_FILES で、移したものは移した先へ書き換え、');
  console.log('  消したものは消す。新しいファイルを足して判定から外さない。');
  ok = false;
}
if (graph.unresolved.length > 0) {
  console.log(`解決できない相対 import — ${graph.unresolved.length} 件`);
  for (const u of graph.unresolved) console.log(`  ${u.file}:${u.line} → ${u.spec}`);
  ok = false;
}
const violations = [...findImportViolations(graph), ...findSyntaxViolations(graph), ...findPatternViolations(graph)];
if (!report(group(violations), readAllowlist())) ok = false;
if (ok) {
  console.log('\n境界の検査を通った。');
} else {
  console.log('\n境界の検査に落ちた。各判定の括弧が、その目的を書いた規則(DEVELOP/ARCHITECTURE.md・CODING-RULE.md)。');
  console.log('読んで、目的に照らしてコードを直す。規則どおりに分けられないなら、理由を書いて exempt へ例外にする。');
  console.log('規則・判定を書き換えて通さない(ARCHITECTURE.md「規則に合わないとき」)。');
}
process.exit(ok ? 0 : 1);
