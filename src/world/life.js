import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { rng, TAU, clamp, lerp, sr, srnd } from '../core/math.js';
import { MAP, lakeRho, lakeContour, terrainH } from './layout.js';
import { addRipple } from './lake.js';
import { FX } from '../fx/particles.js';
import { fishSound } from '../fx/audio.js';
import { WIND } from './wind.js';

/* ============================================================================
   ЖИВНОСТЬ
   Светлячки в сумерках над травой и у воды, днём — бабочки над полянами и
   стрекозы над камышом, в озере плещет рыба. Всё движется на GPU: траектории
   — сумма синусов от случайных параметров, CPU только двигает юниформы.
============================================================================ */
const LIFE = { flies: null, bugs: null, nextFish: 5 };

function buildFireflies() {
  const N = Math.round(420 * (Q.ferns ?? 1)), pos = new Float32Array(N * 3), rnd = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { pos[i * 3] = srnd(); pos[i * 3 + 1] = srnd(); pos[i * 3 + 2] = srnd(); for (let k = 0; k < 4; k++) rnd[i * 4 + k] = srnd(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aR', new THREE.BufferAttribute(rnd, 4));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uT: { value: 0 }, uC: { value: new THREE.Vector3() }, uO: { value: 0 }, uG: { value: 0 } },
    vertexShader: `attribute vec4 aR; uniform float uT, uG; uniform vec3 uC; varying float vA;
      void main(){
        vec3 box = vec3(60.0, 1.0, 60.0);
        vec3 p = position * box;
        p.x += sin(uT * (0.2 + aR.x * 0.3) + aR.y * 20.0) * 2.0;
        p.z += cos(uT * (0.17 + aR.z * 0.3) + aR.x * 20.0) * 2.0;
        vec3 w = uC + mod(p - uC + box * 0.5, box) - box * 0.5;
        w.y = uG + 0.4 + aR.w * 2.2 + sin(uT * (0.5 + aR.y) + aR.z * 9.0) * 0.35;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        // вспышка: короткий импульс раз в 2–5 с, у каждого свой ритм
        float ph = fract(uT * (0.2 + aR.x * 0.25) + aR.y);
        float blink = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.1, 0.35, ph));
        vA = blink * smoothstep(40.0, 8.0, d);
        gl_PointSize = clamp(90.0 / d, 1.5, 9.0);
      }`,
    fragmentShader: `uniform float uO; varying float vA;
      void main(){ float r = length(gl_PointCoord - 0.5); float a = (smoothstep(0.5, 0.0, r) * 0.6 + smoothstep(0.15, 0.0, r)) * vA * uO;
        gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * a * 2.5, a); }`
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 8;
  scene.add(pts); NO_REFLECT.push(pts);
  LIFE.flies = pts;
}

/** Бабочки и стрекозы: две пары «крыльев» на инстанс, взмахи в шейдере. */
function buildBugs() {
  const pos = [], side = [], idx = [];
  // крылья: 4 треугольника (переднее и заднее крыло с каждой стороны)
  for (const s of [-1, 1]) for (const [w, l, off] of [[1, 0.9, 0.15], [0.75, 0.6, -0.25]]) {
    const b = pos.length / 3;
    pos.push(0, 0, off, s * w, 0, off + l * 0.5, s * w * 0.8, 0, off - l * 0.4);
    side.push(0, s, s);
    idx.push(b, b + 1, b + 2);
  }
  // тельце
  const b = pos.length / 3;
  pos.push(-0.05, 0, 0.5, 0.05, 0, 0.5, 0, 0, -0.9); side.push(0, 0, 0); idx.push(b, b + 1, b + 2);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  const R = rng(3131), anchors = [], params = [], cols = [];
  const add = (x, z, kind) => {
    anchors.push(x, terrainH(x, z), z, kind);
    params.push(srnd(), srnd(), srnd(), srnd());
    if (kind > 0.5) cols.push(0.12, 0.35, 0.55); // стрекоза: синеватая
    else { const c = [[0.95, 0.93, 0.85], [0.95, 0.8, 0.25], [0.85, 0.45, 0.15], [0.9, 0.9, 0.95]][R.int(0, 3)]; cols.push(...c); }
  };
  for (let i = 0; i < 60; i++) {
    // бабочки: поляны у озера и опушки
    const [x, z] = lakeContour(R() * TAU, R.range(4, 26));
    add(x, z, 0);
  }
  for (let i = 0; i < 36; i++) {
    const [x, z] = lakeContour(R() * TAU, R.range(-5, 1));
    add(x, z, 1);
  }
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(new Float32Array(anchors), 4));
  g.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array(params), 4));
  g.setAttribute('aC', new THREE.InstancedBufferAttribute(new Float32Array(cols), 3));
  g.instanceCount = anchors.length / 4;
  const m = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, transparent: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uT: { value: 0 }, uDay: { value: 1 }, uW: { value: new THREE.Vector2() }, uL: { value: new THREE.Color(1, 1, 1) } }]),
    vertexShader: `attribute vec4 aA, aP; attribute vec3 aC; attribute float aSide;
      uniform float uT, uDay; uniform vec2 uW; varying vec3 vC;
      #include <fog_pars_vertex>
      void main(){
        float drag = aA.w;
        float sp = mix(0.35, 1.1, drag);
        float t = uT * sp + aP.x * 50.0;
        // блуждание вокруг якоря: стрекоза — резкие рывки над водой, бабочка — порхание
        vec3 c = aA.xyz;
        vec3 off = vec3(sin(t * 0.7 + aP.y * 6.0) * 4.0 + sin(t * 1.9) * 1.2, 0.0, cos(t * 0.6 + aP.z * 6.0) * 4.0 + cos(t * 2.3) * 1.2);
        if (drag > 0.5) off += vec3(sin(t * 3.1), 0.0, cos(t * 2.7)) * 1.5 * step(0.5, fract(t * 0.3));
        float y = mix(0.4 + abs(sin(t * 2.2 + aP.w * 6.0)) * 0.6 + aP.w * 1.2, 0.5 + aP.w * 0.8, drag);
        vec3 wp = c + off + vec3(0.0, y, 0.0);
        wp.xz += uW * 0.6 * (1.0 - drag);
        vec3 dir = normalize(vec3(cos(t * 0.7 + aP.y * 6.0) * 2.8 + cos(t * 1.9) * 2.2, 0.0, -sin(t * 0.6 + aP.z * 6.0) * 2.4 - sin(t * 2.3) * 2.7) + 1e-4);
        float yaw = atan(dir.x, dir.z);
        float flap = drag > 0.5 ? sin(uT * 60.0 + aP.x * 9.0) * 0.25 : sin(uT * (11.0 + aP.y * 4.0) + aP.x * 9.0) * 0.9;
        vec3 p = position;
        float scl = drag > 0.5 ? 0.045 : 0.03 + aP.z * 0.015;
        if (drag > 0.5) p.x *= 1.3;
        p.y += abs(p.x) * sin(flap) * aSide * aSide * 1.2;
        p.x *= cos(flap * 0.8);
        p *= scl;
        float cy = cos(yaw), sy = sin(yaw);
        p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
        // днём видны, к вечеру прячутся
        p *= step(0.5, uDay);
        vC = aC;
        vec4 mvPosition = viewMatrix * vec4(wp + p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform vec3 uL; varying vec3 vC;
      #include <fog_pars_fragment>
      void main(){ gl_FragColor = vec4(vC * uL, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  scene.add(mesh); NO_REFLECT.push(mesh);
  LIFE.bugs = mesh;
}

export function buildLife() { buildFireflies(); buildBugs(); }

export function updateLife(dt, sky) {
  const t = FRAME.t, cp = camera.position;
  if (LIFE.flies) {
    const u = LIFE.flies.material.uniforms;
    u.uT.value = t; u.uC.value.copy(cp);
    u.uG.value = terrainH(cp.x, cp.z);
    u.uO.value = clamp((sky.night - 0.35) * 1.8, 0, 1) * (cp.y - u.uG.value < 25 ? 1 : 0);
  }
  if (LIFE.bugs) {
    const u = LIFE.bugs.material.uniforms;
    u.uT.value = t; u.uDay.value = sky.night < 0.4 ? 1 : 0;
    u.uW.value.copy(WIND.dir).multiplyScalar(WIND.strength);
    const k = lerp(1.0, 0.1, sky.night) * (0.35 + sky.sunI * 0.15);
    u.uL.value.setRGB(k, k, k);
  }
  // рыба: всплеск и кольца, если озеро рядом
  if (t > LIFE.nextFish) {
    LIFE.nextFish = t + sr(3, 11);
    const near = lakeRho(cp.x, cp.z) < 2.5;
    if (near) {
      const [cx, cz] = lakeContour(srnd() * TAU, 0), k = sr(0.25, 0.8);
      const x = cx * k, z = cz * k;
      addRipple(x, z, sr(0.25, 0.5));
      for (let i = 0; i < 6; i++) FX.alpha.spawn({ x, y: MAP.WATER_Y + 0.05, z, vx: sr(-0.6, 0.6), vy: sr(1, 2.2), vz: sr(-0.6, 0.6), size: 0.12, grow: 0.3, life: 0.6, col: [0.8, 0.84, 0.88], a: 0.5, grav: 7 });
      fishSound(x, z);
    }
  }
}
