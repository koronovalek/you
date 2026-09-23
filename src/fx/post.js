import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { renderer, scene, camera, Q, FRAME } from '../core/env.js';
import { lerp } from '../core/math.js';

/* Пост-обработка: блум (ночью сильнее — фонари «дышат» в тумане), цветокор
   с ночным сдвигом в холодное и потерей насыщенности, виньетка, зерно. */
const Grade = {
  uniforms: { tDiffuse: { value: null }, uNight: { value: 0 }, uSat: { value: 1.05 }, uVig: { value: 0.25 }, uT: { value: 0 }, uHit: { value: 0 }, uWarm: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uNight, uSat, uVig, uT, uHit, uWarm; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat);
      // ночное зрение: холоднее и беднее цветом, но тёплые огни остаются тёплыми
      vec3 scot = vec3(l * 0.78, l * 0.92, l * 1.2);
      float keep = smoothstep(0.25, 0.9, l);
      c.rgb = mix(c.rgb, scot, uNight * 0.55 * (1.0 - keep));
      // лёгкий «плёночный» тон: тени в зелень, света в тепло
      c.rgb += vec3(-0.004, 0.003, -0.002) * (1.0 - l) + vec3(0.012, 0.006, -0.01) * l * uWarm;
      vec2 d = vUv - 0.5;
      c.rgb *= clamp(1.0 - dot(d, d) * uVig * 3.0, 0.0, 1.0);
      c.rgb += (h(vUv * 1000.0 + uT) - 0.5) * (0.018 + uNight * 0.02);
      // контузия: красный край и смаз
      c.rgb = mix(c.rgb, c.rgb * vec3(1.2, 0.55, 0.5), uHit * smoothstep(0.1, 0.7, length(d) * 1.4));
      gl_FragColor = c;
    }`
};
/* ---------- Лучи света сквозь кроны ----------
   Маска: открытое небо (глубина на дальней плоскости) вокруг диска солнца.
   Радиальное размытие к солнцу в половинном разрешении в два прохода даёт
   «столбы» между стволами; результат добавляется к кадру с цветом солнца.
   Тот же проход чистит NaN/Inf из HDR — одна битая точка не зальёт экран
   через блум. */
const RAYS_MASK = `
  uniform sampler2D tColor, tDepth; uniform vec2 uSun; uniform float uAspect; varying vec2 vUv;
  void main(){
    float d = texture2D(tDepth, vUv).r;
    vec3 c = texture2D(tColor, vUv).rgb;
    float sky = step(0.99995, d);
    vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
    float disk = exp(-dot(dv, dv) * 9.0) + exp(-dot(dv, dv) * 90.0) * 2.0;
    float lum = dot(min(c, vec3(8.0)), vec3(0.3, 0.5, 0.2));
    gl_FragColor = vec4(vec3(sky * disk * clamp(lum, 0.2, 2.0)), 1.0);
  }`;
const RAYS_BLUR = `
  uniform sampler2D tMask; uniform vec2 uSun; uniform float uStep; varying vec2 vUv;
  void main(){
    vec2 dir = (uSun - vUv) * uStep;
    vec2 uv = vUv; float w = 1.0, acc = 0.0, sum = 0.0;
    for (int i = 0; i < 24; i++) { acc += texture2D(tMask, uv).r * w; sum += w; w *= 0.955; uv += dir; }
    gl_FragColor = vec4(vec3(acc / sum), 1.0);
  }`;
const RAYS_COMP = `
  uniform sampler2D tColor, tRays; uniform vec3 uCol; varying vec2 vUv;
  void main(){
    vec4 c = texture2D(tColor, vUv);
    // санитайзер: NaN и бесконечности из HDR — в ноль/предел
    if (!(c.r == c.r) || !(c.g == c.g) || !(c.b == c.b)) c = vec4(0.0, 0.0, 0.0, 1.0);
    // потолок яркости по светимости (оттенок сохраняется): ни один пиксель
    // не разольётся блумом на пол-экрана
    float lm = max(max(c.r, c.g), c.b);
    if (lm > 10.0) c.rgb *= 10.0 / lm;
    float r = texture2D(tRays, vUv).r;
    c.rgb += uCol * r;
    gl_FragColor = c;
  }`;
const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
class RaysPass extends Pass {
  constructor() {
    super();
    const mk = (fs, u) => new THREE.ShaderMaterial({ uniforms: u, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });
    this.mask = mk(RAYS_MASK, { tColor: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.blur = mk(RAYS_BLUR, { tMask: { value: null }, uSun: { value: new THREE.Vector2() }, uStep: { value: 0.02 } });
    this.comp = mk(RAYS_COMP, { tColor: { value: null }, tRays: { value: null }, uCol: { value: new THREE.Color() } });
    this.quad = new FullScreenQuad(this.mask);
    const o = { type: THREE.HalfFloatType, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(4, 4, o); this.b = new THREE.WebGLRenderTarget(4, 4, o);
    this.strength = 0; this.sun = new THREE.Vector2();
  }
  setSize(w, h) { this.a.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.b.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.aspect = w / h; }
  render(r, writeBuffer, readBuffer) {
    const on = this.strength > 0.002 && readBuffer.depthTexture;
    if (on) {
      this.mask.uniforms.tColor.value = readBuffer.texture; this.mask.uniforms.tDepth.value = readBuffer.depthTexture;
      this.mask.uniforms.uSun.value.copy(this.sun); this.mask.uniforms.uAspect.value = this.aspect || 1;
      this.quad.material = this.mask; r.setRenderTarget(this.a); this.quad.render(r);
      this.blur.uniforms.uSun.value.copy(this.sun);
      this.blur.uniforms.tMask.value = this.a.texture; this.blur.uniforms.uStep.value = 0.028;
      this.quad.material = this.blur; r.setRenderTarget(this.b); this.quad.render(r);
      this.blur.uniforms.tMask.value = this.b.texture; this.blur.uniforms.uStep.value = 0.009;
      r.setRenderTarget(this.a); this.quad.render(r);
    }
    this.comp.uniforms.tColor.value = readBuffer.texture;
    this.comp.uniforms.tRays.value = this.a.texture;
    this.comp.uniforms.uCol.value.copy(this.color || new THREE.Color()).multiplyScalar(on ? this.strength : 0);
    this.quad.material = this.comp;
    r.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(r);
  }
}
export let composer, bloom, grade, smaa, rays;
export function buildPost() {
  // цель с текстурой глубины: по ней лучи отличают небо от крон
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
  rt.depthTexture.type = THREE.UnsignedIntType;
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));
  rays = new RaysPass();
  composer.addPass(rays);
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.6, 0.88);
  bloom.enabled = Q.bloom;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  grade = new ShaderPass(Grade);
  composer.addPass(grade);
  smaa = new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
  smaa.enabled = Q.smaa;
  composer.addPass(smaa);
  composer.setSize(innerWidth, innerHeight);
}
const _sp = new THREE.Vector3(), _cf = new THREE.Vector3();
export function updatePost(sky, hit) {
  // экранная позиция солнца; лучи гаснут, когда солнце за спиной или у горизонта
  _sp.copy(sky.sunDir).multiplyScalar(1000).add(camera.position).project(camera);
  camera.getWorldDirection(_cf);
  const facing = Math.max(0, _cf.dot(sky.sunDir));
  const edge = Math.max(0, 1 - Math.max(Math.abs(_sp.x), Math.abs(_sp.y)) / 1.6);
  rays.sun.set(_sp.x * 0.5 + 0.5, _sp.y * 0.5 + 0.5);
  rays.strength = Q.bloom ? Math.pow(facing, 2) * edge * Math.min(1, sky.sunDir.y * 6 + 0.2) * (1 - sky.night) * 0.22 : 0;
  rays.color = sky.sunColor;
  grade.uniforms.uNight.value = sky.night;
  grade.uniforms.uSat.value = lerp(1.06, 0.88, sky.night);
  grade.uniforms.uVig.value = lerp(0.22, 0.42, sky.night);
  grade.uniforms.uT.value = FRAME.t % 100;
  grade.uniforms.uHit.value = hit;
  grade.uniforms.uWarm.value = 1 - sky.night;
  // днём блум почти только от бликов; ночью мягче вокруг фонарей
  bloom.strength = lerp(0.14, 0.6, sky.night);
  bloom.threshold = lerp(1.6, 0.75, sky.night);
  bloom.radius = lerp(0.35, 0.55, sky.night);
}
export function resizePost() {
  composer.setSize(innerWidth, innerHeight);
  smaa.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
}
