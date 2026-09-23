import * as THREE from 'three';

/* ============================================================================
   АТМОСФЕРА: высотный туман с подсветкой от солнца
   Подменяет штатные чанки тумана three.js во всех материалах сразу:
   • плотность падает с высотой (интеграл экспоненты вдоль луча): в низинах
     и над озером туман гуще, кроны и небо над ними — чище, с дрона видно дальше;
   • в сторону солнца туман светится его цветом — золотая дымка на закате,
     голубоватая от луны ночью.
   Юниформы общие для всех программ: значение-вектор не клонируется при
   сборке материала, поэтому обновляется одним присваиванием за кадр.
============================================================================ */
class SharedVec3 extends THREE.Vector3 { clone() { return this; } }
class SharedVec4 extends THREE.Vector4 { clone() { return this; } }
export const ATMO = {
  sunDir: new SharedVec3(0, 1, 0),
  sunColor: new SharedVec3(0, 0, 0),
  height: new SharedVec4(0, 1 / 14, 1, 0)       // основание, 1/высота слоя, доля высотного эффекта
};
const extra = {
  fogSunDir: { value: ATMO.sunDir },
  fogSunColor: { value: ATMO.sunColor },
  fogHeight: { value: ATMO.height }
};
Object.assign(THREE.UniformsLib.fog, extra);
for (const k of Object.keys(THREE.ShaderLib)) {
  const u = THREE.ShaderLib[k].uniforms;
  if (u && u.fogColor) Object.assign(u, extra);
}

THREE.ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;
// мировая точка из видовой: w = c + Rᵀ·mv (без обращения матриц)
THREE.ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  uniform vec4 fogHeight;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
  {
    vec3 fd = vFogWorld - cameraPosition;
    float fdist = length(fd);
    vec3 fdir = fd / max(fdist, 1e-4);
    #ifdef FOG_EXP2
      float kH = max(fogHeight.y, 1e-4);
      float hc = cameraPosition.y - fogHeight.x, hp = vFogWorld.y - fogHeight.x;
      float dh = hp - hc;
      float integ = abs(dh) > 0.05 ? (exp(-kH * hc) - exp(-kH * hp)) / (kH * dh) : exp(-kH * hc);
      float dens = fogDensity * mix(1.0, clamp(integ, 0.05, 3.0), fogHeight.z);
      float fogFactor = 1.0 - exp(- dens * dens * fdist * fdist);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    float sunAmt = pow(max(dot(fdir, fogSunDir), 0.0), 6.0);
    vec3 fcol = fogColor + fogSunColor * sunAmt;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fcol, clamp(fogFactor, 0.0, 1.0));
  }
#endif`;
