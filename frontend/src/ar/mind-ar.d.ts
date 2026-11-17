// Ambient types for the untyped mind-ar three.js bundle (mind-ar 1.2.5 ships no .d.ts).
// Shapes mirror mind-ar/src/image-target/three.js.
declare module "mind-ar/dist/mindar-image-three.prod.js" {
  import type { Group, PerspectiveCamera, Scene, WebGLRenderer } from "three";

  export interface MindARAnchor {
    group: Group;
    targetIndex: number;
    onTargetFound: (() => void) | null;
    onTargetLost: (() => void) | null;
    onTargetUpdate: (() => void) | null;
    css: boolean;
    visible: boolean;
  }

  export interface MindARThreeOptions {
    container: HTMLElement;
    imageTargetSrc: string;
    maxTrack?: number;
    uiLoading?: "yes" | "no";
    uiScanning?: "yes" | "no";
    uiError?: "yes" | "no";
    filterMinCF?: number | null;
    filterBeta?: number | null;
    warmupTolerance?: number | null;
    missTolerance?: number | null;
    userDeviceId?: string | null;
    environmentDeviceId?: string | null;
  }

  export class MindARThree {
    constructor(options: MindARThreeOptions);
    container: HTMLElement;
    scene: Scene;
    cssScene: Scene;
    camera: PerspectiveCamera;
    renderer: WebGLRenderer;
    video?: HTMLVideoElement;
    addAnchor(targetIndex: number): MindARAnchor;
    addCSSAnchor(targetIndex: number): MindARAnchor;
    start(): Promise<void>;
    stop(): void;
    switchCamera(): void;
    resize(): void;
  }
}
