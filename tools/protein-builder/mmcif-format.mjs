// 最小限の mmCIF ループ読み取り。RCSB が配布する _atom_site / _struct_conf /
// _struct_sheet_range のような単純な空白区切りループだけを対象とし、multi-line
// text field(セミコロン区切りの複数行値)は扱わない。

// value ',' などスペースを含む値は '...' / "..." で囲まれる。トークナイザはそれを1トークンとして扱う。
function tokenizeLine(line) {
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) index++;
    if (index >= line.length) break;
    const quote = line[index] === "'" || line[index] === '"' ? line[index] : null;
    if (quote) {
      const end = line.indexOf(quote, index + 1);
      if (end === -1) { tokens.push(line.slice(index)); break; }
      tokens.push(line.slice(index + 1, end));
      index = end + 1;
    } else {
      const start = index;
      while (index < line.length && !/\s/.test(line[index])) index++;
      tokens.push(line.slice(start, index));
    }
  }
  return tokens;
}

// categoryPrefix(例: '_atom_site.')で始まる loop_ ブロックを1つ読み、各行を
// フィールド名をキーとするオブジェクトにして返す。ブロックが無ければ空配列。
export function parseMmcifLoop(text, categoryPrefix) {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    if (lines[index].trim() === 'loop_') {
      let cursor = index + 1;
      const fields = [];
      while (cursor < lines.length && lines[cursor].trim().startsWith(categoryPrefix)) {
        fields.push(lines[cursor].trim().slice(categoryPrefix.length).trim());
        cursor++;
      }
      if (fields.length > 0) {
        const rows = [];
        while (cursor < lines.length) {
          const line = lines[cursor];
          const trimmed = line.trim();
          if (trimmed === '' || trimmed === '#' || trimmed.startsWith('loop_') || trimmed.startsWith('_') || trimmed.startsWith('data_')) break;
          const tokens = tokenizeLine(line);
          if (tokens.length >= fields.length) {
            const row = {};
            fields.forEach((field, fieldIndex) => { row[field] = tokens[fieldIndex]; });
            rows.push(row);
          }
          cursor++;
        }
        return rows;
      }
    }
    index++;
  }
  return [];
}
