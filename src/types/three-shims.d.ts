// three.js のこのバージョンは型定義を同梱しておらず、@types/three もWebGPU
// レンダラーをまだ十分にカバーしていないため、暫定的にモジュール型を緩めておく。
// 将来three本体または@types/threeがWebGPU向け型を整備したら削除する。
declare module 'three/webgpu' {
  export * from 'three';
  export class WebGPURenderer {
    constructor(parameters?: Record<string, unknown>);
    domElement: HTMLCanvasElement;
    init(): Promise<void>;
    setPixelRatio(ratio: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: import('three').Scene, camera: import('three').Camera): void;
  }
  export class MeshStandardNodeMaterial extends import('three').MeshStandardMaterial {
    constructor(parameters?: import('three').MeshStandardMaterialParameters);
    colorNode: unknown;
  }
}

// TSL (Three Shading Language) ノード関数群。型定義が未整備なため any で緩く扱う。
declare module 'three/tsl' {
  export const texture: (map: import('three').Texture, uvNode?: unknown) => any;
  export const uv: () => any;
  export const mix: (a: unknown, b: unknown, t: unknown) => any;
  export const vec2: (x: number, y: number) => any;
  export const vec3: (x: number, y: number, z: number) => any;
}
