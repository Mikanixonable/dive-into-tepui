// src/ の import グラフを測る。答えるのは「あるファイルを読むために、何行ぶんのファイルを
// 開くことになるか」で、これを近傍 ctx_k と呼ぶ — ファイル f から import 辺を k 歩以内で
// 到達できるファイルの総行数(f 自身は除く)。
//
// 循環の有無ではなく近傍で測るのは、強連結成分の大きさが塊の内側の改善を原理的に測れない
// ためである。塊の中のファイルは塊の全部を推移的に引くので、責務をどう移しても推移的依存は
// 飽和したまま動かない。k=1,2,3 でだけ内側の改善が見える。k=Infinity は「塊から出たか」の
// 判定にだけ使う。
//
// 型のみの辺も1辺として数える。読む手間は import type でも値 import でも変わらないので、
// 循環を切るためだけに type を付けて辺を増やす直し方を、この指標は正しく罰する。
//
//   node tools/dep-metrics.mjs                     全体の要約
//   node tools/dep-metrics.mjs --file <path>...    指定ファイルの内訳と import 元
//   node tools/dep-metrics.mjs --top <n>           ctx2 の重い順
//   node tools/dep-metrics.mjs --against <ref>     ref の木と比べた差分
//   node tools/dep-metrics.mjs --merge <x>=<host>  面 x を実装 host へ畳んだ場合との差分
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SRC = 'src';

// import 節の識別子が全部 type 前置なら型のみの辺とみなす。値の辺だけの循環を別に数えるため。
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|[\w,\s{}]+?)?\s*(?:from\s*)?['"](\.[^'"]+)['"]/g;

// 作業木の src/ を読む。
function readWorkTree() {
  const sources = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
        sources.set(rel, readFileSync(path.join(root, rel), 'utf8'));
      }
    }
  };
  walk(SRC);
  return sources;
}

// git の ref が指す src/ を読む。cat-file --batch へ一括で流す。
function readRef(ref) {
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', ref, '--', SRC],
    { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-tree ${ref} が失敗した: ${listed.stderr}`);
  const paths = listed.stdout.split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'));
  const batch = spawnSync('git', ['cat-file', '--batch'],
    { cwd: root, input: paths.map((p) => `${ref}:${p}`).join('\n'), maxBuffer: 1 << 28 });
  const buf = batch.stdout;
  const sources = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = buf.indexOf(10, at);
    const size = Number(buf.toString('utf8', at, nl).split(' ')[2]);
    sources.set(p, buf.toString('utf8', nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return sources;
}

// import のパスを src/ の中のファイルへ解決し、辺と行数を組む。
function buildGraph(sources) {
  const files = [...sources.keys()].sort();
  const lines = new Map();
  for (const f of files) {
    const text = sources.get(f);
    const n = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    lines.set(f, n);
  }
  const edges = new Map(files.map((f) => [f, new Map()]));
  for (const f of files) {
    const dir = path.posix.dirname(f);
    for (const m of sources.get(f).matchAll(IMPORT_RE)) {
      const [, typeKeyword, clause, spec] = m;
      const base = path.posix.normalize(path.posix.join(dir, spec));
      const target = [`${base}.ts`, `${base}/index.ts`].find((c) => sources.has(c) && c !== f);
      if (target === undefined) continue;
      const names = clause === undefined ? [] : clause.split(',').map((s) => s.trim()).filter(Boolean);
      const typeOnly = typeKeyword !== undefined
        || (names.length > 0 && names.every((n) => n.startsWith('type ')));
      const kind = typeOnly ? 'type' : 'value';
      const known = edges.get(f).get(target);
      edges.get(f).set(target, known === 'value' || kind === 'value' ? 'value' : 'type');
    }
  }
  return { files, lines, edges };
}

// 面 x を実装 host へ畳んだグラフ。x を引いていた側は host を引くようになり、host は x の
// 依存と行数を吸う。「その面が別ファイルであることが何を買っているか」を測るために使う。
function mergeInto(graph, pairs) {
  const lines = new Map(graph.lines);
  const edges = new Map([...graph.edges].map(([a, b]) => [a, new Map(b)]));
  for (const [x, host] of pairs) {
    if (!edges.has(x)) throw new Error(`${x} が src/ に無い`);
    if (!edges.has(host)) throw new Error(`${host} が src/ に無い`);
    lines.set(host, lines.get(host) + lines.get(x));
    for (const [t, kind] of edges.get(x)) if (t !== host) edges.get(host).set(t, kind);
    for (const [a, outs] of edges) {
      const kind = outs.get(x);
      if (kind === undefined) continue;
      outs.delete(x);
      if (a !== host) outs.set(host, outs.get(host) ?? kind);
    }
    edges.delete(x);
    lines.delete(x);
    edges.get(host).delete(host);
  }
  return { files: graph.files.filter((f) => edges.has(f)), lines, edges };
}

function adjacency(graph, valueOnly) {
  const adj = new Map();
  for (const [a, outs] of graph.edges) {
    adj.set(a, [...outs].filter(([, k]) => !valueOnly || k === 'value').map(([t]) => t));
  }
  return adj;
}

// f から k 歩以内に到達できるファイルの数と総行数。
function neighborhood(graph, k) {
  const adj = adjacency(graph, false);
  const out = new Map();
  for (const f of graph.files) {
    const seen = new Set();
    let frontier = [f];
    for (let step = 0; step < k && frontier.length > 0; step++) {
      const next = [];
      for (const u of frontier) {
        for (const w of adj.get(u) ?? []) {
          if (w === f || seen.has(w)) continue;
          seen.add(w);
          next.push(w);
        }
      }
      frontier = next;
    }
    let sum = 0;
    for (const w of seen) sum += graph.lines.get(w);
    out.set(f, { files: seen.size, lines: sum });
  }
  return out;
}

// Tarjan。再帰だと 500 ファイルで積むので明示スタックで回す。
function stronglyConnected(graph, valueOnly) {
  const adj = adjacency(graph, valueOnly);
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const start of graph.files) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [u, pi] = frame;
      if (pi === 0) {
        index.set(u, counter);
        low.set(u, counter);
        counter++;
        stack.push(u);
        onStack.add(u);
      }
      const succ = adj.get(u) ?? [];
      let descended = false;
      for (let i = pi; i < succ.length; i++) {
        const w = succ[i];
        if (!index.has(w)) {
          frame[1] = i + 1;
          work.push([w, 0]);
          descended = true;
          break;
        }
        if (onStack.has(w)) low.set(u, Math.min(low.get(u), index.get(w)));
      }
      if (descended) continue;
      if (low.get(u) === index.get(u)) {
        const component = [];
        for (;;) {
          const w = stack.pop();
          onStack.delete(w);
          component.push(w);
          if (w === u) break;
        }
        components.push(component);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(u)));
      }
    }
  }
  return components.filter((c) => c.length > 1).sort((a, b) => b.length - a.length);
}

function at(sorted, ratio) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  return {
    median: at(sorted, 0.5),
    p90: at(sorted, 0.9),
    mean: Math.floor(total / sorted.length),
    max: sorted[sorted.length - 1],
    total,
  };
}

function summary(graph) {
  let edgeCount = 0;
  let valueCount = 0;
  for (const outs of graph.edges.values()) {
    for (const kind of outs.values()) {
      edgeCount++;
      if (kind === 'value') valueCount++;
    }
  }
  const ctx = {};
  for (const k of [1, 2, 3]) ctx[k] = neighborhood(graph, k);
  return {
    files: graph.files.length,
    edges: edgeCount,
    valueEdges: valueCount,
    typeEdges: edgeCount - valueCount,
    srcLines: [...graph.lines.values()].reduce((s, v) => s + v, 0),
    sccAll: stronglyConnected(graph, false).map((c) => c.length),
    sccValue: stronglyConnected(graph, true).map((c) => c.length),
    ctx,
  };
}

function printSummary(s, label) {
  if (label !== undefined) console.log(`--- ${label}`);
  console.log(`files ${s.files}  edges ${s.edges} (value ${s.valueEdges} / type ${s.typeEdges})  srcLines ${s.srcLines}`);
  console.log(`SCC 全辺   : ${s.sccAll.join(', ') || 'なし'}`);
  console.log(`SCC 値の辺 : ${s.sccValue.join(', ') || 'なし'}`);
  for (const k of [1, 2, 3]) {
    const l = stats([...s.ctx[k].values()].map((v) => v.lines));
    const f = stats([...s.ctx[k].values()].map((v) => v.files));
    console.log(`ctx${k} 行数 中央値 ${l.median}  平均 ${l.mean}  p90 ${l.p90}  最大 ${l.max}`);
    console.log(`ctx${k} 件数 中央値 ${f.median}  平均 ${f.mean}  p90 ${f.p90}  最大 ${f.max}`);
  }
}

function diffLine(name, before, after) {
  const d = after - before;
  return `${name}: ${before} -> ${after} (${d >= 0 ? '+' : ''}${d})`;
}

function printDiff(a, b, labelA, labelB) {
  console.log(`--- ${labelA} -> ${labelB}`);
  console.log(diffLine('files', a.files, b.files));
  console.log(diffLine('edges', a.edges, b.edges));
  console.log(diffLine('type edges', a.typeEdges, b.typeEdges));
  console.log(`SCC 全辺  : ${a.sccAll.join(', ')} -> ${b.sccAll.join(', ')}`);
  console.log(`SCC 値の辺: ${a.sccValue.join(', ')} -> ${b.sccValue.join(', ')}`);
  for (const k of [1, 2, 3]) {
    const sa = stats([...a.ctx[k].values()].map((v) => v.lines));
    const sb = stats([...b.ctx[k].values()].map((v) => v.lines));
    console.log(`${diffLine(`ctx${k} 中央値`, sa.median, sb.median)}   ${diffLine('平均', sa.mean, sb.mean)}   ${diffLine('p90', sa.p90, sb.p90)}`);
  }
  const rows = [];
  for (const f of b.ctx[2].keys()) {
    if (!a.ctx[2].has(f)) continue;
    rows.push([b.ctx[2].get(f).lines - a.ctx[2].get(f).lines, a.ctx[2].get(f).lines, b.ctx[2].get(f).lines, f]);
  }
  rows.sort((x, y) => x[0] - y[0]);
  const improved = rows.filter((r) => r[0] < 0).length;
  const worsened = rows.filter((r) => r[0] > 0).length;
  console.log(`ctx2: 改善 ${improved} / 悪化 ${worsened} / 不変 ${rows.length - improved - worsened} / 新設 ${b.files - rows.length}`);
  console.log('ctx2 改善の上位:');
  for (const [d, x, y, f] of rows.slice(0, 10)) console.log(`  ${String(d).padStart(8)}  ${x} -> ${y}  ${f}`);
  const tail = rows.slice(-10).filter((r) => r[0] > 0);
  if (tail.length > 0) {
    console.log('ctx2 悪化の上位:');
    for (const [d, x, y, f] of tail.reverse()) console.log(`  ${String(`+${d}`).padStart(8)}  ${x} -> ${y}  ${f}`);
  }
}

function printFiles(graph, targets) {
  const ctx = [1, 2, 3].map((k) => neighborhood(graph, k));
  for (const f of targets) {
    if (!graph.edges.has(f)) {
      console.log(`${f}: src/ に無い`);
      continue;
    }
    const importers = graph.files.filter((a) => graph.edges.get(a).has(f));
    const valueImporters = importers.filter((a) => graph.edges.get(a).get(f) === 'value');
    console.log(`=== ${f}`);
    console.log(`  行数 ${graph.lines.get(f)}  import 先 ${graph.edges.get(f).size}  import 元 ${importers.length} (うち値 ${valueImporters.length})`);
    console.log(`  ctx1 ${ctx[0].get(f).lines} 行 / ${ctx[0].get(f).files} 件`
      + `   ctx2 ${ctx[1].get(f).lines} 行 / ${ctx[1].get(f).files} 件`
      + `   ctx3 ${ctx[2].get(f).lines} 行 / ${ctx[2].get(f).files} 件`);
    for (const a of importers) console.log(`  <- ${graph.edges.get(a).get(f).padEnd(5)} ${a}`);
  }
}

const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1];
};
const rest = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? [] : args.slice(i + 1).filter((a) => !a.startsWith('--'));
};

const graph = buildGraph(readWorkTree());
const against = take('--against');
const merge = rest('--merge');
const fileArgs = rest('--file');
const top = take('--top');

if (against !== null) {
  printDiff(summary(buildGraph(readRef(against))), summary(graph), against, '作業木');
} else if (merge.length > 0) {
  const pairs = merge.map((a) => {
    const [x, host] = a.split('=');
    return [x.replaceAll('\\', '/'), host.replaceAll('\\', '/')];
  });
  printDiff(summary(graph), summary(mergeInto(graph, pairs)), '作業木', `畳んだ場合 (${merge.join(' ')})`);
} else if (fileArgs.length > 0) {
  printFiles(graph, fileArgs.map((f) => f.replaceAll('\\', '/')));
} else if (top !== null) {
  const ctx2 = neighborhood(graph, 2);
  const rows = [...ctx2].sort((a, b) => b[1].lines - a[1].lines).slice(0, Number(top));
  for (const [f, v] of rows) console.log(`${String(v.lines).padStart(7)} ${String(v.files).padStart(4)}  ${f}`);
} else {
  printSummary(summary(graph));
}
