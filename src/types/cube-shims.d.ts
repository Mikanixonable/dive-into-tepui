declare module '*.cube' {
  const source: string;
  export default source;
}

interface WebpackRequireContext {
  (id: string): string;
  keys(): string[];
}

interface WebpackRequire {
  context(directory: string, useSubdirectories: boolean, regExp: RegExp): WebpackRequireContext;
}

declare const require: WebpackRequire;
