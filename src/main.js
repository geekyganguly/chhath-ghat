import * as THREE from 'three';
import { Peer } from 'peerjs';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import './style.css';
import { createMusic } from './music.js';

// ---------------------------------------------------------------- constants
const APP = 'chhath-patna-ghat-v1';
// shown on the hoarding in the river and the start screen
const DEV = { name:'Saurav Ganguly', role:'Developer', url:'https://www.sauravganguly.in/', link:'www.sauravganguly.in',
  photo:'https://avatars.githubusercontent.com/u/58353139?s=320' };
const DAY = 300;               // seconds in one game day
const DIYA_LIFE = 140000;      // ms
const ARGHYA_COOLDOWN = 3000;  // ms
const WALK_X = 64;             // how far along the ghat you can walk; the bazaars sit at both ends past x=±48
const STALL_REACH = 3;         // how close to a stall's counter you need to be to buy from it
// a devotee's soop is one number: the SOOP bit says they hold one, the low 5 bits say which ITEMS are in it
const SOOP = 32, PRASAD = 31;
const COLORS = ['#e63946','#ff7b00','#ffc300','#ff4d8d','#7b2cbf','#3a86ff','#2a9d8f','#38b000'];
const ITEMS = [
  { name:'Thekua',  e:'🍪', color:0xb5651d },
  { name:'Kela',    e:'🍌', color:0xffd43b },
  { name:'Nariyal', e:'🥥', color:0x6b4423 },
  { name:'Ganna',   e:'🎋', color:0x5a9e2f },
  { name:'Santra',  e:'🍊', color:0xff8c1a },
];
const QUICK = ['Jai Chhathi Maiya! 🙏','Kaanch hi baans ke bahangiya 🎶','Ugi he Suruj Dev ☀️','Thekua khaibu? 🍪','Chhath Puja ki shubhkamnayein!','Ganga Maiya ki jai 🌊'];
// [time s, sun angle deg] — 0° = rising in the east, 180° = setting in the west
const SUN_KEYS = [[0,165],[60,183],[90,210],[150,330],[180,357],[240,375],[300,525]];
const PHASES = [
  { from:0,   to:60,  name:'🌇 Sandhya Arghya', sub:'Offer arghya to the setting sun', bless:true },
  { from:60,  to:90,  name:'🌆 Godhuli · Dusk', sub:'Float diyas on the Ganga' },
  { from:90,  to:150, name:'🌙 Kosi Raat · Night', sub:'Diyas glow along the ghat — sing Chhath geet' },
  { from:150, to:180, name:'🌌 Bhor · Pre-dawn', sub:'Fill your soop, sunrise is near' },
  { from:180, to:240, name:'🌅 Usha Arghya', sub:'Offer arghya to the rising sun', bless:true },
  { from:240, to:300, name:'☀️ Din · Daytime', sub:'Prepare thekua & soop for the evening' },
];

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const rand = (a,b) => a + Math.random()*(b-a);
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const lerp = (a,b,t) => a + (b-a)*t;
const uid = () => Math.random().toString(36).slice(2,9);
const clean = (s,n=16) => String(s ?? '').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,n);
const lerpAngle = (a,b,t) => { const d = ((b-a+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI; return a + d*t; };
const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;

// Ghat profile: land at y=3.2 behind z=-14, 8 steps down to the water at z=0, riverbed slopes after.
function groundY(z) {
  if (z < -14) return 3.2;
  if (z < 0) return (Math.min(7, Math.floor(-z/1.75)) + 1) * 0.4;
  return -Math.min(1.15, 0.25 + z*0.12);
}
const waveY = (x,z,t) => 0.07*Math.sin(0.35*x + t*1.1) + 0.05*Math.sin(0.45*z + t*0.8);

// ---------------------------------------------------------------- shared state
const world = { start: Date.now() - 5000, players: new Map(), diyas: [] };
// dev only: ?t=<seconds> starts the day at that time (e.g. ?t=120 for night, ?t=270 for daytime)
if (import.meta.env.DEV && new URLSearchParams(location.search).has('t')) world.start = Date.now() - +new URLSearchParams(location.search).get('t')*1000;
let clockOffset = 0;
const netNow = () => Date.now() + clockOffset;
const me = { name:'', color:COLORS[1], kind:'woman', soop:0, x:rand(-12,12), z:-18, y:3.2, r:0, moving:false, offerUntil:0, lastDiya:0 };
const net = { mode:'off', peer:null, isHost:false, myId:'local', hostConn:null, conns:new Map(), gen:0, room:'public', count:1 };
let started = false;

function dayTime() { const t = ((netNow() - world.start)/1000) % DAY; return t < 0 ? t + DAY : t; }
function phaseAt(t) { return PHASES.find(p => t >= p.from && t < p.to) || PHASES[0]; }
function sunTheta(t) {
  for (let i = 0; i < SUN_KEYS.length-1; i++) {
    const [t0,a0] = SUN_KEYS[i], [t1,a1] = SUN_KEYS[i+1];
    if (t <= t1) return THREE.MathUtils.degToRad(lerp(a0, a1, (t-t0)/(t1-t0)));
  }
  return THREE.MathUtils.degToRad(165);
}

// ---------------------------------------------------------------- renderer & scene
const canvas = $('#c');
// alpha so the projector screen can punch a hole through to the YouTube player rendered by CSS3DRenderer underneath
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xff8844, 70, 430);
const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.1, 1200);
const cssRenderer = new CSS3DRenderer(); cssRenderer.setSize(innerWidth, innerHeight);
cssRenderer.domElement.id = 'css3d'; document.body.prepend(cssRenderer.domElement);
const cssScene = new THREE.Scene();

// graphics quality: "high" adds soft sun shadows + bloom glow (environment lighting is always on)
const gfx = { high: (() => {
  try { const q = localStorage.getItem('chhath-gfx'); if (q) return q === 'high'; } catch {}
  return !matchMedia('(pointer:coarse)').matches;
})() };
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type:THREE.HalfFloatType, samples:4 }));
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.82);
// add the glow to colour only and keep alpha, so the projector-screen hole stays see-through to the video
Object.assign(bloom.blendMaterial, { blending:THREE.CustomBlending, blendSrc:THREE.OneFactor, blendDst:THREE.OneFactor, blendSrcAlpha:THREE.ZeroFactor, blendDstAlpha:THREE.OneFactor });
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); cssRenderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); });

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowTex = canvasTex(64, 64, (g) => {
  const gr = g.createRadialGradient(32,32,0,32,32,32);
  gr.addColorStop(0,'rgba(255,255,240,1)'); gr.addColorStop(.2,'rgba(255,210,120,.9)');
  gr.addColorStop(.5,'rgba(255,140,40,.3)'); gr.addColorStop(1,'rgba(255,120,30,0)');
  g.fillStyle = gr; g.fillRect(0,0,64,64);
});
const glowMat = (color, opacity=1) => new THREE.SpriteMaterial({ map:glowTex, color, transparent:true, opacity, depthWrite:false, blending:THREE.AdditiveBlending, fog:false });

function textSprite(text, { size=40, color='#fff8ec', bg='rgba(20,10,30,.6)', height=0.34 } = {}) {
  const font = `700 ${size}px system-ui,-apple-system,sans-serif`;
  const m = document.createElement('canvas').getContext('2d'); m.font = font;
  const w = Math.ceil(m.measureText(text).width) + size, h = Math.round(size*1.5);
  const tex = canvasTex(w, h, (g) => {
    g.font = font; g.fillStyle = bg; g.beginPath(); g.roundRect(0,0,w,h,h/2); g.fill();
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w/2, h/2+2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, fog:false }));
  s.scale.set(height*w/h, height, 1); s.renderOrder = 10;
  return s;
}
function disposeSprite(s) { s.parent?.remove(s); s.material.map?.dispose(); s.material.dispose(); }

// ---------------------------------------------------------------- sky
const skyGroup = new THREE.Group(); scene.add(skyGroup);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite:false, fog:false, toneMapped:false,
  uniforms: { top:{value:new THREE.Color()}, horizon:{value:new THREE.Color()}, sunCol:{value:new THREE.Color()}, sunDir:{value:new THREE.Vector3(0,1,0)}, gain:{value:1} },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 top, horizon, sunCol, sunDir; uniform float gain; varying vec3 vDir;
    void main(){ vec3 d = normalize(vDir); float h = max(d.y, 0.0);
      vec3 c = mix(horizon, top, pow(h, 0.55));
      float s = max(dot(d, sunDir), 0.0);
      c += sunCol * (pow(s, 6.0)*0.45 + pow(s, 120.0)*0.8);
      if (d.y < 0.0) c = horizon;
      gl_FragColor = vec4(c*gain, 1.0);
      #include <colorspace_fragment>
    }`
});
skyGroup.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMat));
const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(11, 24, 16), new THREE.MeshBasicMaterial({ color:0xffaa55, fog:false, toneMapped:false }));
const sunGlow = new THREE.Sprite(glowMat(0xff9944, .9)); sunGlow.scale.set(110,110,1);
const moon = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 14), new THREE.MeshBasicMaterial({ color:0xf3f0e0, fog:false, toneMapped:false, transparent:true }));
skyGroup.add(sunDisc, sunGlow, moon);
const stars = (() => {
  const pos = [];
  for (let i = 0; i < 900; i++) {
    const a = Math.random()*Math.PI*2, e = Math.asin(Math.random()*0.95 + 0.04);
    pos.push(Math.cos(a)*Math.cos(e)*460, Math.sin(e)*460, Math.sin(a)*Math.cos(e)*460);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color:0xffffff, size:1.6, sizeAttenuation:false, transparent:true, fog:false, depthWrite:false }));
})();
skyGroup.add(stars);

// image-based lighting rendered from our own sky, so reflections and fill light follow sunset → night → sunrise
const pmrem = new THREE.PMREMGenerator(renderer);
// same sky (shared uniforms) but dimmer, so the fill light doesn't wash out the sun's shading and shadows
const envSkyMat = new THREE.ShaderMaterial({ side:THREE.BackSide, depthWrite:false, vertexShader:skyMat.vertexShader, fragmentShader:skyMat.fragmentShader,
  uniforms: { ...skyMat.uniforms, gain:{ value:0.4 } } });
const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), envSkyMat));
let envRT = null, envT = 0;
function updateEnv(dt) {
  if ((envT -= dt) > 0) return;
  envT = gfx.high ? 1 : 3;
  const rt = pmrem.fromScene(envScene, 0, 0.1, 1000);
  scene.environment = rt.texture; envRT?.dispose(); envRT = rt;
}

const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b4a2a, 1); scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffe2c4, 0.2); scene.add(ambient);
const sunLight = new THREE.DirectionalLight(0xffffff, 2); scene.add(sunLight, sunLight.target);
sunLight.shadow.mapSize.set(2048, 2048);
Object.assign(sunLight.shadow.camera, { left:-28, right:28, top:28, bottom:-28, near:1, far:220 });
sunLight.shadow.camera.updateProjectionMatrix();
sunLight.shadow.bias = -0.0004; sunLight.shadow.normalBias = 0.04;
const moonLight = new THREE.DirectionalLight(0x8aa4ff, 0.3); moonLight.position.set(-40, 80, 60); scene.add(moonLight);

// ---------------------------------------------------------------- ghat, river & Patna skyline
const std = (color, extra={}) => new THREE.MeshStandardMaterial({ color, roughness:0.9, ...extra });
// steps
for (let i = 0; i < 8; i++) {
  const top = 0.4*(i+1), h = top + 2;
  const m = new THREE.Mesh(new THREE.BoxGeometry(140, h, 1.75), std(i%2 ? 0xbf9d72 : 0xd2b088));
  m.position.set(0, top - h/2, -(i+0.5)*1.75); scene.add(m);
  // painted red edge on each step — common on decorated Chhath ghats
  const edge = new THREE.Mesh(new THREE.BoxGeometry(140, 0.08, 0.15), std(i%2 ? 0xc0392b : 0xf4f1e8));
  edge.position.set(0, top+0.01, -i*1.75 - 0.08); scene.add(edge);
}
const land = new THREE.Mesh(new THREE.BoxGeometry(200, 5.2, 80), std(0xb89a72)); land.position.set(0, 0.6, -54); scene.add(land);
const bed = new THREE.Mesh(new THREE.PlaneGeometry(200, 60), std(0x5a4a35)); bed.rotation.x = -Math.PI/2; bed.position.set(0, -1.3, 22); scene.add(bed);

// water with gentle CPU waves
const waterGeo = new THREE.PlaneGeometry(900, 620, 110, 70); waterGeo.rotateX(-Math.PI/2); waterGeo.translate(0, 0, 306);
const waterBase = Float32Array.from(waterGeo.attributes.position.array);
// on top of the CPU swell, the shader adds fine wind ripples per pixel (bent normals catch the sky reflection
// and glitter under lamps/diyas), plus a fresnel alpha: see-through looking down, mirror-like at grazing angles
const waterTime = { value:0 };
const waterMat = new THREE.MeshStandardMaterial({ color:0x1d2f29, roughness:0.07, metalness:0, envMapIntensity:2.2, transparent:true });
waterMat.onBeforeCompile = (sh) => {
  sh.uniforms.uTime = waterTime;
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterWorld = (modelMatrix*vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>
      uniform float uTime; varying vec3 vWaterWorld;
      // slope of one travelling sine wave
      vec2 rip(vec2 p, vec2 dir, float k, float speed, float amp) { return amp*k*cos(dot(normalize(dir), p)*k + uTime*speed)*normalize(dir); }`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec2 p = vWaterWorld.xz;
        float fade = 1.0/(1.0 + 0.035*distance(vWaterWorld, cameraPosition));   // calm the far water so it doesn't shimmer
        vec2 g = rip(p, vec2(0.2, 1.0), 0.9, 1.3, 0.05) + rip(p, vec2(-0.7, 0.6), 1.7, 1.9, 0.03)
               + rip(p, vec2(0.9, 0.35), 3.1, 2.6, 0.016) + rip(p, vec2(-0.3, -0.95), 5.3, 3.4, 0.009)
               + rip(p, vec2(0.6, -0.8), 8.7, 4.6, 0.005) + rip(p, vec2(-1.0, 0.15), 13.0, 5.8, 0.003);
        normal = normalize(normal + (viewMatrix*vec4(-g.x*fade, 0.0, -g.y*fade, 0.0)).xyz);
      }`)
    // the glossy surface focuses the low sun into a blinding white blob (then bloomed); cap direct highlights
    // so the sun/lamp reflections stay a coloured glitter path
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(0.7));`)
    .replace('#include <opaque_fragment>', `
      float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      diffuseColor.a = mix(0.6, 0.98, fres);
      #include <opaque_fragment>`);
};
const water = new THREE.Mesh(waterGeo, waterMat);
scene.add(water);
// sun path on water
const pathTex = canvasTex(64, 256, (g,w,h) => {
  const gx = g.createLinearGradient(0,0,w,0);
  gx.addColorStop(0,'rgba(255,255,255,0)'); gx.addColorStop(.5,'rgba(255,255,255,1)'); gx.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle = gx; g.fillRect(0,0,w,h);
  g.globalCompositeOperation = 'destination-in';
  const gy = g.createLinearGradient(0,0,0,h); gy.addColorStop(0,'rgba(0,0,0,1)'); gy.addColorStop(.85,'rgba(0,0,0,.6)'); gy.addColorStop(1,'rgba(0,0,0,0)');
  g.fillStyle = gy; g.fillRect(0,0,w,h);
});
const sunPathGeo = new THREE.PlaneGeometry(10, 260); sunPathGeo.rotateX(-Math.PI/2); sunPathGeo.translate(0, 0, 130);
const sunPath = new THREE.Mesh(sunPathGeo, new THREE.MeshBasicMaterial({ map:pathTex, color:0xffaa55, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false }));
scene.add(sunPath);

// skyline buildings with windows that light up at night
const winCount = 400;
const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.8, 1.1), new THREE.MeshBasicMaterial({ color:0xffc870 }), winCount);
let wi = 0; const dummy = new THREE.Object3D();
const bColors = [0xd9a066,0xe8c39e,0xc97b63,0xf2d0a4,0xb5838d,0xe9d8a6,0xd4a373];
for (let x = -80; x < 80; ) {
  const w = rand(6, 10), h = rand(6, 18), z = -32 - rand(0, 4);
  if (Math.abs(x + 20) < 6 || Math.abs(x - 30) < 5) { x += 10; continue; } // leave room for temples
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 8), std(bColors[(Math.random()*bColors.length)|0]));
  b.position.set(x + w/2, 3.2 + h/2, z - 4); scene.add(b);
  for (let fy = 4.5; fy < h + 2.5 && wi < winCount; fy += 2.6)
    for (let fx = x + 1.2; fx < x + w - 0.8 && wi < winCount; fx += 1.9) {
      if (Math.random() < 0.35) continue;
      dummy.position.set(fx, fy, z + 0.02); dummy.updateMatrix(); windows.setMatrixAt(wi++, dummy.matrix);
    }
  x += w + rand(0.3, 1.5);
}
windows.count = wi; scene.add(windows);
function temple(x, z, s=1) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(6*s, 4*s, 6*s), std(0xf1e3c8)); base.position.y = 2*s;
  const shikhara = new THREE.Mesh(new THREE.ConeGeometry(3.2*s, 8*s, 8), std(0xf4a259)); shikhara.position.y = 8*s;
  const kalash = new THREE.Mesh(new THREE.SphereGeometry(0.45*s, 10, 8), std(0xffd166, { metalness:.6, roughness:.3 })); kalash.position.y = 12.3*s;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3*s), std(0x553311)); pole.position.y = 13.5*s;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6*s, 0.9*s), std(0xff5500, { side:THREE.DoubleSide })); flag.position.set(0.8*s, 14.4*s, 0);
  g.add(base, shikhara, kalash, pole, flag); g.position.set(x, 3.2, z); scene.add(g);
}
temple(-20, -30, 1.1); temple(30, -29, 0.85);

// lamp posts + marigold garlands along the top of the ghat
const lampMat = glowMat(0xffb347, 1);
const garland = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 6, 5), std(0xffffff), 9*16);
let gi = 0;
const postXs = []; for (let x = -54; x <= 54; x += 12) postXs.push(x);
postXs.forEach((x, i) => {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 3.6), std(0x3b2a1a)); post.position.set(x, 3.2 + 1.8, -27.5); scene.add(post);
  const lamp = new THREE.Sprite(lampMat); lamp.position.set(x, 7.1, -27.5); lamp.scale.set(2.2, 2.2, 1); scene.add(lamp);
  if (i < postXs.length - 1) for (let k = 0; k < 16; k++) {
    const t = (k+0.5)/16; dummy.position.set(x + 12*t, 6.6 - Math.sin(Math.PI*t)*1.1, -27.5); dummy.updateMatrix();
    garland.setMatrixAt(gi, dummy.matrix); garland.setColorAt(gi++, new THREE.Color(k%2 ? 0xffb703 : 0xfb8500));
  }
});
garland.count = gi; scene.add(garland);
const lampLights = [-32, 0, 32].map(x => { const l = new THREE.PointLight(0xffaa55, 0, 40, 1.6); l.position.set(x, 6, -9); scene.add(l); return l; });

// loudspeakers (horn "bhonpu" speakers on bamboo poles) playing Chhath geet for the whole ghat
const hornMat = std(0xc3c7cc, { metalness:.6, roughness:.35, side:THREE.DoubleSide }), bambooMat = std(0x9c7a45);
const hornGeo = new THREE.ConeGeometry(0.55, 1.3, 18, 1, true); hornGeo.rotateX(-Math.PI/2);
const driverGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.4, 12); driverGeo.rotateX(Math.PI/2);
const speakers = [];
for (const x of [-40, -14, 14, 40]) {
  const z = -15.5, top = 3.2 + 7;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 7.4), bambooMat); pole.position.set(x, 3.2 + 3.7, z); scene.add(pole);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), bambooMat); bar.position.set(x, top - 0.45, z); scene.add(bar);
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    const horn = new THREE.Mesh(hornGeo, hornMat); horn.position.z = 0.55;
    const driver = new THREE.Mesh(driverGeo, hornMat); driver.position.z = -0.25;
    g.add(horn, driver); g.position.set(x + 0.55*s, top - 0.2, z); g.rotation.set(0.22, s*0.55, 0, 'YXZ');
    scene.add(g);
  }
  speakers.push(new THREE.Vector3(x, top, z));
}
const music = createMusic(() => (netNow() - world.start)/1000);

// big projector screen standing in the Ganga, facing the ghat — the YouTube player is shown on it,
// and a Chhath poster covers it whenever the video isn't playing
let posterMesh, posterNote = null;
function drawPoster(note) {
  return canvasTex(1024, 576, (g, w, h) => {
    const sky = g.createLinearGradient(0, 0, 0, h*0.62);
    sky.addColorStop(0, '#3b1c4a'); sky.addColorStop(0.55, '#d9481c'); sky.addColorStop(1, '#ffb347');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    const sun = g.createRadialGradient(w/2, h*0.62, 10, w/2, h*0.62, 150);
    sun.addColorStop(0, '#fff6d0'); sun.addColorStop(0.45, '#ffc14d'); sun.addColorStop(0.75, 'rgba(255,120,30,.6)'); sun.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = sun; g.fillRect(0, 0, w, h);
    const river = g.createLinearGradient(0, h*0.62, 0, h);
    river.addColorStop(0, '#7a2e1c'); river.addColorStop(1, '#1d1030');
    g.fillStyle = river; g.fillRect(0, h*0.62, w, h);
    g.fillStyle = 'rgba(255,200,110,.55)';
    for (let i = 0; i < 9; i++) { const y = h*0.64 + i*13, ww = 220 - i*18; g.fillRect(w/2 - ww/2, y, ww, 4); }
    // devotees standing in the river, holding up their soop
    g.fillStyle = '#1a0b14';
    for (const [x, s] of [[140, 1], [250, 0.85], [780, 0.9], [890, 1.05]]) {
      const y = h*0.66;
      g.beginPath(); g.moveTo(x - 26*s, y); g.lineTo(x - 15*s, y - 80*s); g.lineTo(x + 15*s, y - 80*s); g.lineTo(x + 26*s, y); g.fill();
      g.beginPath(); g.arc(x, y - 96*s, 14*s, 0, Math.PI*2); g.fill();
      g.beginPath(); g.ellipse(x + 10*s, y - 130*s, 38*s, 9*s, -0.15, 0, Math.PI*2); g.fill();
      g.fillRect(x - 4*s, y - 128*s, 5*s, 40*s); g.fillRect(x + 14*s, y - 128*s, 5*s, 40*s);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12;
    g.fillStyle = '#ffe08a'; g.font = '800 112px "Kohinoor Devanagari","Nirmala UI","Noto Sans Devanagari",system-ui,sans-serif';
    g.fillText('छठ पूजा', w/2, 105);
    g.fillStyle = '#fff4dc'; g.font = '600 46px "Kohinoor Devanagari","Nirmala UI","Noto Sans Devanagari",system-ui,sans-serif';
    g.fillText('की हार्दिक शुभकामनाएं', w/2, 185);
    g.font = '600 30px system-ui,sans-serif'; g.fillText('Jai Chhathi Maiya 🙏  ·  Patna Ghat', w/2, 240);
    if (note) {
      g.shadowBlur = 0; g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.roundRect(w/2 - 300, h - 78, 600, 52, 26); g.fill();
      g.fillStyle = '#ffd166'; g.font = '700 28px system-ui,sans-serif'; g.fillText(note, w/2, h - 51);
    }
  });
}
function updatePoster() {
  const playing = music.playing;
  posterMesh.visible = !playing;
  if (playing) return;
  const note = !music.hasSongs ? '' : !music.enabled ? '🔇 Press M to switch on the Chhath geet' : '🎵 Chhath geet starting…';
  if (note !== posterNote) { posterNote = note; posterMesh.material.map.dispose(); posterMesh.material.map = drawPoster(note); }
}
const SCREEN_W = 16, SCREEN_H = 9, SCREEN_PX = 960;
const screenPos = new THREE.Vector3(-22, 7.2, 17), screenYaw = 2.55;
{
  const g = new THREE.Group(); g.position.copy(screenPos); g.rotation.y = screenYaw; scene.add(g);
  const frameMat = std(0x1d1d22, { roughness:.6 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.8, SCREEN_H + 0.8, 0.3), frameMat); back.position.z = -0.2; g.add(back);
  // writes transparent pixels (NoBlending) so the CSS3D video behind the canvas shows through, while
  // anything nearer the camera still draws over it thanks to the depth buffer
  const hole = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), new THREE.MeshBasicMaterial({ color:0x000000, opacity:0, blending:THREE.NoBlending, fog:false }));
  hole.position.z = 0.01; g.add(hole);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 9, 0.35), frameMat); leg.position.set(s*(SCREEN_W/2 - 1.5), -SCREEN_H/2 - 3.5, -0.2); g.add(leg);
  }
  const pontoon = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 2, 1, 4), std(0x6b3e26)); pontoon.position.set(0, -screenPos.y + 0.1, -0.5); g.add(pontoon);
  posterMesh = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), new THREE.MeshBasicMaterial({ map:drawPoster(''), toneMapped:false, fog:false }));
  posterMesh.position.z = 0.02; g.add(posterMesh);
  const title = textSprite('📺 Chhath Geet · Sharda Sinha', { height:0.9, bg:'rgba(255,138,31,.9)', color:'#1b0f00' });
  title.position.set(0, SCREEN_H/2 + 1, 0); g.add(title);

  const el = document.createElement('div'); el.id = 'ytbox'; el.className = 'hidden';
  el.style.width = `${SCREEN_PX}px`; el.style.height = `${SCREEN_PX*SCREEN_H/SCREEN_W}px`;
  el.innerHTML = '<div id="yt"></div>';
  const css = new CSS3DObject(el); css.position.copy(screenPos); css.rotation.y = screenYaw; css.scale.setScalar(SCREEN_W/SCREEN_PX);
  cssScene.add(css);
}
// developer hoarding standing on the land just past the right-hand bazaar, angled towards the ghat; tap it to visit
const devBoard = (() => {
  const W = 12, H = 6;
  // drawn once straight away, then again with the photo once it has loaded
  const draw = (g, w, h, photo) => {
    const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#5a0f1f'); bg.addColorStop(1, '#2a0a35');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffd166'; g.lineWidth = 10; g.strokeRect(18, 18, w - 36, h - 36);
    // the photo sits in a gold ring on a rising-sun glow
    const cx = w - 160, cy = h/2 - 6, R = 88;
    const sun = g.createRadialGradient(cx, cy, R*0.6, cx, cy, R*1.6);
    sun.addColorStop(0, '#ffb347'); sun.addColorStop(0.45, 'rgba(255,138,31,.55)'); sun.addColorStop(1, 'rgba(255,106,26,0)');
    g.fillStyle = sun; g.fillRect(cx - R*1.7, cy - R*1.7, R*3.4, R*3.4);
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI*2); g.clip();
    if (photo) g.drawImage(photo, cx - R, cy - R, R*2, R*2);
    else { g.fillStyle = '#3b1530'; g.fillRect(cx - R, cy - R, R*2, R*2); }
    g.restore();
    g.strokeStyle = '#ffd166'; g.lineWidth = 8; g.beginPath(); g.arc(cx, cy, R + 4, 0, Math.PI*2); g.stroke();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 8;
    g.fillStyle = '#ffd166'; g.font = '700 34px system-ui,sans-serif'; g.fillText('🙏  Crafted with ❤️ by', 70, 110);
    g.fillStyle = '#fff8ec'; g.font = '800 82px system-ui,sans-serif'; g.fillText(DEV.name, 70, 210);
    g.fillStyle = '#ffb347'; g.font = '600 40px system-ui,sans-serif'; g.fillText(DEV.role, 72, 270);
    g.shadowBlur = 0; g.fillStyle = 'rgba(255,209,102,.16)'; g.beginPath(); g.roundRect(66, 318, 560, 70, 35); g.fill();
    g.fillStyle = '#fff8ec'; g.font = '600 36px system-ui,sans-serif'; g.fillText(`🔗  ${DEV.link}`, 92, 365);
    g.fillStyle = '#ffd166'; g.font = '600 26px system-ui,sans-serif'; g.fillText('Tap the board to say hello · Jai Chhathi Maiya', 70, 448);
  };
  const tex = canvasTex(1024, 512, (g, w, h) => draw(g, w, h, null));
  // GitHub serves avatars with CORS, so the canvas stays untainted and can still be uploaded as a texture
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => { const c = tex.image; draw(c.getContext('2d'), c.width, c.height, img); tex.needsUpdate = true; };
  img.src = DEV.photo;
  const LEGS = 6;   // tall enough to clear the bazaar gate sign when seen from the ghat
  const g = new THREE.Group(); g.position.set(69, 3.2 + LEGS + H/2, -19); g.rotation.y = -1.1; scene.add(g);
  const frameMat = std(0x1d1d22, { roughness:.6 });
  const back = new THREE.Mesh(new THREE.BoxGeometry(W + 0.6, H + 0.6, 0.3), frameMat); back.position.z = -0.2; g.add(back);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map:tex, toneMapped:false, fog:false }));
  face.position.z = 0.01; g.add(face);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, LEGS + 0.4, 0.35), frameMat); leg.position.set(sx*(W/2 - 1.2), -H/2 - LEGS/2 + 0.2, -0.2); g.add(leg);
  }
  const title = textSprite('📣 Developer', { height:0.8, bg:'rgba(255,138,31,.9)', color:'#1b0f00' });
  title.position.set(0, H/2 + 0.9, 0); g.add(title);
  return face;
})();

// projector on the x=-14 speaker pole, throwing a light beam onto the screen
const projector = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 1.1), std(0x2b2b30)); projector.position.set(-14, 11, -15.2); scene.add(projector);
projector.lookAt(screenPos);
// the beam is a frustum from the lens to the screen's actual corners (the screen is angled to the beam,
// so a plain cone never lined up); each side face carries along/across coords for a soft volumetric falloff
const lens = new THREE.Vector3(0, 0, 0.58).applyQuaternion(projector.quaternion).add(projector.position);
const screenMat = new THREE.Matrix4().compose(screenPos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, screenYaw, 0)), new THREE.Vector3(1, 1, 1));
const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector3(x*SCREEN_W/2*0.99, y*SCREEN_H/2*0.99, 0.03).applyMatrix4(screenMat));
const beamPos = [], beamAlong = [], beamAcross = [];
for (let i = 0; i < 4; i++) {
  const a = corners[i], b = corners[(i + 1) % 4];
  beamPos.push(lens.x, lens.y, lens.z, a.x, a.y, a.z, b.x, b.y, b.z);
  beamAlong.push(0, 1, 1); beamAcross.push(0, -1, 1);
}
const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(beamPos, 3));
beamGeo.setAttribute('along', new THREE.Float32BufferAttribute(beamAlong, 1));
beamGeo.setAttribute('across', new THREE.Float32BufferAttribute(beamAcross, 1));
const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
  uniforms: { uOpacity:{ value:0.1 }, uTime:{ value:0 }, uColor:{ value:new THREE.Color(0xfff1d6) } },
  vertexShader: `attribute float along; attribute float across; varying float vAlong; varying float vAcross; varying vec3 vWorld;
    void main(){ vAlong = along; vAcross = across; vec4 w = modelMatrix*vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `uniform float uOpacity; uniform float uTime; uniform vec3 uColor; varying float vAlong; varying float vAcross; varying vec3 vWorld;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
    void main(){
      // clamp first: interpolation can push vAlong just below 0 near the lens, and pow() of a negative is NaN,
      // which the bloom pass smears into a big black square
      float along = clamp(vAlong, 0.0, 1.0);
      float edge = 1.0 - smoothstep(0.35, 1.0, clamp(abs(vAcross)/max(along, 1e-3), 0.0, 1.0));   // soft sides
      float fall = mix(1.0, 0.18, pow(along, 0.6));                                                 // brightest at the lens
      fall *= 1.0 - smoothstep(0.85, 1.0, along);                                                   // don't wash over the screen
      fall *= smoothstep(0.0, 0.04, along);
      float dust = 0.85 + 0.15*sin(vWorld.x*1.7 + vWorld.y*2.3 + uTime*0.6)*sin(vWorld.z*1.3 - uTime*0.4);
      float a = uOpacity*edge*fall*dust*(0.96 + 0.04*hash(floor(vWorld*6.0)));
      gl_FragColor = vec4(uColor*clamp(a, 0.0, 1.0), 0.0);
    }`,
  transparent:true, depthWrite:false, side:THREE.DoubleSide,
  // add light to colour only: leaving alpha untouched keeps the video hole clear instead of greying it
  blending:THREE.CustomBlending, blendSrc:THREE.OneFactor, blendDst:THREE.OneFactor, blendSrcAlpha:THREE.ZeroFactor, blendDstAlpha:THREE.OneFactor,
}));
beam.frustumCulled = false; scene.add(beam);

// little diyas lining the steps
const stepDiyaMat = glowMat(0xffa040, 1);
for (let i = 0; i < 4; i++) for (let x = -60; x <= 60; x += rand(2.5, 4.5)) {
  const s = new THREE.Sprite(stepDiyaMat); s.position.set(x, 0.4*(i+1) + 0.18, -i*1.75 - 0.4); s.scale.set(0.7, 0.7, 1); scene.add(s);
}

// kosi — sugarcane canopies with a diya in the middle
const caneMat = std(0x4f8a2b), clothMat = std(0xd62828), clothMat2 = std(0xffbe0b);
function kosi(x, z) {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const a = i/5*Math.PI*2, c = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.6, 6), caneMat);
    c.position.set(Math.cos(a)*0.55, 1.2, Math.sin(a)*0.55); c.lookAt(0, 3.5, 0); c.rotateX(Math.PI/2); g.add(c);
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.9, 5), caneMat); leaf.position.set(Math.cos(a)*0.2, 2.75, Math.sin(a)*0.2); g.add(leaf);
  }
  const cloth = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.6, 8, 1, true), Math.random() < .5 ? clothMat : clothMat2); cloth.position.y = 2.2; g.add(cloth);
  const flame = new THREE.Sprite(lampMat); flame.position.y = 0.35; flame.scale.set(1.4, 1.4, 1); g.add(flame);
  const pot = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), std(0xb5532a)); pot.position.y = 0.15; g.add(pot);
  g.position.set(x, 3.2, z); scene.add(g);
}
for (let x = -45; x <= 45; x += 15) kosi(x + rand(-2, 2), -17.5 - rand(0, 3));

// boats & Gandhi Setu in the distance & the far bank
const boats = [];
for (let i = 0; i < 7; i++) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 6), std(0x6b3e26)); hull.position.y = 0.15;
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.4, 4), std(0x6b3e26)); bow.rotation.x = Math.PI/2; bow.position.set(0, 0.2, 3.6);
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 2.4, 10, 1, true, 0, Math.PI), std([0xe63946,0xffb703,0x2a9d8f][i%3], { side:THREE.DoubleSide }));
  canopy.rotation.z = Math.PI/2; canopy.rotation.y = Math.PI/2; canopy.position.y = 0.5;
  g.add(hull, bow, canopy); g.position.set(rand(-70, 70), 0, rand(20, 55)); g.rotation.y = rand(-0.4, 0.4) + (Math.random() < .5 ? 0 : Math.PI);
  scene.add(g); boats.push({ g, ph:Math.random()*6, v:rand(0.3, 0.9)*(Math.random()<.5?-1:1) });
}
const setuMat = std(0x9a9a9a), SETU_Z = 200;
const deck = new THREE.Mesh(new THREE.BoxGeometry(1000, 1.1, 7), setuMat); deck.position.set(0, 10, SETU_Z); scene.add(deck);
for (let x = -480; x <= 480; x += 32) { const p = new THREE.Mesh(new THREE.BoxGeometry(2, 11, 2.5), setuMat); p.position.set(x, 4.5, SETU_Z); scene.add(p); }
const farBank = new THREE.Mesh(new THREE.BoxGeometry(1200, 2, 200), std(0x6d7a45)); farBank.position.set(0, 0.2, 400); scene.add(farBank);

// ---------------------------------------------------------------- avatars
// f: wears saree/lehenga (else dhoti-kurta) · s: overall height · head: head size relative to the body (bigger for children)
const BODIES = {
  woman:    { label:'Woman',     f:true,  s:1,    head:1 },
  man:      { label:'Man',       f:false, s:1.08, head:1 },
  teengirl: { label:'Teen girl', f:true,  s:0.86, head:1.05 },
  teenboy:  { label:'Teen boy',  f:false, s:0.9,  head:1.05 },
  girl:     { label:'Girl',      f:true,  s:0.64, head:1.2 },
  boy:      { label:'Boy',       f:false, s:0.62, head:1.2 },
};
const bodyKind = k => Object.hasOwn(BODIES, k) ? k : 'woman';
// soop: a woven bamboo winnowing tray — a nearly flat lip at the front (+z), sides that curve up more towards
// the back, a raised back wall with rounded corners, and a bamboo rim bound around the sides and back
// s: -1..1 across, t: 0 at the front lip .. 1 at the back wall
const SOOP_FRONT = 0.42, SOOP_DEPTH = 0.85;
const soopHalfW = t => 0.48*(1 - 0.18*t)*Math.sqrt(1 - 0.75*t**6);
const soopLift = (s, t) => Math.min(0.3, 0.2*Math.abs(s)**4*(0.35 + 0.65*t) + 0.24*t**4);
// height of the tray's surface at a point (x, z) in the soop's own space
const soopSurfaceY = (x, z) => { const t = clamp((SOOP_FRONT - z)/SOOP_DEPTH, 0, 1); return soopLift(clamp(x/soopHalfW(t), -1, 1), t); };
function soopGeometry() {
  const NS = 24, NT = 16;
  const pt = (s, t) => new THREE.Vector3(s*soopHalfW(t), soopLift(s, t), SOOP_FRONT - t*SOOP_DEPTH);
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= NT; j++) for (let i = 0; i <= NS; i++) {
    const sv = i/NS*2 - 1, t = j/NT, p = pt(sv, t);
    pos.push(p.x, p.y, p.z); uv.push((sv + 1)*2, t*4);
  }
  for (let j = 0; j < NT; j++) for (let i = 0; i < NS; i++) {
    const a = j*(NS + 1) + i, b = a + 1, c = a + NS + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const tray = new THREE.BufferGeometry();
  tray.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tray.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tray.setIndex(idx); tray.computeVertexNormals();
  const edge = [];
  for (let k = 0; k <= 8; k++) edge.push(pt(-1, k/8));
  for (let k = 1; k <= 8; k++) edge.push(pt(k/4 - 1, 1));
  for (let k = 7; k >= 0; k--) edge.push(pt(1, k/8));
  const rim = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(edge), 64, 0.022, 6);
  const lip = new THREE.TubeGeometry(new THREE.LineCurve3(pt(-1, 0), pt(1, 0)), 8, 0.014, 5);
  return mergeGeometries([tray, rim, lip]);
}
// over-under bamboo strips, for the soop and daura
const weaveTex = (() => {
  const t = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#b8873f'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const across = (x + y) % 2 === 0;
      g.fillStyle = across ? '#e2bd78' : '#d3a85e';
      const px = x*16, py = y*16;
      if (across) for (let k = 0; k < 3; k++) g.fillRect(px + 1, py + 1 + k*5, 14, 4);
      else for (let k = 0; k < 3; k++) g.fillRect(px + 1 + k*5, py + 1, 4, 14);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
})();

const G = {
  skirt: new THREE.CylinderGeometry(0.26, 0.46, 1.1, 14), hem: new THREE.TorusGeometry(0.45, 0.035, 6, 20),
  torso: new THREE.CylinderGeometry(0.2, 0.27, 0.5, 12), pallu: new THREE.BoxGeometry(0.1, 0.75, 0.56),
  leg: new THREE.CylinderGeometry(0.12, 0.16, 1.1, 10), kurta: new THREE.CylinderGeometry(0.21, 0.28, 0.78, 12),
  gamchha: new THREE.BoxGeometry(0.08, 0.7, 0.14), bun: new THREE.SphereGeometry(0.09, 10, 8),
  moustache: new THREE.BoxGeometry(0.12, 0.025, 0.03), tilak: new THREE.BoxGeometry(0.02, 0.07, 0.01),
  head: new THREE.SphereGeometry(0.17, 16, 12), hair: new THREE.SphereGeometry(0.178, 16, 12),
  dot: new THREE.SphereGeometry(0.022, 6, 5), arm: new THREE.CylinderGeometry(0.06, 0.05, 0.56, 8),
  soop: soopGeometry(), fruit: new THREE.SphereGeometry(0.1, 8, 6),
};
const M = { gold: std(0xffc94d, { metalness:.5, roughness:.4 }), hair: std(0x1a1110), red: std(0xd00000), bamboo: std(0xd4a54a),
  soop: std(0xffffff, { map:weaveTex, roughness:.85, side:THREE.DoubleSide }),
  kurta: std(0xf3ead8, { roughness:.85 }), gamchha: std(0xc8402a, { roughness:.85 }), tilak: std(0xff6a00) };
const SKIN = [0x8d5524, 0xa0673d, 0xc68642, 0x7a4a2a];
const FRUIT_MATS = ITEMS.map(it => std(it.color));
const HEAD_TOP = 1.98;

function makeAvatar(color, name, kind = 'woman', labelColor) {
  const b = BODIES[bodyKind(kind)], g = new THREE.Group(), body = new THREE.Group();
  const cloth = std(color, { roughness:.75 }), skin = std(SKIN[(Math.random()*SKIN.length)|0], { roughness:.8 });
  // head parts are placed relative to the head centre so children's bigger heads scale with their face details
  const headG = new THREE.Group(); headG.position.y = 1.8; headG.scale.setScalar(b.head);
  const head = new THREE.Mesh(G.head, skin);
  const hair = new THREE.Mesh(G.hair, M.hair); hair.position.set(0, 0.035, -0.035);
  headG.add(head, hair); body.add(headG);
  if (b.f) {
    const skirt = new THREE.Mesh(G.skirt, cloth); skirt.position.y = 0.55;
    const hem = new THREE.Mesh(G.hem, M.gold); hem.rotation.x = Math.PI/2; hem.position.y = 0.04;
    const torso = new THREE.Mesh(G.torso, cloth); torso.position.y = 1.35;
    const bun = new THREE.Mesh(G.bun, M.hair); bun.position.set(0, -0.02, -0.17);
    const bindi = new THREE.Mesh(G.dot, M.red); bindi.position.set(0, 0.06, 0.165);
    body.add(skirt, hem, torso); headG.add(bun, bindi);
    // little girls wear a plain lehenga; women and teens drape a pallu / dupatta over the shoulder
    if (kind !== 'girl') { const pallu = new THREE.Mesh(G.pallu, M.gold); pallu.position.set(0, 1.35, 0); pallu.rotation.z = 0.55; body.add(pallu); }
  } else {
    // dhoti in the chosen colour, cream kurta on top, gamchha over the shoulder for the older ones
    for (const s of [-1, 1]) { const leg = new THREE.Mesh(G.leg, cloth); leg.position.set(0.13*s, 0.55, 0); body.add(leg); }
    const kurta = new THREE.Mesh(G.kurta, M.kurta); kurta.position.y = 1.24;
    const tilak = new THREE.Mesh(G.tilak, M.tilak); tilak.position.set(0, 0.07, 0.168);
    hair.scale.set(1, 0.7, 1); hair.position.set(0, 0.06, -0.02); // short hair: just a cap on top
    body.add(kurta); headG.add(tilak);
    if (kind !== 'boy') { const gamchha = new THREE.Mesh(G.gamchha, M.gamchha); gamchha.position.set(-0.12, 1.4, 0.05); gamchha.rotation.z = -0.5; body.add(gamchha); }
    if (kind === 'man') { const mo = new THREE.Mesh(G.moustache, M.hair); mo.position.set(0, -0.05, 0.165); headG.add(mo); }
  }
  const arms = [-1, 1].map(s => {
    const sh = new THREE.Group(); sh.position.set(0.27*s, 1.55, 0);
    const arm = new THREE.Mesh(G.arm, skin); arm.position.y = -0.28; sh.add(arm); body.add(sh); return sh;
  });
  const soop = new THREE.Group(); soop.add(new THREE.Mesh(G.soop, M.soop));
  const fruits = FRUIT_MATS.map((mat, i) => {
    const f = new THREE.Mesh(G.fruit, mat), a = i/FRUIT_MATS.length*Math.PI*2;
    const x = Math.cos(a)*0.2, z = Math.sin(a)*0.17 - 0.06;
    // rest each fruit on the tray (radius 0.1 plus a little clearance), so none pokes through the underside
    f.position.set(x, soopSurfaceY(x, z) + 0.13, z); soop.add(f); return f;
  });
  soop.position.set(0, 2.05, 0); soop.visible = false; body.add(soop);
  body.scale.setScalar(b.s); g.add(body);
  const top = HEAD_TOP*b.s;
  let label = null;
  if (name) { label = textSprite(name, labelColor ? { color:labelColor } : undefined); label.position.y = top + 0.57; g.add(label); }
  g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  scene.add(g);
  return { g, arms, soop, fruits, prasad:PRASAD, prasadShown:PRASAD, label, cloth, skin, top, bubble:null, bubbleUntil:0, offerUntil:0,
    carry:false, x:0, z:0, r:0, tx:0, tz:0, tr:0, m:0, walk:0 };
}
function disposeAvatar(av) {
  scene.remove(av.g); av.label && disposeSprite(av.label); av.bubble && disposeSprite(av.bubble);
  av.cloth.dispose(); av.skin.dispose();
}
function poseAvatar(av, dt, t, moving, offering) {
  const k = 1 - Math.exp(-dt*8);
  // carrying: both hands hold the soop up over the head; offering: it's lifted out towards the sun
  const rz = offering ? 0.25 : av.carry ? 2.7 : 0.12, rx = offering ? -2.3 : (moving && !av.carry ? Math.sin(av.walk)*0.5 : 0);
  av.arms.forEach((sh, i) => { const s = i ? 1 : -1; sh.rotation.z = lerp(sh.rotation.z, s*rz, k); sh.rotation.x = lerp(sh.rotation.x, i ? rx : (offering ? rx : -rx), k); });
  av.soop.visible = !!(av.carry || offering);
  av.soop.position.y = lerp(av.soop.position.y, offering ? 2.3 : 2.05, k);
  av.soop.position.z = lerp(av.soop.position.z, offering ? 0.55 : 0, k);
  av.soop.rotation.x = lerp(av.soop.rotation.x, offering ? 0.35 : 0, k);
  if (av.prasadShown !== av.prasad) { av.fruits.forEach((f, i) => f.visible = !!(av.prasad >> i & 1)); av.prasadShown = av.prasad; }
  if (moving) av.walk += dt*9;
  const inWater = av.z > 0;
  const y = groundY(av.z) + (moving ? Math.abs(Math.sin(av.walk))*0.07 : 0) + (inWater ? waveY(av.x, av.z, t)*0.4 : 0);
  av.g.position.set(av.x, y, av.z); av.g.rotation.y = av.r;
  if (av.bubble && t > av.bubbleUntil) { disposeSprite(av.bubble); av.bubble = null; }
}
function sayBubble(av, text) {
  if (!av) return;
  if (av.bubble) disposeSprite(av.bubble);
  av.bubble = textSprite(text.length > 34 ? text.slice(0, 33) + '…' : text, { bg:'rgba(255,248,236,.92)', color:'#2a1600', height:0.4 });
  av.bubble.position.y = av.top + (av.label ? 1 : 0.62); av.g.add(av.bubble); av.bubbleUntil = clock.elapsedTime + 5;
}

// background devotees (NPCs) standing in the Ganga and on the steps
const npcs = [];
// vratis standing in the water are grown-ups and teens; the whole family waits on the steps
const NPC_KINDS = { water:['woman','woman','woman','man','man','teengirl','teenboy'], steps:['woman','man','man','teengirl','teenboy','girl','girl','boy','boy'] };
for (let i = 0; i < 28; i++) {
  const inWater = i < 18, kinds = NPC_KINDS[inWater ? 'water' : 'steps'];
  const av = makeAvatar(new THREE.Color().setHSL(Math.random(), 0.75, 0.5).getHex(), null, kinds[(Math.random()*kinds.length)|0]);
  av.x = rand(-50, 50); av.z = inWater ? rand(1.2, 7.5) : -rand(1, 12);
  av.inWater = inWater; av.r = inWater ? 0 : rand(-0.4, 0.4); av.carry = inWater || Math.random() < 0.4;
  if (!inWater) av.prasad = 1 + ((Math.random()*PRASAD)|0);
  npcs.push(av);
}

// ---------------------------------------------------------------- Chhath bazaar at both ends of the ghat
// devotees first pick up an empty soop & daura, then fill it with prasad from the other stalls, before going down to the water
// sells: indices into ITEMS; the soop stall sells the soop itself
const STALL_KINDS = [
  { sign:'🧺 सूप · Soop & Daura', canopy:0xd62828, sells:[] },
  { sign:'🍌 फल · Kela, Nariyal, Santra', canopy:0xffb703, sells:[1, 2, 4] },
  { sign:'🎋 ईख · Ganna', canopy:0x2a9d8f, sells:[3] },
  { sign:'🪔 ठेकुआ · Thekua & Diya', canopy:0xfb8500, sells:[0] },
];
const stallSpots = [];   // where a customer stands at each counter, and which kind of stall it is
{
  const wood = std(0x7a5230), cloth = std(0xf1e3c8);
  const canopyMats = STALL_KINDS.map(k => std(k.canopy, { side:THREE.DoubleSide, roughness:.8 }));
  const F = { banana:std(0xffd43b), coconut:std(0x6b4423), orange:std(0xff8c1a), cane:std(0x5a9e2f), thekua:std(0xb5651d), clay:std(0xb5532a) };
  const SG = {
    top: new THREE.BoxGeometry(3.2, 0.12, 1.3), leg: new THREE.BoxGeometry(0.1, 0.9, 0.1), skirt: new THREE.BoxGeometry(3.2, 0.7, 0.04),
    pole: new THREE.CylinderGeometry(0.06, 0.07, 2.9, 6), canopy: new THREE.BoxGeometry(3.9, 0.06, 2.5),
    daura: new THREE.CylinderGeometry(0.42, 0.3, 0.38, 14, 1, true), banana: new THREE.CapsuleGeometry(0.045, 0.22, 3, 6),
    coconut: new THREE.SphereGeometry(0.15, 10, 8), orange: new THREE.SphereGeometry(0.09, 8, 6), cane: new THREE.CylinderGeometry(0.035, 0.04, 2.6, 5),
    thekua: new THREE.CylinderGeometry(0.11, 0.11, 0.035, 10), diya: new THREE.SphereGeometry(0.09, 8, 5, 0, Math.PI*2, Math.PI/2, Math.PI/2),
  };
  const put = (g, geo, mat, x, y, z, rx = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, 0, rz); g.add(m); return m; };
  // a little heap: rings of items stacked smaller towards the top
  const heap = (g, geo, mat, cx, cz, r, layers) => {
    for (let l = 0; l < layers; l++) {
      const rr = r*(1 - l/layers), n = Math.max(1, Math.round(rr*28));
      for (let i = 0; i < n; i++) { const a = i/n*Math.PI*2 + l; put(g, geo, mat, cx + Math.cos(a)*rr, 1.1 + l*r*0.55, cz + Math.sin(a)*rr*0.6); }
    }
  };
  const VENDOR_KINDS = ['man', 'man', 'woman', 'woman', 'teenboy'];
  function stall(x, z, kind) {
    const g = new THREE.Group(); g.position.set(x, 3.2, z);
    put(g, SG.top, wood, 0, 0.95, 0); put(g, SG.skirt, cloth, 0, 0.5, 0.66);
    for (const sx of [-1.5, 1.5]) for (const sz of [-0.55, 0.55]) put(g, SG.leg, wood, sx, 0.45, sz);
    for (const sx of [-1.8, 1.8]) for (const sz of [-1.1, 1.1]) put(g, SG.pole, bambooMat, sx, 1.45, sz);
    put(g, SG.canopy, canopyMats[kind], 0, 2.9, 0, 0.16);   // tarp sloping down towards the customers
    if (kind === 0) {
      for (const sx of [-0.9, 0.1]) for (let i = 0; i < 4; i++) put(g, G.soop, M.soop, sx, 1.01 + i*0.06, 0, 0, i*0.05);
      put(g, SG.daura, M.soop, 1.05, 1.2, 0);
      for (const sx of [-1, 0, 1]) put(g, G.soop, M.soop, sx*0.9, 0.48, 0.78, 1.3);   // leaning against the counter
    } else if (kind === 1) {
      for (let b = 0; b < 3; b++) for (let i = 0; i < 6; i++) put(g, SG.banana, F.banana, -1.15 + b*0.28 + (i%3)*0.06, 1.08 + ((i/3)|0)*0.08, (i%3 - 1)*0.09, 1.4, 0.3);
      heap(g, SG.coconut, F.coconut, 0, 0, 0.32, 3);
      heap(g, SG.orange, F.orange, 1.0, 0, 0.3, 3);
    } else if (kind === 2) {
      for (const sx of [-1.25, 1.25]) for (let i = 0; i < 9; i++) put(g, SG.cane, F.cane, sx + (i%3 - 1)*0.09, 1.3, 0.85 + ((i/3)|0)*0.08, rand(-0.12, 0.05), rand(-0.1, 0.1));
      for (let i = 0; i < 6; i++) put(g, SG.cane, F.cane, (i%3 - 1)*0.12, 1.06 + ((i/3)|0)*0.07, 0, 0, Math.PI/2).scale.y = 1.1;
    } else {
      for (const sx of [-0.9, -0.3]) for (let i = 0; i < 7; i++) put(g, SG.thekua, F.thekua, sx + rand(-0.04, 0.04), 1.03 + i*0.035, rand(-0.04, 0.04));
      for (let i = 0; i < 6; i++) {
        const dx = 0.35 + (i%3)*0.3, dz = ((i/3)|0)*0.3 - 0.15;
        put(g, SG.diya, F.clay, dx, 1.1, dz, Math.PI);
        const f = new THREE.Sprite(stepDiyaMat); f.position.set(dx, 1.2, dz); f.scale.set(0.45, 0.45, 1); g.add(f);
      }
    }
    const bulb = new THREE.Sprite(lampMat); bulb.position.set(0, 2.55, 0.3); bulb.scale.set(1.3, 1.3, 1); g.add(bulb);
    const sign = textSprite(STALL_KINDS[kind].sign, { height:0.42, bg:'rgba(255,248,236,.92)', color:'#4a1d00' }); sign.position.set(0, 3.45, 0.6); g.add(sign);
    scene.add(g);
    const vendor = makeAvatar(new THREE.Color().setHSL(Math.random(), 0.7, 0.45).getHex(), null, VENDOR_KINDS[(Math.random()*VENDOR_KINDS.length)|0]);
    vendor.x = x + rand(-0.6, 0.6); vendor.z = z - 1; npcs.push(vendor);
    stallSpots.push({ i:stallSpots.length, x, z:z + 1.3, kind });
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < STALL_KINDS.length; i++) stall(side*(50.5 + i*4), -21.5, i);
    // bamboo gate with a marigold string and a big sign, facing the ghat
    const gx = side*48.3;
    for (const z of [-17.6, -25.4]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 5.2, 6), bambooMat); p.position.set(gx, 3.2 + 2.6, z); scene.add(p); }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 8), bambooMat); bar.position.set(gx, 3.2 + 5.1, -21.5); scene.add(bar);
    for (let k = 0; k < 14; k++) {
      const t = (k + 0.5)/14, m = new THREE.Mesh(G.fruit, std(k%2 ? 0xffb703 : 0xfb8500));
      m.position.set(gx, 3.2 + 4.95 - Math.sin(Math.PI*t)*0.6, -25.4 + 7.8*t); scene.add(m);
    }
    const sign = textSprite('🧺 छठ बाज़ार · Chhath Bazaar', { height:0.8, bg:'rgba(214,40,40,.92)', color:'#fff3c4' });
    sign.position.set(gx, 3.2 + 6, -21.5); scene.add(sign);
    // a few devotees shopping at the counters
    for (let i = 0; i < 3; i++) {
      const spot = stallSpots[stallSpots.length - 1 - ((Math.random()*4)|0)];
      const kinds = NPC_KINDS.steps, av = makeAvatar(new THREE.Color().setHSL(Math.random(), 0.75, 0.5).getHex(), null, kinds[(Math.random()*kinds.length)|0]);
      av.x = spot.x + rand(-1.2, 1.2); av.z = spot.z + rand(0, 0.6); av.r = Math.PI + rand(-0.3, 0.3); av.carry = Math.random() < 0.3; npcs.push(av);
    }
  }
  for (const x of [-56, 56]) { const l = new THREE.PointLight(0xffaa55, 0, 24, 1.6); l.position.set(x, 7, -19); scene.add(l); lampLights.push(l); }
}
// the nearest counter within reach (stalls are only 4m apart, so the first match isn't good enough)
function stallAt(x, z) {
  let best = null, bd = STALL_REACH;
  for (const s of stallSpots) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { best = s; bd = d; } }
  return best;
}
// host side: is this player standing at the counter they say they're buying from? a little slack, since
// our copy of their position lags a tick
const atCounter = (p, i) => { const s = stallSpots[i | 0]; return s && Math.hypot(s.x - p.x, s.z - p.z) < STALL_REACH + 1.5 ? s : null; };
const cleanSoop = v => (v |= 0) & SOOP ? v & (SOOP | PRASAD) : 0;
let myAv = makeAvatar(me.color, null);
const remotes = new Map();

// ---------------------------------------------------------------- diyas
const diyaMeshes = new Map();
const diyaGeo = { bowl: new THREE.SphereGeometry(0.17, 10, 6, 0, Math.PI*2, Math.PI/2, Math.PI/2), leaf: new THREE.CircleGeometry(0.32, 10) };
const diyaBowlMat = std(0xb5532a, { side:THREE.DoubleSide }), diyaLeafMat = std(0x3f7d20, { side:THREE.DoubleSide });
function addDiyaMesh(d) {
  if (diyaMeshes.has(d.id)) return;
  const g = new THREE.Group();
  const leaf = new THREE.Mesh(diyaGeo.leaf, diyaLeafMat); leaf.rotation.x = -Math.PI/2;
  const bowl = new THREE.Mesh(diyaGeo.bowl, diyaBowlMat); bowl.position.y = 0.17;
  const flame = new THREE.Sprite(glowMat(0xffa94d, 1)); flame.position.y = 0.3; flame.scale.set(1.1, 1.1, 1);
  g.add(leaf, bowl, flame); g.userData = { d, flame, ph:Math.random()*6 };
  scene.add(g); diyaMeshes.set(d.id, g);
}
function rebuildDiyas() {
  for (const g of diyaMeshes.values()) { scene.remove(g); g.userData.flame.material.dispose(); }
  diyaMeshes.clear(); world.diyas.forEach(addDiyaMesh);
}

// floating effects: sparkles
const fx = [];
function sparkle(x, y, z, color=0xffd166) {
  const n = 50, pos = new Float32Array(n*3), vel = [];
  for (let i = 0; i < n; i++) { pos.set([x, y, z], i*3); vel.push([rand(-1,1), rand(1.5,4), rand(-1,1)]); }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size:0.18, map:glowTex, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending }));
  scene.add(pts); fx.push({ o:pts, vel, life:2.2, age:0 });
}

// ---------------------------------------------------------------- authority (host) logic
function isBlessed() { return !!phaseAt(dayTime()).bless; }
function helloMsg() { return { t:'hello', name:me.name, color:me.color, kind:me.kind, soop:me.soop, x:me.x, z:me.z }; }
function stateMsg() { return { t:'st', x:+me.x.toFixed(2), z:+me.z.toFixed(2), r:+me.r.toFixed(2), m:me.moving ? 1 : 0 }; }

function hostHandle(from, msg) {
  if (!msg || typeof msg !== 'object') return;
  const p = world.players.get(from);
  switch (msg.t) {
    case 'hello': {
      const np = { id:from, name:clean(msg.name) || 'Bhakt', color:COLORS.includes(msg.color) ? msg.color : COLORS[0], kind:bodyKind(msg.kind),
        x:clamp(+msg.x || 0, -WALK_X, WALK_X), z:clamp(+msg.z || -18, -26, 11), r:0, m:0,
        soop:cleanSoop(msg.soop), seen:Date.now(), lastDiya:0, lastArghya:0 };
      world.players.set(from, np);
      if (from !== net.myId) sendTo(from, { t:'welcome', now:Date.now(), start:world.start, diyas:world.diyas });
      broadcast({ t:'chat', sys:true, text:`${np.name} arrived at the ghat 🙏` });
      break;
    }
    case 'st':
      if (!p) return;
      p.x = clamp(+msg.x || 0, -WALK_X, WALK_X); p.z = clamp(+msg.z || 0, -26, 11); p.r = +msg.r || 0; p.m = msg.m ? 1 : 0; p.seen = Date.now();
      break;
    case 'arghya': {
      const now = Date.now();
      if (!p || !(p.soop & PRASAD) || p.z < 0.2 || now - p.lastArghya < ARGHYA_COOLDOWN) return;
      p.lastArghya = now; p.soop = 0;
      broadcast({ t:'fx', k:'arghya', by:from, name:p.name, bless:isBlessed() });
      break;
    }
    case 'soop':
      if (p && !p.soop && atCounter(p, msg.s)?.kind === 0) p.soop = SOOP;
      break;
    case 'take': {
      const k = msg.k | 0, st = p && p.soop && atCounter(p, msg.s);
      if (st && STALL_KINDS[st.kind].sells.includes(k)) p.soop |= 1 << k;
      break;
    }
    case 'diya': {
      const now = Date.now();
      if (!p || now - p.lastDiya < 2500 || p.z < -2.6) return;
      p.lastDiya = now;
      const d = { id:uid(), x:+(p.x + Math.sin(p.r)*1.3).toFixed(2), z:+Math.max(0.8, p.z + Math.cos(p.r)*1.3).toFixed(2), born:now };
      world.diyas.push(d); if (world.diyas.length > 160) world.diyas.shift();
      broadcast({ t:'diya', d, by:from });
      break;
    }
    case 'chat': {
      const text = clean(msg.text, 80);
      if (p && text) broadcast({ t:'chat', by:from, name:p.name, color:p.color, text });
      break;
    }
  }
}
function broadcast(msg) {
  for (const c of net.conns.values()) if (c.open) { try { c.send(msg); } catch {} }
  clientHandle(msg);
}
function sendTo(id, msg) { const c = net.conns.get(id); if (c?.open) try { c.send(msg); } catch {} }
function send(msg) {
  if (net.mode === 'host' || net.mode === 'solo') hostHandle(net.myId, msg);
  else if (net.mode === 'client' && net.hostConn?.open) try { net.hostConn.send(msg); } catch {}
}

setInterval(() => {
  if (!started) return;
  if (net.mode === 'client') { send(stateMsg()); return; }
  if (net.mode !== 'host' && net.mode !== 'solo') return;
  send(stateMsg());
  const now = Date.now();
  for (const [id, p] of world.players) if (id !== net.myId && now - p.seen > 15000) world.players.delete(id);
  while (world.diyas.length && now - world.diyas[0].born > DIYA_LIFE) world.diyas.shift();
  broadcast({ t:'snap', now, p:[...world.players.values()].map(p => [p.id, p.name, p.color, p.x, p.z, p.r, p.m, p.kind, p.soop]) });
}, 100);

// ---------------------------------------------------------------- client-side message handling
function clientHandle(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      clockOffset = msg.now - Date.now(); world.start = msg.start;
      world.diyas = (msg.diyas || []).slice(); rebuildDiyas();
      break;
    case 'snap': applySnap(msg); break;
    case 'diya':
      if (!net.isHost) world.diyas.push(msg.d);
      addDiyaMesh(msg.d);
      if (msg.by === net.myId) sfx.diya();
      break;
    case 'fx': {
      const self = msg.by === net.myId, av = self ? myAv : remotes.get(msg.by);
      if (av) { av.offerUntil = clock.elapsedTime + 2.6; sparkle(av.x, groundY(av.z) + 2.3, av.z, msg.bless ? 0xffd166 : 0xffffff); }
      if (self) {
        me.offerUntil = clock.elapsedTime + 2.6; me.soop = 0; updateShop(); sfx.bell();
        toast(msg.bless ? '☀️ Arghya offered to Surya Dev' : '🙏 Arghya offered');
      } else sfx.far();
      logChat(`${msg.name} offered Arghya to Surya Dev${msg.bless ? ' ☀️' : ''}`, true);
      break;
    }
    case 'chat':
      logChat(msg.sys ? msg.text : `${msg.name}: ${msg.text}`, msg.sys, msg.color);
      if (!msg.sys) sayBubble(msg.by === net.myId ? myAv : remotes.get(msg.by), msg.text);
      break;
  }
}
function applySnap(msg) {
  if (!net.isHost) clockOffset = clockOffset*0.9 + (msg.now - Date.now())*0.1;
  const seen = new Set();
  for (let [id, name, color, x, z, r, m, kind, soop] of msg.p) {
    if (id === net.myId) {
      soop = cleanSoop(soop);
      const added = soop & PRASAD & ~me.soop;
      if (soop && !me.soop) { sfx.soop(); toast('🧺 Soop & daura in hand — now fill it with prasad from the stalls'); }
      else if (added) { sfx.soop(); toast(`${ITEMS.filter((_, i) => added >> i & 1).map(it => `${it.e} ${it.name}`).join(', ')} added to your soop`); }
      if (soop !== me.soop) { me.soop = soop; updateShop(); }
      continue;
    }
    seen.add(id);
    let av = remotes.get(id);
    if (!av) { av = makeAvatar(color, name, kind); av.x = av.tx = x; av.z = av.tz = z; av.r = r; remotes.set(id, av); }
    av.tx = x; av.tz = z; av.tr = r; av.m = m; soop = cleanSoop(soop); av.carry = !!soop; av.prasad = soop & PRASAD;
  }
  for (const [id, av] of remotes) if (!seen.has(id)) { disposeAvatar(av); remotes.delete(id); }
  net.count = msg.p.length;
  updateNetPill();
}
function clearRemotes() { for (const av of remotes.values()) disposeAvatar(av); remotes.clear(); }

// ---------------------------------------------------------------- networking (PeerJS / WebRTC, no backend of our own)
// The first player to open a room claims a well-known peer id and becomes host; everyone else connects to it.
// If the host leaves, the remaining players race to claim the id and the game carries on.
const hostId = () => `${APP}-${net.room}`;
function cleanupPeer() {
  for (const c of net.conns.values()) try { c.close(); } catch {}
  net.conns.clear();
  if (net.hostConn) try { net.hostConn.close(); } catch {}
  net.hostConn = null;
  if (net.peer) try { net.peer.destroy(); } catch {}
  net.peer = null;
}
function connect() {
  cleanupPeer();
  const gen = ++net.gen;
  net.mode = 'connecting'; updateNetPill();
  const p = new Peer(hostId(), { debug:0 }); net.peer = p;
  const failT = setTimeout(() => { if (gen === net.gen && net.mode === 'connecting') goSolo('signal server unreachable'); }, 12000);
  p.on('open', id => { if (gen !== net.gen) return; clearTimeout(failT); becomeAuthority(id, 'host'); });
  p.on('connection', c => { if (gen === net.gen && net.mode === 'host') setupHostConn(c); else c.close(); });
  p.on('disconnected', () => { if (gen === net.gen && net.mode === 'host') setTimeout(() => { try { p.reconnect(); } catch {} }, 1500); });
  p.on('error', err => {
    if (gen !== net.gen) return;
    if (err.type === 'unavailable-id') { clearTimeout(failT); joinAsClient(); }
    else if (net.mode === 'connecting') { clearTimeout(failT); goSolo(err.type); }
  });
}
function joinAsClient() {
  cleanupPeer();
  const gen = ++net.gen;
  const p = new Peer({ debug:0 }); net.peer = p;
  const failT = setTimeout(() => { if (gen === net.gen && net.mode === 'connecting') retrySoon(); }, 12000);
  p.on('open', id => {
    if (gen !== net.gen) return;
    const c = p.connect(hostId(), { reliable:true }); net.hostConn = c;
    c.on('open', () => {
      if (gen !== net.gen) return;
      clearTimeout(failT);
      net.myId = id; net.mode = 'client'; net.isHost = false;
      clearRemotes(); c.send(helloMsg()); updateNetPill();
    });
    c.on('data', m => { if (gen === net.gen) clientHandle(m); });
    c.on('close', () => { if (gen === net.gen) hostLost(); });
    c.on('error', () => { if (gen === net.gen) hostLost(); });
  });
  p.on('error', err => {
    if (gen !== net.gen) return;
    if (err.type === 'peer-unavailable') { clearTimeout(failT); retrySoon(); }
    else if (net.mode === 'connecting') { clearTimeout(failT); goSolo(err.type); }
  });
}
function retrySoon() { cleanupPeer(); net.gen++; net.mode = 'connecting'; updateNetPill(); setTimeout(connect, rand(200, 1800)); }
function hostLost() {
  if (net.mode !== 'client') return;
  logChat('The host left — finding the ghat again…', true);
  clearRemotes(); retrySoon();
}
function setupHostConn(c) {
  const add = () => net.conns.set(c.peer, c);
  c.on('open', add);
  c.on('data', m => { if (!net.conns.has(c.peer)) add(); hostHandle(c.peer, m); });
  const bye = () => {
    if (net.conns.get(c.peer) !== c) return;
    net.conns.delete(c.peer);
    const p = world.players.get(c.peer); world.players.delete(c.peer);
    if (p) broadcast({ t:'chat', sys:true, text:`${p.name} left the ghat` });
  };
  c.on('close', bye); c.on('error', bye);
}
function becomeAuthority(id, mode) {
  // carry the shared clock over from the previous host so the sun doesn't jump
  world.start -= clockOffset; for (const d of world.diyas) d.born -= clockOffset; clockOffset = 0;
  net.mode = mode; net.isHost = true; net.myId = id;
  world.players.clear(); clearRemotes();
  hostHandle(id, helloMsg());
  updateNetPill();
}
function goSolo(reason) {
  cleanupPeer(); net.gen++;
  becomeAuthority('solo', 'solo');
  logChat(`Playing offline (${reason}). Tap the status box to retry.`, true);
}

// ---------------------------------------------------------------- HUD
const hud = { phase:$('#phase'), sub:$('#phaseSub'), bless:$('#bless'), hint:$('#hint'), soop:$('#soop'), shop:$('#shop'), soopItems:$('#soopItems'), net:$('#net'), music:$('#musicTitle'), mute:$('#mute') };
function toggleMusic() { music.setEnabled(!music.enabled); hud.mute.textContent = music.enabled ? '🔊' : '🔇'; }
hud.mute.onclick = toggleMusic;
function updateNetPill() {
  const room = net.room === 'public' ? 'Public ghat' : `Room “${net.room}”`;
  hud.net.textContent = {
    connecting: '🟡 Connecting to the ghat…',
    host: `🟢 ${room} · ${net.count} devotee${net.count === 1 ? '' : 's'} (you host)`,
    client: `🟢 ${room} · ${net.count} devotee${net.count === 1 ? '' : 's'}`,
    solo: '⚪ Offline solo · tap to retry',
    off: '',
  }[net.mode];
}
hud.net.onclick = () => { if (net.mode === 'solo') connect(); };
// the panel at the bottom: what's in your soop, plus the counter of the stall you're standing at
let shopKey = '';
function updateShop() {
  const spot = stallAt(me.x, me.z), key = `${spot?.i ?? ''}|${me.soop}`;
  if (key === shopKey) return;
  shopKey = key;
  hud.soop.classList.toggle('hidden', !spot && !me.soop);
  hud.soopItems.innerHTML = !me.soop ? '' : '🧺 ' + ITEMS.map((it, i) => me.soop >> i & 1 ? it.e : '<span class="empty">◯</span>').join(' ');
  if (!spot) { hud.shop.replaceChildren(); return; }
  const st = STALL_KINDS[spot.kind], title = document.createElement('div'), row = document.createElement('div');
  title.textContent = st.sign; row.className = 'row';
  const btn = (text, done, onclick) => { const b = document.createElement('button'); b.textContent = done ? `✓ ${text}` : text; b.disabled = done; b.onclick = onclick; return b; };
  if (!st.sells.length) row.append(btn('🧺 Take soop & daura', !!me.soop, () => send({ t:'soop', s:spot.i })));
  else if (!me.soop) { row.textContent = 'Get a soop & daura from the 🧺 stall first'; }
  else row.append(...st.sells.map(k => btn(`${ITEMS[k].e} ${ITEMS[k].name}`, !!(me.soop >> k & 1), () => send({ t:'take', s:spot.i, k }))));
  hud.shop.replaceChildren(title, row);
}
function logChat(text, sys, color) {
  const box = $('#chatlog'), d = document.createElement('div');
  d.textContent = text; if (sys) d.className = 'sys'; if (color) d.style.borderLeft = `3px solid ${color}`;
  box.append(d); while (box.children.length > 6) box.firstChild.remove();
  setTimeout(() => d.remove(), 20000);
}
let toastT;
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

// ---------------------------------------------------------------- audio (tiny synthesized bells)
let ac;
function tone(freq, dur, type='sine', vol=0.12, delay=0) {
  try {
    ac = ac || new AudioContext();
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
  } catch {}
}
const sfx = {
  soop: () => tone(880, 0.25, 'triangle', 0.07),
  diya: () => { tone(660, 0.5, 'sine', 0.08); tone(990, 0.6, 'sine', 0.05, 0.08); },
  bell: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 1.8, 'sine', 0.1, i*0.12)),
  far: () => tone(1046, 1.2, 'sine', 0.025),
};

// ---------------------------------------------------------------- input
const keys = {};
let camYaw = 0, camPitch = 0.32, camDist = 7.5;
const chatin = $('#chatin'), chatbox = $('#chatbox');
const isTyping = () => document.activeElement === chatin;
addEventListener('keydown', e => {
  if (isTyping()) {
    if (e.key === 'Enter') { sendChat(chatin.value); chatin.value = ''; closeChat(); }
    else if (e.key === 'Escape') closeChat();
    return;
  }
  if (!started) return;
  keys[e.code] = true;
  if (e.code === 'KeyE') doArghya();
  else if (e.code === 'KeyF') doDiya();
  else if (e.code === 'KeyM') toggleMusic();
  else if (e.code === 'Enter' || e.code === 'KeyT') { e.preventDefault(); openChat(); }
  else if (/^Digit[1-6]$/.test(e.code)) sendChat(QUICK[+e.code.slice(5) - 1]);
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

let drag = null;
canvas.addEventListener('pointerdown', e => { drag = { id:e.pointerId, x:e.clientX, y:e.clientY, x0:e.clientX, y0:e.clientY, t0:performance.now() }; canvas.setPointerCapture(e.pointerId); if (isTyping()) chatin.blur(); });
canvas.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  camYaw -= (e.clientX - drag.x)*0.006; camPitch = clamp(camPitch + (e.clientY - drag.y)*0.004, 0.05, 1.25);
  drag.x = e.clientX; drag.y = e.clientY;
});
// a quick tap (not a camera drag) on the developer hoarding opens the developer's page
const raycaster = new THREE.Raycaster();
function tapBoard(e) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((e.clientX - r.left)/r.width*2 - 1, -(e.clientY - r.top)/r.height*2 + 1), camera);
  if (raycaster.intersectObject(devBoard).length) window.open(DEV.url, '_blank', 'noopener');
}
const endDrag = e => {
  if (drag?.id !== e.pointerId) return;
  if (e.type === 'pointerup' && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8 && performance.now() - drag.t0 < 500) tapBoard(e);
  drag = null;
};
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', e => { camDist = clamp(camDist + e.deltaY*0.01, 3, 16); }, { passive:true });

const joy = $('#joy'), knob = $('#knob'); let joyId = null, joyC = null; const joyVec = { x:0, y:0 };
joy.addEventListener('pointerdown', e => {
  joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
  const r = joy.getBoundingClientRect(); joyC = { x:r.left + r.width/2, y:r.top + r.height/2 }; moveJoy(e);
});
joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) moveJoy(e); });
const endJoy = e => { if (e.pointerId === joyId) { joyId = null; joyVec.x = joyVec.y = 0; knob.style.transform = ''; } };
joy.addEventListener('pointerup', endJoy); joy.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  let dx = e.clientX - joyC.x, dy = e.clientY - joyC.y; const m = 50, d = Math.hypot(dx, dy);
  if (d > m) { dx *= m/d; dy *= m/d; }
  knob.style.transform = `translate(${dx}px,${dy}px)`; joyVec.x = dx/m; joyVec.y = -dy/m;
}

function doArghya() {
  if (!me.soop) return toast('Get a soop & daura from the bazaar at either end of the ghat 🧺');
  if (!(me.soop & PRASAD)) return toast('Your soop is empty — pick some prasad at the bazaar stalls');
  if (me.z < 0.2) return toast('Step down into the Ganga to offer Arghya');
  if (clock.elapsedTime < me.offerUntil) return;
  send({ t:'arghya' });
}
function doDiya() {
  const now = performance.now();
  if (me.z < -2.6) return toast('Go down to the water’s edge to float a diya 🪔');
  if (now - me.lastDiya < 2600) return;
  me.lastDiya = now; send({ t:'diya' });
  $('#bDiya').classList.add('cool'); setTimeout(() => $('#bDiya').classList.remove('cool'), 2600);
}
function sendChat(text) { text = clean(text, 80); if (text) send({ t:'chat', text }); }
function openChat() { chatbox.classList.remove('hidden'); chatin.focus(); for (const k in keys) keys[k] = false; }
function closeChat() { chatin.blur(); chatbox.classList.add('hidden'); }
$('#quick').append(...QUICK.map((q, i) => { const b = document.createElement('button'); b.textContent = `${i+1}. ${q}`; b.onclick = () => { sendChat(q); closeChat(); }; return b; }));
$('#bArghya').onclick = doArghya; $('#bDiya').onclick = doDiya;
$('#bChat').onclick = () => chatbox.classList.contains('hidden') ? openChat() : closeChat();
$('#invite').onclick = async () => {
  const url = `${location.href.split(/[?#]/)[0]}?room=${encodeURIComponent(net.room)}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied — share it with family & friends!'); }
  catch { prompt('Share this link:', url); }
};

// ---------------------------------------------------------------- start screen
const NAMES = ['Sunita','Rajesh','Pinky','Munna','Guddu','Rinki','Bablu','Savitri','Chhotu','Anita','Pappu','Kiran','Sonu','Lalita'];
$('#credit').href = DEV.url; $('#credit').textContent = DEV.name;
$('#name').value = (() => { try { return localStorage.getItem('chhath-name'); } catch { return null; } })() || NAMES[(Math.random()*NAMES.length)|0];
const roomParam = clean(new URLSearchParams(location.search).get('room') || '', 24).toLowerCase();
$('#room').value = roomParam && roomParam !== 'public' ? roomParam : '';
me.color = COLORS[(Math.random()*COLORS.length)|0];
me.kind = bodyKind((() => { try { return localStorage.getItem('chhath-kind'); } catch { return null; } })());
$('#kinds').append(...Object.entries(BODIES).map(([k, b]) => {
  const btn = document.createElement('button'); btn.textContent = b.label; if (k === me.kind) btn.className = 'sel';
  btn.onclick = () => { me.kind = k; document.querySelectorAll('#kinds button').forEach(x => x.classList.toggle('sel', x === btn)); };
  return btn;
}));
$('#colors').append(...COLORS.map(c => {
  const b = document.createElement('button'); b.style.background = c; if (c === me.color) b.className = 'sel';
  b.onclick = () => { me.color = c; document.querySelectorAll('#colors button').forEach(x => x.classList.toggle('sel', x === b)); };
  return b;
}));
$('#go').onclick = () => {
  me.name = clean($('#name').value) || 'Bhakt';
  try { localStorage.setItem('chhath-name', me.name); localStorage.setItem('chhath-kind', me.kind); } catch {}
  net.room = clean($('#room').value, 24).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'public';
  if (net.room !== 'public') history.replaceState(null, '', `?room=${net.room}`);
  disposeAvatar(myAv); myAv = makeAvatar(me.color, me.name, me.kind, '#ffd166');
  $('#start').classList.add('hidden'); $('#hud').classList.remove('hidden');
  started = true; tone(523, 0.8, 'sine', 0.08); music.start();
  connect();
};
addEventListener('keydown', e => { if (!started && e.key === 'Enter' && document.activeElement?.tagName === 'INPUT') $('#go').click(); });

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
const C = {
  night:{ top:new THREE.Color(0x050a1f), hor:new THREE.Color(0x1b2244) },
  dusk: { top:new THREE.Color(0x2b2f6b), hor:new THREE.Color(0xff7a38) },
  day:  { top:new THREE.Color(0x3d7fd6), hor:new THREE.Color(0xbfe3ff) },
  sunLow:new THREE.Color(0xff5a14), sunHigh:new THREE.Color(0xfff1c9),
};
const tmpTop = new THREE.Color(), tmpHor = new THREE.Color(), tmpSun = new THREE.Color();
const sunDir = new THREE.Vector3(), camTarget = new THREE.Vector3();
let hudT = 0;

function updateSky(t) {
  const th = sunTheta(t), elev = Math.sin(th);
  sunDir.set(Math.cos(th), elev, 0.55).normalize();
  if (elev < 0) { const k = clamp(-elev/0.3, 0, 1); tmpTop.lerpColors(C.dusk.top, C.night.top, k); tmpHor.lerpColors(C.dusk.hor, C.night.hor, k); }
  else { const k = clamp(elev/0.4, 0, 1); tmpTop.lerpColors(C.dusk.top, C.day.top, k); tmpHor.lerpColors(C.dusk.hor, C.day.hor, k); }
  tmpSun.lerpColors(C.sunLow, C.sunHigh, clamp(elev*2.5, 0, 1));
  const night = clamp((0.05 - elev)/0.3, 0, 1);
  skyMat.uniforms.top.value.copy(tmpTop); skyMat.uniforms.horizon.value.copy(tmpHor);
  skyMat.uniforms.sunCol.value.copy(tmpSun).multiplyScalar(1 - night*0.9); skyMat.uniforms.sunDir.value.copy(sunDir);
  scene.fog.color.copy(tmpHor);
  sunDisc.position.copy(sunDir).multiplyScalar(400); sunDisc.material.color.copy(tmpSun);
  sunGlow.position.copy(sunDisc.position); sunGlow.material.color.copy(tmpSun); sunGlow.material.opacity = clamp(elev*4 + 0.6, 0, 0.9);
  moon.position.set(-sunDir.x, -sunDir.y*0.8 + 0.25, 0.7).normalize().multiplyScalar(400); moon.material.opacity = night;
  stars.material.opacity = night;
  const dayK = clamp(elev*3 + 0.25, 0, 1);
  sunLight.intensity = dayK*2.4; sunLight.color.copy(tmpSun); sunLight.castShadow = gfx.high && dayK > 0.05;
  hemi.intensity = lerp(0.2, 0.7, clamp(elev*2 + 0.3, 0, 1)); hemi.color.copy(tmpTop).lerp(C.day.hor, 0.5);
  moonLight.intensity = night*0.5;
  lampLights.forEach(l => l.intensity = night*60);
  lampMat.opacity = stepDiyaMat.opacity = 0.35 + night*0.65;
  windows.material.color.setRGB(1, 0.78, 0.44).multiplyScalar(0.12 + night*0.9);
  water.material.color.copy(tmpHor).multiplyScalar(0.12).add(new THREE.Color(0x13241f));
  sunPath.material.color.copy(tmpSun); sunPath.material.opacity = elev > -0.08 ? clamp(1 - Math.abs(elev)*2.2, 0, 1)*0.3 : 0;
  sunPath.position.set(camera.position.x, 0.08, 0.5); sunPath.rotation.y = Math.atan2(sunDir.x, sunDir.z);
  return { elev, night };
}

function updateMe(dt) {
  let ix = 0, iz = 0;
  if (!isTyping()) {
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
  }
  ix += joyVec.x; iz += joyVec.y;
  const len = Math.hypot(ix, iz);
  me.moving = len > 0.1;
  if (me.moving) {
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw), rx = -Math.cos(camYaw), rz = Math.sin(camYaw);
    const n = Math.min(1, len)/len;
    const mx = (fx*iz + rx*ix)*n, mz = (fz*iz + rz*ix)*n;
    const speed = me.z > 0 ? 2.4 : 5;
    me.x = clamp(me.x + mx*speed*dt, -WALK_X, WALK_X);
    me.z = clamp(me.z + mz*speed*dt, -26, 11);
    me.r = lerpAngle(me.r, Math.atan2(mx, mz), 1 - Math.exp(-dt*12));
  }
  myAv.x = me.x; myAv.z = me.z; myAv.r = me.r; myAv.carry = !!me.soop; myAv.prasad = me.soop & PRASAD;
}

function updateHud(t, night) {
  const ph = phaseAt(t);
  hud.phase.textContent = ph.name;
  let next;
  if (ph.bless) next = `ends in ${fmt(ph.to - t)}`;
  else { const nb = t < 180 ? 180 : DAY; next = `${nb === 180 ? 'Usha' : 'Sandhya'} Arghya in ${fmt(nb - t)}`; }
  hud.sub.textContent = `${ph.sub} · ${next}`;
  hud.bless.classList.toggle('hidden', !ph.bless);
  const tr = music.track;
  hud.music.textContent = !music.hasSongs ? 'Add songs to public/music to fill the loudspeakers'
    : !music.enabled ? 'Loudspeakers muted' : tr ? `${tr.title}${tr.artist ? ' — ' + tr.artist : ''}` : 'Tuning the loudspeakers…';
  let h;
  const bazaar = `the Chhath Bazaar ${me.x < 0 ? '⬅️' : '➡️'}`;
  if (!me.soop) h = `Get a soop & daura from the 🧺 stall at ${bazaar}`;
  else if (!(me.soop & PRASAD)) h = `Fill your soop with prasad from the stalls at ${bazaar} 🍪 🍌 🥥 🎋 🍊`;
  else if (me.z < 0.2) h = `Walk down the steps into the Ganga to offer Arghya ⬇️${(me.soop & PRASAD) !== PRASAD ? ' · or add more prasad' : ''}`;
  else h = 'Press E / 🙏 to offer Arghya to Surya Dev';
  if (me.z > -2.6 && night > 0.3) h += ' · F / 🪔 float a diya';
  hud.hint.textContent = h;
  updateShop();
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.12), et = clock.elapsedTime;
  const t = dayTime();
  const { night } = updateSky(t);
  updatePoster(); beam.visible = !posterMesh.visible; beam.material.uniforms.uOpacity.value = 0.04 + night*0.32; beam.material.uniforms.uTime.value = et;
  const blessed = !!phaseAt(t).bless;

  if (started) updateMe(dt);
  poseAvatar(myAv, dt, et, me.moving, et < me.offerUntil);
  myAv.g.visible = started;

  const k = 1 - Math.exp(-dt*10);
  for (const av of remotes.values()) {
    av.x = lerp(av.x, av.tx, k); av.z = lerp(av.z, av.tz, k); av.r = lerpAngle(av.r, av.tr, k);
    poseAvatar(av, dt, et, !!av.m, et < av.offerUntil);
  }
  const faceSun = Math.atan2(sunDir.x, sunDir.z);
  for (const n of npcs) {
    if (n.inWater) n.r = lerpAngle(n.r, faceSun, dt);
    poseAvatar(n, dt, et, false, n.inWater && blessed);
  }
  const now = netNow();
  for (const [id, g] of diyaMeshes) {
    const { d, flame, ph } = g.userData, age = (now - d.born)/1000;
    if (age*1000 > DIYA_LIFE) { scene.remove(g); flame.material.dispose(); diyaMeshes.delete(id); continue; }
    const x = d.x + age*0.35, z = d.z + age*0.1 + Math.sin(age*0.3 + ph)*0.4;
    g.position.set(x, waveY(x, z, et) + 0.02, z); g.rotation.z = Math.sin(et*1.3 + ph)*0.08;
    const f = 1 + Math.sin(et*12 + ph)*0.08 + Math.sin(et*7.3 + ph*2)*0.06;
    flame.scale.set(1.1*f, 1.3*f, 1); flame.material.opacity = Math.min(1, (DIYA_LIFE/1000 - age)/8);
  }
  if (!net.isHost) world.diyas = world.diyas.filter(d => now - d.born < DIYA_LIFE);
  for (const b of boats) { b.g.position.y = Math.sin(et*0.9 + b.ph)*0.08; b.g.position.x += b.v*dt; if (Math.abs(b.g.position.x) > 90) b.v *= -1; b.g.rotation.z = Math.sin(et*0.7 + b.ph)*0.03; }
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.age += dt; const a = 1 - f.age/f.life;
    const p = f.o.geometry.attributes.position;
    f.vel.forEach((v, j) => { v[1] -= dt*1.5; p.array[j*3] += v[0]*dt; p.array[j*3+1] += v[1]*dt; p.array[j*3+2] += v[2]*dt; });
    p.needsUpdate = true; f.o.material.opacity = a;
    if (f.age >= f.life) { scene.remove(f.o); f.o.geometry.dispose(); f.o.material.dispose(); fx.splice(i, 1); }
  }
  // waves
  const wp = waterGeo.attributes.position.array;
  for (let i = 0; i < wp.length; i += 3) wp[i+1] = waveY(waterBase[i], waterBase[i+2], et);
  waterGeo.attributes.position.needsUpdate = true; waterGeo.computeVertexNormals(); waterTime.value = et;

  // camera
  const focus = started ? myAv.g.position : new THREE.Vector3(Math.sin(et*0.05)*10, 3.2, -14);
  camTarget.lerp(new THREE.Vector3(focus.x, focus.y + 1.6, focus.z), started ? 1 - Math.exp(-dt*10) : 1);
  if (!started) camYaw = Math.sin(et*0.07)*0.5;
  const cx = camTarget.x - Math.sin(camYaw)*Math.cos(camPitch)*camDist;
  const cz = camTarget.z - Math.cos(camYaw)*Math.cos(camPitch)*camDist;
  const cy = Math.max(camTarget.y + Math.sin(camPitch)*camDist, groundY(cz) + 0.6, 0.5);
  camera.position.set(cx, cy, cz); camera.lookAt(camTarget);
  skyGroup.position.copy(camera.position);
  sunLight.position.copy(camTarget).addScaledVector(sunDir, 80); sunLight.target.position.copy(camTarget);

  if (started) music.update(camera.position, { x:-Math.cos(camYaw), z:Math.sin(camYaw) }, speakers);
  if (started && (hudT -= dt) <= 0) { hudT = 0.25; updateHud(t, night); }
  updateEnv(dt);
  if (gfx.high) composer.render(); else renderer.render(scene, camera);
  cssRenderer.render(cssScene, camera);
}
// every lit (standard-material) mesh built so far casts and receives sun shadows; the water only receives
scene.traverse(o => { if (o.isMesh && o.material?.isMeshStandardMaterial) o.castShadow = o.receiveShadow = true; });
water.castShadow = bed.castShadow = false;

function setGfx(high) {
  gfx.high = high; envT = 0;
  try { localStorage.setItem('chhath-gfx', high ? 'high' : 'low'); } catch {}
  $('#gfx').textContent = high ? '✨ Graphics: High' : '⚡ Graphics: Fast';
}
setGfx(gfx.high);
$('#gfx').onclick = () => setGfx(!gfx.high);
addEventListener('keydown', e => { if (started && !isTyping() && e.code === 'KeyG') { setGfx(!gfx.high); toast(gfx.high ? '✨ High graphics: shadows + glow' : '⚡ Fast graphics'); } });
frame();
