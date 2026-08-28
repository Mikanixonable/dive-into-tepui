// JSON は焼き込みアセットの入れ物で、その中身の型は実行時に validate する側が持つ。
// resolveJsonModule で tsc に読ませると、src/assets/ の 110MB を型検査のたびに構文解析する
// ことになる(protein の structure/motion だけで 94MB)ので、値の形は宣言しない。
declare module '*.json' {
  const value: unknown;
  export default value;
}
