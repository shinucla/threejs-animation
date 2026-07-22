/**
 * Virtual Pixelation Granularity layer — Three.js port of engine2 VPGLayer.
 *
 * Scene renders at full resolution into an offscreen target; presentation
 * snaps UVs to a virtual-pixel grid. VPG=1 is a 1:1 passthrough; lowering
 * VPG only changes the blit quantization (3D cost stays constant).
 */
import * as THREE from 'three';

export const DEFAULT_VPG = 0.18;
export const MIN_VPG = 0.02;
export const MAX_VPG = 1.0;

export class VPGLayer {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ granularity?: number }} [options]
   */
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.granularity = clamp(options.granularity ?? DEFAULT_VPG, MIN_VPG, MAX_VPG);

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.generateMipmaps = false;
    // Scene pass already applies ACES; keep linear for a single sRGB encode on blit.
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.uniforms = {
      uVirtualPixels: { value: new THREE.Vector2(1, 1) },
      uTexelSize: { value: new THREE.Vector2(1, 1) },
    };

    // MeshBasicMaterial keeps Three color-management / output encoding correct.
    this.material = new THREE.MeshBasicMaterial({
      map: this.target.texture,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uVirtualPixels = this.uniforms.uVirtualPixels;
      shader.uniforms.uTexelSize = this.uniforms.uTexelSize;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
#include <common>
uniform vec2 uVirtualPixels;
uniform vec2 uTexelSize;
`,
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
#ifdef USE_MAP
  vec2 texSize = 1.0 / max(uTexelSize, vec2(1.0e-6));
  vec2 px = max(uVirtualPixels, vec2(1.0));
  vec2 sampleUv = vMapUv;
  // VPG=1 (or grid >= framebuffer): passthrough. Else snap to virtual pixels.
  if (!(px.x >= texSize.x - 0.5 && px.y >= texSize.y - 0.5)) {
    sampleUv = (floor(vMapUv * px) + 0.5) / px;
  }
  vec4 sampledDiffuseColor = texture2D(map, sampleUv);
  diffuseColor *= sampledDiffuseColor;
#endif
`,
        );
    };
    // Force recompile if material is reused after HMR / param changes.
    this.material.customProgramCacheKey = () => 'vpg-present';

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  getGranularity() {
    return this.granularity;
  }

  setGranularity(value) {
    this.granularity = clamp(value, MIN_VPG, MAX_VPG);
  }

  addGranularity(delta) {
    this.setGranularity(this.granularity + delta);
  }

  /** Virtual-pixel grid size for an output framebuffer. */
  virtualResolution(width, height) {
    const scale = this.granularity;
    return [
      Math.max(1, Math.floor(width * scale)),
      Math.max(1, Math.floor(height * scale)),
    ];
  }

  /**
   * Ensure the scene target matches the drawable size, then bind it.
   * @returns {[number, number]} internal width/height
   */
  beginScene(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    this.renderer.setRenderTarget(this.target);
    return [w, h];
  }

  /** Blit the scene target through the virtual-pixel shader to the canvas. */
  present(outputWidth, outputHeight) {
    const outW = Math.max(1, Math.floor(outputWidth));
    const outH = Math.max(1, Math.floor(outputHeight));
    const [vw, vh] = this.virtualResolution(outW, outH);

    this.material.map = this.target.texture;
    this.uniforms.uVirtualPixels.value.set(vw, vh);
    this.uniforms.uTexelSize.value.set(1 / this.target.width, 1 / this.target.height);

    const prevTone = this.renderer.toneMapping;
    const prevAutoClear = this.renderer.autoClear;

    this.renderer.setRenderTarget(null);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.renderer.render(this.scene, this.camera);

    this.renderer.toneMapping = prevTone;
    this.renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
