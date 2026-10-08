import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const BASE = './assets/';

/** Central asset cache + loading progress. */
export class Assets {
  constructor(renderer) {
    this.renderer = renderer;
    this.manager = new THREE.LoadingManager();
    this.gltf = new GLTFLoader(this.manager);
    this.tex = new THREE.TextureLoader(this.manager);
    this.hdr = new HDRLoader(this.manager);
    this.models = {};
    this.textures = {};
    this.materialsets = {};
    this.onProgress = null;
    this.total = 0;
    this.done = 0;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
  }

  _tick(label) {
    this.done++;
    this.onProgress?.(this.done / Math.max(1, this.total), label);
  }

  async model(key, path) {
    this.total++;
    try {
      const g = await this.gltf.loadAsync(BASE + path);
      this.models[key] = g;
      return g;
    } catch (e) {
      console.error('model failed', path, e);
      return null;
    } finally { this._tick(path); }
  }

  async texture(path, srgb = true, repeat = true) {
    if (this.textures[path]) return this.textures[path];
    this.total++;
    try {
      const t = await this.tex.loadAsync(BASE + path);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, this.maxAniso);
      this.textures[path] = t;
      return t;
    } catch (e) {
      console.error('texture failed', path, e);
      return null;
    } finally { this._tick(path); }
  }

  /** PBR set from textures/<name>/{Color,NormalGL,Roughness}.jpg */
  async materialSet(name) {
    if (this.materialsets[name]) return this.materialsets[name];
    const [map, normalMap, roughnessMap] = await Promise.all([
      this.texture(`textures/${name}/Color.jpg`, true),
      this.texture(`textures/${name}/NormalGL.jpg`, false),
      this.texture(`textures/${name}/Roughness.jpg`, false),
    ]);
    const set = { map, normalMap, roughnessMap };
    this.materialsets[name] = set;
    return set;
  }

  async hdri(path) {
    this.total++;
    try {
      const t = await this.hdr.loadAsync(BASE + path);
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    } finally { this._tick(path); }
  }
}
