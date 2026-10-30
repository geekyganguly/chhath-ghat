// Ghat loudspeaker music.
// Songs come either from a YouTube video (official embedded player, "youtube" in playlist.json) or from
// audio files in public/music/ listed in public/music/playlist.json. Every player derives the
// playlist position from the shared world clock, so everyone on the ghat hears the same song at the same moment.
// Audio runs through a "PA horn" filter chain and gets louder / pans towards the nearest speakers.

const BASE = `${import.meta.env.BASE_URL}music/`;

function probeDuration(src) {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => (isFinite(a.duration) && a.duration > 0 ? resolve(a.duration) : reject());
    a.onerror = reject;
    a.src = src;
  });
}

function hornCurve(amount) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i*2/n - 1; curve[i] = Math.tanh(x*amount)/Math.tanh(amount); }
  return curve;
}

let ytApi = null;
function loadYouTubeApi() {
  ytApi ??= new Promise(resolve => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.append(s);
  });
  return ytApi;
}

export function createMusic(getTime) {
  const audio = new Audio();
  audio.preload = 'auto';
  let ctx = null, gain = null, panner = null;
  let tracks = [], total = 0, cur = -1, enabled = true, ready = false, lastSync = 0, lastVol = 0;
  let yt = null; // { id, title, artist, player, ready }

  const loaded = (async () => {
    try {
      const list = await (await fetch(`${BASE}playlist.json`)).json();
      if (list.youtube?.id) { yt = { ...list.youtube }; loadYouTubeApi(); return; }
      const probed = await Promise.all((list.tracks || []).map(t =>
        probeDuration(BASE + t.file).then(dur => ({ ...t, src:BASE + t.file, dur })).catch(() => null)));
      tracks = probed.filter(Boolean);
      total = tracks.reduce((s, t) => s + t.dur, 0);
    } catch { tracks = []; }
    finally { ready = true; }
  })();

  // YouTube's embedded player must stay visible (min 200×200), so it shows as a small "Ghat TV" screen.
  async function startYouTube() {
    const YT = await loadYouTubeApi();
    document.getElementById('ytbox')?.classList.remove('hidden');
    yt.player = new YT.Player('yt', {
      videoId: yt.id, width: '100%', height: '100%',
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, controls: 1, origin: location.origin },
      events: {
        onReady: e => { yt.ready = true; e.target.setVolume(60); syncYouTube(true); if (enabled) e.target.playVideo(); },
        onStateChange: e => { if (e.data === YT.PlayerState.ENDED) syncYouTube(true); },
      },
    });
  }
  function syncYouTube(force) {
    const p = yt?.player;
    if (!yt?.ready || !enabled) return;
    const d = p.getDuration();
    if (!d) return;
    const target = ((getTime() % d) + d) % d;
    if (force || Math.abs(p.getCurrentTime() - target) > 3) p.seekTo(target, true);
    // -1 unstarted, 0 ended, 5 cued — kick those; leave a deliberate pause (2) alone
    if ([-1, 0, 5].includes(p.getPlayerState())) p.playVideo();
  }

  // Must be called from a user gesture (browsers block autoplay otherwise).
  async function start() {
    await loaded;
    if (yt) { if (!yt.player) startYouTube(); return; }
    if (ctx) return;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaElementSource(audio);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
      const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1800; mid.gain.value = 4;
      const drive = ctx.createWaveShaper(); drive.curve = hornCurve(1.6); drive.oversample = '2x';
      gain = ctx.createGain(); gain.gain.value = 0;
      panner = ctx.createStereoPanner();
      src.connect(hp).connect(mid).connect(lp).connect(drive).connect(gain).connect(panner).connect(ctx.destination);
    } catch { ctx = null; }
  }

  function sync() {
    if (!ready || !total || !enabled) return;
    let pos = getTime() % total; if (pos < 0) pos += total;
    let idx = 0;
    while (idx < tracks.length - 1 && pos >= tracks[idx].dur) { pos -= tracks[idx].dur; idx++; }
    if (idx !== cur) {
      cur = idx;
      audio.src = tracks[idx].src;
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = pos; audio.play().catch(() => {}); }, { once:true });
    } else if (audio.readyState >= 1) {
      if (Math.abs(audio.currentTime - pos) > 2) audio.currentTime = pos;
      if (audio.paused) audio.play().catch(() => {});
    }
  }

  // listener: THREE.Vector3 (camera position), right: unit vector {x,z} pointing to screen-right,
  // speakers: array of THREE.Vector3
  function update(listener, right, speakers) {
    if (!ctx && !yt?.ready) return;
    const now = performance.now();
    if (now - lastSync > (yt ? 2000 : 1000)) { lastSync = now; yt ? syncYouTube(false) : sync(); }
    let sum = 0, panSum = 0;
    for (const s of speakers) {
      const dx = s.x - listener.x, dz = s.z - listener.z, d = Math.hypot(dx, dz, s.y - listener.y);
      const w = 6/(d + 6);
      sum += w; panSum += w * ((dx*right.x + dz*right.z) / (Math.hypot(dx, dz) || 1));
    }
    const vol = enabled ? Math.min(1, 0.12 + sum*0.55) : 0;
    if (yt) {
      const v = Math.round(vol*100);
      if (Math.abs(v - lastVol) >= 3) { lastVol = v; yt.player.setVolume(v); }
      return;
    }
    gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.1);
    panner.pan.setTargetAtTime(sum ? Math.max(-0.8, Math.min(0.8, panSum/sum)) : 0, ctx.currentTime, 0.1);
  }

  function setEnabled(on) {
    enabled = on;
    if (yt) {
      document.getElementById('ytbox')?.classList.toggle('hidden', !on);
      if (!yt.ready) return;
      if (on) { yt.player.playVideo(); syncYouTube(true); } else yt.player.pauseVideo();
      return;
    }
    if (ctx?.state === 'suspended') ctx.resume();
    if (!on) audio.pause(); else { cur = -1; sync(); }
  }

  return {
    loaded, start, update, setEnabled,
    get enabled() { return enabled; },
    get track() { return yt ? (yt.ready ? yt : null) : ready && total && cur >= 0 ? tracks[cur] : null; },
    // true only while the YouTube video is actually playing (or buffering after it has started)
    get playing() {
      if (!yt) return enabled && !audio.paused;
      if (!yt.ready || !enabled) return false;
      const st = yt.player.getPlayerState();
      if (st === 1) yt.started = true;
      return st === 1 || (st === 3 && !!yt.started);
    },
    get hasSongs() { return !!yt || (ready && total > 0); },
  };
}
