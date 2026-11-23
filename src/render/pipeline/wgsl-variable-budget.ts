// three が組んだ WGSL の一時変数を、WebKit の変数サイズ上限(1 関数・モジュールのそれぞれで合計
// 8192 バイト)に収まる形へ書き換える。大きなノードグラフ(大気・地表)は一時変数が数千個になり、
// 上限を超えたパイプラインは作られずに描画から消える。
//
// 書き換えるのは「1 度しか代入されず、代入と同じ block の中でだけ読まれる」変数で、宣言を消して
// 代入を `let` へ変える。意味は変わらず、行数も変わらない(宣言行は空行になる)。
import type { WebGPURenderer } from 'three/webgpu';

// three が一時変数に付ける名前。ユーザーが名付けた変数(toVar('x'))は対象にしない。
const TEMP_VARIABLE = /\bnodeVar\d+\b/g;
const TEMP_DECLARATION = /^var<private>\s+(nodeVar\d+)\s*:\s*(.+);\s*$/;

// 変数名 name への、読み取り以外の操作(部分代入・複合代入・要素代入)を検出する式。
function modificationPattern(name: string): RegExp {
  return new RegExp(`\\b${name}(\\.[a-z]+|\\[[^\\]]*\\])?\\s*([-+*/%&|^]|<<|>>)?=(?!=)`);
}

// 各行の「文が属する block」を、外側から順に並べた block 番号の列で返す。行頭の閉じ括弧は
// その行の判定より先に閉じ、行内の開き括弧は次の行から有効になる。
function blockPathsOf(lines: readonly string[]): number[][] {
  const paths: number[][] = [];
  const stack: number[] = [];
  let nextId = 1;
  for (const line of lines) {
    // 行頭の閉じ括弧を先に畳んでから、その行の文の位置を控える。
    const body = line.trimStart();
    let leadingCloses = 0;
    while (body[leadingCloses] === '}') {
      stack.pop();
      leadingCloses++;
    }
    paths.push(stack.slice());
    for (const ch of body.slice(leadingCloses)) {
      if (ch === '{') stack.push(nextId++);
      else if (ch === '}') stack.pop();
    }
  }
  return paths;
}

interface Occurrence {
  readonly line: number;
  readonly column: number;
}

// 変数名ごとの出現位置(宣言行を除く)。
function occurrencesOf(lines: readonly string[]): Map<string, Occurrence[]> {
  const occurrences = new Map<string, Occurrence[]>();
  lines.forEach((text, line) => {
    // 宣言行は出現に数えない。
    if (TEMP_DECLARATION.test(text)) return;
    for (const match of text.matchAll(TEMP_VARIABLE)) {
      const list = occurrences.get(match[0]) ?? [];
      list.push({ line, column: match.index });
      occurrences.set(match[0], list);
    }
  });
  return occurrences;
}

// WGSL ソースの一時変数のうち let へ置き換えられるものを置き換えた結果。
export function promoteSingleAssignmentVariables(code: string): string {
  const lines = code.split('\n');
  const declarations = new Map<string, { type: string; line: number }>();
  lines.forEach((text, line) => {
    const match = TEMP_DECLARATION.exec(text);
    if (match !== null) declarations.set(match[1]!, { type: match[2]!, line });
  });
  if (declarations.size === 0) return code;

  const paths = blockPathsOf(lines);
  const occurrences = occurrencesOf(lines);
  const promoted = new Map<string, { assignLine: number; type: string; declLine: number }>();

  for (const [name, declaration] of declarations) {
    const found = occurrences.get(name) ?? [];
    const assignment = new RegExp(`^\\s*${name} = `);
    const modification = modificationPattern(name);
    const assignments: Occurrence[] = [];
    let readOnlyElsewhere = true;
    for (const occurrence of found) {
      const text = lines[occurrence.line]!;
      if (assignment.test(text)) {
        assignments.push(occurrence);
      } else if (modification.test(text.slice(occurrence.column)) || text[occurrence.column - 1] === '&') {
        readOnlyElsewhere = false;
        break;
      }
    }
    if (!readOnlyElsewhere || assignments.length !== 1) continue;
    const assigned = assignments[0]!;
    // 自分自身を読む代入(x = f(x))は更新なので対象外。
    if ((lines[assigned.line]!.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length !== 1) continue;

    // すべての読み取りが、代入より後で、代入と同じ block かその内側にあること。
    const assignPath = paths[assigned.line]!;
    const readsInsideScope = found.every((occurrence) => {
      if (occurrence === assigned) return true;
      const readPath = paths[occurrence.line]!;
      return occurrence.line > assigned.line
        && readPath.length >= assignPath.length
        && assignPath.every((id, depth) => readPath[depth] === id);
    });
    if (readsInsideScope) {
      promoted.set(name, { assignLine: assigned.line, type: declaration.type, declLine: declaration.line });
    }
  }
  if (promoted.size === 0) return code;

  const declarationLines = new Set<number>();
  const assignmentOf = new Map<number, { name: string; type: string }>();
  for (const [name, entry] of promoted) {
    declarationLines.add(entry.declLine);
    assignmentOf.set(entry.assignLine, { name, type: entry.type });
  }
  return lines.map((text, line) => {
    if (declarationLines.has(line)) return '';
    const target = assignmentOf.get(line);
    if (target === undefined) return text;
    return text.replace(new RegExp(`^(\\s*)${target.name} = `), `$1let ${target.name} : ${target.type} = `);
  }).join('\n');
}

// GPUDevice のうち、この書き換えが差し込む口。
interface ShaderModuleFactory {
  createShaderModule(descriptor: { code: string }): unknown;
}

// 初期化を終えたレンダラが以後に作るシェーダモジュールのソースへ、promoteSingleAssignmentVariables を
// 掛ける。WebGL2 へ落ちたレンダラ(GPUDevice を持たない)では何もしない。最初のコンパイルより前に呼ぶこと。
export function limitShaderVariableBudget(renderer: WebGPURenderer): void {
  const device = (renderer.backend as unknown as { device?: ShaderModuleFactory }).device;
  if (device === undefined) return;
  const createShaderModule = device.createShaderModule.bind(device);
  device.createShaderModule = (descriptor) => createShaderModule({
    ...descriptor, code: promoteSingleAssignmentVariables(descriptor.code),
  });
}
