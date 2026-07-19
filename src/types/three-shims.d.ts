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
    autoClear: boolean;
    clear(): void;
    setViewport(x: number, y: number, width: number, height: number): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    setScissorTest(enable: boolean): void;
  }
  export class MeshStandardNodeMaterial extends import('three').MeshStandardMaterial {
    constructor(parameters?: import('three').MeshStandardMaterialParameters);
    colorNode: unknown;
  }
  export class MeshBasicNodeMaterial extends import('three').MeshBasicMaterial {
    constructor(parameters?: import('three').MeshBasicMaterialParameters);
    colorNode: unknown;
    opacityNode: unknown;
  }
}

// TSL (Three Shading Language) ノード関数群。型定義が未整備なため、ノード値は
// すべて any(メソッドチェーンで .mul()/.add() 等を自由に呼べる TSL 独自のプロキシ
// オブジェクトのため、個別に型付けする実益が薄い)で緩く扱う。
declare module 'three/tsl' {
  type Node = any;
  export const texture: (map: import('three').Texture, uvNode?: Node) => Node;
  export const uv: () => Node;
  export const mix: (a: Node, b: Node, t: Node) => Node;
  export const vec2: (x: Node | number, y: Node | number) => Node;
  export const vec3: (x: Node | number, y: Node | number, z: Node | number) => Node;
  export const float: (x: number) => Node;
  export const uniform: (value: import('three').Vector3 | number) => Node & { value: import('three').Vector3 | number };
  export const normalWorld: Node;
  export const positionWorld: Node;
  export const cameraPosition: Node;
  export const dot: (a: Node, b: Node) => Node;
  export const max: (a: Node, b: Node | number) => Node;
  export const min: (a: Node, b: Node | number) => Node;
  export const exp: (a: Node) => Node;
  export const sqrt: (a: Node) => Node;
  export const select: (cond: Node, a: Node, b: Node) => Node;
  export const and: (a: Node, b: Node) => Node;
  export const greaterThan: (a: Node, b: Node | number) => Node;
  export const lessThan: (a: Node, b: Node | number) => Node;
  export const normalize: (a: Node) => Node;
  export const length: (a: Node) => Node;
  export const sub: (a: Node, b: Node) => Node;
  export const clamp: (value: Node, low?: number, high?: number) => Node;
}
