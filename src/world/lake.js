import * as THREE from 'three';
import { scene, camera, renderer, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { rng, TAU, lerp, smoothstep, fbm } from '../core/math.js';
import { MAP, lakeRho, lakeContour, lakeXZ, terrainH, ISLAND, pathInfluence, trenchDist, keep, CLUSTERS } from './layout.js';
import { M, TEX, addTranslucency } from '../gen/materials.js';
import { injectWind, WIND } from './wind.js';
import { addBox, addSoft } from '../core/colliders.js';
import { PERF } from '../core/perf.js';

/* ============================================================================
   ОЗЕРО
   Лесное озеро с тёмной «чайной» водой: отражение леса и неба (зеркальная
   камера с косой плоскостью отсечения), френель, блик солнца, рябь от ветра
   и кольца от взрывов. Берег — камыш с рогозом, у кромки — кувшинки.
============================================================================ */
export const LAKE = { mesh: null, mat: null, ripples: [], mirror: null };

const WATER_VS = /* glsl */`
  attribute float aDepth;
  uniform mat4 uTexMat;
  varying vec3 vW; varying vec4 vRUV; varying float vDepth;
  #include <fog_pars_vertex>
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vDepth = aDepth;
    vRUV = uTexMat * vec4(position, 1.0);
    vec4 mvPosition = viewMatrix * w;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
/* Торфяное лесное озеро. Цвет — не «краска», а свет, прошедший сквозь толщу:
   на мелководье видно дно (поглощение по Бугеру — Ламберту по длине луча),
   на глубине — чёрно-чайная вода, в которой отражается лес. Рябь — четыре
   октавы нормалей по ветру; «кошачьи лапки» — пятна ряби, бегущие с порывами.
   У берега — ряска и мокрая кромка, на солнце — дорожка бликов и искры. */
const WATER_FS = /* glsl */`
  uniform sampler2D tRefl, tNormal;
  uniform float uTime, uHasRefl, uNight, uWind, uGust;
  uniform vec2 uWindDir;
  uniform vec3 uSunDir, uSunCol, uSky, uDeep, uShallow, uMoonDir, uWeed;
  uniform vec4 uRip[8];
  varying vec3 vW; varying vec4 vRUV; varying float vDepth;
  #include <common>
  #include <fog_pars_fragment>
  float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh(i), wh(i + vec2(1, 0)), f.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), f.x), f.y); }
  float lakeRhoW(vec2 p) {
    float u = (p.x + p.y) * 0.70710678, v = (p.x - p.y) * 0.70710678;
    float ph = atan(v, u);
    float w = 1.0 + 0.07 * sin(2.0 * ph + 1.1) + 0.05 * sin(4.0 * ph + 2.3) + 0.03 * sin(6.0 * ph + 0.7);
    return length(vec2(u / 36.0, v / 21.0)) / w;
  }
  vec2 nrm(vec2 uv){ return texture2D(tNormal, uv).xy * 2.0 - 1.0; }
  void main(){
    vec2 uv = vW.xz;
    vec2 wd = uWindDir;
    vec2 wp = vec2(-wd.y, wd.x);
    float t = uTime;
    // пятна ряби бегут по ветру: там, где порыв касается воды, она темнеет и мельчит
    vec2 gq = uv * 0.06 - wd * t * 0.09;
    float paws = smoothstep(0.42, 0.78, wn(gq) * 0.65 + wn(gq * 2.3 + 5.1) * 0.35);
    float calm = 0.12 + uWind * 0.4;
    float rough = calm * (0.35 + paws * (0.9 + uGust * 0.8));
    vec2 s1 = nrm(uv * 0.045 + wd * t * 0.012 + wp * t * 0.003);
    vec2 s2 = nrm(uv * 0.11 - wp * t * 0.01 + wd * t * 0.017);
    vec2 s3 = nrm(uv * 0.33 + wd * t * 0.05);
    vec2 s4 = nrm(uv * 0.9 + wd * t * 0.11 + wp * t * 0.03);
    vec2 slope = (s1 * 0.5 + s2 * 0.4) * (0.025 + rough * 0.1) + (s3 * 0.5 + s4 * 0.35) * rough * 0.28;
    // кольца: взрывы, дрон, рыба, шаги вброд
    for (int i = 0; i < 8; i++) {
      vec4 r = uRip[i];
      float age = t - r.z;
      if (age < 0.0 || age > 7.0 || r.w <= 0.0) continue;
      vec2 d = uv - r.xy; float dist = length(d);
      float front = age * (1.2 + r.w * 2.2);
      float x = dist - front;
      float ring = sin(x * (9.0 - r.w * 3.0)) * exp(-x * x * (2.5 / (0.3 + r.w))) * exp(-age * 0.55) * min(r.w, 1.5);
      ring *= smoothstep(0.0, 0.25, dist);
      slope += (dist > 0.01 ? d / dist : vec2(0.0)) * ring * 0.55;
    }
    float rho = lakeRhoW(uv);
    // ряска и пыльца в заводях у берега и в камыше
    float weedN = wn(uv * 0.35 + 3.0) * 0.6 + wn(uv * 1.3) * 0.4;
    float weed = smoothstep(0.86, 0.97, rho) * smoothstep(0.52, 0.7, weedN) * (1.0 - smoothstep(0.35, 0.6, vDepth));
    slope *= 1.0 - weed * 0.85;
    vec3 n = normalize(vec3(slope.x, 1.0, slope.y));
    vec3 V = normalize(cameraPosition - vW);
    float ndv = max(dot(V, n), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
    vec3 refl = uSky;
    if (uHasRefl > 0.5) {
      vec4 ruv = vRUV; ruv.xy += slope * 0.07 * ruv.w;
      refl = texture2DProj(tRefl, ruv).rgb;
    }
    // толща воды вдоль луча зрения: у берега прозрачно, на глубине — чёрный чай
    float thick = vDepth / max(ndv, 0.12);
    vec3 absorb = vec3(0.55, 0.9, 1.6);
    vec3 T3 = exp(-thick * absorb * 1.35);
    float T = dot(T3, vec3(0.3, 0.5, 0.2));
    vec3 scatter = mix(uShallow, uDeep, smoothstep(0.1, 2.2, vDepth));
    vec3 body = scatter * (1.0 - T);
    // солнце: широкий блик-дорожка и острые искры на гребнях
    vec3 H = normalize(uSunDir + V);
    float ndh = max(dot(n, H), 0.0);
    float sunUp = step(0.0, uSunDir.y);
    float spec = pow(ndh, 900.0) * 9.0 + pow(ndh, 90.0) * 0.35 * (0.3 + rough);
    float sparkle = step(0.9985, ndh) * step(0.72, wh(floor(uv * 14.0) + floor(t * 9.0)));
    vec3 sun = uSunCol * (spec + sparkle * 14.0 * rough) * sunUp * (1.0 - weed);
    vec3 Hm = normalize(uMoonDir + V);
    sun += vec3(0.55, 0.65, 0.85) * pow(max(dot(n, Hm), 0.0), 600.0) * 2.2 * uNight * step(0.0, uMoonDir.y);
    // композиция: отражение по Френелю поверх света из толщи; альфа пропускает дно
    float F = clamp(fres * (1.0 - weed * 0.8), 0.0, 1.0);
    float a = 1.0 - (1.0 - F) * T;
    vec3 col = (refl * F + (1.0 - F) * body) / max(a, 0.001);
    vec3 weedCol = uWeed * (0.75 + 0.5 * wn(uv * 6.0));
    col = mix(col, weedCol, weed * 0.85);
    a = max(a, weed * 0.9);
    col += sun / max(a, 0.2);
    // мокрая кромка: тонкая светлая линия, дышит вместе с рябью
    float edge = 1.0 - smoothstep(0.0, 0.06, vDepth);
    float lap = 0.5 + 0.5 * sin(vDepth * 90.0 - t * 1.8 + wn(uv * 0.8) * 6.0);
    col = mix(col, uSky * 0.55 + uShallow, edge * lap * 0.35);
    a *= smoothstep(-0.015, 0.05, vDepth);
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/** Зеркальная камера — та же логика, что у Reflector из three/addons, но с
    исключением травы и частиц: их отражение не видно, а кадр дорогой. */
function makeMirror(size) {
  const rt = new THREE.WebGLRenderTarget(size, Math.round(size * 0.6), { type: THREE.HalfFloatType, samples: 0 });
  const vcam = new THREE.PerspectiveCamera();
  const texMat = new THREE.Matrix4();
  const plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
  const n = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), camPos = new THREE.Vector3();
  const view = new THREE.Vector3(), target = new THREE.Vector3(), look = new THREE.Vector3(), rot = new THREE.Matrix4();
  let frame = 0;
  return {
    rt, texMat,
    render(mesh) {
      pos.set(0, MAP.WATER_Y, 0);
      camPos.setFromMatrixPosition(camera.matrixWorld);
      view.subVectors(pos, camPos);
      if (view.dot(n) > 0) return;               // камера под водой
      // на среднем качестве и при нехватке кадра — через кадр (рябь скрывает задержку)
      if ((Q.refl < 500 || PERF.low) && (frame++ & 1)) return;
      view.reflect(n).negate().add(pos);
      rot.extractRotation(camera.matrixWorld);
      look.set(0, 0, -1).applyMatrix4(rot).add(camPos);
      target.subVectors(pos, look).reflect(n).negate().add(pos);
      vcam.position.copy(view);
      vcam.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
      vcam.lookAt(target);
      vcam.far = Math.min(camera.far, 800);
      vcam.updateMatrixWorld();
      vcam.projectionMatrix.copy(camera.projectionMatrix);
      texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      texMat.multiply(vcam.projectionMatrix).multiply(vcam.matrixWorldInverse).multiply(mesh.matrixWorld);
      plane.setFromNormalAndCoplanarPoint(n, pos).applyMatrix4(vcam.matrixWorldInverse);
      clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      const P = vcam.projectionMatrix.elements;
      q.x = (Math.sign(clip.x) + P[8]) / P[0]; q.y = (Math.sign(clip.y) + P[9]) / P[5]; q.z = -1; q.w = (1 + P[10]) / P[14];
      clip.multiplyScalar(2 / clip.dot(q));
      P[2] = clip.x; P[6] = clip.y; P[10] = clip.z + 1 - 0.003; P[14] = clip.w;
      mesh.visible = false;
      const hidden = NO_REFLECT.filter(o => o.visible);
      for (const o of hidden) o.visible = false;
      const prevRT = renderer.getRenderTarget(), prevAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.state.buffers.depth.setMask(true);
      renderer.clear();
      renderer.render(scene, vcam);
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = prevAuto;
      for (const o of hidden) o.visible = true;
      mesh.visible = true;
    }
  };
}

function waterGeometry() {
  const rings = 26, segs = 128, pos = [], depth = [], idx = [];
  pos.push(0, 0, 0); depth.push(MAP.WATER_Y - terrainH(0, 0));
  for (let r = 1; r <= rings; r++) {
    const k = Math.pow(r / rings, 0.8) * 1.16;
    for (let s = 0; s < segs; s++) {
      const [cx, cz] = lakeContour(s / segs * TAU, 0);
      const x = cx * k, z = cz * k;
      pos.push(x, 0, z); depth.push(MAP.WATER_Y - terrainH(x, z));
    }
  }
  for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + (s + 1) % segs);
  for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = 1 + (r - 1) * segs + s, b = 1 + (r - 1) * segs + (s + 1) % segs, c = a + segs, d = b + segs;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(depth, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildLake() {
  const mirror = Q.refl ? makeMirror(Q.refl) : null;
  LAKE.mirror = mirror;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    tRefl: { value: null }, tNormal: { value: TEX.water }, uTexMat: { value: new THREE.Matrix4() },
    uTime: { value: 0 }, uHasRefl: { value: mirror ? 1 : 0 }, uNight: { value: 0 }, uWind: { value: 0.5 }, uGust: { value: 0.5 },
    uWindDir: { value: new THREE.Vector2(1, 0) }, uWeed: { value: new THREE.Color(0.05, 0.075, 0.018) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 1, 1) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uSky: { value: new THREE.Color(0.5, 0.6, 0.7) }, uDeep: { value: new THREE.Color(0.012, 0.018, 0.014) },
    uShallow: { value: new THREE.Color(0.06, 0.055, 0.035) },
    uRip: { value: [0, 1, 2, 3, 4, 5, 6, 7].map(() => new THREE.Vector4(0, 0, -99, 0)) }
  }]);
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS, transparent: true, fog: true, depthWrite: true });
  mat.uniforms.tNormal.value = TEX.water;
  if (mirror) { mat.uniforms.tRefl.value = mirror.rt.texture; mat.uniforms.uTexMat.value = mirror.texMat; }
  const mesh = new THREE.Mesh(waterGeometry(), mat);
  mesh.position.y = MAP.WATER_Y;
  mesh.renderOrder = 2;
  mesh.name = 'lake';
  if (mirror) mesh.onBeforeRender = () => mirror.render(mesh);
  scene.add(mesh);
  LAKE.mesh = mesh; LAKE.mat = mat;
  buildReeds();
  buildLilies();
  buildPiers();
  buildIsland();
}

export function addRipple(x, z, strength = 1) {
  const u = LAKE.mat?.uniforms.uRip.value;
  if (!u) return;
  let slot = u[0];
  for (const r of u) if (r.z < slot.z) slot = r;
  slot.set(x, z, FRAME.t, strength);
}

/* ---------- Камыш и рогоз ----------
   Пучок — настоящие листья-ленты (без текстуры и альфа-теста) плюс стебли рогоза
   с бархатными початками. Заросли стоят не только по урезу, но и в воде до
   глубины ~0.9 м — плотными куртинами, между которыми остаются чистые «окна». */
function reedClump(R, cattail) {
  const pos = [], nrm = [], col = [], idx = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = R() * TAU, r = Math.sqrt(R()) * 0.28, ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const face = R() * TAU, fx = Math.cos(face), fz = Math.sin(face);
    const h = R.range(1.1, 2.3), w = R.range(0.02, 0.035), lean = R.range(0.1, 0.5), dry = R() < 0.25;
    const segs = 4, base = pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs, bend = lean * t * t;
      const cx = ox + fx * bend * h * 0.5, cz = oz + fz * bend * h * 0.5, y = t * h - bend * h * 0.15;
      const ww = w * (1 - t * 0.92);
      const g = dry ? [0.55 + t * 0.2, 0.48 + t * 0.12, 0.25] : [0.2 + t * 0.2, 0.3 + t * 0.2, 0.08 + t * 0.06];
      const ao = 0.45 + t * 0.55;
      for (const sgn of [-1, 1]) {
        pos.push(cx - fz * ww * sgn, y, cz + fx * ww * sgn);
        nrm.push(fx * 0.5, 0.8, fz * 0.5);
        col.push(g[0] * ao, g[1] * ao, g[2] * ao);
      }
    }
    for (let k = 0; k < segs; k++) { const i = base + k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  }
  if (cattail) {
    // стебель рогоза и початок (шестигранник)
    const n = R.int(1, 3);
    for (let c = 0; c < n; c++) {
      const ox = R.range(-0.15, 0.15), oz = R.range(-0.15, 0.15), h = R.range(1.8, 2.5), tilt = R.range(-0.05, 0.05);
      let base = pos.length / 3;
      for (const [y, ww] of [[0, 0.012], [h, 0.006]]) for (const sgn of [-1, 1]) {
        pos.push(ox + ww * sgn + tilt * y, y, oz); nrm.push(0, 0.3, 1); col.push(0.3, 0.36, 0.14);
      }
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      base = pos.length / 3;
      const y0 = h * 0.72, y1 = h * 0.86, rr = 0.032, cx = ox + tilt * (y0 + y1) / 2;
      for (let k = 0; k <= 1; k++) for (let j = 0; j < 6; j++) {
        const an = j / 6 * TAU, nx = Math.cos(an), nz = Math.sin(an);
        pos.push(cx + nx * rr, k ? y1 : y0, oz + nz * rr); nrm.push(nx, 0.1, nz); col.push(0.26, 0.15, 0.08);
      }
      for (let j = 0; j < 6; j++) { const a0 = base + j, a1 = base + (j + 1) % 6; idx.push(a0, a0 + 6, a1, a1, a0 + 6, a1 + 6); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
export const REEDS = [];
const _zm = new THREE.Matrix4().makeScale(0, 0, 0);
/** Взрыв у воды: камыш в радиусе срезает. */
export function shredReeds(x, z, r) {
  const out = [];
  if (lakeRho(x, z) > 1.35) return out;
  const dirty = new Set();
  for (const e of REEDS) {
    if (e.gone || Math.abs(e.x - x) > r || Math.abs(e.z - z) > r || Math.hypot(e.x - x, e.z - z) > r) continue;
    e.gone = true; e.im.setMatrixAt(e.i, _zm); dirty.add(e.im);
    if (e.soft) e.soft.dead = true;
    out.push({ x: e.x, z: e.z, kind: 'reed' });
  }
  for (const im of dirty) im.instanceMatrix.needsUpdate = true;
  return out;
}
function buildReeds() {
  const R = rng(5150);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
  mat.emissive = new THREE.Color(0x060a03);
  injectWind(mat, { amp: 0.4, stiff: 1.6, refH: 2.2, flutter: 0.05, trample: true, blast: 1.3 });
  addTranslucency(mat, 0.9);
  M.reedBlades = mat;
  const geos = [reedClump(R, false), reedClump(R, true), reedClump(R, false), reedClump(R, true)];
  const pts = [];
  for (let k = 0; k < 60000 && pts.length < 5200; k++) {
    const phi = R() * TAU, rr = R.range(0.8, 1.08);
    const [cx, cz] = lakeContour(phi, 0);
    const x = cx * rr + R.range(-1, 1), z = cz * rr + R.range(-1, 1);
    const rho = lakeRho(x, z);
    if (rho < 0.8 || rho > 1.08) continue;
    const depth = MAP.WATER_Y - terrainH(x, z);
    if (depth > 0.95) continue;
    // куртины: в воде плотнее, на берегу реже; окна чистой воды между ними
    const patch = fbm(x * 0.07 + 3, z * 0.07 - 5, 3);
    if (patch < (depth > 0.05 ? 0.44 : 0.52)) continue;
    if (pathInfluence(x, z, 2.5) > 0 || trenchDist(x, z) < 2) continue;
    if (nearPier(x, z, 3.2)) continue;
    pts.push([x, z]);
  }
  for (let k = 0; k < 300; k++) {
    const a = R() * TAU, r = R.range(ISLAND.r - 1.5, ISLAND.r + 1.2);
    pts.push([ISLAND.x + Math.cos(a) * r, ISLAND.z + Math.sin(a) * r]);
  }
  // плитки по 24 м: отсечение по пирамиде работает
  const tiles = new Map();
  for (const p of pts) {
    const k = Math.floor(p[0] / 24) * 1024 + Math.floor(p[1] / 24) + 1e6 * Math.floor(R() * geos.length);
    if (!tiles.has(k)) tiles.set(k, []);
    tiles.get(k).push(p);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  for (const [k, list] of tiles) {
    const im = new THREE.InstancedMesh(geos[Math.floor(k / 1e6)], mat, list.length);
    list.forEach(([x, z], i) => {
      const gy = terrainH(x, z), inWater = gy < MAP.WATER_Y;
      const y = gy - 0.08;
      const h = R.range(0.75, 1.15) * (inWater ? 1.1 : 0.85);
      p.set(x, y, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); s.set(R.range(0.8, 1.3), h, R.range(0.8, 1.3));
      m.compose(p, q, s); im.setMatrixAt(i, m);
      const v = R.range(0.8, 1.15); c.setRGB(v, v, v * 0.9); im.setColorAt(i, c);
      REEDS.push({ x, z, im, i, soft: addSoft(x, z, 0.45 * s.x, y, y + 2 * h, 'reed') });
    });
    im.receiveShadow = true; im.castShadow = Q.shadowTrees; im.frustumCulled = true;
    im.computeBoundingSphere();
    im.name = 'reeds';
    scene.add(im);
  }
}
function mergeSimple(geos) {
  const pos = [], nrm = [], uv = [], idx = [];
  let off = 0;
  for (const g of geos) {
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uv.push(...g.attributes.uv.array);
    for (const i of g.index.array) idx.push(i + off);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

/* ---------- Кувшинки и кубышки ----------
   Листья с вырезом покачиваются на ряби; местами — белые цветы кувшинки
   (два венчика лепестков) и жёлтые шарики кубышки. */
export const LILY = { u: { uTime: { value: 0 } } };
function lilyFlowerGeo(white) {
  const pos = [], nrm = [], col = [], idx = [];
  const rings = white ? [[10, 0.07, 0.55, 0.0], [8, 0.05, 0.95, 0.35]] : [[6, 0.03, 1.2, 0.0]];
  for (const [n, L, lift, rot] of rings) for (let i = 0; i < n; i++) {
    const a = (i + rot) / n * TAU, ca = Math.cos(a), sa = Math.sin(a), pa = [-sa, ca];
    const base = pos.length / 3;
    const tipX = ca * L, tipZ = sa * L, tipY = L * lift + 0.01, w = L * (white ? 0.32 : 0.6);
    pos.push(0, 0.012, 0, tipX * 0.5 + pa[0] * w, tipY * 0.5 + 0.01, tipZ * 0.5 + pa[1] * w, tipX, tipY, tipZ, tipX * 0.5 - pa[0] * w, tipY * 0.5 + 0.01, tipZ * 0.5 - pa[1] * w);
    for (let k = 0; k < 4; k++) nrm.push(ca * 0.3, 0.9, sa * 0.3);
    const cc = white ? [1.0, 0.98, 0.93] : [0.95, 0.72, 0.1];
    col.push(cc[0] * 0.8, cc[1] * 0.75, cc[2] * 0.6, ...cc, ...cc, ...cc);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // жёлтая середина
  const base = pos.length / 3;
  pos.push(0, 0.03, 0); nrm.push(0, 1, 0); col.push(1, 0.75, 0.15);
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; pos.push(Math.cos(a) * 0.018, 0.02, Math.sin(a) * 0.018); nrm.push(0, 1, 0); col.push(0.9, 0.62, 0.1); }
  for (let i = 0; i < 6; i++) idx.push(base, base + 1 + i, base + 1 + (i + 1) % 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
/** Покачивание на ряби: лист поднимается и наклоняется вместе с водой. */
function bob(mat) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTime = LILY.u.uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec3 r0 = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float ph = dot(r0.xz, vec2(0.7, 0.9));
        transformed.y += sin(uTime * 1.3 + ph) * 0.012 + (transformed.x * sin(uTime * 1.1 + ph) + transformed.z * cos(uTime * 0.9 + ph)) * 0.05;
      }`);
  };
  mat.customProgramCacheKey = () => 'lily-bob';
  return mat;
}
function buildLilies() {
  const R = rng(6161);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  for (let i = 0; i <= 24; i++) { const a = 0.3 + i / 24 * (TAU - 0.6); shape.lineTo(Math.cos(a) * 0.22, Math.sin(a) * 0.22); }
  shape.lineTo(0, 0);
  const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2);
  const mat = bob(new THREE.MeshStandardMaterial({ color: 0x3c5a26, roughness: 0.32, side: THREE.DoubleSide }));
  const pts = [];
  for (let k = 0; k < 20000 && pts.length < 1100; k++) {
    const phi = R() * TAU, rr = R.range(0.62, 0.93);
    const [cx, cz] = lakeContour(phi, 0);
    const x = cx * rr + R.range(-0.8, 0.8), z = cz * rr + R.range(-0.8, 0.8);
    const depth = MAP.WATER_Y - terrainH(x, z);
    if (depth < 0.35 || depth > 2.6) continue;
    if (fbm(x * 0.12 + 11, z * 0.12, 2) < 0.53 || nearPier(x, z, 2)) continue;
    pts.push([x, z]);
  }
  const im = new THREE.InstancedMesh(g, mat, pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  const flowers = [[], []];
  pts.forEach(([x, z], i) => {
    const sc = R.range(0.6, 1.5);
    p.set(x, MAP.WATER_Y + 0.008, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); s.set(sc, 1, sc);
    m.compose(p, q, s); im.setMatrixAt(i, m);
    const v = R.range(0.7, 1.25); c.setRGB(v * R.range(0.9, 1.2), v, v * 0.8); im.setColorAt(i, c);
    if (R() < 0.13) flowers[R() < 0.7 ? 0 : 1].push([x + R.range(-0.1, 0.1), z + R.range(-0.1, 0.1)]);
  });
  im.receiveShadow = true; im.frustumCulled = false; im.name = 'lilies';
  scene.add(im);
  const fmat = bob(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
  fmat.emissive = new THREE.Color(0x181610);
  flowers.forEach((list, k) => {
    if (!list.length) return;
    const fim = new THREE.InstancedMesh(lilyFlowerGeo(k === 0), fmat, list.length);
    list.forEach(([x, z], i) => {
      const sc = R.range(0.8, 1.25);
      p.set(x, MAP.WATER_Y + 0.01, z); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * TAU); s.setScalar(sc);
      fim.setMatrixAt(i, m.compose(p, q, s));
    });
    fim.frustumCulled = false; fim.receiveShadow = true; fim.name = 'lily_flowers';
    scene.add(fim);
  });
}

/* ---------- Мостки турбазы и кордона ---------- */
export const PIERS = [];
{
  // от берега на кончике озера к центру; второй — симметрично
  for (const sgn of [-1, 1]) {
    let a = null;
    for (let t = 55; t > 15; t -= 0.25) {
      const x = sgn * t * Math.SQRT1_2, z = sgn * t * Math.SQRT1_2;
      if (lakeRho(x, z) < 1.03) { a = [x, z]; break; }
    }
    const L = 11, dir = [-sgn * Math.SQRT1_2, -sgn * Math.SQRT1_2];
    const x0 = a[0] - dir[0] * 2.5, z0 = a[1] - dir[1] * 2.5;
    PIERS.push({ x0, z0, x1: x0 + dir[0] * L, z1: z0 + dir[1] * L, rot: Math.atan2(dir[0], dir[1]), L });
  }
}
function nearPier(x, z, r) {
  for (const p of PIERS) {
    const vx = p.x1 - p.x0, vz = p.z1 - p.z0, t = Math.max(0, Math.min(1, ((x - p.x0) * vx + (z - p.z0) * vz) / (vx * vx + vz * vz)));
    if (Math.hypot(x - p.x0 - vx * t, z - p.z0 - vz * t) < r) return true;
  }
  return false;
}
export function planPiers() { for (const p of PIERS) keep((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2, 3); }
function buildPiers() {
  const R = rng(7272);
  const deckY = MAP.WATER_Y + 0.55;
  const plankG = new THREE.BoxGeometry(1.9, 0.05, 0.22);
  const postG = new THREE.CylinderGeometry(0.09, 0.1, 1, 7);
  for (const p of PIERS) {
    const g = new THREE.Group();
    g.position.set(p.x0, 0, p.z0); g.rotation.y = p.rot;
    const n = Math.floor(p.L / 0.26);
    for (let i = 0; i < n; i++) {
      if (R() < 0.08 && i > 4) continue;                       // выпавшие доски
      const pl = new THREE.Mesh(plankG, R() < 0.5 ? M.planks : M.planksDark);
      const sag = i > n * 0.8 ? -(i - n * 0.8) * 0.02 : 0;       // конец просел
      pl.position.set(R.range(-0.04, 0.04), deckY + sag + R.range(-0.01, 0.01), i * 0.26 + 0.13);
      pl.rotation.set(R.range(-0.02, 0.02), R.range(-0.04, 0.04), sag * 2 + R.range(-0.02, 0.02));
      pl.castShadow = true; pl.receiveShadow = true;
      g.add(pl);
    }
    for (let i = 0; i <= p.L; i += 2.2) for (const sx of [-0.85, 0.85]) {
      const wx = p.x0 + Math.sin(p.rot) * i + Math.cos(p.rot) * sx, wz = p.z0 + Math.cos(p.rot) * i - Math.sin(p.rot) * sx;
      const bot = Math.min(terrainH(wx, wz), MAP.WATER_Y) - 0.4, top = deckY - 0.03 + (i > p.L * 0.8 ? -0.1 : 0);
      const post = new THREE.Mesh(postG, M.deadwood);
      post.scale.y = top - bot + 0.15; post.position.set(sx, (top + bot) / 2 + 0.07, i);
      post.castShadow = true; g.add(post);
    }
    // перила с одной стороны — наполовину обломаны
    for (let i = 0.5; i < p.L * 0.55; i += 1.1) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.07), M.planksDark);
      post.position.set(-0.9, deckY + 0.45, i); g.add(post);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, p.L * 0.52), M.planksDark);
    rail.position.set(-0.9, deckY + 0.88, p.L * 0.28); rail.rotation.x = 0.02; g.add(rail);
    scene.add(g);
    // опора для пешего режима: настил мостков
    const cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
    addBox(cx, deckY - 0.3, cz, 1.9, 0.62, p.L, p.rot);
    // лодка у мостков: наполовину затоплена
    buildBoat(p.x0 + Math.sin(p.rot) * 7 + Math.cos(p.rot) * 2.2, p.z0 + Math.cos(p.rot) * 7 - Math.sin(p.rot) * 2.2, p.rot + 0.3, 0.35);
  }
}
/** Деревянная лодка: корпус из профиля, скамьи. sink — насколько затоплена. */
export function buildBoat(x, z, rot, sink = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.7, 0.45); shape.quadraticCurveTo(-0.72, -0.05, 0, -0.1); shape.quadraticCurveTo(0.72, -0.05, 0.7, 0.45);
  shape.lineTo(0.62, 0.45); shape.quadraticCurveTo(0.6, 0.02, 0, 0); shape.quadraticCurveTo(-0.6, 0.02, -0.62, 0.45); shape.closePath();
  const hull = new THREE.ExtrudeGeometry(shape, { depth: 3.6, bevelEnabled: false, steps: 1 });
  hull.translate(0, 0, -1.8);
  // сужаем нос
  const pa = hull.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const zz = pa.getZ(i), k = zz > 1.0 ? 1 - (zz - 1.0) / 0.8 * 0.85 : 1;
    pa.setX(i, pa.getX(i) * k);
  }
  hull.computeVertexNormals();
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(hull, M.planksPaint);
  mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh);
  for (const zz of [-0.9, 0.4]) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.26), M.planks);
    seat.position.set(0, 0.34, zz); g.add(seat);
  }
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.03, 3.0), M.planksDark);
  floor.position.set(0, 0.06, -0.1); g.add(floor);
  const y = Math.max(terrainH(x, z) + 0.1, MAP.WATER_Y - sink);
  g.position.set(x, y, z); g.rotation.set(sink * 0.25, rot, sink * 0.3);
  scene.add(g);
  return g;
}

/* ---------- Остров: старая сосна, камни, останки беседки ---------- */
function buildIsland() {
  const R = rng(8383);
  const y = terrainH(ISLAND.x, ISLAND.z);
  const post = new THREE.CylinderGeometry(0.07, 0.08, 2.4, 6);
  for (let i = 0; i < 6; i++) {
    if (i === 4) continue;
    const a = i / 6 * TAU, x = ISLAND.x - 1.4 + Math.cos(a) * 1.5, z = ISLAND.z + 1 + Math.sin(a) * 1.5;
    const m = new THREE.Mesh(post, M.planksDark);
    const tilt = i === 2 ? 0.25 : R.range(-0.04, 0.04);
    m.position.set(x, terrainH(x, z) + 1.15, z); m.rotation.set(tilt, 0, R.range(-0.05, 0.05));
    m.castShadow = true; scene.add(m);
  }
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 0.9, 6, 1, true), M.roofRust);
  roof.position.set(ISLAND.x - 1.4, y + 2.6, ISLAND.z + 1); roof.rotation.set(0.12, 0.3, 0.2);
  roof.castShadow = true; scene.add(roof);
  for (let i = 0; i < 7; i++) {
    const a = R() * TAU, r = R.range(2.5, ISLAND.r - 0.6), x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
    const s = R.range(0.3, 0.8);
    const g = new THREE.DodecahedronGeometry(1, 1);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) pa.setXYZ(k, pa.getX(k) * (1 + R.range(-0.15, 0.15)), pa.getY(k) * 0.6, pa.getZ(k) * (1 + R.range(-0.15, 0.15)));
    g.computeVertexNormals();
    const cols = new Float32Array(pa.count * 3).fill(0.85);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const m = new THREE.Mesh(g, M.stone);
    m.scale.setScalar(s); m.position.set(x, terrainH(x, z) + s * 0.2, z); m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }
}

/** Обновление воды: цвета берутся из текущего неба. */
export function updateLake(sky) {
  if (!LAKE.mat) return;
  const u = LAKE.mat.uniforms;
  u.uTime.value = FRAME.t;
  u.uSunDir.value.copy(sky.sunDir);
  u.uMoonDir.value.copy(sky.sunDir).multiplyScalar(-1);
  u.uSunCol.value.copy(sky.sunColor).multiplyScalar(sky.sunI * 0.25);
  u.uSky.value.copy(sky.fogColor).multiplyScalar(0.9);
  u.uNight.value = sky.night;
  u.uWind.value = sky.wind;
  u.uGust.value = WIND.gust;
  u.uWindDir.value.copy(WIND.dir);
  u.uWeed.value.setRGB(lerp(0.05, 0.006, sky.night), lerp(0.075, 0.009, sky.night), lerp(0.018, 0.006, sky.night));
  // вода темнеет к ночи, днём — торфяная
  u.uDeep.value.setRGB(lerp(0.014, 0.004, sky.night), lerp(0.02, 0.006, sky.night), lerp(0.016, 0.01, sky.night));
  u.uShallow.value.setRGB(lerp(0.07, 0.012, sky.night), lerp(0.062, 0.013, sky.night), lerp(0.04, 0.016, sky.night));
}
