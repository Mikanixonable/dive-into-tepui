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
}
