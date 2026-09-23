import * as THREE from 'three';
import { scene, camera, Q, NO_REFLECT } from '../core/env.js';
import { rng, TAU, lerp, clamp } from '../core/math.js';
import { MAP, isFree, lakeRho, pathInfluence, terrainNormal } from './layout.js';
import { hFast } from './heightcache.js';
import { forestDensity, TREES } from './forest.js';
import { M, TEX } from '../gen/materials.js';

/* ============================================================================
   ЛЕСНАЯ ПОДСТИЛКА
   Мелочь, которая делает землю лесом, а не текстурой: шишки под елями и
   соснами, сучья и валежник, камешки, грибы (боровики, мухоморы, сыроежки),
   опавшие листья под берёзами. Всё лежит по нормали склона, плитками по 32 м
   с отсечением по дистанции.
============================================================================ */
const TILE = 32;
const TILES = [];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function withColor(g, fn) {
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const [r, gg, b] = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function merge(list) {
  const pos = [], nrm = [], col = [], uv = [];
  for (let g of list) {
    g = g.index ? g.toNonIndexed() : g;
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array);
    col.push(...(g.attributes.color ? g.attributes.color.array : new Float32Array(g.attributes.position.count * 3).fill(1)));
    uv.push(...(g.attributes.uv ? g.attributes.uv.array : new Float32Array(g.attributes.position.count * 2)));
  }
  const o = new THREE.BufferGeometry();
  o.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  o.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  o.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  o.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return o;
}
function coneGeo() {
  // шишка: чешуйчатый профиль (зубцы по высоте), лежит на боку
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, r = Math.sin(t * Math.PI) * (0.5 + 0.12 * (i % 2)) * (1 - t * 0.35);
    pts.push(new THREE.Vector2(Math.max(0.02, r), t - 0.5));
  }
  const g = new THREE.LatheGeometry(pts, 7);
  g.scale(0.035, 0.09, 0.035); g.rotateZ(Math.PI / 2); g.translate(0, 0.022, 0);
  return withColor(g, (x) => { const k = 0.8 + 0.4 * Math.abs(Math.sin(x * 400)); return [0.3 * k, 0.18 * k, 0.1 * k]; });
}
function twigGeo(R) {
  const parts = [];
  const L = 1, main = new THREE.CylinderGeometry(0.012, 0.02, L, 5, 1);
  main.rotateZ(Math.PI / 2); main.translate(0, 0.018, 0); parts.push(main);
  for (let k = 0; k < 3; k++) {
    const l = R.range(0.15, 0.35), b = new THREE.CylinderGeometry(0.005, 0.009, l, 4, 1);
    b.translate(0, l / 2, 0); b.rotateZ(R.range(0.6, 1.2) * (R() < 0.5 ? 1 : -1)); b.rotateY(R.range(-0.5, 0.5));
    b.translate(R.range(-0.4, 0.4), 0.018, 0); parts.push(b);
  }
  return merge(parts.map(g => withColor(g, () => [0.36, 0.3, 0.24])));
}
function stoneGeo(R) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.25 * Math.sin(x * 5 + z * 3) + R.range(-0.1, 0.1);
    p.setXYZ(i, x * k, Math.max(y * 0.55 * k, -0.1), z * k * 0.85);
  }
  g.computeVertexNormals();
  return withColor(g, (x, y) => { const moss = clamp(y * 2.2, 0, 1); return [lerp(0.42, 0.2, moss), lerp(0.42, 0.28, moss), lerp(0.4, 0.1, moss)]; });
}
function mushroomGeo(kind) {
  // kind: 0 — боровик, 1 — мухомор, 2 — сыроежка
  const cap = [[0.34, 0.2, 0.1], [0.62, 0.06, 0.03], [0.55, 0.16, 0.2]][kind];
  const stem = new THREE.CylinderGeometry(kind === 0 ? 0.022 : 0.014, kind === 0 ? 0.03 : 0.016, 0.08, 7);
  stem.translate(0, 0.04, 0);
  const c = new THREE.SphereGeometry(kind === 1 ? 0.05 : 0.045, 9, 5, 0, TAU, 0, Math.PI * 0.5);
  c.scale(1, kind === 1 ? 0.55 : 0.5, 1); c.translate(0, 0.078, 0);
  const under = new THREE.CircleGeometry(kind === 1 ? 0.05 : 0.045, 9); under.rotateX(Math.PI / 2); under.translate(0, 0.078, 0);
  return merge([
    withColor(stem, () => [0.82, 0.78, 0.68]),
    withColor(c, (x, y, z) => kind === 1 && Math.sin(x * 120) * Math.sin(z * 130) > 0.75 ? [0.9, 0.88, 0.8] : cap),
    withColor(under, () => kind === 0 ? [0.7, 0.6, 0.3] : [0.85, 0.82, 0.74])
  ]);
}
function leafPatchGeo() {
  const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2); g.translate(0, 0.012, 0);
  return withColor(g, () => [1, 1, 1]);
}

export function buildLitter() {
  const R = rng(5757);
  const vc = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const shiny = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45 });
  const leafMat = new THREE.MeshStandardMaterial({ map: TEX.birch, alphaTest: 0.5, roughness: 0.9, vertexColors: true, side: THREE.DoubleSide });
  const K = Q.ferns ?? 1;
  const kinds = [
    { geo: coneGeo(), mat: vc, n: 7000 * K, far: 45, scale: [0.8, 1.3], test: (x, z) => nearConifer(x, z, 4), tint: () => [1, 1, 1] },
    { geo: twigGeo(R), mat: M.deadwood.clone(), n: 3500 * K, far: 65, scale: [0.4, 1.4], test: (x, z) => forestDensity(x, z) > 0.25, tint: () => [1, 1, 1] },
    { geo: stoneGeo(R), mat: vc, n: 2600 * K, far: 60, scale: [0.04, 0.16], test: () => true, tint: () => [1, 1, 1] },
    { geo: mushroomGeo(0), mat: shiny, n: 350 * K, far: 40, scale: [0.8, 1.6], test: (x, z) => forestDensity(x, z) > 0.45, tint: () => [1, 1, 1] },
    { geo: mushroomGeo(1), mat: shiny, n: 260 * K, far: 40, scale: [0.9, 1.8], test: (x, z) => nearBirch(x, z, 6) || forestDensity(x, z) > 0.55, tint: () => [1, 1, 1] },
    { geo: mushroomGeo(2), mat: shiny, n: 300 * K, far: 40, scale: [0.7, 1.3], test: (x, z) => forestDensity(x, z) > 0.35, tint: () => [1, 1, 1] },
    { geo: leafPatchGeo(), mat: leafMat, n: 3000 * K, far: 55, scale: [0.35, 0.8], test: (x, z) => nearBirch(x, z, 7), tint: () => R() < 0.5 ? [0.9, 0.75, 0.35] : [0.7, 0.62, 0.3] }
  ];
  kinds[1].mat.vertexColors = true;
  for (const K2 of kinds) {
    const pts = [];
    for (let t = 0; t < K2.n * 8 && pts.length < K2.n; t++) {
      const x = R.range(-MAP.PLAY, MAP.PLAY), z = R.range(-MAP.PLAY, MAP.PLAY);
      if (lakeRho(x, z) < 1.04 || pathInfluence(x, z, 0.3) > 0.4 || !K2.test(x, z)) continue;
      if (!isFree(x, z, 0.1, { pathPad: -0.2, trenchPad: 0.4, lake: 1.04 })) continue;
      pts.push([x, z]);
    }
    const tiles = new Map();
    for (const p of pts) {
      const k = Math.floor(p[0] / TILE) * 1024 + Math.floor(p[1] / TILE);
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push(p);
    }
    for (const list of tiles.values()) {
      const im = new THREE.InstancedMesh(K2.geo, K2.mat, list.length);
      let cx = 0, cz = 0;
      list.forEach(([x, z], i) => {
        const s = R.range(K2.scale[0], K2.scale[1]);
        terrainNormal(x, z, _n);
        _q.setFromUnitVectors(UP, _n);
        _q2.setFromAxisAngle(UP, R() * TAU);
        _q.multiply(_q2);
        _p.set(x, hFast(x, z) - 0.005, z);
        im.setMatrixAt(i, _m.compose(_p, _q, _s.set(s, s, s)));
        const tn = K2.tint(), v = R.range(0.8, 1.15);
        im.setColorAt(i, _c.setRGB(tn[0] * v, tn[1] * v, tn[2] * v));
        cx += x / list.length; cz += z / list.length;
      });
      im.receiveShadow = true; im.castShadow = false; im.frustumCulled = true;
      im.computeBoundingSphere();
      im.name = 'litter';
      scene.add(im); NO_REFLECT.push(im);
      TILES.push({ im, x: cx, z: cz, far: K2.far });
    }
  }
}
function nearConifer(x, z, r) {
  for (const t of nearTrees(x, z, r)) if (t.sp !== 'birch') return true;
  return false;
}
function nearBirch(x, z, r) {
  for (const t of nearTrees(x, z, r)) if (t.sp === 'birch') return true;
  return false;
}
// сетка деревьев 8 м для быстрой проверки при расстановке
let TG = null;
function nearTrees(x, z, r) {
  if (!TG) {
    TG = new Map();
    for (const t of TREES) { const k = Math.floor(t.x / 8) * 4096 + Math.floor(t.z / 8); if (!TG.has(k)) TG.set(k, []); TG.get(k).push(t); }
  }
  const out = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const L = TG.get(Math.floor(x / 8 + i) * 4096 + Math.floor(z / 8 + j));
    if (L) for (const t of L) if (Math.hypot(t.x - x, t.z - z) < r) out.push(t);
  }
  return out;
}
export function updateLitter() {
  const cp = camera.position;
  const agl = cp.y - hFast(cp.x, cp.z);
  for (const t of TILES) t.im.visible = agl < 40 && Math.hypot(t.x - cp.x, t.z - cp.z) - TILE * 0.7 < t.far;
}
