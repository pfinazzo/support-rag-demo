declare module 'three/addons/controls/OrbitControls.js' {
  import { Camera, EventDispatcher, Vector3 } from 'three';
  export class OrbitControls extends EventDispatcher {
    constructor(camera: Camera, domElement?: HTMLElement);
    enableDamping: boolean;
    enabled: boolean;
    target: Vector3;
    maxDistance: number;
    minDistance: number;
    update(): boolean;
    dispose(): void;
  }
}
declare module 'three/addons/renderers/CSS2DRenderer.js' {
  import { Camera, Object3D, Scene, Vector3 } from 'three';
  export class CSS2DObject extends Object3D {
    element: HTMLElement;
    constructor(element: HTMLElement);
  }
  export class CSS2DRenderer {
    domElement: HTMLDivElement;
    setSize(width: number, height: number): void;
    render(scene: Scene, camera: Camera): void;
  }
}
