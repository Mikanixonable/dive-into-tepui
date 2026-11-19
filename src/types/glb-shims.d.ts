// GLB / GLTF の import を、バンドラーが出力する URL として型付けする。
declare module '*.glb' {
  const url: string;
  export { url as default };
}

declare module '*.gltf' {
  const url: string;
  export { url as default };
}
