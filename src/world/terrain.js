import * as THREE from 'three';
import { scene, Q } from '../core/env.js';
import { MAP, terrainH, splat, edgeDist, TRENCHES, CRATERS, PADS, lakeRho, pathInfluence } from './layout.js';
import { TEX } from '../gen/materials.js';
import { forestDensity } from './forest.js';
import { windUniforms } from './wind.js';

/* ============================================================================
   МЕШ РЕЛЬЕФА
   Чанки 16 м со своим шагом сетки: у окопов и воронок мелкий (стенки траншей
   должны быть крутыми), на ровном лесу — метр. Стыки разных шагов закрыты
   «юбками». Нормали — по сетке высот с запасом в одну клетку, поэтому на
   границах чанков нет швов освещения.
============================================================================ */
const CH = 16, INNER = 136;
export const TERRAIN = { chunks: [], mat: null, ao: { value: null } };
const AO_R = 136, AO_S = 0.5, AO_N = Math.round(AO_R * 2 / AO_S);
{
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  TERRAIN.ao.value = t;
}
/** Запечь затенение земли: мягкие пятна у стволов, под бревнами, машинами и
    стенами. Предметы «садятся» на землю, а не парят над ней. */
export function bakeGroundAO(trees, colliders) {
  const c = document.createElement('canvas');
  c.width = c.height = AO_N;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, AO_N, AO_N);
  const px = v => (v + AO_R) / AO_S;
  x.globalCompositeOperation = 'multiply';
  const blob = (cx, cz, r, a) => {
    const g = x.createRadialGradient(px(cx), px(cz), 0, px(cx), px(cz), r / AO_S);
    const k = Math.round(255 * (1 - a));
    g.addColorStop(0, `rgb(${k},${k},${k})`); g.addColorStop(1, '#fff');
    x.fillStyle = g; x.beginPath(); x.arc(px(cx), px(cz), r / AO_S, 0, 7); x.fill();
  };
  for (const t of trees) {
    if (Math.max(Math.abs(t.x), Math.abs(t.z)) > AO_R) continue;
    blob(t.x, t.z, 0.6 + t.r * 7, 0.55);           // комель
    if (!t.dead) blob(t.x, t.z, t.h * 0.17, 0.16);  // крона
  }
  for (const k of colliders) {
    if (k.soft || k.dead) continue;
    if (k.y0 > terrainH(k.x, k.z) + 0.8) continue;
    if (k.t === 0) { if (k.y1 - k.y0 < 5) blob(k.x, k.z, k.r * 1.9 + 0.2, 0.5); continue; }   // стволы уже учтены
    // бокс у земли: размытая тень по периметру пятна
    x.save();
    x.translate(px(k.x), px(k.z)); x.rotate(-Math.atan2(k.s, k.c));
    x.filter = 'blur(2px)';
    const w = (k.hw * 2 + 0.5) / AO_S, d = (k.hd * 2 + 0.5) / AO_S;
    x.fillStyle = 'rgb(110,110,110)';
    x.fillRect(-w / 2, -d / 2, w, d);
    x.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.flipY = false;
  t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  TERRAIN.ao.value = t;
}

function chunkStep(x0, z0) {
  const pad = 3.5, x1 = x0 + CH, z1 = z0 + CH;
  const inBox = (x, z) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad;
  for (const t of TRENCHES) for (const p of t.pts) if (inBox(p[0], p[1])) return Q.tex < 0.6 ? 0.4 : 0.32;
  for (const c of CRATERS) if (inBox(c.x, c.z)) return 0.5;
  // берег острова и уреза — плавнее
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const r = lakeRho(x0 + i * 4, z0 + j * 4);
    if (r > 0.85 && r < 1.4) return 0.6;
    if (pathInfluence(x0 + i * 4, z0 + j * 4, 2) > 0) return 0.8;
  }
  for (const p of PADS) if (inBox(p.x, p.z)) return 0.8;
  return 1.0;
}

function gridChunk(x0, z0, size, step, skirt) {
  const n = Math.round(size / step), s = size / n;
  const N = n + 3;                       // +1 клетка с каждой стороны для нормалей
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = terrainH(x0 + (i - 1) * s, z0 + (j - 1) * s);
  const V = n + 1, pos = [], nrm = [], spl = [], idx = [];
  const sp = [0, 0, 0];
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const x = x0 + i * s, z = z0 + j * s, gi = (j + 1) * N + (i + 1);
    pos.push(x, H[gi], z);
    const nx = H[gi - 1] - H[gi + 1], nz = H[gi - N] - H[gi + N], ny = 2 * s, l = Math.hypot(nx, ny, nz);
    nrm.push(nx / l, ny / l, nz / l);
    splat(x, z, sp);
    spl.push(sp[0], sp[1], sp[2], forestDensity(x, z));
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    // диагональ по склону: меньше «ступенек» на стенках окопов
    if ((i + j) % 2) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
  }
  if (skirt) {
    // юбка: опущенная кромка по периметру чанка
    const edges = [];
    for (let i = 0; i < n; i++) edges.push([i, 0, i + 1, 0], [i + 1, n, i, n], [0, i + 1, 0, i], [n, i, n, i + 1]);
    for (const [ia, ja, ib, jb] of edges) {
      const a = ja * V + ia, b = jb * V + ib, base = pos.length / 3;
      for (const k of [a, b]) {
        pos.push(pos[k * 3], pos[k * 3 + 1] - 1.2, pos[k * 3 + 2]);
        nrm.push(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
        spl.push(spl[k * 4], spl[k * 4 + 1], spl[k * 4 + 2], spl[k * 4 + 3]);
      }
      idx.push(a, b, base, b, base + 1, base);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aSplat', new THREE.Float32BufferAttribute(spl, 4));
  g.setIndex(idx);
  g.computeBoundingSphere(); g.computeBoundingBox();
  return g;
}

/** Внешний лес: одна крупная сетка вокруг игровой зоны, без дыр и швов. */
function outerRing() {
  const step = 6, R = MAP.WORLD, n = Math.ceil(R * 2 / step);
  const pos = [], nrm = [], spl = [], idx = [];
  const map = new Int32Array((n + 1) * (n + 1)).fill(-1);
  const inside = (x, z) => Math.max(Math.abs(x), Math.abs(z)) < INNER - step;
  const sp = [0, 0, 0];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = -R + i * step, z = -R + j * step;
    if (inside(x, z) && inside(x + step, z + step) && inside(x - step, z - step)) continue;
    map[j * (n + 1) + i] = pos.length / 3;
    const h = terrainH(x, z);
    pos.push(x, h - (edgeDist(x, z) < INNER + 1 ? 0.25 : 0), z);
    const nx = terrainH(x - 2, z) - terrainH(x + 2, z), nz = terrainH(x, z - 2) - terrainH(x, z + 2), l = Math.hypot(nx, 4, nz);
    nrm.push(nx / l, 4 / l, nz / l);
    splat(x, z, sp);
    spl.push(0, 0, sp[2], forestDensity(x, z));
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = map[j * (n + 1) + i], b = map[j * (n + 1) + i + 1], c = map[(j + 1) * (n + 1) + i], d = map[(j + 1) * (n + 1) + i + 1];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    const cx = -R + (i + 0.5) * step, cz = -R + (j + 0.5) * step;
    if (Math.max(Math.abs(cx), Math.abs(cz)) < INNER - 0.5) continue;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aSplat', new THREE.Float32BufferAttribute(spl, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Материал земли: четыре слоя (подстилка, тропа, ил, перекопанный грунт) плюс
    макро-вариации мха и сухой хвои, чтобы с высоты дрона не читался тайл. */
function groundMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const U = {
    tFloor: { value: TEX.floor.map }, tFloorN: { value: TEX.floor.normal },
    tPath: { value: TEX.path.map }, tPathN: { value: TEX.path.normal },
    tMud: { value: TEX.mud.map }, tMudN: { value: TEX.mud.normal },
    tDug: { value: TEX.dug.map }, tDugN: { value: TEX.dug.normal },
    uWet: { value: 0 }, uTime: windUniforms.uTime, uWaterY: { value: MAP.WATER_Y },
    tAO: TERRAIN.ao, uAOM: { value: new THREE.Vector4(-AO_R, 1 / (AO_S * AO_N), 0, 0) }
  };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'attribute vec4 aSplat;\nvarying vec4 vSplat;\nvarying vec3 vWPos;\nvarying vec3 vWN;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = aSplat;\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = /* glsl */`
      uniform sampler2D tFloor, tFloorN, tPath, tPathN, tMud, tMudN, tDug, tDugN;
      uniform float uWet, uTime, uWaterY;
      uniform sampler2D tAO; uniform vec4 uAOM;
      varying vec4 vSplat;
      // каустика: свет, собранный рябью в сетку бликов на дне
      float caustic(vec2 p, float t) {
        vec2 i = p; float c = 1.0;
        for (int n = 0; n < 4; n++) {
          float tt = t * (1.0 - 3.5 / float(n + 1));
          i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
          c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / 0.005), p.y / (cos(i.y + tt) / 0.005)));
        }
        c = 1.17 - pow(c / 4.0, 1.4);
        return pow(abs(c), 8.0);
      } varying vec3 vWPos; varying vec3 vWN;
      float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float gNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }
      vec3 gW; float gMacro;
    ` + sh.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
        vec2 wuv = vWPos.xz;
        float macro = gNoise(wuv * 0.018) * 0.6 + gNoise(wuv * 0.07) * 0.4;
        gMacro = macro;
        vec3 cF = texture2D(tFloor, wuv * 0.21).rgb;
        vec3 cF2 = texture2D(tFloor, wuv * 0.047 + 0.37).rgb;
        cF = mix(cF, cF2, 0.4 + 0.3 * (macro - 0.5));
        // мох на открытых местах, сухая рыжая хвоя под плотными кронами
        float canopy = vSplat.w;
        vec3 moss = vec3(0.075, 0.105, 0.035);
        vec3 needles = vec3(0.16, 0.085, 0.035);
        cF = mix(cF, cF * moss / 0.07, smoothstep(0.45, 0.8, macro) * (1.0 - canopy) * 0.55);
        cF = mix(cF, cF * needles / 0.1, smoothstep(0.5, 0.9, canopy) * 0.35);
        vec3 cP = texture2D(tPath, wuv * 0.33).rgb;
        vec3 cM = texture2D(tMud, wuv * 0.28).rgb;
        vec3 cD = texture2D(tDug, wuv * 0.3).rgb;
        // шум на границах слоёв: переходы рваные, а не градиентные
        float edgeN = gNoise(wuv * 0.9) - 0.5;
        float wP = smoothstep(0.15, 0.75, vSplat.x + edgeN * 0.35);
        float wM = smoothstep(0.1, 0.8, vSplat.y + edgeN * 0.3);
        float wD = smoothstep(0.1, 0.7, vSplat.z + edgeN * 0.4);
        vec3 col = cF;
        col = mix(col, cD, wD);
        col = mix(col, cP, wP);
        col = mix(col, cM, wM);
        gW = vec3(wP, wM, wD);
        // затопленный берег темнее, дно под водой — ещё темнее
        col *= mix(1.0, 0.55, smoothstep(0.35, 0.95, vSplat.y) * (1.0 - wP));
        // запечённое затенение: у комлей, под машинами и стенами земля темнее
        float ao = texture2D(tAO, (vWPos.xz - uAOM.x) * uAOM.y + uAOM.z).r;
        col *= mix(0.35, 1.0, ao);
        diffuseColor.rgb *= col;
      `)
      .replace('#include <lights_fragment_begin>', /* glsl */`#include <lights_fragment_begin>
        #if NUM_DIR_LIGHTS > 0
          vec3 gSun = directLight.color;
        #else
          vec3 gSun = vec3(0.0);
        #endif`)
      .replace('#include <opaque_fragment>', /* glsl */`
        if (vWPos.y < uWaterY) {
          float dep = uWaterY - vWPos.y;
          float cs = caustic(vWPos.xz * 0.55 + 20.0, uTime * 0.55) + caustic(vWPos.xz * 1.1 - 7.0, uTime * 0.7 + 3.0) * 0.5;
          outgoingLight += diffuseColor.rgb * gSun * cs * 1.8 * exp(-dep * 0.8) * smoothstep(0.02, 0.2, dep);
        }
        #include <opaque_fragment>`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        roughnessFactor = mix(roughnessFactor, 0.82, gW.x);
        roughnessFactor = mix(roughnessFactor, 0.48 - uWet * 0.2, smoothstep(0.4, 1.0, gW.y));
        roughnessFactor = mix(roughnessFactor, 0.97, gW.z);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          vec2 wuv = vWPos.xz;
          vec3 nF = texture2D(tFloorN, wuv * 0.21).xyz * 2.0 - 1.0;
          vec3 nP = texture2D(tPathN, wuv * 0.33).xyz * 2.0 - 1.0;
          vec3 nM = texture2D(tMudN, wuv * 0.28).xyz * 2.0 - 1.0;
          vec3 nD = texture2D(tDugN, wuv * 0.3).xyz * 2.0 - 1.0;
          vec3 nt = nF;
          nt = mix(nt, nD, gW.z); nt = mix(nt, nP, gW.x); nt = mix(nt, nM * vec3(0.6, 0.6, 1.0), gW.y);
          vec3 nW = normalize(normalize(vWN) + vec3(nt.x, 0.0, nt.y) * 0.9);
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }
      `);
  };
  m.customProgramCacheKey = () => 'ground-v2';
  return m;
}

export function buildTerrain() {
  const mat = groundMaterial();
  TERRAIN.mat = mat;
  for (let z0 = -INNER; z0 < INNER; z0 += CH) for (let x0 = -INNER; x0 < INNER; x0 += CH) {
    const step = chunkStep(x0, z0);
    const g = gridChunk(x0, z0, CH, step, true);
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    scene.add(mesh);
    TERRAIN.chunks.push(mesh);
  }
  const outer = new THREE.Mesh(outerRing(), mat);
  outer.receiveShadow = true; outer.name = 'terrain_outer';
  scene.add(outer);
  TERRAIN.chunks.push(outer);
}
