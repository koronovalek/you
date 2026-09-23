import * as THREE from 'three';
import { scene, camera, QNAME, NO_REFLECT } from '../core/env.js';
import { rng, clamp } from '../core/math.js';
import { MAP } from './layout.js';
import { heightGrid, hFast } from './heightcache.js';
import { forestDensity } from './forest.js';
import { windUniforms, WIND_GLSL } from './wind.js';
import { COLLIDERS } from '../core/colliders.js';

/* ============================================================================
   ТРАВА НА GPU
   Настоящие травинки (изогнутые сужающиеся ленты, без альфа-теста), пучками.
   Сетка пучков привязана к миру и «заворачивается» вокруг камеры: инстанс i
   всегда стоит в ячейке, сравнимой с i по модулю размера сетки, поэтому при
   движении CPU ничего не пересобирает — ни одного обновления буферов за кадр.
   Высота и плотность берутся из текстур, ветер — бегущими волнами порывов.
   Два яруса: ближний (густо, 7 травинок в пучке) и дальний (редко, крупнее).
============================================================================ */
export const GRASS = { tiers: [], count: 0, tex: null };

const TIERS = {
  low: [{ S: 0.42, R0: 0, R1: 10, blades: 5, segs: 3 }, { S: 1.0, R0: 9, R1: 26, blades: 4, segs: 2 }, { S: 1.6, R0: 0, R1: 16, flower: true }],
  medium: [{ S: 0.34, R0: 0, R1: 14, blades: 7, segs: 3 }, { S: 0.82, R0: 13, R1: 38, blades: 5, segs: 2 }, { S: 1.25, R0: 0, R1: 24, flower: true }],
  high: [{ S: 0.29, R0: 0, R1: 18, blades: 8, segs: 4 }, { S: 0.7, R0: 17, R1: 52, blades: 5, segs: 3 }, { S: 1.0, R0: 0, R1: 30, flower: true }]
};

/** Цветок: стебель-лента и венчик из двух скрещённых квадов на верхушке.
    aH — (смещение по стороне, по высоте, 1 = венчик). */
function flowerGeometry() {
  const pos = [], aB = [], aV = [], aH = [], idx = [];
  const segs = 3;
  for (let k = 0; k <= segs; k++) for (const s of k < segs ? [-1, 1] : [0]) { pos.push(0, k / segs, 0); aB.push(0, 0, 0, 0.5); aV.push(k / segs, s); aH.push(0, 0, 0); }
  for (let k = 0; k < segs - 1; k++) { const i = k * 2; idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
  idx.push((segs - 1) * 2, (segs - 1) * 2 + 1, segs * 2);
  for (let q = 0; q < 2; q++) {
    const base = pos.length / 3;
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { pos.push(0, 1, 0); aB.push(0, 0, q * 1.5708, 0.5); aV.push(1, 0); aH.push(u, v, 1); }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  // горизонтальный диск венчика — видно сверху
  const base = pos.length / 3;
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { pos.push(0, 1, 0); aB.push(0, 0, 0, 0.5); aV.push(1, 0); aH.push(u, v, 2); }
  idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(aB, 4));
  g.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 2));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 3));
  g.setIndex(idx);
  return g;
}

/** Геометрия пучка: травинки как ленты. aB — (смещение x,z, поворот, случайность), aV — (t, сторона). */
function clumpGeometry(blades, segs, spread, seed) {
  const R = rng(seed);
  const pos = [], aB = [], aV = [], idx = [];
  for (let b = 0; b < blades; b++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * spread;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r, face = R() * Math.PI * 2, rnd = R();
    const base = pos.length / 3;
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      for (const s of [-1, 1]) { pos.push(ox, t, oz); aB.push(ox, oz, face, rnd); aV.push(t, s); }
    }
    pos.push(ox, 1, oz); aB.push(ox, oz, face, rnd); aV.push(1, 0);
    for (let k = 0; k < segs - 1; k++) {
      const i = base + k * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
    const i = base + (segs - 1) * 2;
    idx.push(i, i + 1, i + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aB', new THREE.Float32BufferAttribute(aB, 4));
  g.setAttribute('aV', new THREE.Float32BufferAttribute(aV, 2));
  g.setIndex(idx);
  return g;
}

const GRASS_VS = /* glsl */`
  attribute vec4 aB;
  attribute vec2 aV;
  attribute vec2 aCell;
  #ifdef FLOWER
    attribute vec3 aH;
  #endif
  uniform sampler2D uHeight, uDens;
  uniform vec4 uHM, uDM;            // x0, 1/(шаг·N), полтекселя: высоты и плотность
  uniform vec3 uCamG;               // камера (x, z) и высота над землёй
  uniform vec2 uCamCell;
  uniform float uS, uG, uR0, uR1, uDensK, uWidth;
  varying float vT;
  varying float vCanopy;
  float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
  float lakeRhoG(vec2 p) {
    float u = (p.x + p.y) * 0.70710678, v = (p.x - p.y) * 0.70710678;
    float ph = atan(v, u);
    float w = 1.0 + 0.07 * sin(2.0 * ph + 1.1) + 0.05 * sin(4.0 * ph + 2.3) + 0.03 * sin(6.0 * ph + 0.7);
    return length(vec2(u / 36.0, v / 21.0)) / w;
  }
`;

const GRASS_BEGIN = /* glsl */`
  vec2 cell = aCell + uG * ceil((uCamCell - uG * 0.5 - aCell) / uG);
  float h1 = gh(cell), h2 = gh(cell + 17.31), h3 = gh(cell * 1.73 + 3.1), h4 = gh(cell + 91.7);
  vec2 base = (cell + vec2(h1, h2)) * uS;
  vec2 dn = texture2D(uDens, (base - uDM.x) * uDM.y + uDM.z).rg;
  vCanopy = dn.g;
  float dist = distance(base, uCamG.xy);
  // ярусы перекрываются рваной кромкой, внешний край — плавное уменьшение
  float edge = dist + (h4 - 0.5) * 3.0;
  float fade = smoothstep(uR1, uR1 * 0.8, dist) * step(uR0, edge) * (uR0 > 0.0 ? 1.0 : step(edge, uR1));
  float dens = dn.r * uDensK;
  float sc = smoothstep(h3, h3 + 0.12, dens) * fade;
  #ifdef FLOWER
    // цветы: на открытых местах, не под пологом и не на сухой минной полосе
    sc *= step(0.55, h4) * (1.0 - smoothstep(0.35, 0.6, dn.g)) * step(0.25, dn.r);
  #endif
  // бурьян на минной полосе, сочная высокая трава у воды
  float e = max(abs(base.x), abs(base.y));
  float mine = step(${(MAP.PLAY - 2).toFixed(1)}, e) * step(e, ${MAP.FENCE.toFixed(1)});
  float rho = lakeRhoG(base);
  float wet = 1.0 - smoothstep(1.02, 1.6, rho);
  float tall = 1.0 + mine * 0.7 + wet * 0.45;
  float dry = clamp(mine * 0.6 + (gn(base * 0.045) - 0.45) * 1.1 * (1.0 - wet) + (1.0 - dn.g) * 0.12, 0.0, 1.0);
  float rnd = aB.w;
  float ang = aB.z + h1 * 6.2831;
  float ca = cos(h2 * 6.2831), sa = sin(h2 * 6.2831);
  vec2 off = vec2(aB.x * ca - aB.y * sa, aB.x * sa + aB.y * ca) * (0.8 + tall * 0.25);
  float bh = (0.34 + 0.5 * h2 * h2 + 0.25 * gn(base * 0.21)) * tall * (0.62 + 0.55 * rnd) * sc;
  #ifdef FLOWER
    float species = floor(fract(h1 * 7.31 + gn(base * 0.06) * 2.0) * 5.0);   // куртинами
    bh = (species > 3.5 ? 0.75 + 0.35 * h2 : 0.28 + 0.3 * h2) * sc;
    mine = 0.0;
  #endif
  float t = aV.x;
  vec2 fdir = vec2(cos(ang), sin(ang));
  vec2 side = vec2(-fdir.y, fdir.x);
  float w = uWidth * (1.0 - t * 0.88) * (0.75 + 0.5 * fract(rnd * 7.13)) * (0.8 + tall * 0.2) * min(sc * 3.0, 1.0);
  vec3 gp = vec3(base.x + off.x, 0.0, base.y + off.y);
  gp.xz += side * aV.y * w * 0.5;
  #ifdef FLOWER
    gp.xz = base + off * 0.3 + side * aV.y * w * 0.5;
  #endif
  float lean = 0.18 + 0.55 * fract(rnd * 3.7);
  gp.y = t * bh;
  gp.xz += fdir * lean * t * t * bh * 0.55;
  gp.y -= lean * t * t * bh * 0.18;
  // ветер: наклон по порыву + дрожь кончиков
  float gw = gustWave(gp.xz);
  float wk = t * t * bh;
  vec2 wd = uWind * uWindAmp * (0.18 + gw * 0.85) * 0.55;
  wd += vec2(sin(uTime * 3.1 + base.x * 1.7 + rnd * 6.0), cos(uTime * 2.7 + base.y * 1.9)) * 0.06 * uWindAmp * (0.4 + gw);
  // ударная волна от взрыва
  vec2 bd = gp.xz - uBlast.xz;
  float bdist = length(bd);
  float tau = uBlast.w - bdist / 70.0;
  if (tau > 0.0 && tau < 2.5 && uBlastStr > 0.0) {
    float push = exp(-tau * 3.0) * sin(tau * 11.0 + 1.2) * uBlastStr * exp(-bdist / 22.0) * 1.6;
    wd += (bdist > 0.01 ? bd / bdist : vec2(1.0, 0.0)) * push;
  }
  // игрок приминает траву вокруг себя
  vec2 pd = gp.xz - uPlayer.xz;
  float pdist = length(pd);
  float press = (1.0 - smoothstep(0.25, 1.0, pdist)) * step(-900.0, uPlayer.y);
  wd += (pdist > 0.001 ? pd / pdist : vec2(1.0, 0.0)) * press * 1.6;
  float wl = length(wd);
  if (wl > 1.2) wd *= 1.2 / wl;
  gp.xz += wd * wk;
  gp.y -= min(dot(wd, wd), 1.4) * wk * 0.32;
  #ifdef FLOWER
    // венчик на верхушке: крест из двух квадов + диск
    float hs = (species > 3.5 ? 0.028 : 0.04 + 0.02 * h3) * min(sc * 3.0, 1.0);
    if (aH.z > 1.5) { gp.xz += vec2(aH.x, aH.y) * hs; gp.y += 0.004; }
    else if (aH.z > 0.5) {
      vec2 fs = vec2(cos(aB.z + ang), sin(aB.z + ang));
      gp.xz += fs * aH.x * hs; gp.y += aH.y * hs * (species > 3.5 ? 3.0 : 0.6);
    }
  #endif
  vec2 gxz = gp.xz;
  float gy = texture2D(uHeight, (gxz - uHM.x) * uHM.y + uHM.z).r;
  gp.y += gy - 0.04;
  // цвет: тёмное основание, светлые кончики, сухие куртины пятнами
  vec3 lush = mix(vec3(0.05, 0.085, 0.022), vec3(0.16, 0.24, 0.06), t);
  vec3 hay = mix(vec3(0.11, 0.09, 0.04), vec3(0.42, 0.34, 0.15), t);
  vColor = mix(lush, hay, dry) * (0.78 + 0.44 * h3) * mix(0.35, 1.0, smoothstep(0.0, 0.55, t));
  vColor *= mix(1.0, 0.8, dn.g);
  // колоски: у части травинок тёмные метёлки на кончиках
  vColor = mix(vColor, vec3(0.2, 0.15, 0.08) * (0.8 + 0.4 * h3), step(0.82, fract(rnd * 13.7 + h4)) * smoothstep(0.82, 0.97, t) * (0.4 + dry * 0.6));
  #ifdef FLOWER
    if (aH.z > 0.5) {
      // ромашка, лютик, клевер, колокольчик, иван-чай
      vec3 pc = species < 0.5 ? vec3(0.85, 0.85, 0.8) : species < 1.5 ? vec3(0.8, 0.62, 0.03) : species < 2.5 ? vec3(0.5, 0.16, 0.3) : species < 3.5 ? vec3(0.24, 0.24, 0.62) : vec3(0.62, 0.16, 0.42);
      float ctr = aH.z > 1.5 ? 1.0 - step(0.35, length(vec2(aH.x, aH.y))) : 0.0;
      vColor = mix(pc, vec3(0.75, 0.55, 0.05), ctr * step(species, 0.5)) * (0.85 + 0.3 * h3);
    }
  #endif
  vT = t;
  vec3 bn = normalize(vec3(fdir.x, 0.0, fdir.y) * (1.0 - t * 0.5) + vec3(wd.x, 0.0, wd.y) * 0.3);
  vec3 objectNormal = normalize(mix(bn, vec3(0.0, 1.0, 0.0), 0.55));
`;

function grassMaterial(tier) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, vertexColors: true });
  if (tier.flower) m.defines = { FLOWER: '' };
  const U = GRASS.uniforms;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, windUniforms, U, {
      uS: { value: tier.S }, uG: { value: tier.G }, uR0: { value: tier.R0 }, uR1: { value: tier.R1 },
      uDensK: { value: tier.densK }, uWidth: { value: tier.width }, uCamCell: tier.camCell
    });
    sh.vertexShader = WIND_GLSL + GRASS_VS + sh.vertexShader
      .replace('#include <beginnormal_vertex>', GRASS_BEGIN)
      .replace('#include <begin_vertex>', 'vec3 transformed = gp;')
      .replace('#include <color_vertex>', '');
    sh.fragmentShader = 'varying float vT;\nvarying float vCanopy;\n' + sh.fragmentShader
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <lights_fragment_begin>', /* glsl */`#include <lights_fragment_begin>
        #if NUM_DIR_LIGHTS > 0
          // просвет: травинки против солнца светятся (свет уже с учётом тени)
          float back = pow(max(dot(normalize(-vViewPosition), directLight.direction), 0.0), 3.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * (back * 1.6 + 0.12) * vT;
        #endif`);
  };
  m.customProgramCacheKey = () => 'grass-gpu-' + tier.S + (tier.flower ? 'f' : '');
  return m;
}

export function buildGrass() {
  const { HN, R, DN } = heightGrid();
  const tiers = TIERS[QNAME] || TIERS.medium;
  // высоты: полуточные float (фильтруются линейно во всех WebGL2)
  const htex = new THREE.DataTexture(new Uint16Array(HN * HN), HN, HN, THREE.RedFormat, THREE.HalfFloatType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter; htex.generateMipmaps = false;
  htex.wrapS = htex.wrapT = THREE.ClampToEdgeWrapping; htex.unpackAlignment = 1;
  const dtex = new THREE.DataTexture(new Uint8Array(DN * DN * 2), DN, DN, THREE.RGFormat, THREE.UnsignedByteType);
  dtex.magFilter = dtex.minFilter = THREE.LinearFilter; dtex.generateMipmaps = false;
  dtex.wrapS = dtex.wrapT = THREE.ClampToEdgeWrapping; dtex.unpackAlignment = 1;
  GRASS.uniforms = {
    uHeight: { value: htex }, uDens: { value: dtex },
    uHM: { value: new THREE.Vector4(-R, 1 / (heightGrid().HS * HN), 0.5 / HN, 0) },
    uDM: { value: new THREE.Vector4(-R, 1 / (heightGrid().DS * DN), 0.5 / DN, 0) },
    uCamG: { value: new THREE.Vector3() }
  };
  GRASS.htex = htex; GRASS.dtex = dtex;
  fillHeight();
  for (const [i, t] of tiers.entries()) {
    const tier = { ...t, G: Math.ceil(t.R1 * 2 / t.S) + 1, camCell: { value: new THREE.Vector2() } };
    tier.densK = i === 0 ? 1.0 : 0.95;
    tier.width = t.flower ? 0.01 : i === 0 ? 0.042 : 0.08;
    const geo = t.flower ? flowerGeometry() : clumpGeometry(t.blades, t.segs, i === 0 ? 0.13 : 0.3, 700 + i);
    const cells = new Float32Array(tier.G * tier.G * 2);
    for (let j = 0, k = 0; j < tier.G; j++) for (let q = 0; q < tier.G; q++) { cells[k++] = q; cells[k++] = j; }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geo.instanceCount = tier.G * tier.G;
    const mesh = new THREE.Mesh(geo, grassMaterial(tier));
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.name = 'grass_' + i; mesh.renderOrder = -1;
    tier.mesh = mesh;
    scene.add(mesh); NO_REFLECT.push(mesh);
    GRASS.tiers.push(tier);
  }
}
function fillHeight() {
  const { H, HN } = heightGrid();
  const a = GRASS.htex.image.data;
  for (let i = 0; i < HN * HN; i++) a[i] = THREE.DataUtils.toHalfFloat(H[i]);
  GRASS.htex.needsUpdate = true;
}
/** Плотность считается после расстановки всего реквизита: под полами, машинами,
    бревнами и камнями травы нет — она не протыкает предметы. */
export function finishGrass() {
  const { GD, DN, DS, R } = heightGrid();
  const a = GRASS.dtex.image.data;
  const mask = new Float32Array(DN * DN).fill(1);
  const cellOf = v => Math.round((v + R) / DS);
  for (const c of COLLIDERS) {
    if (c.soft) continue;
    const g = hFast(c.x, c.z);
    if (c.y0 > g + 0.6 || c.y1 < g - 0.2) continue;
    const r = c.t === 0 ? c.r + 0.15 : Math.hypot(c.hw, c.hd) + 0.2;
    for (let j = cellOf(c.z - r); j <= cellOf(c.z + r); j++) for (let i = cellOf(c.x - r); i <= cellOf(c.x + r); i++) {
      if (i < 0 || j < 0 || i >= DN || j >= DN) continue;
      const x = -R + i * DS, z = -R + j * DS;
      let inside;
      if (c.t === 0) inside = Math.hypot(x - c.x, z - c.z) < r;
      else {
        const dx = x - c.x, dz = z - c.z, lx = dx * c.c - dz * c.s, lz = dx * c.s + dz * c.c;
        inside = Math.abs(lx) < c.hw + 0.25 && Math.abs(lz) < c.hd + 0.25;
      }
      if (inside) mask[j * DN + i] = c.t === 0 ? 0.35 : 0;
    }
  }
  for (let j = 0; j < DN; j++) for (let i = 0; i < DN; i++) {
    const k = j * DN + i, x = -R + i * DS, z = -R + j * DS;
    a[k * 2] = clamp(GD[k] / 1.3 * mask[k], 0, 1) * 255;
    a[k * 2 + 1] = clamp(forestDensity(x, z), 0, 1) * 255;
  }
  GRASS.dtex.needsUpdate = true;
}
/** Кадр: только юниформы (позиция камеры). */
export function refreshGrass() {
  const cp = camera.position;
  const agl = cp.y - hFast(cp.x, cp.z);
  GRASS.uniforms.uCamG.value.set(cp.x, cp.z, agl);
  let n = 0;
  for (const t of GRASS.tiers) {
    // с высоты дрона ближний ярус не виден, дальний — до 70 м
    t.mesh.visible = agl < (t.R0 > 0 ? 70 : 30);
    t.camCell.value.set(Math.floor(cp.x / t.S), Math.floor(cp.z / t.S));
    if (t.mesh.visible) n += t.G * t.G;
  }
  GRASS.count = n;
}
/** Воронка или разрушение: пересчитать высоты в текстуре. */
export function grassHeightsDirty() { if (GRASS.htex) fillHeight(); }
