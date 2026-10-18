'use strict';
(function () {
  /* =====================================================================
     Shared helpers
     ===================================================================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D2R = Math.PI / 180, S2 = Math.SQRT2, S3 = Math.sqrt(3);
  const EPS = 1e-6;
  const HAS3D = typeof THREE !== 'undefined' && THREE.OrbitControls;
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  /* Language: every string lives next to its translation. tx() picks one at call time, DATA tables are rebuilt and
     HOOKS rewrite the generated text, so switching language never touches the 3D scenes or the state of any control. */
  const X = window.XI18N || { stored: () => 'en', save() {}, apply() {} };
  let LANG = X.stored();
  const tx = (en, zh) => (LANG === 'zh' ? zh : en);
  const DATA = [], HOOKS = [];
  const dataset = f => { DATA.push(f); f(); };
  const onLang = f => HOOKS.push(f);

  const COL = { corner: '#4F7FE0', face: '#1FA386', body: '#E7962A', plane: '#7A5CF0' };
  const T = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['stage', 'edge3d', 'ghost3d', 'ink', 'muted', 'accent', 'line', 'hi', 'grid', 'surface', 'ok', 'bad', 'film', 'filmline'])
      T[k] = cs.getPropertyValue('--' + k).trim();
  }
  readTheme();

  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
  const gcdN = arr => arr.reduce((g, x) => gcd(g, x), 0);
  const isInt = x => Math.abs(x - Math.round(x)) < EPS;
  const frac = x => { const f = x - Math.floor(x + EPS); return Math.abs(f) < EPS ? 0 : f; };
  const fmt = (x, d = 3) => (Math.abs(x) < 5e-10 ? 0 : x).toFixed(d);

  // Index formatting: negative numbers get an overbar, e.g. [1 -1 0] -> 1 1̄ 0
  function idxHTML(arr, br = '()') {
    return '<span class="idx">' + br[0] + arr.map(n => n < 0 ? `<span class="bar">${-n}</span>` : String(n)).join(arr.some(n => Math.abs(n) > 9) ? ' ' : '') + br[1] + '</span>';
  }
  const idxText = (arr, br = '()') => br[0] + arr.map(n => String(n)).join('') + br[1]; // "-" handled by sprite renderer
  const UNI = { '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/8': '⅛', '3/8': '⅜', '5/8': '⅝', '7/8': '⅞' };
  function fracStr(x) {
    if (!isFinite(x)) return '∞';
    if (isInt(x)) return String(Math.round(x)).replace('-', '−');
    const s = x < 0 ? '−' : ''; x = Math.abs(x);
    for (let den = 2; den <= 12; den++) {
      const num = x * den;
      if (isInt(num)) { const n = Math.round(num), g = gcd(n, den); const k = `${n / g}/${den / g}`; return s + (UNI[k] || k); }
    }
    return s + x.toFixed(3);
  }
  const fracTxt = x => fracStr(x); // for sprite labels (unicode fractions render fine)

  function seg(el, onPick) {
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      setSeg(el, b.dataset.v); onPick(b.dataset.v);
    });
  }
  function setSeg(el, v) { $$('button', el).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); }
  const intIn = (el, lo = -4, hi = 4) => { let v = parseInt(el.value, 10); if (isNaN(v)) v = 0; return Math.max(lo, Math.min(hi, v)); };

  /* =====================================================================
     One WebGL renderer shared by every 3D stage (copied onto 2D canvases)
     ===================================================================== */
  let GL = null;
  if (HAS3D) {
    try { GL = new THREE.WebGLRenderer({ antialias: true, alpha: true }); GL.setPixelRatio(1); GL.localClippingEnabled = true; }
    catch (e) { GL = null; }
  }
  let glW = 0, glH = 0;
  function glEnsure(w, h) { if (w <= glW && h <= glH) return; glW = Math.max(glW, w); glH = Math.max(glH, h); GL.setSize(glW, glH, false); }

  const VIEWERS = [];
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => {
    for (const e of es) {
      const v = e.target.__viewer; if (!v) continue;
      v.visible = e.isIntersecting;
      if (v.visible) { v.dirty = true; if (v.init) { const f = v.init; v.init = null; f(); } }
      else v.setLive(false);
    }
  }, { rootMargin: '200px' }) : null;
  const ro = new ResizeObserver(es => { for (const e of es) { const v = e.target.__viewer; if (v) v.resize(); } });
  // Tapping outside a live stage hands touch scrolling back to the page
  document.addEventListener('pointerdown', e => { VIEWERS.forEach(v => { if (v.live && !v.host.contains(e.target)) v.setLive(false); }); }, true);

  const GEO = {};
  if (GL) {
    GEO.sphere = new THREE.SphereGeometry(1, 36, 18);
    GEO.cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
    GEO.cone = new THREE.ConeGeometry(1, 1, 20);
    Object.values(GEO).forEach(g => (g.userData.shared = true));
  }
  const UP = GL ? V3(0, 1, 0) : null;

  class Viewer {
    constructor(host, opt = {}) {
      this.host = host; host.__viewer = this;
      this.fov = opt.fov || 30; this.view = opt.view || [1, 0.42, 0.5];
      this.clearA = opt.clear ?? 1; // 0 = transparent, so the stage's CSS background shows through
      this.cv = document.createElement('canvas');
      this.cv.setAttribute('role', 'img'); this.labelFn = opt.label || (() => tx('3D model you can drag to rotate', '可以拖曳旋轉的 3D 模型'));
      host.appendChild(this.cv);
      this.ctx = this.cv.getContext('2d');
      this.scene = new THREE.Scene();
      this.cam = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 500); this.cam.up.set(0, 0, 1);
      this.scene.add(this.cam);
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5d6578, 0.72));
      const dl = new THREE.DirectionalLight(0xffffff, 0.78); dl.position.set(-2, 3, 4); this.cam.add(dl);
      this.root = new THREE.Group(); this.scene.add(this.root);
      this.ctl = new THREE.OrbitControls(this.cam, this.cv);
      this.ctl.enablePan = false; this.ctl.rotateSpeed = 0.85; this.ctl.autoRotateSpeed = 1.4; this.ctl.zoomSpeed = 0.8;
      this.ctl.addEventListener('change', () => { this.dirty = true; });
      const tools = document.createElement('div'); tools.className = 'stage-tools';
      tools.innerHTML = '<button type="button" data-act="in"></button><button type="button" data-act="out"></button><button type="button" data-act="reset"></button><button type="button" data-act="spin" aria-pressed="false"></button>';
      this.tools = tools;
      host.appendChild(tools);
      tools.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
        if (act === 'reset') this.reset(); else if (act === 'spin') this.setSpin(!this.spin); else this.zoomBy(act === 'in' ? 0.8 : 1.25);
      });
      this.spinBtn = $('[data-act=spin]', tools);
      this.hint = document.createElement('div'); this.hint.className = 'stage-hint'; host.appendChild(this.hint);
      this.live = false; this.applyLang();
      if (COARSE) {
        // Phones: the page scrolls through the model until it is tapped
        this.ctl.enabled = false; this.cv.style.touchAction = 'pan-y';
        this.cv.addEventListener('click', () => { if (!this.live) this.setLive(true); });
      } else {
        // Desktop: dragging always rotates; the wheel only zooms after a click, so page scrolling is never hijacked
        this.ctl.enableZoom = false;
        this.cv.addEventListener('pointerdown', () => this.setLive(true));
        host.addEventListener('pointerleave', () => this.setLive(false));
      }
      this.setLive(false);
      this.visible = !io; this.dirty = true; this.spin = false; this.anim = null; this.init = null;
      if (io) io.observe(host); ro.observe(host); VIEWERS.push(this); this.resize();
    }
    lazy(fn) { if (this.visible || !io) fn(); else this.init = fn; }
    setLive(on) {
      if (on === this.live && this.hint.textContent) return;
      this.live = on; this.host.classList.toggle('live', on);
      if (COARSE) { this.ctl.enabled = on; this.cv.style.touchAction = on ? 'none' : 'pan-y'; }
      else this.ctl.enableZoom = on;
      this.hint.textContent = this.hintText();
      this.hint.classList.toggle('cta', COARSE && !on);
    }
    hintText() {
      const on = this.live;
      return COARSE ? (on ? tx('One finger rotates, two fingers zoom · tap outside to scroll', '操作中：單指旋轉、雙指縮放・點模型外面就能繼續捲動') : tx('Tap the model to start', '點一下模型開始操作'))
        : (on ? tx('Drag to rotate · scroll to zoom', '拖曳旋轉・滾輪縮放') : tx('Drag to rotate · click first to zoom with the wheel', '拖曳旋轉・點一下後可用滾輪縮放'));
    }
    applyLang() {
      this.cv.setAttribute('aria-label', this.labelFn());
      const set = (act, text, label) => { const b = $(`[data-act=${act}]`, this.tools); b.textContent = text; if (label) b.setAttribute('aria-label', label); };
      set('in', tx('+', '＋'), tx('Zoom in', '放大')); set('out', tx('−', '－'), tx('Zoom out', '縮小'));
      set('reset', tx('Reset', '重設')); set('spin', tx('Spin', '旋轉'));
      this.hint.textContent = this.hintText();
    }
    setSpin(on) { this.spin = on; this.ctl.autoRotate = on; this.spinBtn.setAttribute('aria-pressed', String(on)); this.dirty = true; }
    fitDist() {
      const vf = this.fov * D2R, hf = 2 * Math.atan(Math.tan(vf / 2) * this.cam.aspect);
      return this.radius / Math.sin(Math.min(vf, hf) / 2) * 1.02;
    }
    ratio() { return this.radius ? this.cam.position.distanceTo(this.ctl.target) / this.fitDist() : 1; }
    resize() {
      const r = this.host.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
      if (w === this.cv.width && h === this.cv.height) return;
      const k = this.ratio();
      this.cv.width = w; this.cv.height = h; this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      if (this.radius) this._place(this.cam.position.clone().sub(this.ctl.target), k);
      this.dirty = true;
    }
    // Re-centre on new content. Without an explicit direction the user's current angle and zoom are kept.
    frame(center, radius, dir) {
      const had = !!this.radius, cur = had ? this.cam.position.clone().sub(this.ctl.target) : null, k = this.ratio();
      this.center = center.clone(); this.radius = radius;
      if (dir) this.curView = dir; else if (!this.curView) this.curView = this.view;
      this.ctl.target.copy(this.center);
      if (dir || !had) this._place(V3(...this.curView), 1); else this._place(cur, k);
    }
    _place(dir, k = 1) {
      this.cam.position.copy(this.center).add(dir.clone().normalize().multiplyScalar(this.fitDist() * k));
      this.ctl.update(); this.dirty = true;
    }
    zoomBy(f) { if (!this.radius) return; const k = Math.max(0.35, Math.min(3, this.ratio() * f)); this._place(this.cam.position.clone().sub(this.ctl.target), k); }
    reset() { if (this.radius) this._place(V3(...this.curView), 1); }
    clear() {
      this.root.traverse(o => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
      });
      this.root.clear(); this.dirty = true;
    }
    render() {
      const w = this.cv.width, h = this.cv.height;
      glEnsure(w, h);
      GL.setViewport(0, 0, w, h); GL.setScissor(0, 0, w, h); GL.setScissorTest(true);
      GL.setClearColor(new THREE.Color(this.clearA ? T.stage : (T.film || T.stage)), this.clearA);
      GL.render(this.scene, this.cam);
      this.ctx.clearRect(0, 0, w, h);
      this.ctx.drawImage(GL.domElement, 0, glH - h, w, h, 0, 0, w, h);
    }
  }

  function loop(t) {
    for (const v of VIEWERS) {
      if (!v.visible) continue;
      if (v.spin) v.ctl.update();
      if (v.anim) v.anim(t);
      if (v.dirty) { v.dirty = false; v.render(); }
    }
    requestAnimationFrame(loop);
  }

  /* ---------- scene-building primitives ---------- */
  function mStd(color, o = {}) {
    const op = o.opacity ?? 1;
    return new THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.42, metalness: 0.04, transparent: op < 1, opacity: op, depthWrite: op >= 1,
      clippingPlanes: o.clip || null, side: o.clip ? THREE.DoubleSide : THREE.FrontSide,
      depthTest: o.depthTest ?? true, emissive: o.emissive || 0x000000
    });
  }
  function mBasic(color, o = {}) {
    const op = o.opacity ?? 1;
    return new THREE.MeshBasicMaterial({ color, transparent: op < 1, opacity: op, depthWrite: o.depthWrite ?? (op >= 1), depthTest: o.depthTest ?? true, side: o.side || THREE.FrontSide });
  }
  function atom(g, p, r, color, o = {}) {
    const m = new THREE.Mesh(GEO.sphere, mStd(color, o)); m.position.copy(p); m.scale.setScalar(r);
    if (o.order) m.renderOrder = o.order; g.add(m); return m;
  }
  function rod(g, a, b, r, mat) {
    const d = b.clone().sub(a), L = d.length(); if (L < 1e-9) return null;
    const m = new THREE.Mesh(GEO.cyl, mat); m.position.copy(a).addScaledVector(d, 0.5);
    m.scale.set(r, L, r); m.quaternion.setFromUnitVectors(UP, d.normalize()); g.add(m); return m;
  }
  function arrow(g, a, b, r, color, o = {}) {
    const mat = o.basic ? mBasic(color, o) : mStd(color, o);
    const d = b.clone().sub(a), L = d.length(); if (L < 1e-9) return;
    const u = d.clone().normalize(), hl = Math.min(r * 6, L * 0.4);
    const base = b.clone().addScaledVector(u, -hl);
    const s = rod(g, a, base, r, mat); if (s && o.order) s.renderOrder = o.order;
    const c = new THREE.Mesh(GEO.cone, mat); c.position.copy(base).addScaledVector(u, hl / 2);
    c.scale.set(r * 2.6, hl, r * 2.6); c.quaternion.setFromUnitVectors(UP, u); if (o.order) c.renderOrder = o.order; g.add(c);
  }
  function cellEdges(g, O, A, B, C, r, mat) {
    const P = (i, j, k) => O.clone().addScaledVector(A, i).addScaledVector(B, j).addScaledVector(C, k);
    for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      rod(g, P(0, i, j), P(1, i, j), r, mat); rod(g, P(i, 0, j), P(i, 1, j), r, mat); rod(g, P(i, j, 0), P(i, j, 1), r, mat);
    }
  }
  function dashed(g, pairs, color, o = {}) {
    const pts = []; pairs.forEach(([a, b]) => pts.push(a, b));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color, dashSize: o.dash || 0.06, gapSize: o.gap || 0.045, transparent: true, opacity: o.opacity ?? 0.9 });
    const ls = new THREE.LineSegments(geo, mat); ls.computeLineDistances(); g.add(ls); return ls;
  }
  function poly(g, pts, color, opacity = 0.32, outline = true) {
    const arr = [];
    for (let i = 1; i < pts.length - 1; i++) arr.push(...pts[0].toArray(), ...pts[i].toArray(), ...pts[i + 1].toArray());
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const m = new THREE.Mesh(geo, mBasic(color, { opacity, side: THREE.DoubleSide, depthWrite: false })); m.renderOrder = 3; g.add(m);
    if (outline) { const lg = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]); g.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color }))); }
    return m;
  }
  // Text sprite. A "-" directly before a digit is drawn as an overbar on that digit.
  function measureIdx(x, s) { let w = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '-' && /\d/.test(s[i + 1] || '')) continue; w += x.measureText(s[i]).width; } return w; }
  function drawIdx(x, s, x0, y, fs, stroke) {
    let cx = x0;
    for (let i = 0; i < s.length; i++) {
      let ch = s[i], bar = false;
      if (ch === '-' && /\d/.test(s[i + 1] || '')) { bar = true; ch = s[++i]; }
      const w = x.measureText(ch).width;
      if (stroke) x.strokeText(ch, cx, y); else x.fillText(ch, cx, y);
      if (bar) { const yb = y - fs * 0.5; x.beginPath(); x.moveTo(cx + w * 0.12, yb); x.lineTo(cx + w * 0.88, yb); if (stroke) { x.lineWidth = fs * 0.32; x.stroke(); } else { x.lineWidth = fs * 0.075; x.strokeStyle = x.fillStyle; x.stroke(); } }
      cx += w;
    }
  }
  function label(g, text, p, o = {}) {
    const fs = 64, font = `${o.weight || 600} ${fs}px "IBM Plex Mono","IBM Plex Sans","Noto Sans TC",monospace`;
    const c = document.createElement('canvas'), x = c.getContext('2d'); x.font = font;
    const w = measureIdx(x, text);
    c.width = Math.ceil(w + fs * 0.6); c.height = Math.ceil(fs * 1.55);
    x.font = font; x.textBaseline = 'middle'; x.lineJoin = 'round';
    const y = c.height * 0.56;
    x.strokeStyle = T.stage; x.lineWidth = fs * 0.32; drawIdx(x, text, fs * 0.3, y, fs, true);
    x.fillStyle = o.color || T.ink; drawIdx(x, text, fs * 0.3, y, fs, false);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: !!o.depth, depthWrite: false, transparent: true }));
    sp.renderOrder = 30; const s = (o.size || 0.12) * 1.2; sp.scale.set(s * c.width / c.height, s, 1);
    sp.position.copy(p); g.add(sp); return sp;
  }
  // Polygon where a plane n·p = val cuts a convex solid (vertices + edges)
  function slice(verts, edges, n, val) {
    const pts = [];
    const add = p => { if (!pts.some(q => q.distanceTo(p) < 1e-5)) pts.push(p); };
    verts.forEach(v => { if (Math.abs(n.dot(v) - val) < 1e-6) add(v.clone()); });
    edges.forEach(([i, j]) => {
      const a = verts[i], b = verts[j], fa = n.dot(a) - val, fb = n.dot(b) - val;
      if (fa * fb < -1e-12) add(a.clone().lerp(b, fa / (fa - fb)));
    });
    if (pts.length < 3) return null;
    const c = pts.reduce((s, p) => s.add(p), V3(0, 0, 0)).multiplyScalar(1 / pts.length);
    const nn = n.clone().normalize();
    const u = (Math.abs(nn.x) < 0.9 ? V3(1, 0, 0) : V3(0, 1, 0)).cross(nn).normalize(), w = nn.clone().cross(u);
    pts.sort((p, q) => Math.atan2(p.clone().sub(c).dot(w), p.clone().sub(c).dot(u)) - Math.atan2(q.clone().sub(c).dot(w), q.clone().sub(c).dot(u)));
    return pts;
  }
  // Part of a unit sphere kept by half-spaces n·d ≥ 0 through its centre, closed with flat caps.
  // Cut planes always run along the 7.5° tessellation lines, so the edges stay clean.
  const WEDGE = new Map();
  function wedgeGeo(ns) {
    const key = ns.map(n => n.toArray().map(x => x.toFixed(3)).join()).join('|');
    if (WEDGE.has(key)) return WEDGE.get(key);
    const src = new THREE.SphereGeometry(1, 48, 24).toNonIndexed(); src.rotateX(Math.PI / 2);
    const P = src.attributes.position.array, Nn = src.attributes.normal.array;
    const sp = [], sn = [], cp = [], cn = []; let kept = 0, total = 0;
    const tri = (a, b, c) => b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    for (let t = 0; t < P.length; t += 9) {
      const a = V3(P[t], P[t + 1], P[t + 2]), b = V3(P[t + 3], P[t + 4], P[t + 5]), c = V3(P[t + 6], P[t + 7], P[t + 8]);
      const ar = tri(a, b, c); total += ar;
      const m = a.clone().add(b).add(c).multiplyScalar(1 / 3);
      if (ns.every(n => n.dot(m) >= -1e-7)) { kept += ar; for (let k = 0; k < 9; k++) { sp.push(P[t + k]); sn.push(Nn[t + k]); } }
    }
    ns.forEach((n, i) => {
      const w = Math.abs(n.z) > 0.9 ? V3(0, 1, 0) : V3(0, 0, 1);
      const u = Math.abs(n.z) > 0.9 ? V3(1, 0, 0) : w.clone().cross(n).normalize();
      for (let j = 0; j < 48; j++) {
        const a0 = j * Math.PI / 24, a1 = (j + 1) * Math.PI / 24;
        const p1 = u.clone().multiplyScalar(Math.cos(a0)).addScaledVector(w, Math.sin(a0));
        const p2 = u.clone().multiplyScalar(Math.cos(a1)).addScaledVector(w, Math.sin(a1));
        const m = p1.clone().add(p2).multiplyScalar(1 / 3);
        if (!ns.every((o, k) => k === i || o.dot(m) >= -1e-7)) continue;
        [V3(0, 0, 0), p1, p2].forEach(q => { cp.push(q.x, q.y, q.z); cn.push(-n.x, -n.y, -n.z); });
      }
    });
    const mk = (pos, nor) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.userData.shared = true; return g; };
    const out = { shell: mk(sp, sn), cap: mk(cp, cn), frac: kept / total };
    src.dispose(); WEDGE.set(key, out); return out;
  }
  // Atom cut by any of the given planes that pass through its centre; returns the kept fraction
  function cutAtom(g, p, r, color, planes, o = {}) {
    const ns = planes.filter(pl => Math.abs(pl.distanceToPoint(p)) < 1e-6).map(pl => pl.normal.clone());
    if (!ns.length) { atom(g, p, r, color, o); return 1; }
    const W = wedgeGeo(ns);
    const shell = new THREE.Mesh(W.shell, mStd(color, o));
    const cap = new THREE.Mesh(W.cap, mStd(new THREE.Color(color).multiplyScalar(0.72), { rough: 0.7, ...o }));
    cap.material.side = THREE.DoubleSide;
    [shell, cap].forEach(m => { m.position.copy(p); m.scale.setScalar(r); g.add(m); });
    return W.frac;
  }
  const CUBE_V = GL ? [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]].map(a => V3(...a)) : [];
  const CUBE_E = []; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const d = i ^ j; if (d === 1 || d === 2 || d === 4) CUBE_E.push([i, j]); }

  // Crystal bases in fractional coordinates
  const FCC_B = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
  const BASIS = {
    SC: [[0, 0, 0]],
    BCC: [[0, 0, 0], [.5, .5, .5]],
    FCC: FCC_B,
    DIA: [...FCC_B, ...FCC_B.map(p => p.map(x => x + .25))]
  };
  // All atom positions inside the closed cube [0,1]^3 (optionally range r0..r1)
  function sitesIn(basis, lo = 0, hi = 1) {
    const out = [], seen = new Set();
    for (let i = Math.floor(lo) - 1; i <= Math.ceil(hi); i++) for (let j = Math.floor(lo) - 1; j <= Math.ceil(hi); j++) for (let k = Math.floor(lo) - 1; k <= Math.ceil(hi); k++)
      basis.forEach((b, bi) => {
        const p = [b[0] + i, b[1] + j, b[2] + k];
        if (p.every(x => x > lo - EPS && x < hi + EPS)) { const key = p.map(x => x.toFixed(4)).join(); if (!seen.has(key)) { seen.add(key); out.push({ p, bi }); } }
      });
    return out;
  }
  const onBound = p => p.filter(x => Math.abs(x) < EPS || Math.abs(x - 1) < EPS).length; // 3 corner, 1 face, 0 inside
  const kindColor = p => { const n = onBound(p); return n === 3 ? COL.corner : n === 0 ? COL.body : COL.face; };
  const hexVerts = (z, a = 1) => [0, 1, 2, 3, 4, 5].map(i => V3(a * Math.cos(i * Math.PI / 3), a * Math.sin(i * Math.PI / 3), z));
  function hexPrism(c, a = 1) {
    const v = [...hexVerts(0, a), ...hexVerts(c, a)], e = [];
    for (let i = 0; i < 6; i++) { e.push([i, (i + 1) % 6], [6 + i, 6 + (i + 1) % 6], [i, 6 + i]); }
    return { v, e };
  }
  function hexEdges(g, c, r, mat, z0 = 0) {
    const P = hexPrism(c); P.e.forEach(([i, j]) => rod(g, P.v[i].clone().setZ(P.v[i].z + z0), P.v[j].clone().setZ(P.v[j].z + z0), r, mat));
  }

  /* =====================================================================
     Hero: 2×2×2 FCC, coloured by (111) layer (A/B/C)
     ===================================================================== */
  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [1, 0.55, 0.45], label: () => tx('Hard-sphere model of 8 FCC unit cells', '8 個 FCC 晶胞的硬球模型'), clear: 0 });
    const LAY = [COL.corner, COL.body, COL.face];
    v.rebuild = () => {
      v.clear(); const g = v.root, R = S2 / 4;
      const sites = sitesIn(FCC_B, 0, 2);
      sites.forEach(({ p }) => { const L = Math.round(p[0] + p[1] + p[2]); atom(g, V3(...p), R * 0.985, LAY[((L % 3) + 3) % 3]); });
      const em = mStd(T.filmline || T.edge3d);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) cellEdges(g, V3(i, j, k), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.008, em);
    };
    v.rebuild(); v.frame(V3(1, 1, 1), 2.5);
    if (!REDUCED) v.setSpin(true);
  }

  /* =====================================================================
     01 Lattice & unit cell
     ===================================================================== */
  function secLattice() {
    const v = new Viewer($('#v-lattice'), { view: [1, 0.5, 0.55] });
    const st = { mode: 'lattice', one: false };
    const A = V3(1, 0, 0), B = V3(0, 1.15, 0), C = V3(0, 0, 0.95);
    const BASE = [{ d: [0, 0, 0], r: 0.17, c: COL.corner }, { d: [0.3, 0.22, 0.1], r: 0.1, c: COL.body }, { d: [0.06, 0.34, 0.3], r: 0.085, c: COL.face }];
    const legend = $('#lat-legend'), info = $('#lat-info');
    v.rebuild = () => {
      v.clear(); const g = v.root;
      const n = st.one ? [2, 2, 2] : [4, 4, 3];
      const P = (i, j, k) => V3(0, 0, 0).addScaledVector(A, i).addScaledVector(B, j).addScaledVector(C, k);
      const faint = mStd(T.ghost3d, { opacity: 0.7 });
      for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
        if (i + 1 < n[0]) rod(g, P(i, j, k), P(i + 1, j, k), 0.007, faint);
        if (j + 1 < n[1]) rod(g, P(i, j, k), P(i, j + 1, k), 0.007, faint);
        if (k + 1 < n[2]) rod(g, P(i, j, k), P(i, j, k + 1), 0.007, faint);
        const p = P(i, j, k);
        if (st.mode === 'lattice') atom(g, p, 0.065, T.edge3d);
        else BASE.forEach(b => atom(g, p.clone().add(V3(...b.d)), b.r, b.c));
      }
      cellEdges(g, V3(0, 0, 0), A, B, C, 0.028, mStd(T.accent));
      label(g, 'a', A.clone().multiplyScalar(0.5).add(V3(0.1, -0.16, -0.12)), { color: T.accent, size: 0.26 });
      label(g, 'b', B.clone().multiplyScalar(0.5).add(V3(0.1, 0, -0.16)), { color: T.accent, size: 0.26 });
      label(g, 'c', C.clone().multiplyScalar(0.5).add(V3(0.12, -0.14, 0)), { color: T.accent, size: 0.26 });
      const ctr = P((n[0] - 1) / 2, (n[1] - 1) / 2, (n[2] - 1) / 2);
      v.frame(ctr, P(n[0] - 1, n[1] - 1, n[2] - 1).length() / 2 + 0.35);
    };
    function text() {
      legend.innerHTML = st.mode === 'lattice'
        ? tx(`<span><i style="background:${T.edge3d}"></i>Lattice point (marks a position only)</span><span><i class="sq" style="background:var(--accent)"></i>One unit cell</span>`, `<span><i style="background:${T.edge3d}"></i>晶格點（只代表位置）</span><span><i class="sq" style="background:var(--accent)"></i>一個單位晶胞</span>`)
        : tx(`<span><i style="background:${COL.corner}"></i><i style="background:${COL.body};margin-left:-4px"></i><i style="background:${COL.face};margin-left:-4px"></i>Basis: a group of 3 atoms</span><span><i class="sq" style="background:var(--accent)"></i>One unit cell</span>`, `<span><i style="background:${COL.corner}"></i><i style="background:${COL.body};margin-left:-4px"></i><i style="background:${COL.face};margin-left:-4px"></i>基底：一組 3 個原子</span><span><i class="sq" style="background:var(--accent)"></i>一個單位晶胞</span>`);
      info.innerHTML = st.mode === 'lattice'
        ? tx(`<h4>Lattice points only</h4><p>Each point means “an identical copy sits here”. The distance between points is the lattice constant: a, b and c along the three directions. In this example all three angles are 90°.</p>`, `<h4>只有晶格點</h4><p>每個點代表「這裡有一份一模一樣的東西」。點和點之間的距離就是晶格常數：沿三個方向分別是 a、b、c。這個例子的三個夾角都是 90°。</p>`)
        : tx(`<h4>Crystal = lattice + basis</h4><p>Put the same group of 3 atoms (the basis) on every lattice point and you get the real crystal. Note that a lattice point does not have to sit at the center of an atom. It only marks a position that repeats.</p>`, `<h4>晶體 ＝ 晶格 ＋ 基底</h4><p>在每個晶格點放上同一組 3 個原子（基底），就得到真正的晶體。注意：晶格點不一定要放在原子正中心，它只是用來標記「重複的位置」。</p>`);
      if (st.one) info.innerHTML += tx(`<p class="note">With only one cell shown, each of the 8 corners has a lattice point. Those points also belong to the neighboring cells.</p>`, `<p class="note">只看一個晶胞時，8 個角落各有一個晶格點；它們同時也屬於相鄰的晶胞。</p>`);
    }
    seg($('#lat-mode'), x => { st.mode = x; v.rebuild(); text(); });
    $('#lat-one').addEventListener('change', e => { st.one = e.target.checked; v.rebuild(); text(); });
    v.lazy(v.rebuild); text(); onLang(text);
  }

  /* =====================================================================
     02 Crystal systems & Bravais lattices
     ===================================================================== */
  let SYS; dataset(() => { SYS = [
    { id: 'cubic', zh: '立方', en: 'Cubic', a: 1, b: 1, c: 1, al: 90, be: 90, ga: 90, rule: tx('a = b = c; α = β = γ = 90°', 'a = b = c；α = β = γ = 90°'), types: 'PIF', ex: { P: 'α-Po', I: tx('Fe, W, Cr', 'Fe、W、Cr'), F: tx('Cu, Al, Au', 'Cu、Al、Au') } },
    { id: 'tet', zh: '正方（四方）', en: 'Tetragonal', a: 1, b: 1, c: 1.45, al: 90, be: 90, ga: 90, rule: tx('a = b ≠ c; α = β = γ = 90°', 'a = b ≠ c；α = β = γ = 90°'), types: 'PI', ex: { P: tx('the lattice of TiO₂ (rutile)', 'TiO₂（金紅石）的晶格'), I: tx('white tin β-Sn, In', '白錫 β-Sn、In') } },
    { id: 'ort', zh: '斜方（正交）', en: 'Orthorhombic', a: 0.8, b: 1.05, c: 1.35, al: 90, be: 90, ga: 90, rule: tx('a ≠ b ≠ c; α = β = γ = 90°', 'a ≠ b ≠ c；α = β = γ = 90°'), types: 'PCIF', ex: { P: tx('the lattice of olivine', '橄欖石的晶格'), C: tx('α-U, Ga', 'α-U、Ga'), I: '—', F: tx('orthorhombic sulfur α-S', '斜方硫 α-S') } },
    { id: 'rho', zh: '菱方（三方）', en: 'Rhombohedral', a: 1, b: 1, c: 1, al: 72, be: 72, ga: 72, rule: tx('a = b = c; α = β = γ ≠ 90°', 'a = b = c；α = β = γ ≠ 90°'), types: 'P', ex: { P: tx('Bi, calcite CaCO₃', 'Bi、方解石 CaCO₃') } },
    { id: 'hex', zh: '六方', en: 'Hexagonal', a: 1, b: 1, c: 1.6, al: 90, be: 90, ga: 120, rule: tx('a = b ≠ c; α = β = 90°, γ = 120°', 'a = b ≠ c；α = β = 90°，γ = 120°'), types: 'P', ex: { P: tx('Mg, Zn, Ti, graphite', 'Mg、Zn、Ti、石墨') } },
    { id: 'mon', zh: '單斜', en: 'Monoclinic', a: 0.85, b: 1.05, c: 1.3, al: 90, be: 108, ga: 90, rule: tx('a ≠ b ≠ c; α = γ = 90° ≠ β', 'a ≠ b ≠ c；α = γ = 90° ≠ β'), types: 'PC', ex: { P: tx('monoclinic sulfur β-S', '單斜硫 β-S'), C: tx('gypsum CaSO₄·2H₂O', '石膏 CaSO₄·2H₂O') } },
    { id: 'tri', zh: '三斜', en: 'Triclinic', a: 0.85, b: 1.05, c: 1.25, al: 78, be: 100, ga: 108, rule: tx('a ≠ b ≠ c; α ≠ β ≠ γ ≠ 90°', 'a ≠ b ≠ c；α ≠ β ≠ γ ≠ 90°'), types: 'P', ex: { P: tx('chalcanthite CuSO₄·5H₂O', '膽礬 CuSO₄·5H₂O') } }
  ]; });
  const CENT = { P: [], I: [[.5, .5, .5]], F: [[0, .5, .5], [1, .5, .5], [.5, 0, .5], [.5, 1, .5], [.5, .5, 0], [.5, .5, 1]], C: [[.5, .5, 0], [.5, .5, 1]] };
  let CNAME; dataset(() => { CNAME = { P: tx('simple', '簡單'), I: tx('body-centered', '體心'), F: tx('face-centered', '面心'), C: tx('base-centered', '底心') }; });
  const CEN_EN = { P: 'Simple', I: 'Body-centered', F: 'Face-centered', C: 'Base-centered' };
  function cellVecs(s) {
    const al = s.al * D2R, be = s.be * D2R, ga = s.ga * D2R;
    const A = V3(s.a, 0, 0), B = V3(s.b * Math.cos(ga), s.b * Math.sin(ga), 0);
    const cx = s.c * Math.cos(be), cy = s.c * (Math.cos(al) - Math.cos(be) * Math.cos(ga)) / Math.sin(ga);
    return [A, B, V3(cx, cy, Math.sqrt(Math.max(0, s.c * s.c - cx * cx - cy * cy)))];
  }
  function secBravais() {
    const v = new Viewer($('#v-bravais'), { view: [1, 0.38, 0.45] });
    const st = { sys: 'cubic', type: 'P', demo: null, hexFull: true };
    const sysEl = $('#bv-sys'), typeEl = $('#bv-type'), info = $('#bv-info'), hexWrap = $('#bv-hexwrap');
    const sysLabel = s => tx(s.en, s.zh);
    sysEl.innerHTML = SYS.map(s => `<button type="button" data-v="${s.id}">${sysLabel(s)}</button>`).join('');
    onLang(() => { $$('button', sysEl).forEach((b, i) => { b.textContent = sysLabel(SYS[i]); }); });
    const pt = (g, p, kind, ghost) => atom(g, p, ghost ? 0.06 : 0.085, kind, ghost ? { opacity: 0.35 } : {});

    function buildSystem(g) {
      const s = SYS.find(x => x.id === st.sys); const [A, B, C] = cellVecs(s);
      const P = f => V3(0, 0, 0).addScaledVector(A, f[0]).addScaledVector(B, f[1]).addScaledVector(C, f[2]);
      const em = mStd(T.edge3d), am = mStd(T.accent);
      cellEdges(g, V3(0, 0, 0), A, B, C, 0.012, em);
      rod(g, V3(0, 0, 0), A, 0.02, am); rod(g, V3(0, 0, 0), B, 0.02, am); rod(g, V3(0, 0, 0), C, 0.02, am);
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) pt(g, P([i, j, k]), COL.corner);
      CENT[st.type].forEach(f => pt(g, P(f), st.type === 'I' ? COL.body : COL.face));
      const out = A.clone().add(B).add(C).normalize().multiplyScalar(-0.13);
      label(g, 'a', A.clone().multiplyScalar(0.55).add(out), { color: T.accent, size: 0.15 });
      label(g, 'b', B.clone().multiplyScalar(0.55).add(out), { color: T.accent, size: 0.15 });
      label(g, 'c', C.clone().multiplyScalar(0.55).add(out), { color: T.accent, size: 0.15 });
      const ang = (u, w, t) => label(g, t, u.clone().normalize().add(w.clone().normalize()).normalize().multiplyScalar(0.3), { color: T.muted, size: 0.12 });
      ang(B, C, 'α'); ang(A, C, 'β'); ang(A, B, 'γ');
      let ctr = A.clone().add(B).add(C).multiplyScalar(0.5), rad = Math.max(A.clone().add(B).add(C).length(), A.clone().sub(B).add(C).length(), A.clone().add(B).sub(C).length(), B.clone().add(C).sub(A).length()) / 2 + 0.2;
      if (st.sys === 'hex' && st.hexFull) {
        const hv0 = [A, A.clone().add(B), B, A.clone().negate(), A.clone().add(B).negate(), B.clone().negate()];
        const pairs = [];
        hv0.forEach((p, i) => { const q = hv0[(i + 1) % 6]; pairs.push([p, q], [p.clone().add(C), q.clone().add(C)], [p, p.clone().add(C)]); });
        dashed(g, pairs, T.muted, { dash: 0.07, gap: 0.05 });
        [...hv0, V3(0, 0, 0)].forEach(p => { [0, 1].forEach(z => { const q = p.clone().addScaledVector(C, z); if (!(q.distanceTo(V3(0, 0, 0)) < EPS || q.distanceTo(A) < EPS || q.distanceTo(B) < EPS || q.distanceTo(A.clone().add(B)) < EPS || q.distanceTo(C) < EPS || q.distanceTo(A.clone().add(C)) < EPS || q.distanceTo(B.clone().add(C)) < EPS || q.distanceTo(A.clone().add(B).add(C)) < EPS)) pt(g, q, COL.corner, true); }); });
        ctr = C.clone().multiplyScalar(0.5); rad = Math.hypot(1, C.z / 2) + 0.2;
      }
      v.frame(ctr, rad);
    }
    function buildDemo(g) {
      const em = mStd(T.edge3d), hm = mStd(T.hi);
      if (st.demo === 'bcc2tet') {
        cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.01, em);
        cellEdges(g, V3(1, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.01, em);
        for (let x = 0; x <= 2; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++) pt(g, V3(x, y, z), COL.corner);
        [[.5, .5], [1.5, .5]].forEach(([x, y]) => [0, 1].forEach(z => pt(g, V3(x, y, z), COL.face)));
        const O = V3(1, 0, 0), A = V3(.5, .5, 0), B = V3(-.5, .5, 0), C = V3(0, 0, 1);
        cellEdges(g, O, A, B, C, 0.022, hm);
        label(g, "a' = a/√2", V3(1.45, 0.15, -0.12), { color: T.hi, size: 0.12 });
        label(g, "c' = a", V3(1.12, -0.12, 0.5), { color: T.hi, size: 0.12 });
        v.frame(V3(1, 0.5, 0.5), 1.35, [0.6, -1, 0.75]);
      } else {
        cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.01, em);
        sitesIn(BASIS.FCC).forEach(({ p }) => pt(g, V3(...p), kindColor(p)));
        const a1 = V3(.5, .5, 0), a2 = V3(.5, 0, .5), a3 = V3(0, .5, .5);
        cellEdges(g, V3(0, 0, 0), a1, a2, a3, 0.022, hm);
        arrow(g, V3(0, 0, 0), V3(1.12, 1.12, 1.12), 0.012, T.accent);
        label(g, '[111]', V3(1.2, 1.2, 1.24), { color: T.accent, size: 0.12 });
        label(g, 'α = 60°', V3(0.22, 0.22, 0.16), { color: T.hi, size: 0.11 });
        v.frame(V3(0.5, 0.5, 0.5), 1.0, [1, 0.35, 0.45]);
      }
    }
    v.rebuild = () => { v.clear(); st.demo ? buildDemo(v.root) : buildSystem(v.root); };
    function refresh() {
      const s = SYS.find(x => x.id === st.sys);
      setSeg(sysEl, st.demo ? '' : st.sys); setSeg(typeEl, st.demo ? '' : st.type); setSeg($('#bv-demo'), st.demo || '');
      $$('button', typeEl).forEach(b => (b.disabled = !s.types.includes(b.dataset.v)));
      hexWrap.hidden = st.sys !== 'hex' || !!st.demo;
      if (st.demo === 'bcc2tet') {
        info.innerHTML = tx(`<h4>“Base-centered cubic” = simple tetragonal</h4><p>Adding points at the centers of the top and bottom faces of a cubic cell looks like a new lattice. Put two cells side by side, though, and you can draw the small red cell inside them. Its base edge is a/√2 and its height is a, it has points only at its corners, and a/√2 ≠ a, so it is <b>simple tetragonal</b>. It is not a new lattice, so it is not one of the 14.</p><p class="note">Also, once points are added to the top and bottom faces, the cube loses its threefold symmetry, so it no longer belongs to the cubic system.</p>`, `<h4>「底心立方」＝ 簡單正方</h4><p>在立方晶胞的上下底面中心加點，看起來像新晶格。可是把兩個晶胞並排，就能在裡面畫出紅色的小晶胞：底邊 a/√2、高 a，只有角落有點，而且 a/√2 ≠ a，正是<b>簡單正方</b>。它不是新的晶格，所以不列入 14 種。</p><p class="note">另外，上下底面加點後，立方體原本的三重對稱就不見了，也就不再屬於立方晶系。</p>`);
      } else if (st.demo === 'fcc2rh') {
        info.innerHTML = tx(`<h4>The rhombohedral cell inside FCC</h4><p>Join the origin to the three nearest face centers and you get three vectors of equal length, with 60° between each pair. The red cell they span is <b>rhombohedral</b> (a = b = c, α = β = γ = 60°). It holds only 1 lattice point and is the smallest repeating unit of FCC.</p><p class="note">Its volume is 1/4 of the cubic cell, which matches the 4 lattice points in each cubic cell of FCC. The body diagonal [111] is its threefold axis.</p>`, `<h4>FCC 裡的菱方晶胞</h4><p>從原點連到三個相鄰面心，得到三條等長的向量，兩兩夾角都是 60°。它們撐出的紅色晶胞是<b>菱方</b>（a = b = c，α = β = γ = 60°），只含 1 個晶格點，是 FCC 的最小重複單元。</p><p class="note">它的體積是立方晶胞的 1/4，正好對應 FCC 每個立方晶胞有 4 個晶格點。體對角線 [111] 是它的三重對稱軸。</p>`);
      } else {
        info.innerHTML = tx(`<h4>${CEN_EN[st.type]} ${s.en.toLowerCase()}<span class="note">&ensp;${st.type}</span></h4>
          <dl class="stats"><dt>Lattice parameters</dt><dd>${s.rule}</dd><dt>This system has</dt><dd>${s.types.length} Bravais lattice${s.types.length > 1 ? 's' : ''} (${[...s.types].map(t => CNAME[t]).join(', ')})</dd><dt>Examples</dt><dd style="font-family:var(--f-body)">${s.ex[st.type] || '—'}</dd></dl>
          ${st.sys === 'hex' ? '<p class="note">The solid blue lines are one hexagonal cell (its base is a 120° rhombus). Three of these cells make up the dashed hexagonal prism. The HCP in Unit 3 is drawn as that prism.</p>' : ''}
          ${st.sys === 'rho' ? '<p class="note">A rhombohedral cell is like a cube squashed or stretched along its body diagonal. The special case α = 60° is FCC (see the “Going further” buttons).</p>' : ''}`, `<h4>${CNAME[st.type]}${s.zh.replace(/（.*）/, '')}<span class="note">　${CEN_EN[st.type]} ${s.en}</span></h4>
          <dl class="stats"><dt>晶格參數</dt><dd>${s.rule}</dd><dt>這個晶系有</dt><dd>${s.types.length} 種布拉維晶格（${[...s.types].map(t => CNAME[t]).join('、')}）</dd><dt>例子</dt><dd style="font-family:var(--f-body)">${s.ex[st.type] || '—'}</dd></dl>
          ${st.sys === 'hex' ? '<p class="note">藍色實線是一個六方晶胞（底面是 120° 的菱形）。三個這樣的晶胞拼成虛線的六角柱，第 3 單元的 HCP 就是畫成六角柱。</p>' : ''}
          ${st.sys === 'rho' ? '<p class="note">菱方晶胞像把立方體沿體對角線壓扁或拉長。α = 60° 的特例就是 FCC（看下面的延伸按鈕）。</p>' : ''}`);
      }
    }
    seg(sysEl, x => { st.sys = x; st.demo = null; const s = SYS.find(y => y.id === x); if (!s.types.includes(st.type)) st.type = 'P'; v.rebuild(); refresh(); });
    seg(typeEl, x => { st.type = x; st.demo = null; v.rebuild(); refresh(); });
    seg($('#bv-demo'), x => { st.demo = x; v.rebuild(); refresh(); });
    $('#bv-hexfull').addEventListener('change', e => { st.hexFull = e.target.checked; v.rebuild(); });
    v.lazy(v.rebuild); refresh(); onLang(refresh);
  }

  /* =====================================================================
     03 Metallic structures
     ===================================================================== */
  const HC = Math.sqrt(8 / 3); // ideal c/a
  let METAL; dataset(() => { METAL = {
    SC: { R: 0.5, N: '8 × ⅛ = 1', CN: 6, aR: 'a = 2R', apf: 'π/6 ≈ 0.52',
      deriv: tx(`Atoms touch along the <b>cube edge</b>: a = 2R<br>APF = 1 × (4/3)πR³ ÷ (2R)³<br>&nbsp;&nbsp;&nbsp;&nbsp;= 4.19R³ ÷ 8R³ ≈ <b>0.52</b>`, `原子沿<b>立方體的邊</b>互相接觸：a = 2R<br>APF = 1 × (4/3)πR³ ÷ (2R)³<br>　　= 4.19R³ ÷ 8R³ ≈ <b>0.52</b>`),
      ex: tx('α-polonium Po (a = 0.335 nm) is the only element that is simple cubic at room temperature. The packing is too loose, so almost no metal chooses it.', 'α-釙 Po（a = 0.335 nm）是唯一在室溫採簡單立方的元素。排得太鬆，金屬幾乎都不選它。') },
    BCC: { R: S3 / 4, N: '8 × ⅛ + 1 = 2', CN: 8, aR: 'a = 4R/√3', apf: '√3π/8 ≈ 0.68',
      deriv: tx(`Atoms touch along the <b>body diagonal</b>: √3 a = 4R → a = 4R/√3<br>V<sub>atoms</sub> = 2 × (4/3)πR³ = 8.378R³<br>V<sub>cell</sub> = a³ = (4R/√3)³ = 12.32R³<br>APF = 8.378 ÷ 12.32 ≈ <b>0.68</b>`, `原子沿<b>體對角線</b>接觸：√3 a = 4R → a = 4R/√3<br>V<sub>原子</sub> = 2 × (4/3)πR³ = 8.378R³<br>V<sub>晶胞</sub> = a³ = (4R/√3)³ = 12.32R³<br>APF = 8.378 ÷ 12.32 ≈ <b>0.68</b>`),
      ex: tx('Fe (a = 0.287 nm), Cr (0.289 nm), W (0.3165 nm), Na (0.429 nm)', 'Fe（a = 0.287 nm）、Cr（0.289 nm）、W（0.3165 nm）、Na（0.429 nm）') },
    FCC: { R: S2 / 4, N: '8 × ⅛ + 6 × ½ = 4', CN: 12, aR: 'a = 4R/√2 = 2√2 R', apf: 'π/(3√2) ≈ 0.74',
      deriv: tx(`Atoms touch along the <b>face diagonal</b>: √2 a = 4R → a = 2√2 R<br>V<sub>atoms</sub> = 4 × (4/3)πR³ = 16.76R³<br>V<sub>cell</sub> = (2√2 R)³ = 22.63R³<br>APF = 16.76 ÷ 22.63 ≈ <b>0.74</b>`, `原子沿<b>面對角線</b>接觸：√2 a = 4R → a = 2√2 R<br>V<sub>原子</sub> = 4 × (4/3)πR³ = 16.76R³<br>V<sub>晶胞</sub> = (2√2 R)³ = 22.63R³<br>APF = 16.76 ÷ 22.63 ≈ <b>0.74</b>`),
      ex: tx('Al (a = 0.405 nm), Au (0.408 nm), Cu (0.361 nm)', 'Al（a = 0.405 nm）、Au（0.408 nm）、Cu（0.361 nm）') },
    HCP: { R: 0.5, N: '12 × ⅙ + 2 × ½ + 3 = 6', CN: 12, aR: tx('a = 2R, c/a = √(8/3) ≈ 1.633', 'a = 2R，c/a = √(8/3) ≈ 1.633'), apf: 'π/(3√2) ≈ 0.74',
      deriv: tx(`In the base, atoms touch along the <b>hexagon edge</b>: a = 2R<br>A middle-layer atom sits in the hollow of three atoms below, and the four spheres form a regular tetrahedron:<br>a² = (c/2)² + (a/√3)² → c/a = √(8/3) ≈ 1.633<br>V<sub>prism</sub> = (3√3/2)a² × c = 33.94R³<br>APF = 6 × (4/3)πR³ ÷ 33.94R³ ≈ <b>0.74</b>`, `底面上原子沿<b>六角形的邊</b>接觸：a = 2R<br>中間層原子落在下層三顆原子的凹洞，四顆球圍成正四面體：<br>a² = (c/2)² + (a/√3)² → c/a = √(8/3) ≈ 1.633<br>V<sub>六角柱</sub> = (3√3/2)a² × c = 33.94R³<br>APF = 6 × (4/3)πR³ ÷ 33.94R³ ≈ <b>0.74</b>`),
      ex: tx('Zn (a = 0.2665 nm, c/a = 1.856), Co (a = 0.2507 nm, c/a = 1.623), Mg (c/a = 1.624). In real metals c/a differs from the ideal value.', 'Zn（a = 0.2665 nm，c/a = 1.856）、Co（a = 0.2507 nm，c/a = 1.623）、Mg（c/a = 1.624）。真實金屬的 c/a 會偏離理想值。') }
  }; });
  function secMetal() {
    const v = new Viewer($('#v-metal'), { view: [1, 0.4, 0.42] });
    const st = { s: 'BCC', mode: 'ball', cn: false, fade: true, cnT: 3 };
    const info = $('#mt-info');
    const CLIP_CUBE = GL ? [new THREE.Plane(V3(1, 0, 0), 0), new THREE.Plane(V3(-1, 0, 0), 1), new THREE.Plane(V3(0, 1, 0), 0), new THREE.Plane(V3(0, -1, 0), 1), new THREE.Plane(V3(0, 0, 1), 0), new THREE.Plane(V3(0, 0, -1), 1)] : [];
    const CLIP_HEX = GL ? [...[0, 1, 2, 3, 4, 5].map(i => { const t = (30 + 60 * i) * D2R; return new THREE.Plane(V3(-Math.cos(t), -Math.sin(t), 0), S3 / 2); }), new THREE.Plane(V3(0, 0, 1), 0), new THREE.Plane(V3(0, 0, -1), HC)] : [];

    const TET = GL ? [V3(0, 0, 0), V3(1, 0, 0), V3(0.5, S3 / 2, 0), V3(0.5, S3 / 6, HC / 2)] : [];
    const HLINE = { SC: [[0, 0, 0], [1, 0, 0]], BCC: [[0, 0, 0], [1, 1, 1]], FCC: [[1, 0, 0], [1, 1, 1]] };
    function hcpSites() {
      const s = [];
      hexVerts(0).forEach(p => s.push({ p, c: COL.corner })); hexVerts(HC).forEach(p => s.push({ p, c: COL.corner }));
      s.push({ p: V3(0, 0, 0), c: COL.face }, { p: V3(0, 0, HC), c: COL.face });
      [30, 150, 270].forEach(t => s.push({ p: V3(Math.cos(t * D2R) / S3, Math.sin(t * D2R) / S3, HC / 2), c: COL.body }));
      return s;
    }
    // CN view: the red atom's home cell first, then the neighbors that live in adjacent cells fade in (st.cnT 0 → 1)
    let cnOut = [], cnInRods = [], cnHome = [], cnTag = null, cnGhost = null, cnFrame = null;
    // t: 0 = the "small balls" model, 0→1 one atom turns red, 1→2 the other atoms of the cell fade out,
    // 2→3 the neighbors in adjacent cells come in (3 = all neighbors)
    function applyCN(t) {
      const ease = x => x * x * (3 - 2 * x), cl = x => Math.max(0, Math.min(1, x));
      const e1 = ease(cl(t)), e2 = ease(cl(t - 1)), e3 = ease(cl(t - 2));
      cnHome.forEach(h => {
        if (h.kind === 'red') { h.m.material.color.lerpColors(h.c0, h.c1, e1); h.m.scale.setScalar(0.11 + 0.06 * e1); }
        else if (h.kind === 'nbr') { h.m.material.color.lerpColors(h.c0, h.c1, e2); h.m.scale.setScalar(0.11 + 0.02 * e2); }
        else { h.m.visible = e2 < 0.99; h.m.scale.setScalar(0.11 * Math.max(1 - e2, 0.01)); }
      });
      cnInRods.forEach(r => { r.material.opacity = 0.55 * e2; r.visible = e2 > 0.01; });
      if (cnTag) { cnTag.visible = e1 > 0.01 && e2 < 0.99; cnTag.material.opacity = e1 * (1 - e2); }
      cnOut.forEach(o => { o.a.visible = e3 > 0.01; o.a.scale.setScalar(0.13 * Math.max(e3, 0.01)); o.r.material.opacity = 0.55 * e3; o.r.visible = e3 > 0.01; });
      if (cnGhost) cnGhost.opacity = 0.8 * e3;
      if (cnFrame) v.frame(cnFrame.c0.clone().lerp(cnFrame.c1, e3), cnFrame.r0 + (cnFrame.r1 - cnFrame.r0) * e3);
      v.dirty = true;
    }
    function buildCN(g) {
      const homeM = mStd(T.edge3d); cnGhost = mStd(T.ghost3d, { opacity: 0 }); cnOut = []; cnInRods = []; cnHome = [];
      let pts = [];
      const hex = st.s === 'HCP';
      if (hex) {
        for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
          const p = V3(i - j * 0.5, j * S3 / 2, 0); if (p.length() < 1.01) pts.push(p);
          [-1, 1].forEach(z => { const q = V3(i - j * 0.5 + 0.5, j * S3 / 2 + S3 / 6, z * HC / 2); if (q.length() < 1.2) pts.push(q); });
        }
        hexEdges(g, HC, 0.011, homeM, 0); hexEdges(g, HC, 0.007, cnGhost, -HC);
      } else {
        const sites = sitesIn(BASIS[st.s], -1, 1); pts = sites.map(s => V3(...s.p));
        for (let i = -1; i <= 0; i++) for (let j = -1; j <= 0; j++) for (let k = -1; k <= 0; k++) {
          const home = !i && !j && !k;
          cellEdges(g, V3(i, j, k), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), home ? 0.011 : 0.006, home ? homeM : cnGhost);
        }
      }
      const ds = pts.map(p => p.length()).filter(d => d > EPS); const dmin = Math.min(...ds);
      const nn = pts.filter(p => p.length() > EPS && p.length() < dmin * 1.01);
      const isNn = p => nn.some(q => q.distanceTo(p) < 1e-6);
      const home = hex ? hcpSites().map(x => ({ p: x.p, c: x.c })) : sitesIn(BASIS[st.s]).map(x => { const p = V3(...x.p); return { p, c: kindColor(x.p) }; });
      let nin = 0;
      home.forEach(({ p, c }) => {
        const kind = p.length() < EPS ? 'red' : isNn(p) ? 'nbr' : 'other';
        if (kind === 'nbr') nin++;
        cnHome.push({ kind, m: atom(g, p, 0.11, c), c0: new THREE.Color(c), c1: new THREE.Color(kind === 'red' ? T.hi : COL.corner) });
      });
      nn.forEach(p => {
        const inside = hex ? p.z > -EPS : [p.x, p.y, p.z].every(c => c > -EPS && c < 1 + EPS);
        if (inside) return;
        const a = atom(g, p, 0.13, COL.corner), r = rod(g, V3(0, 0, 0), p, 0.018, mStd(T.hi, { opacity: 0.55 }));
        cnOut.push({ a, r });
      });
      nn.forEach(p => {
        const inside = hex ? p.z > -EPS : [p.x, p.y, p.z].every(c => c > -EPS && c < 1 + EPS);
        if (inside) cnInRods.push(rod(g, V3(0, 0, 0), p, 0.018, mStd(T.hi, { opacity: 0.55 })));
      });
      cnTag = label(g, tx('this atom', '紅色這顆'), V3(-0.3, -0.3, -0.3), { color: T.hi, size: 0.2 });
      st.cnIn = nin; st.cnOut = nn.length - nin;
      cnFrame = hex ? { c0: V3(0, 0, HC / 2), r0: Math.hypot(1, HC / 2) + 0.15, c1: V3(0, 0, 0), r1: 1.45 }
        : { c0: V3(0.5, 0.5, 0.5), r0: S3 / 2 + 0.15, c1: V3(0.2, 0.2, 0.2), r1: 1.55 };
      applyCN(st.cnT);
      return nn.length;
    }
    /* HCP, cut to the cell: the six neighboring prisms, to show why a middle-layer atom counts as 1.
       Each orange atom pokes a cap out through one side face; the same atom of the prism behind the
       opposite face pokes an identical cap in. */
    let nbMats = [], nbRun = false;
    const nbOn = () => st.nb && st.s === 'HCP' && st.mode === 'cut' && !st.cn;
    const NB_R = [Math.hypot(1, HC / 2) + 0.45, 1.95], NB_PALE = 0.17;
    function setOp(x, o) {
      const m = x.m; m.opacity = o; if (x.sprite) return;
      const tr = o < 1; if (m.transparent !== tr) { m.transparent = tr; m.depthWrite = !tr; m.needsUpdate = true; }
    }
    function buildNb(g, r) {
      const gm = mStd(T.ghost3d, { opacity: 0.8 }); nbMats.push({ m: gm, from: 0, to: 0.8 });
      const P = hexPrism(HC);
      for (let i = 0; i < 6; i++) {
        const t = (30 + 60 * i) * D2R, o = V3(S3 * Math.cos(t), S3 * Math.sin(t), 0);
        P.e.forEach(([a, b]) => rod(g, P.v[a].clone().add(o), P.v[b].clone().add(o), 0.006, gm));
      }
      const dark = new THREE.Color(COL.body).multiplyScalar(0.72), discGeo = new THREE.CircleGeometry(Math.sqrt(r * r - Math.pow(S3 / 2 - 1 / S3, 2)), 40);
      const piece = (p, plane, from, to) => { const m = atom(g, p, r, COL.body, { clip: [plane], opacity: to }); if (from !== to) nbMats.push({ m: m.material, from, to }); };
      const disc = (p, d, from) => {
        const m = new THREE.Mesh(discGeo, mStd(dark, { rough: 0.7 })); m.material.side = THREE.DoubleSide;
        m.position.copy(p); m.quaternion.setFromUnitVectors(V3(0, 0, 1), d); g.add(m); if (from !== 1) nbMats.push({ m: m.material, from, to: 1 });
      };
      const tag = (text, p) => nbMats.push({ m: label(g, text, p, { color: T.hi, size: 0.19 }).material, from: 0, to: 1, sprite: true });
      [0, 2, 4].forEach(i => {
        const t = (30 + 60 * i) * D2R, d = V3(Math.cos(t), Math.sin(t), 0), mid = V3(0, 0, HC / 2);
        const own = mid.clone().addScaledVector(d, 1 / S3), img = own.clone().addScaledVector(d, -S3);
        const pOut = CLIP_HEX[i], pIn = CLIP_HEX[(i + 3) % 6];
        piece(own, pOut, 1, 1); piece(own, pOut.clone().negate(), 1, NB_PALE);
        piece(img, pIn, 0, 1); piece(img, pIn.clone().negate(), 0, NB_PALE);
        disc(mid.clone().addScaledVector(d, S3 / 2), d, 1); disc(mid.clone().addScaledVector(d, -S3 / 2), d, 0);
        label(g, '1', own, { size: 0.16 });
        tag(tx('out', '凸出'), mid.clone().addScaledVector(d, 1.2).add(V3(0, 0, 0.2)));
        tag(tx('in', '補回'), mid.clone().addScaledVector(d, -0.74).add(V3(0, 0, 0.2)));
      });
    }
    function playNb() {
      v.rebuild(); refresh();
      if (REDUCED) return;
      const t0 = performance.now(), mats = nbMats; mats.forEach(x => setOp(x, x.from));
      // tilt towards a view from above, where the caps going out and coming in are easiest to tell apart
      const d0 = v.cam.position.clone().sub(v.ctl.target).normalize(), d1 = V3(0.5, 0.22, 1).normalize();
      const step = now => {
        const u = Math.max(0, Math.min(1, (now - t0) / 800)), e = u * u * (3 - 2 * u);
        mats.forEach(x => setOp(x, x.from + (x.to - x.from) * e));
        v.frame(V3(0, 0, HC / 2), NB_R[0] + (NB_R[1] - NB_R[0]) * e, d0.clone().lerp(d1, e).normalize().toArray());
        if (u >= 1) { v.anim = null; nbRun = false; v.curView = v.view; }
      };
      nbRun = true; v.anim = step; step(t0);
    }
    v.rebuild = () => {
      if (nbRun) { v.anim = null; nbRun = false; }
      v.clear(); nbMats = []; const g = v.root, M = METAL[st.s];
      if (st.cn) { st.count = buildCN(g); return; }
      const em = mStd(T.edge3d);
      const r = st.mode === 'ball' ? 0.11 : M.R;
      const clip = st.mode === 'cut' ? (st.s === 'HCP' ? CLIP_HEX : CLIP_CUBE) : null;
      const nb = nbOn();
      if (st.s === 'HCP') {
        hexEdges(g, HC, 0.011, em);
        hcpSites().forEach(({ p, c }) => {
          if (!clip) {
            if (st.mode !== 'hard') { atom(g, p, r, c); return; }
            atom(g, p, r * 0.995, c, st.fade ? { opacity: TET.some(q => q.distanceTo(p) < 1e-6) ? 0.5 : 0.1 } : {}); return;
          }
          if (nb && c === COL.body) return;
          const n0 = g.children.length;
          const f = cutAtom(g, p, r, c, clip, nb ? { opacity: 0.13 } : {});
          if (nb) g.children.slice(n0).forEach(m => nbMats.push({ m: m.material, from: 1, to: 0.13 }));
          const sp = label(g, f > 0.99 ? '1' : '1/' + Math.round(1 / f), p.clone().add(V3(p.x, p.y, p.z - HC / 2).setLength(f < 1 ? 0.13 : 0)), { size: 0.14, depth: f < 1 });
          if (nb) nbMats.push({ m: sp.material, from: 1, to: 0, sprite: true });
        });
        if (st.mode === 'ball') {
          const A = V3(1, 0, 0), B = V3(-0.5, S3 / 2, 0), C = V3(0, 0, HC), pairs = [];
          const P = (i, j, k) => V3(0, 0, 0).addScaledVector(A, i).addScaledVector(B, j).addScaledVector(C, k);
          for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pairs.push([P(0, i, j), P(1, i, j)], [P(i, 0, j), P(i, 1, j)], [P(i, j, 0), P(i, j, 1)]);
          dashed(g, pairs, T.hi, { opacity: 0.9 });
        }
        if (nb) { buildNb(g, r); nbMats.forEach(x => setOp(x, x.to)); }
        if (st.mode === 'hard') {
          // Where c/a comes from: a middle-layer atom M over the centroid G of three touching base atoms
          const [O, P, Q, Mm] = TET, G = V3(0.5, S3 / 6, 0), u = P.clone().sub(G).normalize(), k = 0.09;
          const ln = (a, b, rr, col, op = 0.999) => { const L = rod(g, a, b, rr, mStd(col, { depthTest: false, opacity: op })); if (L) L.renderOrder = 25; };
          [[O, P], [P, Q], [Q, O]].forEach(([a, b]) => ln(a, b, 0.008, T.ink, 0.7));
          [O, Q].forEach(a => ln(a, G, 0.005, T.ink, 0.5));
          const c1 = G.clone().addScaledVector(u, k), c2 = G.clone().add(V3(0, 0, k));
          ln(c1, c1.clone().add(V3(0, 0, k)), 0.005, T.ink); ln(c2, c2.clone().addScaledVector(u, k), 0.005, T.ink);
          ln(P, G, 0.014, T.ink); ln(G, Mm, 0.014, T.ink); ln(P, Mm, 0.017, T.hi);
          label(g, 'a = 2R', P.clone().add(Mm).multiplyScalar(0.5).add(V3(0.15, -0.3, 0.08)), { color: T.hi, size: 0.14 });
          label(g, 'c/2', G.clone().add(V3(-0.1, 0.17, HC / 4 + 0.05)), { size: 0.14 });
          label(g, 'a/√3', P.clone().add(G).multiplyScalar(0.5).add(V3(0.1, 0.05, -0.13)), { size: 0.14 });
        }
        v.frame(V3(0, 0, HC / 2), nb ? NB_R[1] : Math.hypot(1, HC / 2) + (st.mode === 'ball' ? 0.15 : 0.45));
      } else {
        cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.011, em);
        sitesIn(BASIS[st.s]).forEach(({ p }) => {
          const P = V3(...p);
          if (!clip) {
            if (st.mode !== 'hard') { atom(g, P, r, kindColor(p)); return; }
            const [A0, B0] = HLINE[st.s].map(q => V3(...q)), ab = B0.clone().sub(A0), t = P.clone().sub(A0).dot(ab) / ab.lengthSq();
            const on = t > -1e-6 && t < 1 + 1e-6 && P.clone().sub(A0).addScaledVector(ab, -t).length() < 1e-6;
            atom(g, P, r * 0.995, kindColor(p), on || !st.fade ? {} : { opacity: 0.16 }); return;
          }
          const f = cutAtom(g, P, r, kindColor(p), clip);
          label(g, f > 0.99 ? '1' : '1/' + Math.round(1 / f), P.clone().add(P.clone().sub(V3(0.5, 0.5, 0.5)).setLength(f < 1 ? 0.12 : 0)), { size: 0.14, depth: f < 1 });
        });
        if (st.mode === 'hard') {
          const line = [...HLINE[st.s], { SC: '2R = a', BCC: '4R = √3 a', FCC: '4R = √2 a' }[st.s]];
          const lm = mStd(T.hi, { depthTest: false }); const L = rod(g, V3(...line[0]), V3(...line[1]), 0.016, lm); if (L) L.renderOrder = 25;
          label(g, line[2], V3(...line[1]).add(V3(...line[0])).multiplyScalar(0.5).add(V3(0.12, 0.1, 0.18)), { color: T.hi, size: 0.13 });
        }
        v.frame(V3(0.5, 0.5, 0.5), S3 / 2 + (st.mode === 'ball' ? 0.15 : 0.45));
      }
    };
    function refresh() {
      const M = METAL[st.s];
      $('#mt-mode').style.opacity = st.cn ? 0.45 : 1;
      $('#mt-cnwrap').hidden = !st.cn;
      $('#mt-cn').closest('label').hidden = st.mode !== 'ball';
      $('#mt-fadewrap').hidden = !(st.mode === 'hard' && !st.cn);
      const nbBtn = st.s === 'HCP' && st.mode === 'cut' && !st.cn ? `<br><button type="button" class="btn sm" data-act="nb" aria-pressed="${!!st.nb}">${tx('Show the neighboring prisms', '顯示周圍的六角柱')}</button>` : '';
      info.innerHTML = tx(`<h4>${{ SC: 'Simple cubic SC', BCC: 'Body-centered cubic BCC', FCC: 'Face-centered cubic FCC', HCP: 'Hexagonal close-packed HCP' }[st.s]}</h4>
        <dl class="stats"><dt>Atoms per cell N</dt><dd>${M.N}${st.s === 'HCP' ? '<br><span class="note">(hexagonal prism; the primitive cell in red dashes has only 2)</span>' : ''}${nbBtn}</dd>
        <dt>Coordination number CN</dt><dd>${M.CN}</dd><dt>a and atomic radius R</dt><dd>${M.aR}</dd><dt>Packing factor APF</dt><dd>${M.apf}</dd></dl>
        ${st.cn ? `<p>The red atom has <b>${st.count}</b> blue neighbors. They are all the same distance from it, and they are the nearest ones. ${st.s === 'HCP' ? '6 are in the same layer, with 3 each in the layers above and below.' : st.s === 'FCC' ? 'Turn the model. They lie on three planes at right angles to each other, 4 on each.' : st.s === 'BCC' ? 'This time the red atom is at a corner. Its 8 neighbors are the body centers of the 8 cells around it.' : 'One each above and below, left and right, front and back.'}</p>` : ''}
        ${st.cn ? `<p class="note">Inside its own cell the red atom touches only <b>${st.cnIn}</b> of them. The other <b>${st.cnOut}</b> sit in the neighboring cells. Drag the slider to bring those cells in.</p>` : ''}
        ${!st.cn && st.mode === 'cut' ? `<p>The number on each atom is the <b>fraction of it inside the cell</b>. The fractions add up to exactly N. ${st.s === 'HCP' ? (nbOn() ? 'The pale cap of each orange atom sticks out into the prism next door. On the opposite side, the same atom of the prism behind pushes an identical cap in (the solid piece marked “in”). One cap out, one cap in, so each still counts as 1.' : 'The 3 atoms in the middle layer stick out a little through the sides of the prism. Atoms from the neighboring prisms fill in exactly what sticks out, so each still counts as 1.') : ''}</p>` : ''}
        ${!st.cn && st.mode === 'hard' && st.s === 'HCP' ? `<p>Where c/a comes from: the <b style="color:var(--hi)">red line</b> joins a middle-layer atom to a base atom it touches, so its length is a = 2R. The middle-layer atom sits straight above the centroid of the triangle made by three base atoms. In an equilateral triangle of side a, the centroid is a/√3 from each corner, and the atom is c/2 above it. These three segments form a right triangle:</p>
        <div class="eq">a² = (a/√3)² + (c/2)²<br>c²/4 = a² − a²/3 = 2a²/3<br>c² = 8a²/3 → c/a = √(8/3) ≈ <b>1.633</b></div>` : ''}
        <div class="eq">${M.deriv}</div><p class="note">${M.ex}</p>`, `<h4>${{ SC: '簡單立方 SC', BCC: '體心立方 BCC', FCC: '面心立方 FCC', HCP: '六方最密堆積 HCP' }[st.s]}</h4>
        <dl class="stats"><dt>每晶胞原子數 N</dt><dd>${M.N}${st.s === 'HCP' ? '<br><span class="note">（六角柱；紅色虛線的基本晶胞只有 2 個）</span>' : ''}${nbBtn}</dd>
        <dt>配位數 CN</dt><dd>${M.CN}</dd><dt>a 與原子半徑 R</dt><dd>${M.aR}</dd><dt>堆積因子 APF</dt><dd>${M.apf}</dd></dl>
        ${st.cn ? `<p>紅色原子周圍有 <b>${st.count}</b> 個藍色鄰居，它們和紅色原子的距離都一樣，而且是最近的。${st.s === 'HCP' ? '同一層 6 個，上下層各 3 個。' : st.s === 'FCC' ? '把模型轉一轉：它們分布在三個互相垂直的平面上，每面 4 個。' : st.s === 'BCC' ? '這次把紅色原子放在角落，它的 8 個鄰居是周圍 8 個晶胞的體心。' : '上下、左右、前後各一個。'}</p>` : ''}
        ${st.cn ? `<p class="note">在自己的晶胞裡，紅色原子只碰得到其中 <b>${st.cnIn}</b> 個；另外 <b>${st.cnOut}</b> 個在相鄰的晶胞裡。拖動滑桿，把相鄰晶胞加進來。</p>` : ''}
        ${!st.cn && st.mode === 'cut' ? `<p>每顆原子上的數字是它<b>留在晶胞裡的比例</b>，加起來正好是 N。${st.s === 'HCP' ? (nbOn() ? '每顆橘色原子凸出去的那一塊（淡色）落在隔壁的六角柱裡。對面那一側，後面那個六角柱的同一顆原子也凸進來一塊一模一樣的（標「補回」的實心部分）。一塊出去、一塊進來，所以仍算 1 顆。' : '中間層的 3 顆原子會稍微凸出六角柱的側面，凸出去的部分剛好由相鄰六角柱的原子補回來，所以仍算 1 顆。') : ''}</p>` : ''}
        ${!st.cn && st.mode === 'hard' && st.s === 'HCP' ? `<p>c/a 是這樣算出來的：<b style="color:var(--hi)">紅線</b>連著一顆中間層原子和它碰到的一顆底層原子，兩顆球相切，所以長度是 a = 2R。中間層原子落在底層三顆原子圍成的三角形重心的正上方。邊長 a 的正三角形，重心到每個頂點的距離是 a/√3；原子離底面的高度是 c/2。這三段圍成一個直角三角形：</p>
        <div class="eq">a² = (a/√3)² + (c/2)²<br>c²/4 = a² − a²/3 = 2a²/3<br>c² = 8a²/3 → c/a = √(8/3) ≈ <b>1.633</b></div>` : ''}
        <div class="eq">${M.deriv}</div><p class="note">${M.ex}</p>`);
    }
    seg($('#mt-s'), x => { st.s = x; if (st.cn) playCN(); else { v.rebuild(); refresh(); } });
    seg($('#mt-mode'), x => { st.mode = x; if (st.cn) { st.cn = false; $('#mt-cn').checked = false; } v.rebuild(); refresh(); });
    $('#mt-fade').addEventListener('change', e => { st.fade = e.target.checked; v.rebuild(); });
    const cnSlider = $('#mt-cnt');
    function playCN() {
      st.cnT = 0; cnSlider.value = 0; v.rebuild(); refresh();
      if (REDUCED) { st.cnT = 3; cnSlider.value = 3; applyCN(3); return; }
      const t0 = performance.now() + 500;
      v.anim = now => { const u = Math.max(0, Math.min(3, (now - t0) / 1100)); st.cnT = u; cnSlider.value = u; applyCN(u); if (u >= 3) v.anim = null; };
    }
    cnSlider.addEventListener('input', () => { v.anim = null; st.cnT = +cnSlider.value; applyCN(st.cnT); });
    $('#mt-cn').addEventListener('change', e => { st.cn = e.target.checked; if (st.cn) playCN(); else { v.anim = null; v.rebuild(); refresh(); } });
    info.addEventListener('click', e => {
      if (!e.target.closest('[data-act=nb]')) return;
      st.nb = !st.nb; if (st.nb) playNb(); else { v.rebuild(); refresh(); }
      const b = $('[data-act=nb]', info); if (b) b.focus();
    });
    v.lazy(v.rebuild); refresh(); onLang(() => { if (st.cn || nbOn()) v.rebuild(); refresh(); });
  }

  /* =====================================================================
     04 Close-packed stacking
     ===================================================================== */
  function secStack() {
    const v = new Viewer($('#v-stack'), { view: [1, 0.25, 0.62] });
    const st = { seq: 'ABC', n: 3, view: 'side', mode: 'full' };
    const H = Math.sqrt(2 / 3), OFF = { A: [0, 0], B: [0.5, S3 / 6], C: [1, S3 / 3] }, CLR = { A: COL.corner, B: COL.body, C: COL.face };
    const info = $('#st-info'), SIDE = [1, 0.25, 0.62], LIFT = 1.5, GAP = 700, MS = REDUCED ? 0 : 1;
    const letter = k => st.seq[k % st.seq.length];
    // Simple mode keeps one sphere and its ring of 6 in layer A, and the 3 spheres that sit in its hollows in B and C
    const geom = () => st.mode === 'simple' ? { c: [0, 0], r: { A: 1.05, B: 0.6, C: 0.6 }, R: 1 } : { c: [0.5, S3 / 6], r: { A: 2.15, B: 2.15, C: 2.15 }, R: 2.15 };
    const layers = [], leaving = []; let cam = null, lbVis = 1;
    const clamp = u => Math.max(0, Math.min(1, u));
    const easeOut = u => 1 - Math.pow(1 - u, 3), easeIn = u => u * u * u, easeIO = u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

    // Sites of one layer, ordered outward from the centre so the spheres land in a spiral
    function sites(L, G) {
      const o = OFF[L], out = [];
      for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
        const x = i + j * 0.5 + o[0], y = j * S3 / 2 + o[1], d = Math.hypot(x - G.c[0], y - G.c[1]);
        if (d <= G.r[L]) out.push([x, y, Math.round(d * 1e3), Math.atan2(y - G.c[1], x - G.c[0])]);
      }
      return out.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
    }
    function setPart(p, dz, a) {
      p.dz = dz; p.a = a;
      if (!p.fix) p.m.position.z = (p.z || 0) + dz;
      const mat = p.m.material, o = p.fix ? a * lbVis : a, tr = !!p.fix || o < 1;
      if (mat.transparent !== tr) { mat.transparent = tr; mat.needsUpdate = true; }
      mat.opacity = o; p.m.visible = o > 0.004;
    }
    function makeLayer(k) {
      const L = letter(k), G = geom(), g = new THREE.Group(), parts = [];
      const pts = sites(L, G), step = Math.min(90, 400 / pts.length);
      pts.forEach(([x, y], i) => parts.push({ m: atom(g, V3(x, y, 0), 0.497, CLR[L]), d: i * step }));
      // On the first layer, small dots mark the two sets of hollows the next layers can use
      if (k === 0) for (const M of 'BC') sites(M, G).forEach(([x, y]) => {
        if (pts.filter(p => Math.hypot(p[0] - x, p[1] - y) < 0.6).length < 3) return;
        const m = new THREE.Mesh(GEO.sphere, mBasic(CLR[M])); m.position.set(x, y, 0.4); m.scale.setScalar(0.085); g.add(m);
        parts.push({ m, d: 400, z: 0.4 });
      });
      parts.push({ m: label(g, L, V3(G.c[0], G.c[1] - G.R - 0.95, 0), { color: CLR[L], size: 0.36 }), d: 0, fix: true });
      g.position.z = k * H; v.root.add(g);
      const ly = { g, parts, tw: null };
      parts.forEach(p => setPart(p, 0, 1));
      return ly;
    }
    function dispose(ly) {
      v.root.remove(ly.g);
      ly.parts.forEach(p => { if (p.m.material.map) p.m.material.map.dispose(); p.m.material.dispose(); });
    }
    function tween(ly, kind, t0, lift) {
      ly.tw = { kind, t0, lift, dur: (kind === 'in' ? 640 : 380) * MS };
      ly.parts.forEach(p => { if (kind === 'in') setPart(p, lift, 0); p.z0 = p.dz; p.a0 = p.a; });
    }
    function step(ly, t) {
      const w = ly.tw; let done = true;
      for (const p of ly.parts) {
        const tt = t - w.t0 - (w.kind === 'in' ? p.d * MS : 0), u = w.dur ? clamp(tt / w.dur) : (tt >= 0 ? 1 : 0);
        if (u < 1) done = false;
        if (w.kind === 'in') setPart(p, w.lift * (1 - easeOut(u)), Math.min(1, u / 0.35));
        else setPart(p, p.z0 + (w.lift - p.z0) * easeIn(u), p.a0 * (1 - u));
      }
      return done;
    }
    const run = () => { if (!v.anim) v.anim = tick; };
    function tick(t) {
      let busy = false;
      for (const ly of layers) if (ly.tw) { if (step(ly, t)) ly.tw = null; else busy = true; }
      for (let i = leaving.length - 1; i >= 0; i--) { if (step(leaving[i], t)) { dispose(leaving[i]); leaving.splice(i, 1); } else busy = true; }
      if (cam) { if (camStep(t)) cam = null; else busy = true; }
      v.dirty = true; if (!busy) v.anim = null;
    }

    /* camera: glide to the new centre, size and (for the view buttons) angle instead of jumping */
    function target() { const G = geom(), hh = (st.n - 1) * H / 2; return { c: V3(G.c[0], G.c[1], hh), r: Math.hypot(G.R + 0.5, hh + 0.5) + 0.5 }; }
    const camDir = () => v.cam.position.clone().sub(v.ctl.target).normalize();
    function fly(view) {
      const { c, r } = target();
      if (!v.radius) { v.frame(c, r, SIDE); return; }
      const d0 = camDir(), az0 = Math.atan2(d0.y, d0.x), po0 = Math.acos(clamp((d0.z + 1) / 2) * 2 - 1);
      // A re-centre that arrives during a view change must not cancel the turn still under way
      const turn = !view && cam && !cam.free ? cam : null;
      cam = { t0: performance.now(), ms: 750 * MS, c0: v.center.clone(), c1: c, r0: v.radius, r1: r, k0: v.ratio(), free: !view && !turn };
      if (!cam.free) {
        const s = V3(...SIDE).normalize();
        let az1 = turn ? turn.az1 : view === 'top' ? az0 : Math.atan2(s.y, s.x); const po1 = turn ? turn.po1 : view === 'top' ? 0.0022 : Math.acos(s.z);
        while (az1 - az0 > Math.PI) az1 -= 2 * Math.PI; while (az1 - az0 < -Math.PI) az1 += 2 * Math.PI;
        Object.assign(cam, { az0, az1, po0, po1 });
        v.curView = [Math.sin(po1) * Math.cos(az1), Math.sin(po1) * Math.sin(az1), Math.cos(po1)];
      }
      run();
    }
    function camStep(t) {
      const u = cam.ms ? clamp((t - cam.t0) / cam.ms) : 1, e = easeIO(u);
      let d = camDir(), k = v.ratio();
      if (!cam.free) {
        const az = cam.az0 + (cam.az1 - cam.az0) * e, po = cam.po0 + (cam.po1 - cam.po0) * e;
        d = V3(Math.sin(po) * Math.cos(az), Math.sin(po) * Math.sin(az), Math.cos(po)); k = cam.k0 + (1 - cam.k0) * e;
      }
      v.center.lerpVectors(cam.c0, cam.c1, e); v.radius = cam.r0 + (cam.r1 - cam.r0) * e;
      v.ctl.target.copy(v.center); v._place(d, k);
      return u >= 1;
    }
    // Dragging takes the angle back from a running camera move; the re-centring still finishes
    v.ctl.addEventListener('start', () => { if (cam) cam.free = true; });
    // Layer letters sit beside the stack; seen from straight above they would pile up, so they fade out
    v.ctl.addEventListener('change', () => {
      const vis = clamp((0.9 - camDir().z) / 0.15);
      if (Math.abs(vis - lbVis) < 1e-3) return; lbVis = vis;
      for (const ly of [...layers, ...leaving]) for (const p of ly.parts) if (p.fix) setPart(p, p.dz, p.a);
    });

    function build(k, t0) { const ly = makeLayer(k); layers[k] = ly; if (t0 != null) tween(ly, 'in', t0, LIFT); return ly; }
    function retire(ly, t0, lift) { tween(ly, 'out', t0, lift); leaving.push(ly); }
    // Layers from `from` upward leave (top first), then come back one layer at a time
    function restack(from, lift) {
      const now = performance.now(), old = layers.splice(from);
      old.forEach((ly, i) => retire(ly, now + (old.length - 1 - i) * 90 * MS, lift));
      const wait = old.length ? 260 + (old.length - 1) * 90 : 0;
      for (let k = from; k < st.n; k++) build(k, now + (wait + (k - from) * GAP) * MS);
      run();
    }
    const ready = () => { if (v.init) { v.init = null; v.rebuild(); } };
    v.rebuild = () => {
      v.clear(); layers.length = 0; leaving.length = 0; cam = null; v.anim = null;
      for (let k = 0; k < st.n; k++) build(k);
      const { c, r } = target(); v.frame(c, r);
    };
    function refresh() {
      const s = [...Array(st.n)].map((_, k) => `<b style="color:${CLR[letter(k)]}">${letter(k)}</b>`).join(' ');
      let msg;
      if (st.n === 1) msg = tx('First layer: each sphere is surrounded by 6 others. There are two kinds of hollow between the spheres, marked by the small dots. Layer B will fill one kind, and the other is left for C.', '第一層：每顆球被 6 顆球包圍。球與球之間有兩種凹洞，用小點標出來：一種會被 B 層填上，另一種留給 C。');
      else if (st.n === 2) msg = tx('The second layer sits on the B hollows. Up to here, HCP and FCC still look exactly the same.', '第二層落在 B 凹洞上。到這裡，HCP 和 FCC 還長得一模一樣。');
      else msg = st.seq === 'AB'
        ? tx('The third layer is back directly above A. Switch to “Top view”. The C positions are never filled, so you can see straight through to the green dots.', '第三層又回到 A 的正上方。切到「從正上方看」：C 位置從頭到底都沒被填，可以一路看穿，看到底下的綠色小點。')
        : tx('The third layer sits on the C positions, and only the fourth is back at A. From the top, the A, B and C positions together cover every hollow.', '第三層落在 C 位置，第四層才回到 A。從正上方看，A、B、C 三組位置把所有凹洞都蓋住了。');
      info.innerHTML = tx(`<h4>Stacking sequence: <span class="mono">${s}</span></h4><p>${msg}</p>
        <dl class="stats"><dt>This stacking</dt><dd>${st.seq === 'AB' ? 'HCP (hexagonal close-packed)' : 'FCC (face-centered cubic)'}</dd><dt>Layer spacing</dt><dd>√(2/3) × 2R ≈ 1.633R</dd><dt>Coordination number / APF</dt><dd>12 / 0.74</dd></dl>`, `<h4>堆疊順序：<span class="mono">${s}</span></h4><p>${msg}</p>
        <dl class="stats"><dt>這種疊法</dt><dd>${st.seq === 'AB' ? 'HCP（六方最密）' : 'FCC（面心立方）'}</dd><dt>層間距</dt><dd>√(2/3) × 2R ≈ 1.633R</dd><dt>配位數／APF</dt><dd>12 ／ 0.74</dd></dl>`);
    }
    seg($('#st-seq'), x => { ready(); st.seq = x; restack(2, LIFT); refresh(); });
    seg($('#st-mode'), x => { ready(); st.mode = x; restack(0, 0); fly(); });
    seg($('#st-view'), x => { ready(); st.view = x; fly(x); });
    $('#st-add').addEventListener('click', () => {
      if (st.n >= 6) return; ready(); st.n++;
      const last = layers.reduce((m, ly) => (ly.tw && ly.tw.kind === 'in' ? Math.max(m, ly.tw.t0 + GAP * MS) : m), 0);
      build(st.n - 1, Math.max(performance.now(), last)); fly(); refresh();
    });
    $('#st-del').addEventListener('click', () => { if (st.n <= 1) return; ready(); st.n--; retire(layers.pop(), performance.now(), LIFT * 0.8); fly(); refresh(); });
    $('#st-replay').addEventListener('click', () => { ready(); restack(0, LIFT); });
    v.lazy(() => { const { c, r } = target(); v.frame(c, r, SIDE); restack(0, 0); }); refresh(); onLang(refresh);
  }

  /* =====================================================================
     05 Semiconductor lattices
     ===================================================================== */
  let SEMI; dataset(() => { SEMI = {
    dia: { zh: '鑽石結構', en: tx('Diamond structure', 'Diamond'), A: 'Si', B: 'Si', N: '8 × ⅛ + 6 × ½ + 4 = 8', CN: 4,
      desc: tx('Two FCC lattices, the second shifted along the body diagonal by (¼, ¼, ¼). Both hold the same element, and the colors only help you tell them apart. Each atom and its 4 neighbors form a regular tetrahedron. Bond length = √3 a / 4.', '兩套 FCC，第二套沿體對角線錯開 (¼, ¼, ¼)。兩套都是同一種元素，顏色只是幫你分辨。每個原子和 4 個鄰居形成正四面體，鍵長 = √3 a / 4。'),
      mats: [[tx('C (diamond)', 'C（鑽石）'), '0.3567'], ['Si', '0.5431'], ['Ge', '0.5658']] },
    zb: { zh: '閃鋅礦', en: 'Zinc blende', A: 'Ga', B: 'As', N: tx('4 Ga + 4 As', '4 個 Ga ＋ 4 個 As'), CN: 4,
      desc: tx('The atom sites are exactly the same as in the diamond structure, but the first FCC lattice holds Ga and the second holds As. Most III-V compound semiconductors have this structure.', '原子位置和鑽石結構完全相同，但第一套 FCC 放 Ga、第二套放 As。大多數 III-V 化合物半導體都是這種結構。'),
      mats: [['GaAs', '0.5653'], ['InP', '0.5869'], ['3C-SiC', '0.4360'], [tx('ZnS (zinc blende)', 'ZnS（閃鋅礦）'), '0.5410']] },
    rs: { zh: '岩鹽（NaCl）', en: tx('Rock salt (NaCl)', 'Rock salt'), A: 'Cl⁻', B: 'Na⁺', N: tx('4 Na⁺ + 4 Cl⁻', '4 個 Na⁺ ＋ 4 個 Cl⁻'), CN: 6,
      desc: tx('Two FCC lattices shifted along the cell edge by (½, 0, 0). Each ion is surrounded by 6 ions of the opposite sign, which form a regular octahedron. Na⁺ sits at the midpoints of the 12 edges (each counts ¼) and at the body center, 4 in all.', '兩套 FCC 沿晶胞邊錯開 (½, 0, 0)。每個離子被 6 個異號離子圍成正八面體。Na⁺ 在 12 條邊的中點（各算 ¼）和體心，共 4 個。'),
      mats: [['NaCl', '0.5640'], ['PbS', '0.5936'], ['PbTe', '0.6462'], ['MgO', '0.4212']] },
    wz: { zh: '纖鋅礦', en: 'Wurtzite', A: 'Ga', B: 'N', N: tx('6 Ga + 6 N in the hexagonal prism', '六角柱內 6 個 Ga ＋ 6 個 N'), CN: 4,
      desc: tx('Ga forms HCP (ABAB stacking), and each N sits 3c/8 directly above a Ga. Every atom still has 4 neighbors that form a tetrahedron. The only difference from zinc blende is the stacking sequence.', 'Ga 排成 HCP（ABAB 堆疊），N 落在 Ga 正上方 3c/8 處。每個原子仍有 4 個鄰居、圍成四面體。和閃鋅礦的差別只在堆疊順序。'),
      mats: [['GaN', tx('a = 0.3189, c = 0.5185', 'a = 0.3189，c = 0.5185')], ['ZnO', tx('a = 0.3250, c = 0.5207', 'a = 0.3250，c = 0.5207')], ['AlN', tx('a = 0.3112, c = 0.4982', 'a = 0.3112，c = 0.4982')]] }
  }; });
  function secSemi() {
    const v = new Viewer($('#v-semi'), { view: [1, 0.38, 0.42] });
    const st = { s: 'dia', poly: true, two: false, t: 1 }, info = $('#sc-info'), legend = $('#sc-legend');
    /* "Two lattices" view: the second lattice is drawn as a whole copy of the first (orange frame) that starts on top
       of it and slides along the shift vector. Orange atoms that end up outside the blue cell turn pale. */
    let two = null;
    const SHIFT = () => (st.s === 'wz' ? V3(0, 0, 3 / 8 * HC) : st.s === 'rs' ? V3(0.5, 0, 0) : V3(0.25, 0.25, 0.25));
    const setA = (m, a) => { m.opacity = a; const tr = a < 1; if (m.transparent !== tr) { m.transparent = tr; m.depthWrite = !tr; m.needsUpdate = true; } };
    function applyTwo(t) {
      if (!two) return;
      const s = two.shift.clone().multiplyScalar(t); two.g2.position.copy(s);
      two.parts.forEach(o => {
        const p = o.p0.clone().add(s), d = two.hex ? Math.max(0, p.z - HC, -p.z) : Math.max(0, -p.x, p.x - 1, -p.y, p.y - 1, -p.z, p.z - 1);
        const a = Math.max(o.tracked ? 0.2 : 0, 1 - Math.max(0, d - 1e-6) / 0.08); setA(o.m.material, a); o.m.visible = a > 0.01;
      });
      const b = Math.max(0, Math.min(1, (t - 0.8) / 0.2)); setA(two.bm, b); two.rods.forEach(r => (r.visible = b > 0.01));
      v.dirty = true;
    }
    v.rebuild = () => {
      v.clear(); two = null; const g = v.root, em = mStd(T.edge3d), bm = mStd(T.ghost3d);
      const S = SEMI[st.s]; let atoms = [], dnn, base = null;
      if (st.s === 'wz') {
        const c = HC, u = 3 / 8;
        const ga = [...hexVerts(0), V3(0, 0, 0), ...hexVerts(c), V3(0, 0, c), ...[30, 150, 270].map(t => V3(Math.cos(t * D2R) / S3, Math.sin(t * D2R) / S3, c / 2))];
        base = ga;
        ga.forEach(p => { atoms.push({ p, t: 0 }); const q = p.clone().setZ(p.z + u * c); if (q.z <= c + EPS) atoms.push({ p: q, t: 1 }); });
        hexEdges(g, c, 0.009, em); dnn = u * c;
      } else if (st.s === 'rs') {
        for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) for (let k = 0; k <= 2; k++) atoms.push({ p: V3(i / 2, j / 2, k / 2), t: (i + j + k) % 2 });
        cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.009, em); dnn = 0.5;
      } else {
        sitesIn(BASIS.DIA).forEach(({ p, bi }) => atoms.push({ p: V3(...p), t: bi < 4 ? 0 : 1 }));
        cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.009, em); dnn = S3 / 4;
      }
      const rad = st.s === 'rs' ? [0.13, 0.085] : [0.1, 0.1];
      const rods = [];
      atoms.forEach(({ p, t }) => { if (!(st.two && t)) atom(g, p, rad[t], t ? COL.body : COL.corner); });
      for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++)
        if (atoms[i].t !== atoms[j].t && Math.abs(atoms[i].p.distanceTo(atoms[j].p) - dnn) < 1e-3) rods.push(rod(g, atoms[i].p, atoms[j].p, 0.022, bm));
      if (st.two) {
        const hex = st.s === 'wz', shift = SHIFT(), g2 = new THREE.Group(), fm = mStd(COL.body), parts = [];
        if (!hex) base = sitesIn(BASIS.FCC).map(x => V3(...x.p));
        if (hex) hexEdges(g2, HC, 0.006, fm); else cellEdges(g2, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.006, fm);
        base.forEach(p0 => parts.push({ m: atom(g2, p0, rad[1] * 1.03, COL.body), p0, tracked: true }));
        // second-lattice atoms that end up in the cell but come from the copy next door
        atoms.filter(a => a.t).forEach(a => { const p0 = a.p.clone().sub(shift); if (!base.some(q => q.distanceTo(p0) < 1e-6)) parts.push({ m: atom(g2, p0, rad[1] * 1.03, COL.body), p0, tracked: false }); });
        g.add(g2);
        arrow(g, V3(0, 0, 0), shift, 0.012, T.hi, { basic: true, depthTest: false, order: 26 });
        label(g, hex ? '⅜ c' : st.s === 'rs' ? '(½, 0, 0) a' : '(¼, ¼, ¼) a', shift.clone().multiplyScalar(0.5).add(hex ? V3(0.05, 0.2, 0) : V3(0.05, -0.05, -0.14)), { color: T.hi, size: 0.13 });
        two = { g2, parts, shift, hex, bm, rods };
        applyTwo(st.t);
        if (hex) v.frame(V3(0, 0, HC / 2), Math.hypot(1, HC / 2) + 0.4); else v.frame(V3(0.5, 0.5, 0.5), S3 / 2 + 0.45);
        return;
      }
      if (st.poly) {
        let ctr, vs;
        if (st.s === 'rs') { ctr = V3(.5, .5, .5); vs = [[.5, .5, 0], [.5, .5, 1], [0, .5, .5], [1, .5, .5], [.5, 0, .5], [.5, 1, .5]].map(a => V3(...a)); }
        else if (st.s === 'wz') { ctr = V3(Math.cos(30 * D2R) / S3, Math.sin(30 * D2R) / S3, HC / 2 + 3 / 8 * HC); vs = atoms.filter(a => a.t === 0 && Math.abs(a.p.distanceTo(ctr) - dnn) < 1e-3).map(a => a.p); }
        else { ctr = V3(.25, .25, .25); vs = [[0, 0, 0], [.5, .5, 0], [.5, 0, .5], [0, .5, .5]].map(a => V3(...a)); }
        const faces = [];
        for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) for (let k = j + 1; k < vs.length; k++) {
          const n = vs[j].clone().sub(vs[i]).cross(vs[k].clone().sub(vs[i])); if (n.length() < 1e-6) continue;
          const d = n.dot(vs[i]); const sides = vs.map(p => Math.sign(Math.round((n.dot(p) - d) * 1e6)));
          if (sides.every(s => s >= 0) || sides.every(s => s <= 0)) faces.push([vs[i], vs[j], vs[k]]);
        }
        faces.forEach(f => poly(g, f, COL.plane, 0.18, false));
        atom(g, ctr, (ctr ? rad[1] : 0.1) * 1.25, T.hi);
      }
      if (st.s === 'wz') v.frame(V3(0, 0, HC / 2), Math.hypot(1, HC / 2) + 0.15);
      else v.frame(V3(0.5, 0.5, 0.5), S3 / 2 + 0.15);
    };
    function refresh() {
      const S = SEMI[st.s], lat = st.s === 'wz' ? 'HCP' : 'FCC', sh = st.s === 'wz' ? '⅜ c' : st.s === 'rs' ? '(½, 0, 0) a' : '(¼, ¼, ¼) a';
      $('#sc-twowrap').hidden = !st.two; $('#sc-poly').closest('label').hidden = st.two;
      const twoP = !st.two ? '' : tx(`<p>The orange frame is the second ${lat} lattice. It starts exactly on top of the blue one, then slides along the <b style="color:var(--hi)">red arrow</b> by ${sh}. Once it is in place, the orange atoms that land inside the blue cell stay solid. The pale ones have left the cell and belong to the cells next door.${st.s === 'rs' ? ' On the far side, orange atoms from the neighboring copy slide in to take their place.' : ''} Drag the slider to move the second lattice yourself.</p>`, `<p>橘色外框是第二套 ${lat} 晶格。它一開始和藍色那一套完全重疊，再沿<b style="color:var(--hi)">紅色箭頭</b>平移 ${sh}。移到定位後，落在藍色晶胞裡的橘色原子維持實心；變淡的那些已經跑出晶胞，屬於隔壁的晶胞。${st.s === 'rs' ? '另一側則有隔壁那一份的橘色原子移進來補位。' : ''}拖動滑桿可以自己移動第二套晶格。</p>`);
      legend.innerHTML = tx(`<span><i style="background:${COL.corner}"></i>${S.A}${st.s === 'dia' ? ' (first FCC lattice)' : ''}</span><span><i style="background:${COL.body}"></i>${S.B}${st.s === 'dia' ? ' (second FCC lattice)' : ''}</span>`, `<span><i style="background:${COL.corner}"></i>${S.A}${st.s === 'dia' ? '（第一套 FCC）' : ''}</span><span><i style="background:${COL.body}"></i>${S.B}${st.s === 'dia' ? '（第二套 FCC）' : ''}</span>`) + (st.two ? tx(`<span><i class="sq" style="background:var(--hi)"></i>Shift of the second lattice</span>`, `<span><i class="sq" style="background:var(--hi)"></i>第二套晶格的位移</span>`) : st.poly ? tx(`<span><i style="background:var(--hi)"></i>Central atom and ${st.s === 'rs' ? 'octahedron' : 'tetrahedron'}</span>`, `<span><i style="background:var(--hi)"></i>中心原子與${st.s === 'rs' ? '八面體' : '四面體'}</span>`) : '');
      info.innerHTML = tx(`<h4>${S.en}</h4><p>${S.desc}</p>${twoP}
        <dl class="stats"><dt>Atoms per cell</dt><dd>${S.N}</dd><dt>Coordination number CN</dt><dd>${S.CN}${S.CN === 4 ? ' (tetrahedral)' : ' (octahedral)'}</dd></dl>
        <table><thead><tr><th>Material</th><th>Lattice constant (nm, 300 K)</th></tr></thead><tbody>${S.mats.map(m => `<tr><td>${m[0]}</td><td class="num">${m[1]}</td></tr>`).join('')}</tbody></table>`, `<h4>${S.zh}<span class="note">　${S.en}</span></h4><p>${S.desc}</p>${twoP}
        <dl class="stats"><dt>每晶胞原子數</dt><dd>${S.N}</dd><dt>配位數 CN</dt><dd>${S.CN}${S.CN === 4 ? '（四面體）' : '（八面體）'}</dd></dl>
        <table><thead><tr><th>材料</th><th>晶格常數（nm，300 K）</th></tr></thead><tbody>${S.mats.map(m => `<tr><td>${m[0]}</td><td class="num">${m[1]}</td></tr>`).join('')}</tbody></table>`);
    }
    const twoSlider = $('#sc-twot');
    function playTwo() {
      st.t = 0; twoSlider.value = 0; v.rebuild(); refresh();
      if (REDUCED) { st.t = 1; twoSlider.value = 1; applyTwo(1); return; }
      const t0 = performance.now() + 700;
      v.anim = now => { const u = Math.max(0, Math.min(1, (now - t0) / 2600)), e = u * u * (3 - 2 * u); st.t = e; twoSlider.value = e; applyTwo(e); if (u >= 1) v.anim = null; };
    }
    twoSlider.addEventListener('input', () => { v.anim = null; st.t = +twoSlider.value; applyTwo(st.t); });
    $('#sc-two').addEventListener('change', e => { st.two = e.target.checked; v.anim = null; if (st.two) playTwo(); else { v.rebuild(); refresh(); } });
    seg($('#sc-s'), x => { st.s = x; v.anim = null; if (st.two) playTwo(); else { v.rebuild(); refresh(); } });
    $('#sc-poly').addEventListener('change', e => { st.poly = e.target.checked; v.rebuild(); refresh(); });
    v.lazy(v.rebuild); refresh(); onLang(refresh);
  }

  /* =====================================================================
     06 Miller indices (cubic)
     ===================================================================== */
  const XTAL = {
    none: null,
    po: { s: 'SC', a: 0.335, n: 'α-Po' }, fe: { s: 'BCC', a: 0.287, n: 'Fe' }, w: { s: 'BCC', a: 0.3165, n: 'W' },
    cu: { s: 'FCC', a: 0.361, n: 'Cu' }, al: { s: 'FCC', a: 0.405, n: 'Al' }
  };
  // Atom coordinates of the structures in units 3 and 5: the positions that belong to one cell, grouped by kind
  const shiftB = (b, d) => b.map(p => p.map((x, i) => frac(x + d[i])));
  const HCP_B = [[0, 0, 0], [1 / 3, 2 / 3, .5]];
  let POS; dataset(() => {
    const fcc1 = tx('1st FCC', '第一套 FCC'), fcc2 = tx('2nd FCC', '第二套 FCC');
    POS = {
      SC: { n: tx('Simple cubic (α-Po)', '簡單立方（α-Po）'), sets: [{ n: tx('Corner', '角落'), c: COL.corner, b: [[0, 0, 0]] }],
        note: tx('There is only one position. The 8 corners are the same atom repeated, and each is shared by 8 cells: 8 × ⅛ = 1.', '只有一個位置。8 個角落是同一顆原子的重複，各被 8 個晶胞共用：8 × ⅛ = 1。') },
      BCC: { n: tx('Body-centered cubic (Fe)', '體心立方（Fe）'), sets: [{ n: tx('Corner', '角落'), c: COL.corner, b: [[0, 0, 0]] }, { n: tx('Body center', '體心'), c: COL.body, b: [[.5, .5, .5]] }],
        note: tx('The body center is half way along each of the three axes, so it is (½, ½, ½).', '體心沿三軸各走一半，所以是 (½, ½, ½)。') },
      FCC: { n: tx('Face-centered cubic (Cu)', '面心立方（Cu）'), sets: [{ n: tx('Corner', '角落'), c: COL.corner, b: [[0, 0, 0]] }, { n: tx('Face centers', '面心'), c: COL.face, b: FCC_B.slice(1) }],
        note: tx('A face center is half way along two axes and stays at 0 on the third. The three faces on the far side hold the same atoms moved by 1.', '面心沿兩條軸各走一半，第三條軸留在 0。對面三個面上的原子，是同樣的位置再移 1。') },
      HCP: { n: tx('Hexagonal close-packed (Mg)', '六方最密（Mg）'), hex: true, per: tx('2 (primitive cell)', '2（基本晶胞）'), sets: [{ n: tx('Layer A', 'A 層'), c: COL.corner, b: [HCP_B[0]] }, { n: tx('Layer B', 'B 層'), c: COL.body, b: [HCP_B[1]] }],
        note: tx('The layer B atom sits above the middle of a triangle of layer A atoms: ⅓ along a₁, ⅔ along a₂ and half way up c.', 'B 層原子落在三顆 A 層原子圍成的三角形正中央上方：沿 a₁ 走 ⅓、沿 a₂ 走 ⅔，高度是 c 的一半。') },
      DIA: { n: tx('Diamond structure (Si)', '鑽石結構（Si）'), sets: [{ n: fcc1, c: COL.corner, b: FCC_B }, { n: fcc2, c: COL.body, b: shiftB(FCC_B, [.25, .25, .25]) }],
        note: tx('The second set is the first set plus (¼, ¼, ¼). Both sets hold the same element.', '第二套就是第一套各加 (¼, ¼, ¼)。兩套是同一種元素。') },
      ZB: { n: tx('Zinc blende (GaAs)', '閃鋅礦（GaAs）'), sets: [{ n: 'Ga', c: COL.corner, b: FCC_B }, { n: 'As', c: COL.body, b: shiftB(FCC_B, [.25, .25, .25]) }],
        note: tx('The coordinates are the same as in the diamond structure. The first set holds Ga and the second holds As.', '座標和鑽石結構完全一樣，只是第一套放 Ga、第二套放 As。') },
      RS: { n: tx('Rock salt (NaCl)', '岩鹽（NaCl）'), sets: [{ n: 'Cl⁻', c: COL.corner, b: FCC_B }, { n: 'Na⁺', c: COL.body, b: shiftB(FCC_B, [.5, 0, 0]) }],
        note: tx('The second set is the first set plus (½, 0, 0). That puts Na⁺ at the body center and at the midpoints of the edges.', '第二套就是第一套各加 (½, 0, 0)，所以 Na⁺ 落在體心和各邊的中點。') },
      WZ: { n: tx('Wurtzite (GaN)', '纖鋅礦（GaN）'), hex: true, per: tx('2 Ga + 2 N (primitive cell)', '2 個 Ga ＋ 2 個 N（基本晶胞）'), sets: [{ n: 'Ga', c: COL.corner, b: HCP_B }, { n: 'N', c: COL.body, b: shiftB(HCP_B, [0, 0, 3 / 8]) }],
        note: tx('Ga takes the two HCP positions. Each N is the Ga below it plus (0, 0, ⅜).', 'Ga 佔 HCP 的兩個位置。每個 N 是它正下方的 Ga 再加 (0, 0, ⅜)。') }
    };
  });
  function linDensity(basis, uvw, a) {
    const g = gcdN(uvw), r = uvw.map(x => x / g), L = Math.hypot(...r);
    for (const t of [0.5, 1]) { const vv = r.map(x => x * t); if (basis.some(b => vv.every((x, i) => isInt(x - b[i])))) return { rho: 1 / (t * L * a), rep: t * L * a }; }
  }
  function planeData(basis, hkl, a) {
    const g = gcdN(hkl), r = hkl.map(x => x / g);
    const vals = []; basis.forEach(b => { const f = frac(r[0] * b[0] + r[1] * b[1] + r[2] * b[2]); if (!vals.some(v => Math.abs(v - f) < EPS)) vals.push(f); });
    const N = r[0] ** 2 + r[1] ** 2 + r[2] ** 2, dTrue = a / (Math.sqrt(N) * vals.length);
    return { g, r, vals, rho: basis.length / a ** 3 * dTrue, dTrue };
  }
  function famCount(arr) {
    const s = new Set(); const p = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    p.forEach(q => { for (let m = 0; m < 8; m++) s.add(q.map((i, j) => arr[i] * ((m >> j) & 1 ? -1 : 1)).map(x => x === 0 ? 0 : x).join()); });
    return s.size;
  }
  function secMiller() {
    const v = new Viewer($('#v-miller'), { view: [1, 0.42, 0.45] });
    const st = { mode: 'plane', uvw: [1, 1, 0], hkl: [1, 1, 1], xtal: 'cu', fam: false, norm: true, pos: 'BCC', posAll: false };
    const info = $('#mi-info');
    const dirPre = [[1, 0, 0], [1, 1, 0], [1, 1, 1], [2, 1, 0], [1, -1, 0], [-1, -1, 1]];
    const plPre = [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, -1, 0], [2, 0, 0], [0, 1, 2]];
    $('#mi-dirpre').innerHTML = dirPre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '[]')}</button>`).join('');
    $('#mi-plpre').innerHTML = plPre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '()')}</button>`).join('');

    function axes(g, o = true) {
      const am = T.edge3d;
      arrow(g, V3(0, 0, 0), V3(1.42, 0, 0), 0.009, am); arrow(g, V3(0, 0, 0), V3(0, 1.42, 0), 0.009, am); arrow(g, V3(0, 0, 0), V3(0, 0, 1.38), 0.009, am);
      label(g, 'x', V3(1.54, 0, 0), { size: 0.13 }); label(g, 'y', V3(0, 1.54, 0), { size: 0.13 }); label(g, 'z', V3(0, 0, 1.5), { size: 0.13 });
      if (o) label(g, 'O', V3(0.02, -0.12, -0.09), { size: 0.11, color: T.muted });
    }
    v.rebuild = () => {
      v.clear(); const g = v.root;
      const S = st.mode === 'pos' ? POS[st.pos] : null, hex = !!(S && S.hex);
      // hexagonal structures use the primitive cell: a₁ and a₂ at 120°, c upright
      const A = V3(1, 0, 0), B = hex ? V3(-0.5, S3 / 2, 0) : V3(0, 1, 0), C = V3(0, 0, hex ? HC : 1);
      cellEdges(g, V3(0, 0, 0), A, B, C, 0.008, mStd(T.edge3d));
      if (hex) {
        [[A, 'a₁', 0.32], [B, 'a₂', 0.32], [C, 'c', 0.2]].forEach(([a, t, k]) => { const u = a.clone().normalize(), L = a.length(); arrow(g, V3(0, 0, 0), u.clone().multiplyScalar(L + k), 0.009, T.edge3d); label(g, t, u.clone().multiplyScalar(L + k + 0.12), { size: 0.13 }); });
      } else axes(g, !S);
      const X = XTAL[st.xtal];
      if (S) {
        const cart = p => V3(0, 0, 0).addScaledVector(A, p[0]).addScaledVector(B, p[1]).addScaledVector(C, p[2]), ctr = cart([.5, .5, .5]);
        S.sets.forEach(set => set.b.forEach(b => {
          for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
            const p = [b[0] + i, b[1] + j, b[2] + k]; if (p.some(x => x > 1 + EPS)) continue;
            const own = !(i || j || k), P = cart(p);
            atom(g, P, 0.072, set.c, own || st.posAll ? {} : { opacity: 0.3 });
            if (!own && !st.posAll) continue;
            const off = onBound(p) === 0 ? V3(0, 0, 0.17) : P.clone().sub(ctr).normalize().multiplyScalar(0.2);
            label(g, `(${p.map(fracTxt).join(',')})`, P.clone().add(off), { size: hex ? 0.11 : 0.085 });
          }
        }));
        if (hex) v.frame(ctr, 1.45); else v.frame(V3(.55, .55, .55), 1.05);
        return;
      } else if (st.mode === 'dir') {
        const u = st.uvw;
        if (X) sitesIn(BASIS[X.s]).forEach(({ p }) => atom(g, V3(...p), 0.06, kindColor(p), { opacity: 0.45 }));
        if (u.some(x => x)) {
          const m = Math.max(...u.map(Math.abs)), S = V3(...u.map(x => x < 0 ? 1 : 0)), E = S.clone().add(V3(...u.map(x => x / m)));
          if (X) sitesIn(BASIS[X.s]).forEach(({ p }) => { const P = V3(...p), d = P.clone().sub(S), t = d.dot(E.clone().sub(S)) / E.clone().sub(S).lengthSq(); if (t > -EPS && t < 1 + EPS && d.distanceTo(E.clone().sub(S).multiplyScalar(t)) < 1e-6) atom(g, P, 0.085, T.hi); });
          atom(g, S, 0.045, T.hi); arrow(g, S, E, 0.02, T.hi);
          label(g, idxText(u, '[]'), E.clone().add(E.clone().sub(S).normalize().multiplyScalar(0.2)), { color: T.hi, size: 0.14 });
        }
      } else {
        const h = st.hkl; if (!h.some(x => x)) { v.frame(V3(.5, .5, .5), 1.05); return; }
        const n = V3(...h), O = V3(...h.map(x => x < 0 ? 1 : 0)), val = 1 + n.dot(O);
        const vals = [];
        if (st.fam) { const cs = CUBE_V.map(p => n.dot(p)); for (let m = Math.ceil(Math.min(...cs) - EPS); m <= Math.floor(Math.max(...cs) + EPS); m++) vals.push(m); }
        else vals.push(val);
        vals.forEach(m => { const pts = slice(CUBE_V, CUBE_E, n, m); if (pts) poly(g, pts, COL.plane, Math.abs(m - val) < EPS ? 0.38 : 0.14); });
        if (X) sitesIn(BASIS[X.s]).forEach(({ p }) => {
          const P = V3(...p), on = vals.some(m => Math.abs(n.dot(P) - m) < 1e-6);
          atom(g, P, on ? 0.085 : 0.055, on ? T.hi : kindColor(p), on ? {} : { opacity: 0.4 });
        });
        if (O.lengthSq() > 0) { atom(g, O, 0.05, T.accent); label(g, "O'", O.clone().add(V3(0.08, 0.08, -0.12)), { size: 0.11, color: T.accent }); }
        [0, 1, 2].forEach(i => { if (h[i]) { const P = O.clone(); P.setComponent(i, O.getComponent(i) + 1 / h[i]); if (P.getComponent(i) > -EPS && P.getComponent(i) < 1 + EPS) atom(g, P, 0.035, COL.plane); } });
        const main = slice(CUBE_V, CUBE_E, n, val);
        if (main) {
          const c = main.reduce((s, p) => s.add(p), V3(0, 0, 0)).multiplyScalar(1 / main.length);
          label(g, idxText(h, '()'), c.clone().add(V3(0, 0, 0.09)), { color: COL.plane, size: 0.14 });
          if (st.norm) { arrow(g, c, c.clone().add(n.clone().normalize().multiplyScalar(0.5)), 0.012, T.hi); label(g, idxText(h, '[]'), c.clone().add(n.clone().normalize().multiplyScalar(0.62)), { color: T.hi, size: 0.11 }); }
          if (st.fam && vals.length > 1) {
            const d = 1 / n.length(), nn = n.clone().normalize();
            const m2 = vals.find(m => Math.abs(m - val) > EPS && slice(CUBE_V, CUBE_E, n, m));
            if (m2 !== undefined) {
              const p2 = c.clone().addScaledVector(nn, (m2 - val) * d);
              rod(g, c, p2, 0.008, mStd(T.ink)); label(g, 'd', c.clone().lerp(p2, 0.5).add(V3(0, 0, 0.08)), { size: 0.12 });
            }
          }
        }
      }
      v.frame(V3(.55, .55, .55), 1.05);
    };
    function refresh() {
      $('#mi-posctl').hidden = st.mode !== 'pos'; $('#mi-dirctl').hidden = st.mode !== 'dir'; $('#mi-plctl').hidden = st.mode !== 'plane'; $('#mi-xtalctl').hidden = st.mode === 'pos';
      const X = XTAL[st.xtal];
      if (st.mode === 'pos') {
        const S = POS[st.pos], N = S.sets.reduce((s, x) => s + x.b.length, 0);
        const rows = S.sets.map(x => `<dt><i style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${x.c}"></i>${x.n}</dt><dd>${x.b.map(p => `<span class="idx">(${p.map(fracStr).join(', ')})</span>`).join(' ')}</dd>`).join('');
        info.innerHTML = tx(`<h4>Atom coordinates: ${S.n}</h4><p>${S.hex ? 'Start at the origin O. The fraction of a cell edge you move along a₁, a₂ and c gives the coordinates. a₁ and a₂ are 120° apart, so these are not right-angle coordinates. The frame is the primitive hexagonal cell, one third of the hexagonal prism in Unit 3.' : 'Start at the origin O. The number of lattice constants you move along x, y and z gives the coordinates.'}</p>
          <dl class="stats">${rows}<dt>Atoms per cell</dt><dd>${S.per || N}</dd></dl><p>${S.note}</p>
          <p class="note">Solid atoms are the ${N === 1 ? 'position that belongs' : N + ' positions that belong'} to this cell. Pale atoms are the same positions moved by one whole cell (add 1 to a coordinate), so they need no entry of their own. Coordinates are fractions of the lattice constant, not nm. The same coordinates fit a cell of any size.</p>`, `<h4>原子座標：${S.n}</h4><p>${S.hex ? '從原點 O 出發，沿 a₁、a₂、c 各走「幾分之幾個晶胞邊長」就是座標。a₁ 和 a₂ 夾 120°，所以這不是直角座標。外框是六方基本晶胞，等於第 3 單元六角柱的三分之一。' : '從原點 O 出發，沿 x、y、z 各走「幾個晶格常數」就是座標。'}</p>
          <dl class="stats">${rows}<dt>每晶胞原子數</dt><dd>${S.per || N}</dd></dl><p>${S.note}</p>
          <p class="note">實心原子是屬於這個晶胞的 ${N} 個位置。淡色原子是同樣的位置平移一整個晶胞（某個座標加 1），不必另外列。座標用的是晶格常數的「分數」，不是 nm，同一套座標可以套到任何大小的晶胞。</p>`);
        return;
      }
      if (st.mode === 'dir') {
        const u = st.uvw; if (!u.some(x => x)) { info.innerHTML = tx('<p class="warn">The three indices cannot all be 0.</p>', '<p class="warn">三個指數不能同時為 0。</p>'); return; }
        const m = Math.max(...u.map(Math.abs)), S = u.map(x => x < 0 ? 1 : 0), E = S.map((s, i) => s + u[i] / m), g = gcdN(u);
        let html = tx(`<h4>Direction ${idxHTML(u, '[]')}</h4><div class="eq">Start (${S.join(', ')})${S.some(x => x) ? ' ← negative index: start moved to another corner so the arrow fits in the cell' : ''}<br>End (${E.map(fracStr).join(', ')})<br>End − start = (${u.map(x => fracStr(x / m)).join(', ')})<br>Multiply by ${m} to get integers → ${idxHTML(u, '[]')}</div>`, `<h4>方向 ${idxHTML(u, '[]')}</h4><div class="eq">起點 (${S.join(', ')})${S.some(x => x) ? '　← 有負數，起點移到別的角落，箭頭才畫得進晶胞' : ''}<br>終點 (${E.map(fracStr).join(', ')})<br>終點 − 起點 = (${u.map(x => fracStr(x / m)).join(', ')})<br>乘以 ${m} 化成整數 → ${idxHTML(u, '[]')}</div>`);
        if (g > 1) html += tx(`<p class="note">${idxHTML(u, '[]')} and ${idxHTML(u.map(x => x / g), '[]')} point the same way. By convention we write the smallest integers.</p>`, `<p class="note">${idxHTML(u, '[]')} 和 ${idxHTML(u.map(x => x / g), '[]')} 指向同一個方向，習慣寫成最小整數。</p>`);
        const r = u.map(x => Math.abs(x / g)).sort((a, b) => b - a);
        html += tx(`<dl class="stats"><dt>Family of directions</dt><dd>${idxHTML(r, ['&lt;', '&gt;'])}, ${famCount(r)} directions</dd>`, `<dl class="stats"><dt>同族方向</dt><dd>${idxHTML(r, ['&lt;', '&gt;'])} 共 ${famCount(r)} 個</dd>`);
        if (X) { const L = linDensity(BASIS[X.s], u, X.a); html += tx(`<dt>Linear density of ${X.n}</dt><dd>${fmt(L.rho, 2)} atoms/nm</dd><dt>Atom spacing</dt><dd>${fmt(L.rep, 4)} nm</dd>`, `<dt>${X.n} 的線密度</dt><dd>${fmt(L.rho, 2)} 個/nm</dd><dt>原子間隔</dt><dd>${fmt(L.rep, 4)} nm</dd>`); }
        info.innerHTML = html + '</dl>' + (X ? tx('<p class="note">The red atoms are the ones the arrow passes through. Linear density = number of atoms met per unit length along this direction.</p>', '<p class="note">紅色原子是箭頭穿過的原子。線密度 ＝ 沿這個方向每單位長度遇到的原子數。</p>') : '');
        return;
      }
      const h = st.hkl; if (!h.some(x => x)) { info.innerHTML = tx('<p class="warn">The three indices cannot all be 0.</p>', '<p class="warn">三個指數不能同時為 0。</p>'); return; }
      const O = h.map(x => x < 0 ? 1 : 0), N = h[0] ** 2 + h[1] ** 2 + h[2] ** 2;
      let html = tx(`<h4>Plane ${idxHTML(h, '()')}</h4><div class="eq">${O.some(x => x) ? `Origin moved to O'(${O.join(', ')}) (negative index)<br>` : ''}Intercepts: x = ${fracStr(1 / h[0])}, y = ${fracStr(1 / h[1])}, z = ${fracStr(1 / h[2])}<br>Reciprocals → (${h.join(' ')})${h.some(x => x === 0) ? ' (the reciprocal of ∞ is 0)' : ''}</div>
        <dl class="stats"><dt>Normal direction</dt><dd>${idxHTML(h, '[]')}</dd><dt>Interplanar spacing</dt><dd>d = a/√${N} = ${fmt(1 / Math.sqrt(N), 3)} a${X ? ` = ${fmt(X.a / Math.sqrt(N), 4)} nm` : ''}</dd>`, `<h4>平面 ${idxHTML(h, '()')}</h4><div class="eq">${O.some(x => x) ? `原點移到 O'(${O.join(', ')})（指數有負號）<br>` : ''}截距：x = ${fracStr(1 / h[0])}，y = ${fracStr(1 / h[1])}，z = ${fracStr(1 / h[2])}<br>取倒數 → (${h.join(' ')})${h.some(x => x === 0) ? '　∞ 的倒數是 0' : ''}</div>
        <dl class="stats"><dt>法線方向</dt><dd>${idxHTML(h, '[]')}</dd><dt>面間距</dt><dd>d = a/√${N} = ${fmt(1 / Math.sqrt(N), 3)} a${X ? ` = ${fmt(X.a / Math.sqrt(N), 4)} nm` : ''}</dd>`);
      if (X) {
        const P = planeData(BASIS[X.s], h, X.a), vd = (1 + h[0] * O[0] + h[1] * O[1] + h[2] * O[2]) / P.g;
        const has = P.vals.some(x => Math.abs(frac(vd) - x) < EPS || Math.abs(frac(vd) - x) > 1 - EPS);
        html += tx(`<dt>Planar density of ${X.n}</dt><dd>${has ? fmt(P.rho, 2) + ' atoms/nm²' : '0 (this plane falls exactly between two layers of atoms)'}</dd>`, `<dt>${X.n} 的面密度</dt><dd>${has ? fmt(P.rho, 2) + ' 個/nm²' : '0（這個面剛好落在兩層原子之間）'}</dd>`);
        if (P.g > 1) html += tx(`<dt>Note</dt><dd style="font-family:var(--f-body)">${idxHTML(h, '()')} and ${idxHTML(P.r, '()')} are parallel, but the spacing is only half as large. This way of writing is common in X-ray diffraction.</dd>`, `<dt>提醒</dt><dd style="font-family:var(--f-body)">${idxHTML(h, '()')} 和 ${idxHTML(P.r, '()')} 互相平行，但間距只有一半。這種寫法在 X 光繞射很常用。</dd>`);
      }
      info.innerHTML = html + '</dl>' + (X ? tx('<p class="note">The centers of the red atoms lie exactly on the purple plane.</p>', '<p class="note">紅色原子的中心剛好在紫色平面上。</p>') : '');
    }
    const readDir = () => { st.uvw = ['#mi-u', '#mi-v', '#mi-w'].map(s => intIn($(s))); };
    const readPl = () => { st.hkl = ['#mi-h', '#mi-k', '#mi-l'].map(s => intIn($(s))); };
    const upd = () => { v.rebuild(); refresh(); };
    seg($('#mi-mode'), x => { st.mode = x; upd(); });
    seg($('#mi-pos'), x => { st.pos = x; upd(); });
    $('#mi-posall').addEventListener('change', e => { st.posAll = e.target.checked; upd(); });
    ['#mi-u', '#mi-v', '#mi-w'].forEach(s => $(s).addEventListener('input', () => { readDir(); upd(); }));
    ['#mi-h', '#mi-k', '#mi-l'].forEach(s => $(s).addEventListener('input', () => { readPl(); upd(); }));
    $('#mi-dirpre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.v.split(',').map(Number); ['#mi-u', '#mi-v', '#mi-w'].forEach((s, i) => ($(s).value = a[i])); readDir(); upd(); });
    $('#mi-plpre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.v.split(',').map(Number); ['#mi-h', '#mi-k', '#mi-l'].forEach((s, i) => ($(s).value = a[i])); readPl(); upd(); });
    $('#mi-xtal').addEventListener('change', e => { st.xtal = e.target.value; upd(); });
    $('#mi-fam').addEventListener('change', e => { st.fam = e.target.checked; upd(); });
    $('#mi-norm').addEventListener('change', e => { st.norm = e.target.checked; upd(); });
    readDir(); readPl(); refresh(); v.lazy(v.rebuild); onLang(refresh);
  }

  /* ---------- 06 Interplanar spacing, derived in four vector steps ---------- */
  function secSpacing() {
    const v = new Viewer($('#v-dspace'), { view: [1, -0.5, 0.3], label: () => tx('3D model: the plane ABC, its normal and the spacing d', '3D 模型：平面 ABC、法向量與面間距 d') });
    const st = { step: 1, hkl: [1, 1, 1], cell: 'cub' };
    const info = $('#ds-info'), ins = ['#ds-h', '#ds-k', '#ds-l'];
    const pre = [[1, 1, 1], [2, 1, 1], [1, 2, 2], [2, 3, 1]];
    $('#ds-pre').innerHTML = pre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '()')}</button>`).join('');
    const dims = () => (st.cell === 'cub' ? [1, 1, 1] : [1.25, 1, 0.8]);
    const over = (s, n) => (n === 1 ? s : `${s}/${n}`);   // a/h with the index filled in
    const under = (n, s) => `${n}/${s}`;                   // h/a with the index filled in

    v.rebuild = () => {
      v.clear(); const g = v.root, [a, b, c] = dims(), [h, k, l] = st.hkl, O = V3(0, 0, 0), s = st.step;
      cellEdges(g, O, V3(a, 0, 0), V3(0, b, 0), V3(0, 0, c), 0.004, mStd(T.ghost3d));
      [[V3(a + 0.34, 0, 0), 'x'], [V3(0, b + 0.34, 0), 'y'], [V3(0, 0, c + 0.32), 'z']].forEach(([p, t]) => {
        arrow(g, O, p, 0.007, T.edge3d); label(g, t, p.clone().multiplyScalar(1 + 0.11 / p.length()), { size: 0.12 });
      });
      label(g, 'O', V3(0.02, -0.1, -0.08), { size: 0.11, color: T.muted });
      const A = V3(a / h, 0, 0), B = V3(0, b / k, 0), C = V3(0, 0, c / l), n = V3(h / a, k / b, l / c);
      const nn = n.clone().normalize(), F = n.clone().multiplyScalar(1 / n.lengthSq()); // F: foot of the perpendicular from O
      if (s === 4) poly(g, [A, B, C].map(P => P.clone().sub(F)), COL.plane, 0.12);
      poly(g, [A, B, C], COL.plane, 0.3);
      [[A, 'A', V3(0.04, -0.1, -0.07)], [B, 'B', V3(0, 0.05, -0.1)], [C, 'C', V3(0, -0.1, 0.03)]].forEach(([P, t, off]) => {
        atom(g, P, 0.028, COL.plane); label(g, t, P.clone().add(off), { size: 0.12 });
      });
      if (s === 1) {
        label(g, over('a', h), A.clone().multiplyScalar(0.5).add(V3(0, -0.13, -0.06)), { size: 0.1, color: T.muted });
        label(g, over('b', k), B.clone().multiplyScalar(0.5).add(V3(0, 0, -0.1)), { size: 0.1, color: T.muted });
        label(g, over('c', l), C.clone().multiplyScalar(0.5).add(V3(0, -0.13, 0)), { size: 0.1, color: T.muted });
      }
      if (s >= 2) {
        const ctr = A.clone().add(B).add(C).multiplyScalar(1 / 3);
        [[B, 'AB'], [C, 'AC']].forEach(([P, t]) => {
          arrow(g, A, P, 0.011, T.accent);
          if (s < 4) { const m = A.clone().lerp(P, 0.5); label(g, t, m.clone().add(m.clone().sub(ctr).normalize().multiplyScalar(0.13)), { size: 0.11 }); }
        });
      }
      if (s === 3) dashed(g, [[O, F]], T.muted);
      if (s >= 3) { arrow(g, F, F.clone().addScaledVector(nn, 0.45), 0.011, T.hi); label(g, 'n', F.clone().addScaledVector(nn, 0.56), { size: 0.13, color: T.hi }); }
      if (s === 4) {
        rod(g, O, A, 0.011, mStd(T.accent));
        rod(g, O, F, 0.014, mStd(T.hi)); atom(g, F, 0.026, T.hi);
        label(g, 'd', O.clone().lerp(F, 0.5).add(V3(0, -0.07, 0.07)), { size: 0.13, color: T.hi });
        dashed(g, [[F, A]], T.muted);
      }
      v.frame(V3(a * 0.45, b * 0.45, c * 0.45), 1.12);
    };
    function refresh() {
      const [h, k, l] = st.hkl, [a, b, c] = dims(), cub = st.cell === 'cub', ix = idxHTML(st.hkl, '()');
      const sum = `(${under(h, 'a')})² + (${under(k, 'b')})² + (${under(l, 'c')})²`;
      const ratio = cub ? '' : tx('<p class="note">The model is drawn with a : b : c = 1.25 : 1 : 0.8.</p>', '<p class="note">模型以 a : b : c = 1.25 : 1 : 0.8 繪製。</p>');
      if (st.step === 1) {
        info.innerHTML = tx(`<h4>Step 1: where ${ix} cuts the axes</h4><p>The intercepts are the cell edges divided by the indices. Write each one as a vector from the origin.</p>`, `<h4>第 1 步：${ix} 和三個軸交在哪裡</h4><p>截距等於晶胞邊長除以指數。把三個截點各寫成從原點出發的向量。</p>`) +
          `<div class="eq"><b>OA</b> = (${over('a', h)}, 0, 0)<br><b>OB</b> = (0, ${over('b', k)}, 0)<br><b>OC</b> = (0, 0, ${over('c', l)})</div>` + ratio;
      } else if (st.step === 2) {
        info.innerHTML = tx('<h4>Step 2: two vectors that lie in the plane</h4><p>Go from A to B and from A to C. Both arrows stay inside the plane.</p>', '<h4>第 2 步：找兩個躺在平面上的向量</h4><p>從 A 走到 B，再從 A 走到 C。這兩支箭頭都貼在平面上。</p>') +
          `<div class="eq"><b>AB</b> = <b>OB</b> − <b>OA</b> = (−${over('a', h)}, ${over('b', k)}, 0)<br><b>AC</b> = <b>OC</b> − <b>OA</b> = (−${over('a', h)}, 0, ${over('c', l)})</div>`;
      } else if (st.step === 3) {
        info.innerHTML = tx('<h4>Step 3: the cross product gives the normal</h4><p>The cross product of two vectors is perpendicular to both of them, so it is perpendicular to the plane.</p>', '<h4>第 3 步：外積得到法向量</h4><p>兩個向量的外積同時垂直於這兩個向量，所以它垂直於整個平面。</p>') +
          `<div class="eq"><b>AB</b> × <b>AC</b> = (${over('bc', k * l)}, ${over('ac', h * l)}, ${over('ab', h * k)})</div>` +
          tx(`<p>Multiply all three components by ${h * k * l === 1 ? '1' : h * k * l}/abc. The arrow changes length but keeps its direction.</p>`, `<p>三個分量同乘 ${h * k * l === 1 ? '1' : h * k * l}/abc。箭頭的長度變了，方向不變。</p>`) +
          `<div class="eq"><b>n</b> = (${under(h, 'a')}, ${under(k, 'b')}, ${under(l, 'c')})</div>` +
          (cub ? tx(`<p class="note">In a cubic cell a = b = c, so <b>n</b> points along ${idxHTML(st.hkl, '[]')}. This is why the normal of ${ix} is ${idxHTML(st.hkl, '[]')}.</p>`, `<p class="note">立方晶胞 a = b = c，所以 <b>n</b> 指向 ${idxHTML(st.hkl, '[]')}。${ix} 的法線是 ${idxHTML(st.hkl, '[]')}，原因就在這裡。</p>`)
            : tx(`<p class="note">Here a, b and c differ, so <b>n</b> is no longer parallel to ${idxHTML(st.hkl, '[]')}.</p>`, `<p class="note">這裡 a、b、c 不相等，<b>n</b> 不再平行於 ${idxHTML(st.hkl, '[]')}。</p>`));
      } else {
        const N = h * h + k * k + l * l, d = 1 / Math.sqrt((h / a) ** 2 + (k / b) ** 2 + (l / c) ** 2);
        info.innerHTML = tx('<h4>Step 4: project OA onto the normal</h4><p>d is the part of <b>OA</b> that points along <b>n</b>. Take the dot product of <b>OA</b> with the unit vector <b>n</b>/|<b>n</b>|.</p>', '<h4>第 4 步：把 OA 投影到法線上</h4><p>d 是 <b>OA</b> 沿著 <b>n</b> 方向的分量。把 <b>OA</b> 和單位向量 <b>n</b>/|<b>n</b>| 做內積。</p>') +
          `<div class="eq">d = <b>OA</b> · <b>n</b>/|<b>n</b>|<br>&nbsp;&nbsp;= (${over('a', h)})(${under(h, 'a')}) / √[${sum}]<br>&nbsp;&nbsp;= 1 / √[${sum}]</div>` +
          (cub ? tx('<p>Set a = b = c and take a out of the square root:</p>', '<p>代入 a = b = c，把 a 提到根號外：</p>') + `<p class="eq big">d<sub>hkl</sub> = a / √(h² + k² + l²) = a/√${N} = ${fmt(1 / Math.sqrt(N), 3)} a</p>`
            : tx('<p>With three different edges the result stays in this form:</p>', '<p>三個邊長不同時，結果維持這個形式：</p>') + `<p class="eq big">1/d² = h²/a² + k²/b² + l²/c²</p>` + tx(`<p class="note">With a : b : c = 1.25 : 1 : 0.8 this plane has d = ${fmt(d, 3)} b.</p>`, `<p class="note">以 a : b : c = 1.25 : 1 : 0.8 計算，這個平面的 d = ${fmt(d, 3)} b。</p>`)) +
          tx('<p class="note">The pale plane passes through O and is parallel to ABC. The red segment between them is d. Projecting <b>OB</b> or <b>OC</b> gives the same value. When an index is 0 the plane never meets that axis and there is no triangle to draw, yet the formula still holds with that term equal to 0.</p>', '<p class="note">淡色平面通過 O，與 ABC 平行，兩者之間的紅色線段就是 d。改用 <b>OB</b> 或 <b>OC</b> 投影會得到相同的值。指數為 0 時平面碰不到那個軸，畫不出三角形，但公式照樣成立，那一項就是 0。</p>');
      }
    }
    const read = () => { st.hkl = ins.map(s => intIn($(s), 1, 4)); };
    const upd = () => { v.rebuild(); refresh(); };
    seg($('#ds-step'), x => { st.step = +x; upd(); });
    seg($('#ds-cell'), x => { st.cell = x; upd(); });
    ins.forEach(s => $(s).addEventListener('input', () => { read(); upd(); }));
    $('#ds-pre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.v.split(',').map(Number); ins.forEach((s, i) => ($(s).value = a[i])); read(); upd(); });
    read(); refresh(); v.lazy(v.rebuild); onLang(refresh);
  }

  /* =====================================================================
     07 Hexagonal 4-index notation
     ===================================================================== */
  function secHex() {
    const v = new Viewer($('#v-hex'), { view: [1, 0.3, 0.45] });
    const st = { mode: 'plane', dir: [2, -1, -1, 0], pl: [1, 0, -1, 0] };
    const c = HC, a1 = GL ? V3(1, 0, 0) : null, a2 = GL ? V3(-0.5, S3 / 2, 0) : null, a3 = GL ? V3(-0.5, -S3 / 2, 0) : null, cz = GL ? V3(0, 0, c) : null;
    const info = $('#hx-info');
    const dirPre = [[2, -1, -1, 0], [-1, 2, -1, 0], [-1, -1, 2, 0], [0, 0, 0, 1], [1, 1, -2, 0], [1, -1, 0, 0], [-1, -1, 2, 1]];
    const plPre = [[0, 0, 0, 1], [1, 0, -1, 0], [0, 1, -1, 0], [1, -1, 0, 0], [1, 1, -2, 0], [1, 0, -1, 1]];
    $('#hx-dirpre').innerHTML = dirPre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '[]')}</button>`).join('');
    $('#hx-plpre').innerHTML = plPre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '()')}</button>`).join('');
    v.rebuild = () => {
      v.clear(); const g = v.root, em = mStd(T.edge3d);
      hexEdges(g, c, 0.01, em);
      [[a1, 'a₁'], [a2, 'a₂'], [a3, 'a₃']].forEach(([a, t]) => { arrow(g, V3(0, 0, 0), a.clone().multiplyScalar(1.28), 0.011, T.accent); label(g, t, a.clone().multiplyScalar(1.42), { color: T.accent, size: 0.15 }); });
      arrow(g, V3(0, 0, 0), V3(0, 0, c + 0.4), 0.011, T.accent); label(g, 'c', V3(0, 0, c + 0.55), { color: T.accent, size: 0.15 });
      if (st.mode === 'dir') {
        const [u, vv, t, w] = st.dir;
        if (u + vv + t === 0 && st.dir.some(x => x)) {
          const vec = V3(0, 0, 0).addScaledVector(a1, u).addScaledVector(a2, vv).addScaledVector(a3, t).addScaledVector(cz, w);
          const O = V3(0, 0, c / 2); let tm = Infinity;
          if (vec.z > EPS) tm = Math.min(tm, (c / 2) / vec.z); if (vec.z < -EPS) tm = Math.min(tm, (c / 2) / -vec.z);
          for (let i = 0; i < 6; i++) { const th = (30 + 60 * i) * D2R, nd = vec.x * Math.cos(th) + vec.y * Math.sin(th); if (nd > EPS) tm = Math.min(tm, (S3 / 2) / nd); }
          const E = O.clone().addScaledVector(vec, tm);
          atom(g, O, 0.04, T.hi); arrow(g, O, E, 0.022, T.hi);
          label(g, idxText(st.dir, '[]'), E.clone().add(vec.clone().normalize().multiplyScalar(0.26)), { color: T.hi, size: 0.15 });
        }
      } else {
        const [h, k, i, l] = st.pl;
        if (i === -(h + k) && st.pl.some(x => x)) {
          const Vc = a1.clone().cross(a2).dot(cz), b1 = a2.clone().cross(cz).divideScalar(Vc), b2 = cz.clone().cross(a1).divideScalar(Vc), b3 = a1.clone().cross(a2).divideScalar(Vc);
          const n = V3(0, 0, 0).addScaledVector(b1, h).addScaledVector(b2, k).addScaledVector(b3, l);
          const O = V3(0, 0, l < 0 ? c : 0); const P = hexPrism(c);
          const pts = slice(P.v, P.e, n, 1 + n.dot(O));
          if (pts) { poly(g, pts, COL.plane, 0.4); const ce = pts.reduce((s, p) => s.add(p), V3(0, 0, 0)).multiplyScalar(1 / pts.length); label(g, idxText(st.pl, '()'), ce.add(V3(0, 0, 0.1)), { color: COL.plane, size: 0.15 }); }
        }
      }
      v.frame(V3(0, 0, c / 2), Math.hypot(1.35, c / 2 + 0.3));
    };
    function reduce(a) { const g = gcdN(a) || 1; return a.map(x => x / g); }
    function refresh() {
      $('#hx-dirctl').hidden = st.mode !== 'dir'; $('#hx-plctl').hidden = st.mode !== 'plane';
      if (st.mode === 'dir') {
        const [u, vv, t, w] = st.dir;
        if (!st.dir.some(x => x)) { info.innerHTML = tx('<p class="warn">The four indices cannot all be 0.</p>', '<p class="warn">四個指數不能同時為 0。</p>'); return; }
        if (u + vv + t !== 0) { info.innerHTML = tx(`<p class="warn">u + v + t = ${u + vv + t}, but it must equal 0. Try changing t to ${-(u + vv)}.</p>`, `<p class="warn">u + v + t = ${u + vv + t}，必須等於 0。試著把 t 改成 ${-(u + vv)}。</p>`); return; }
        const U = u - t, V = vv - t, W = w, r3 = reduce([U, V, W]);
        info.innerHTML = tx(`<h4>Direction ${idxHTML(st.dir, '[]')}</h4><div class="eq">Check: u + v + t = ${u} + (${vv}) + (${t}) = 0 ✓<br>Three-index form: U = u − t = ${U}, V = v − t = ${V}, W = w = ${W}<br>→ ${idxHTML(r3, '[]')}${gcdN([U, V, W]) > 1 ? ' (reduced to the smallest integers)' : ''}</div><p class="note">The arrow starts at the center of the hexagonal prism and shows direction only. Its length is set so that it reaches the surface of the prism.</p>
          <p>In four-index form the three base axes a₁, a₂, a₃ are ${idxHTML([2, -1, -1, 0], '[]')}, ${idxHTML([-1, 2, -1, 0], '[]')}, ${idxHTML([-1, -1, 2, 0], '[]')}. The numbers only change places. In three-index form they are ${idxHTML([1, 0, 0], '[]')}, ${idxHTML([0, 1, 0], '[]')}, ${idxHTML([-1, -1, 0], '[]')}, and nothing shows that they are equivalent.</p>`, `<h4>方向 ${idxHTML(st.dir, '[]')}</h4><div class="eq">檢查：u + v + t = ${u} + (${vv}) + (${t}) = 0 ✓<br>換成三軸：U = u − t = ${U}，V = v − t = ${V}，W = w = ${W}<br>→ ${idxHTML(r3, '[]')}${gcdN([U, V, W]) > 1 ? '（已約成最小整數）' : ''}</div><p class="note">箭頭從六角柱正中心出發，只表示方向；長度已調整到碰到六角柱表面。</p>
          <p>三條底面軸 a₁、a₂、a₃ 寫成四軸是 ${idxHTML([2, -1, -1, 0], '[]')}、${idxHTML([-1, 2, -1, 0], '[]')}、${idxHTML([-1, -1, 2, 0], '[]')}，數字只是換位置；三軸寫法卻是 ${idxHTML([1, 0, 0], '[]')}、${idxHTML([0, 1, 0], '[]')}、${idxHTML([-1, -1, 0], '[]')}，看不出它們是等價的。</p>`);
      } else {
        const [h, k, i, l] = st.pl;
        if (!st.pl.some(x => x)) { info.innerHTML = tx('<p class="warn">The four indices cannot all be 0.</p>', '<p class="warn">四個指數不能同時為 0。</p>'); return; }
        if (i !== -(h + k)) { info.innerHTML = tx(`<p class="warn">h + k + i = ${h + k + i}, but it must equal 0. Try changing i to ${-(h + k)}.</p>`, `<p class="warn">h + k + i = ${h + k + i}，必須等於 0。試著把 i 改成 ${-(h + k)}。</p>`); return; }
        const name = (h === 0 && k === 0) ? tx('Basal plane: the top and bottom faces of the hexagonal prism.', '基面（basal plane）：六角柱的上下底面。') : (l === 0 ? tx('Prism plane: an upright plane parallel to the c axis.', '柱面（prism plane）：和 c 軸平行的直立平面。') : tx('Pyramidal plane: it cuts across both the a axes and the c axis at a slant.', '錐面（pyramidal plane）：同時斜切 a 軸和 c 軸。'));
        info.innerHTML = tx(`<h4>Plane ${idxHTML(st.pl, '()')}</h4><div class="eq">Intercepts: a₁ = ${fracStr(1 / h)}, a₂ = ${fracStr(1 / k)}, a₃ = ${fracStr(1 / i)}, c = ${fracStr(1 / l)}<br>Check: h + k + i = 0 ✓<br>Three-index form: ${idxHTML([h, k, l], '()')} (just drop i)</div><p>${name}</p>${l < 0 ? '<p class="note">l is negative, so the origin is moved to the center of the top face before drawing.</p>' : ''}`, `<h4>平面 ${idxHTML(st.pl, '()')}</h4><div class="eq">截距：a₁ = ${fracStr(1 / h)}，a₂ = ${fracStr(1 / k)}，a₃ = ${fracStr(1 / i)}，c = ${fracStr(1 / l)}<br>檢查：h + k + i = 0 ✓<br>三軸寫法：${idxHTML([h, k, l], '()')}（直接拿掉 i）</div><p>${name}</p>${l < 0 ? '<p class="note">l 是負數，原點移到上底面中心再畫。</p>' : ''}`);
      }
    }
    const rd = (ids, key) => { st[key] = ids.map(s => intIn($(s))); };
    const DIR = ['#hx-u', '#hx-v', '#hx-t', '#hx-w'], PL = ['#hx-h', '#hx-k', '#hx-i', '#hx-l'];
    const upd = () => { v.rebuild(); refresh(); };
    seg($('#hx-mode'), x => { st.mode = x; upd(); });
    DIR.forEach(s => $(s).addEventListener('input', () => { rd(DIR, 'dir'); upd(); }));
    PL.forEach(s => $(s).addEventListener('input', () => { rd(PL, 'pl'); upd(); }));
    $('#hx-dirpre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; b.dataset.v.split(',').forEach((x, i) => ($(DIR[i]).value = x)); rd(DIR, 'dir'); upd(); });
    $('#hx-plpre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; b.dataset.v.split(',').forEach((x, i) => ($(PL[i]).value = x)); rd(PL, 'pl'); upd(); });
    rd(DIR, 'dir'); rd(PL, 'pl'); refresh(); v.lazy(v.rebuild); onLang(refresh);
  }

  /* =====================================================================
     08 Volume density calculator
     ===================================================================== */
  const NA = 6.022e23;
  let ELEM; dataset(() => { ELEM = [
    { k: 'Cu', n: tx('Copper Cu', '銅 Cu'), s: 'FCC', a: 0.3615, M: 63.55, meas: 8.96 },
    { k: 'Al', n: tx('Aluminum Al', '鋁 Al'), s: 'FCC', a: 0.4049, M: 26.98, meas: 2.70 },
    { k: 'Au', n: tx('Gold Au', '金 Au'), s: 'FCC', a: 0.4078, M: 196.97, meas: 19.3 },
    { k: 'Ni', n: tx('Nickel Ni', '鎳 Ni'), s: 'FCC', a: 0.3524, M: 58.69, meas: 8.91 },
    { k: 'Fe', n: tx('Iron Fe (α)', '鐵 Fe（α）'), s: 'BCC', a: 0.2866, M: 55.85, meas: 7.87 },
    { k: 'Cr', n: tx('Chromium Cr', '鉻 Cr'), s: 'BCC', a: 0.2885, M: 52.00, meas: 7.19 },
    { k: 'W', n: tx('Tungsten W', '鎢 W'), s: 'BCC', a: 0.3165, M: 183.84, meas: 19.3 },
    { k: 'Na', n: tx('Sodium Na', '鈉 Na'), s: 'BCC', a: 0.4291, M: 22.99, meas: 0.97 },
    { k: 'Po', n: tx('Polonium Po (α)', '釙 Po（α）'), s: 'SC', a: 0.3359, M: 209, meas: 9.2 },
    { k: 'Mg', n: tx('Magnesium Mg', '鎂 Mg'), s: 'HCP', a: 0.3209, c: 0.5211, M: 24.31, meas: 1.74 },
    { k: 'Zn', n: tx('Zinc Zn', '鋅 Zn'), s: 'HCP', a: 0.2665, c: 0.4947, M: 65.38, meas: 7.13 },
    { k: 'Si', n: tx('Silicon Si', '矽 Si'), s: 'DIA', a: 0.5431, M: 28.09, meas: 2.33 }
  ]; });
  /* ---------- 08 Linear, planar and volume density in 3D ---------- */
  function secDensity3D() {
    const v = new Viewer($('#v-dens'), { view: [1, 0.42, 0.45], label: () => tx('3D model: the atoms counted for a linear, planar or volume density', '3D 模型：計算線密度、面密度、體密度時數到的原子') });
    const MAT = [
      { k: 'cu', n: 'Cu', s: 'FCC', a: 0.361, M: 63.54 }, { k: 'al', n: 'Al', s: 'FCC', a: 0.405, M: 26.98 },
      { k: 'fe', n: 'Fe', s: 'BCC', a: 0.287, M: 55.85 }, { k: 'w', n: 'W', s: 'BCC', a: 0.3165, M: 183.84 },
      { k: 'po', n: 'α-Po', s: 'SC', a: 0.335, M: 209 }, { k: 'si', n: 'Si', s: 'DIA', a: 0.5431, M: 28.09 }
    ];
    const RAD = { SC: 0.5, BCC: S3 / 4, FCC: S2 / 4, DIA: S3 / 8 }; // hard-sphere radius in units of a
    const CUBE6 = [new THREE.Plane(V3(1, 0, 0), 0), new THREE.Plane(V3(-1, 0, 0), 1), new THREE.Plane(V3(0, 1, 0), 0), new THREE.Plane(V3(0, -1, 0), 1), new THREE.Plane(V3(0, 0, 1), 0), new THREE.Plane(V3(0, 0, -1), 1)];
    const st = { mode: 'lin', mat: 'cu', uvw: [1, 1, 0], hkl: [1, 1, 0], aim: true };
    const info = $('#d3-info'), sel = $('#d3-mat'), U = ['#d3-u', '#d3-v', '#d3-w'], Hh = ['#d3-h', '#d3-k', '#d3-l'];
    const SN = () => ({ FCC: 'FCC', BCC: 'BCC', SC: 'SC', DIA: tx('diamond', '鑽石結構') });
    const EX = [{ mode: 'lin', mat: 'cu', idx: [1, 1, 0] }, { mode: 'pla', mat: 'fe', idx: [1, 1, 0] }, { mode: 'vol', mat: 'cu' }];
    function chrome() {
      sel.innerHTML = MAT.map(m => `<option value="${m.k}"${m.k === st.mat ? ' selected' : ''}>${m.n} · ${SN()[m.s]} · a = ${m.a} nm</option>`).join('');
      $('#d3-ex').innerHTML = [tx('1: Cu ', '1：Cu ') + idxHTML([1, 1, 0], '[]'), tx('2: Fe ', '2：Fe ') + idxHTML([1, 1, 0], '()'), tx('3: Cu volume', '3：Cu 體密度')].map((t, i) => `<button type="button" data-v="${i}">${t}</button>`).join('');
    }
    const mat = () => MAT.find(m => m.k === st.mat);
    const dark = c => new THREE.Color(c).multiplyScalar(0.72);
    const colOf = p => kindColor(p.map(frac));
    function disc(g, c, nrm, r, m) { const d = new THREE.Mesh(new THREE.CircleGeometry(r, 48), m); d.position.copy(c); d.quaternion.setFromUnitVectors(V3(0, 0, 1), nrm.clone().normalize()); g.add(d); return d; }
    // x as an integer, or √q/den when that is exact
    function surd(x) {
      if (isInt(x)) return String(Math.round(x));
      for (let den = 1; den <= 8; den++) { const q = (x * den) ** 2; if (isInt(q) && q < 400) return `√${Math.round(q)}${den > 1 ? '/' + den : ''}`; }
      return fmt(x, 3);
    }
    const sumTxt = ws => { const m = new Map(); ws.forEach(w => { const k = fracStr(w); m.set(k, (m.get(k) || 0) + 1); }); return [...m].map(([k, c]) => (c > 1 ? `${c} × ${k}` : k)).join(' + '); };
    const eqN = (ws, N) => { const t = sumTxt(ws); return t === fracStr(N) ? t : `${t} = ${fracStr(N)}`; };
    const unitTxt = (x, u) => (Math.abs(x - 1) < EPS ? u : `${surd(x)} ${u}`);
    // share of an atom's circle that lies inside a convex polygon: 1 inside, ½ on an edge, angle/360° at a vertex
    function share(P, pts, nn) {
      const m = pts.length; let sign = 0;
      for (let i = 0; i < m; i++) { const A = pts[i]; if (P.distanceTo(A) < 1e-6) return pts[(i + 1) % m].clone().sub(A).angleTo(pts[(i + m - 1) % m].clone().sub(A)) / (2 * Math.PI); }
      for (let i = 0; i < m; i++) {
        const A = pts[i], B = pts[(i + 1) % m], s = B.clone().sub(A).cross(P.clone().sub(A)).dot(nn);
        if (Math.abs(s) < 1e-6) { const t = P.clone().sub(A).dot(B.clone().sub(A)) / B.distanceToSquared(A); return t > 0 && t < 1 ? 0.5 : 0; }
        if (sign && Math.sign(s) !== sign) return 0; sign = Math.sign(s);
      }
      return 1;
    }
    function lineGeom() {
      const u = st.uvw, m = Math.max(...u.map(Math.abs)), S = V3(...u.map(x => (x < 0 ? 1 : 0))), E = S.clone().add(V3(...u.map(x => x / m)));
      const d = E.clone().sub(S), len = d.length(), on = [];
      sitesIn(BASIS[mat().s]).forEach(({ p }) => { const P = V3(...p), t = P.clone().sub(S).dot(d) / (len * len); if (t > -EPS && t < 1 + EPS && P.distanceTo(S.clone().addScaledVector(d, t)) < 1e-6) on.push({ p, P, t, w: t < EPS || t > 1 - EPS ? 0.5 : 1 }); });
      on.sort((a, b) => a.t - b.t);
      return { S, E, d, len, on };
    }
    function planeGeom() {
      const h = st.hkl, n = V3(...h), O = V3(...h.map(x => (x < 0 ? 1 : 0))), val = 1 + n.dot(O), nn = n.clone().normalize();
      const pts = slice(CUBE_V, CUBE_E, n, val), R = RAD[mat().s], on = [];
      if (!pts) return { n, nn, pts, on, area: 0 };
      sitesIn(BASIS[mat().s], -1, 2).forEach(({ p }) => { const P = V3(...p); if (Math.abs(n.dot(P) - val) > 1e-6) return; if (p.some(x => x < -R || x > 1 + R)) return; on.push({ p, P, w: p.every(x => x > -EPS && x < 1 + EPS) ? share(P, pts, nn) : 0 }); });
      const c0 = pts[0]; let ar = V3(0, 0, 0); for (let i = 1; i < pts.length - 1; i++) ar.add(pts[i].clone().sub(c0).cross(pts[i + 1].clone().sub(c0)));
      return { n, nn, pts, on, area: ar.length() / 2 };
    }
    v.rebuild = () => {
      v.clear(); const g = v.root, M = mat(), R = RAD[M.s], sites = sitesIn(BASIS[M.s]);
      cellEdges(g, V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), 0.007, mStd(T.edge3d));
      label(g, 'a', V3(0.5, -0.09, -0.09), { size: 0.12, color: T.muted });
      const same = (p, q) => p.every((x, i) => Math.abs(x - q[i]) < EPS);
      const FADE = { opacity: 0.16 };
      let dir = null;
      if (st.mode === 'vol') {
        sites.forEach(({ p }) => cutAtom(g, V3(...p), R, kindColor(p), CUBE6));
      } else if (st.mode === 'lin') {
        if (!st.uvw.some(x => x)) { sites.forEach(({ p }) => cutAtom(g, V3(...p), R, kindColor(p), CUBE6, FADE)); v.frame(V3(.5, .5, .5), 1.05); return; }
        const L = lineGeom(), dh = L.d.clone().normalize();
        // counted atoms: whole hard spheres, cut only where the line segment ends
        const ends = [new THREE.Plane(dh.clone(), -dh.dot(L.S)), new THREE.Plane(dh.clone().negate(), dh.dot(L.E))];
        sites.forEach(({ p }) => { if (!L.on.some(o => same(o.p, p))) cutAtom(g, V3(...p), R, kindColor(p), CUBE6, FADE); });
        L.on.forEach(o => {
          const c = kindColor(o.p), s = new THREE.Mesh(GEO.sphere, mStd(c, { clip: ends })); s.position.copy(o.P); s.scale.setScalar(R); g.add(s);
          if (o.w < 1) disc(g, o.P, dh, R, mStd(dark(c), { rough: 0.7, clip: [] }));
        });
        const r = rod(g, L.S.clone().addScaledVector(dh, -0.12), L.E.clone().addScaledVector(dh, 0.12), 0.011, mBasic(T.hi, { depthTest: false })); if (r) r.renderOrder = 20;
        label(g, idxText(st.uvw, '[]'), L.E.clone().addScaledVector(dh, 0.3), { color: T.hi, size: 0.14 });
        // look from the side of the cell the line runs on, so the counted atoms are not hidden
        const mid = L.S.clone().lerp(L.E, 0.5).sub(V3(.5, .5, .5));
        dir = [1 + mid.x * 0.6, 0.42 + mid.y * 0.6, Math.max(0.4, 0.45 + mid.z * 1.5)];
      } else {
        const P = planeGeom();
        if (!P.pts) { sites.forEach(({ p }) => cutAtom(g, V3(...p), R, kindColor(p), CUBE6, FADE)); v.frame(V3(.5, .5, .5), 1.05); return; }
        // the crystal is cut open along the plane: everything in front of it is removed
        const cut = new THREE.Plane(P.nn.clone().negate(), P.nn.dot(P.pts[0]));
        sites.forEach(({ p }) => { const on = P.on.some(o => same(o.p, p)); cutAtom(g, V3(...p), R, kindColor(p), CUBE6, on ? { clip: [cut] } : { clip: [cut], opacity: 0.16 }); });
        P.on.forEach(o => disc(g, o.P.clone().addScaledVector(P.nn, -0.002), P.nn, R, mStd(dark(colOf(o.p)), { clip: CUBE6, rough: 0.7 })));
        poly(g, P.pts, COL.plane, 0.16);
        const c = P.pts.reduce((s, p) => s.add(p), V3(0, 0, 0)).multiplyScalar(1 / P.pts.length);
        label(g, idxText(st.hkl, '()'), c.clone().addScaledVector(P.nn, 0.2), { color: COL.plane, size: 0.14 });
        dir = [P.nn.x + 0.3, P.nn.y - 0.22, P.nn.z + 0.28];
      }
      if (st.aim && dir) { st.aim = false; v.frame(V3(.5, .5, .5), 1.05, dir); } else v.frame(V3(.5, .5, .5), 1.05);
    };
    function refresh() {
      $('#d3-dirctl').hidden = st.mode !== 'lin'; $('#d3-plctl').hidden = st.mode !== 'pla';
      const M = mat(), R = RAD[M.s], zero = tx('<p class="warn">The three indices cannot all be 0.</p>', '<p class="warn">三個指數不能同時為 0。</p>');
      if (st.mode === 'vol') {
        const N = BASIS[M.s].length, m = N * M.M / NA, V = (M.a * 1e-7) ** 3;
        info.innerHTML = tx(`<h4>Volume density: ${M.n}</h4><p>The model cuts every atom at the cell walls. Add up the pieces left inside, then divide their mass by the volume of the cell.</p>`, `<h4>體密度：${M.n}</h4><p>模型把每顆原子沿晶胞的面切開。把留在晶胞裡的部分加起來，再用它們的質量除以晶胞體積。</p>`) +
          `<div class="eq">${tx('Atoms in the cell', '晶胞內的原子')} N = ${N}<br>m = ${N} × ${M.M} ÷ (6.022 × 10²³) = ${(m * 1e22).toFixed(2)} × 10⁻²² g<br>V = a³ = (${M.a} × 10⁻⁷ cm)³ = ${(V * 1e23).toFixed(2)} × 10⁻²³ cm³<br>ρ<sub>v</sub> = m ÷ V = <b>${(m / V).toFixed(2)} g/cm³</b></div>`;
        return;
      }
      if (st.mode === 'lin') {
        const u = st.uvw; if (!u.some(x => x)) { info.innerHTML = zero; return; }
        const L = lineGeom(), D = linDensity(BASIS[M.s], u, M.a), N = L.on.reduce((s, o) => s + o.w, 0), lenNm = L.len * M.a, ix = idxHTML(u, '[]');
        const whole = N > 0 && Math.abs(N / lenNm - D.rho) < 1e-6 * D.rho;
        let html = tx(`<h4>Linear density: ${M.n} ${ix}</h4><p>The solid atoms are the ones whose centers sit on the red line. An atom at an end of the line is cut in half: only that half lies on this stretch of the line, so it counts as ½.</p>`, `<h4>線密度：${M.n} ${ix}</h4><p>實心的原子是中心落在紅線上的那幾顆。線段兩端的原子被切成一半：只有這一半落在這段線上，各算 ½ 顆。</p>`);
        if (whole) html += `<div class="eq">N = ${eqN(L.on.map(o => o.w), N)}<br>${tx('Length', '長度')} = ${unitTxt(L.len, 'a')} = ${fmt(lenNm, 4)} nm<br>ρ<sub>l</sub> = ${fracStr(N)} ÷ ${fmt(lenNm, 4)} nm = <b>${fmt(D.rho, 2)} ${tx('atoms/nm', '個/nm')}</b></div>`;
        else html += `<div class="eq">${tx('One atom every', '每隔')} ${fmt(D.rep, 4)} nm${tx('', ' 一顆原子')}<br>ρ<sub>l</sub> = 1 ÷ ${fmt(D.rep, 4)} nm = <b>${fmt(D.rho, 2)} ${tx('atoms/nm', '個/nm')}</b></div>` + tx('<p class="note">The piece of this line inside one cell is not a whole repeat, so the count uses the distance from one atom to the next along the line.</p>', '<p class="note">這條線在一個晶胞內的那一段不是完整的重複單位，所以改用沿線相鄰兩顆原子的距離來算。</p>');
        if (Math.abs(D.rep / M.a - 2 * R) < 1e-6) html += tx('<p class="note">The atoms touch along this line. No direction in this crystal is packed more tightly.</p>', '<p class="note">原子沿這條線互相接觸。這種晶體裡沒有比它更密的方向。</p>');
        else html += tx('<p class="note">There are gaps between the atoms along this line, so it is not the densest direction.</p>', '<p class="note">沿這條線原子之間有空隙，所以它不是最密的方向。</p>');
        info.innerHTML = html; return;
      }
      const h = st.hkl; if (!h.some(x => x)) { info.innerHTML = zero; return; }
      const P = planeGeom(), D = planeData(BASIS[M.s], h, M.a), N = P.on.reduce((s, o) => s + o.w, 0), A = P.area * M.a * M.a, ix = idxHTML(h, '()');
      let html = tx(`<h4>Planar density: ${M.n} ${ix}</h4><p>The model cuts the crystal open along the purple plane. Each atom whose center lies on the plane shows a full-size circle on the cut face, and only the part of the circle inside the cell counts.</p>`, `<h4>面密度：${M.n} ${ix}</h4><p>模型沿紫色平面把晶體切開。中心落在平面上的原子，在切面上露出一個完整大小的圓，只算圓落在晶胞內的部分。</p>`);
      if (N < EPS) html += tx('<p><span class="pill bad">0</span> This plane passes between two layers of atoms, so no atom center lies on it.</p>', '<p><span class="pill bad">0</span>　這個平面剛好夾在兩層原子之間，沒有原子的中心落在上面。</p>');
      else if (Math.abs(N / A - D.rho) < 1e-6 * D.rho) html += `<div class="eq">N = ${eqN(P.on.filter(o => o.w > 0).map(o => o.w), N)}<br>${tx('Area', '面積')} = ${unitTxt(P.area, 'a²')} = ${fmt(A, 4)} nm²<br>ρ<sub>p</sub> = ${fracStr(N)} ÷ ${fmt(A, 4)} nm² = <b>${fmt(D.rho, 2)} ${tx('atoms/nm²', '個/nm²')}</b></div>`;
      else html += `<div class="eq">ρ<sub>p</sub> = <b>${fmt(D.rho, 2)} ${tx('atoms/nm²', '個/nm²')}</b></div>` + tx('<p class="note">The piece of this plane inside one cell is not a whole repeating unit, so the value is worked out from the repeating pattern of the plane.</p>', '<p class="note">這個平面在一個晶胞內的那一塊不是完整的重複單位，所以數值是用平面上的重複圖案算出來的。</p>');
      info.innerHTML = html;
    }
    const upd = () => { st.aim = true; v.rebuild(); refresh(); };
    const read = () => { st.uvw = U.map(s => intIn($(s))); st.hkl = Hh.map(s => intIn($(s))); };
    seg($('#d3-mode'), x => { st.mode = x; upd(); });
    sel.addEventListener('change', () => { st.mat = sel.value; upd(); });
    [...U, ...Hh].forEach(s => $(s).addEventListener('input', () => { read(); upd(); }));
    $('#d3-ex').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return; const x = EX[+b.dataset.v];
      st.mode = x.mode; st.mat = x.mat; sel.value = x.mat; setSeg($('#d3-mode'), x.mode);
      if (x.idx) (x.mode === 'lin' ? U : Hh).forEach((s, i) => ($(s).value = x.idx[i]));
      read(); upd();
    });
    chrome(); read(); refresh(); v.lazy(v.rebuild); onLang(() => { chrome(); refresh(); });
  }

  function secDensity() {
    const sel = $('#den-el'), out = $('#den-out');
    const SN = () => ({ FCC: tx('face-centered cubic', '面心立方'), BCC: tx('body-centered cubic', '體心立方'), SC: tx('simple cubic', '簡單立方'), HCP: tx('hexagonal close-packed', '六方最密'), DIA: tx('diamond structure', '鑽石結構') });
    const optText = e => tx(`${e.n} (${SN()[e.s]})`, `${e.n}（${SN()[e.s]}）`);
    sel.innerHTML = ELEM.map(e => `<option value="${e.k}">${optText(e)}</option>`).join('');
    onLang(() => { [...sel.options].forEach((o, i) => { o.textContent = optText(ELEM[i]); }); calc(); });
    function calc() {
      const e = ELEM.find(x => x.k === sel.value);
      const nAt = { FCC: 4, BCC: 2, SC: 1, HCP: 2, DIA: 8 }[e.s];
      const m = nAt * e.M / NA;
      const Vnm = e.s === 'HCP' ? (S3 / 2) * e.a * e.a * e.c : e.a ** 3;
      const V = Vnm * 1e-21, rho = m / V;
      out.innerHTML = tx(`<h4>${e.n}</h4><div class="eq">Atoms per cell = ${nAt}${e.s === 'HCP' ? ' (using the primitive cell of 2 atoms)' : ''}<br>Cell mass m = ${nAt} × ${e.M} ÷ (6.022 × 10²³) = ${(m * 1e22).toFixed(3)} × 10⁻²² g<br>Cell volume V = ${e.s === 'HCP' ? `(√3/2) a² c = (√3/2) × ${e.a}² × ${e.c}` : `a³ = ${e.a}³`} nm³ = ${(V * 1e23).toFixed(3)} × 10⁻²³ cm³<br>Density ρ = m ÷ V = <b>${rho.toFixed(2)} g/cm³</b></div><p>The measured density is about <b>${e.meas} g/cm³</b>. The unit cell and the atomic mass alone give almost the same value.</p><p class="note">Conversion: 1 nm = 10⁻⁷ cm, so 1 nm³ = 10⁻²¹ cm³.</p>`, `<h4>${e.n}</h4><div class="eq">每個晶胞的原子數 = ${nAt}${e.s === 'HCP' ? '（用 2 個原子的基本晶胞）' : ''}<br>晶胞質量 m = ${nAt} × ${e.M} ÷ (6.022 × 10²³) = ${(m * 1e22).toFixed(3)} × 10⁻²² g<br>晶胞體積 V = ${e.s === 'HCP' ? `(√3/2) a² c = (√3/2) × ${e.a}² × ${e.c}` : `a³ = ${e.a}³`} nm³ = ${(V * 1e23).toFixed(3)} × 10⁻²³ cm³<br>密度 ρ = m ÷ V = <b>${rho.toFixed(2)} g/cm³</b></div><p>實際量到的密度約 <b>${e.meas} g/cm³</b>。只靠晶胞和原子量，就能算得幾乎一樣準。</p><p class="note">換算：1 nm = 10⁻⁷ cm，所以 1 nm³ = 10⁻²¹ cm³。</p>`);
    }
    sel.addEventListener('change', calc); calc();
  }

  /* =====================================================================
     2D canvas helper
     ===================================================================== */
  function canvas2d(cv, draw) {
    const fit = () => {
      const r = cv.parentElement.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); draw(x, r.width, r.height);
    };
    new ResizeObserver(fit).observe(cv.parentElement);
    return fit;
  }
  const FONT = (w, s) => tx(`${w} ${s}px "IBM Plex Sans",system-ui,sans-serif`, `${w} ${s}px "Noto Sans TC","PingFang TC",sans-serif`);
  const MFONT = (w, s) => `${w} ${s}px "IBM Plex Mono",monospace`;

  /* =====================================================================
     09-1 Two waves adding up
     ===================================================================== */
  function secWaves() {
    const sl = $('#wv-s'), out = $('#wv-out');
    let draw;
    function paint(x, W, H) {
      const s = +sl.value, f = frac(s), same = f < 0.02 || f > 0.98, opp = Math.abs(f - 0.5) < 0.02;
      const A = 2 * Math.abs(Math.cos(Math.PI * s)), ph = 2 * Math.PI * s;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const x0 = 16, x1 = W - 16, per = (x1 - x0) / 3.25, amp = H * 0.065, y1 = H * 0.17, y2 = H * 0.47, y3 = H * 0.8;
      x.save(); x.setLineDash([3, 4]); x.strokeStyle = T.grid; x.lineWidth = 1;
      for (let px = x0; px <= x1; px += per) { x.beginPath(); x.moveTo(px, y1 - amp - 4); x.lineTo(px, H - 10); x.stroke(); }
      x.restore();
      const wave = (yc, fn, col, lw) => { x.strokeStyle = col; x.lineWidth = lw; x.beginPath(); for (let px = x0; px <= x1; px += 2) { const yy = yc - amp * fn(2 * Math.PI * (px - x0) / per); px === x0 ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); };
      x.font = FONT(500, 12); x.fillStyle = T.muted; x.textAlign = 'left';
      x.fillText(tx('Wave 1', '第 1 道波'), x0, y1 - amp - 10); wave(y1, Math.cos, T.accent, 1.8);
      x.fillText(tx('Wave 2', '第 2 道波'), x0, y2 - amp - 30); wave(y2, u => Math.cos(u - ph), T.accent, 1.8);
      // how far the crest of wave 2 sits behind the crest of wave 1
      const my = y2 - amp - 13, mx = x0 + s * per;
      x.strokeStyle = T.hi; x.lineWidth = 2.2; x.beginPath(); x.moveTo(x0, my); x.lineTo(mx, my); x.moveTo(x0, my - 4); x.lineTo(x0, my + 4); x.moveTo(mx, my - 4); x.lineTo(mx, my + 4); x.stroke();
      x.fillStyle = T.hi; x.font = MFONT(600, 12); x.fillText(s.toFixed(2) + ' λ', mx + 7, my + 4);
      x.fillStyle = T.ink; x.font = FONT(700, 12); x.fillText(tx('Sum of the two', '兩道波相加'), x0, y3 - 2 * amp - 9);
      wave(y3, u => Math.cos(u) + Math.cos(u - ph), same ? T.ok : opp ? T.bad : T.accent, 2.6);
      const verdict = same ? tx('<span class="pill ok">In phase</span> Crest meets crest. The sum is twice as tall and four times as bright.', '<span class="pill ok">同相</span>　波峰對波峰，高度變兩倍，亮度變四倍。')
        : opp ? tx('<span class="pill bad">Out of phase</span> Crest meets trough. The two waves cancel completely.', '<span class="pill bad">反相</span>　波峰對波谷，兩道波完全抵銷。')
          : tx('<span class="pill">In between</span> The waves partly reinforce and partly cancel.', '<span class="pill">介於中間</span>　一部分加強，一部分抵銷。');
      out.innerHTML = tx(`<dl class="stats"><dt>Lag of wave 2</dt><dd>${s.toFixed(2)} λ</dd><dt>As a phase angle</dt><dd>360° × ${s.toFixed(2)} = ${Math.round(s * 360)}°</dd><dt>Height of the sum</dt><dd>${A.toFixed(2)} × one wave</dd><dt>Brightness</dt><dd>${(A * A).toFixed(2)} × one wave</dd></dl><p>${verdict}</p><p class="note">Brightness (intensity) goes as the square of the height. A lag written as an angle is called the phase difference: one full wavelength is 360°.</p>`, `<dl class="stats"><dt>第 2 道波落後</dt><dd>${s.toFixed(2)} λ</dd><dt>換成相位角</dt><dd>360° × ${s.toFixed(2)} = ${Math.round(s * 360)}°</dd><dt>相加後的高度</dt><dd>${A.toFixed(2)} × 單一道波</dd><dt>亮度</dt><dd>${(A * A).toFixed(2)} × 單一道波</dd></dl><p>${verdict}</p><p class="note">亮度（強度）和高度的平方成正比。把落後的距離寫成角度，就叫相位差：一個完整波長對應 360°。</p>`);
      $('#wv-v').textContent = s.toFixed(2) + ' λ';
    }
    draw = canvas2d($('#wv-cv'), paint);
    sl.addEventListener('input', draw);
    $('#wv-pre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; sl.value = b.dataset.v; draw(); });
    return () => draw();
  }

  /* =====================================================================
     09-2 X-ray tube spectrum
     ===================================================================== */
  const TGT = { cu: { n: 'Cu', ka: 0.1542, kb: 0.1392, vk: 8.98 }, mo: { n: 'Mo', ka: 0.0711, kb: 0.0632, vk: 20.0 }, w: { n: 'W', ka: 0.0211, kb: 0.0184, vk: 69.5 } };
  function secTube() {
    const sl = $('#kv'), out = $('#kv-out'), st = { t: 'mo' };
    let draw;
    function paint(x, W, H) {
      const kv = +sl.value, lm = 1.24 / kv, g = TGT[st.t], on = kv > g.vk;
      $('#kv-val').textContent = kv;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 34, mr = 16, mt = 36, mb = 42, LMAX = 0.2, PH = H - mt - mb;
      const X = l => ml + l / LMAX * (W - ml - mr), Y = v => H - mb - Math.min(v, 1) * PH;
      x.lineWidth = 1; x.font = MFONT(400, 11); x.textAlign = 'center';
      for (let i = 0; i <= 4; i++) { const l = i * 0.05; x.strokeStyle = T.grid; x.beginPath(); x.moveTo(X(l), mt); x.lineTo(X(l), H - mb); x.stroke(); x.fillStyle = T.muted; x.fillText(l.toFixed(2), X(l), H - mb + 16); }
      x.fillStyle = T.muted; x.font = FONT(500, 12); x.fillText(tx('Wavelength λ (nm)', '波長 λ（nm）'), (ml + W - mr) / 2, H - 7);
      x.save(); x.translate(14, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.fillText(tx('Intensity (schematic)', '強度（示意）'), 0, 0); x.restore();
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, mt); x.lineTo(ml, H - mb); x.lineTo(W - mr, H - mb); x.stroke();
      // continuous X-rays follow Kramers' law; scaled so the hump at 80 kV fills 60% of the height
      const K = 0.6 * 4 * (1.24 / 80) ** 2, cont = l => (l <= lm ? 0 : K * (l / lm - 1) / (l * l));
      [20, 40, 60, 80].forEach(v => {
        if (v === kv) return; const l0 = 1.24 / v, c = l => K * (l / l0 - 1) / (l * l);
        x.strokeStyle = T.ghost3d; x.lineWidth = 1; x.beginPath(); for (let l = l0; l <= LMAX + 1e-9; l += 0.001) (l === l0 ? x.moveTo(X(l), Y(0)) : x.lineTo(X(l), Y(c(l)))); x.stroke();
        x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center'; x.fillText(v + ' kV', X(2 * l0), Y(c(2 * l0)) - 5);
      });
      const pts = []; for (let l = lm; l <= LMAX + 1e-9; l += 0.0004) pts.push([X(l), Y(cont(l))]);
      if (pts.length) {
        x.beginPath(); x.moveTo(pts[0][0], Y(0)); pts.forEach(p => x.lineTo(p[0], p[1])); x.lineTo(pts[pts.length - 1][0], Y(0)); x.closePath();
        x.globalAlpha = 0.12; x.fillStyle = T.accent; x.fill(); x.globalAlpha = 1;
        x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.strokeStyle = T.accent; x.lineWidth = 2; x.stroke();
      }
      // characteristic lines
      const hk = Math.min(0.9, Math.max(0.07, 0.16 * Math.pow(Math.max(kv / g.vk - 1, 0), 1.5)));
      [[g.ka, hk, 'Kα', 'left', -3], [g.kb, hk * 0.22, 'Kβ', 'right', 3]].forEach(([l, h, name, al, dx]) => {
        x.font = MFONT(600, 12); x.textAlign = al;
        if (on) {
          const base = cont(l), tip = Math.min(base + h, 0.97);
          x.strokeStyle = T.hi; x.fillStyle = T.hi; x.lineWidth = 2; x.beginPath(); x.moveTo(X(l) - 2.5, Y(base)); x.lineTo(X(l), Y(tip)); x.lineTo(X(l) + 2.5, Y(base)); x.closePath(); x.fill(); x.stroke();
          x.fillText(name, X(l) + dx, Y(tip) - 6);
        } else {
          x.save(); x.setLineDash([2, 4]); x.strokeStyle = T.muted; x.lineWidth = 1; x.beginPath(); x.moveTo(X(l), Y(0)); x.lineTo(X(l), Y(0.14)); x.stroke(); x.restore();
          x.fillStyle = T.muted; x.fillText(name, X(l) + dx, Y(0.14) - 6);
        }
      });
      if (lm < LMAX) {
        x.save(); x.setLineDash([4, 4]); x.strokeStyle = T.ink; x.lineWidth = 1.2; x.beginPath(); x.moveTo(X(lm), Y(0)); x.lineTo(X(lm), mt - 6); x.stroke(); x.restore();
        x.fillStyle = T.ink; x.font = MFONT(600, 12); x.textAlign = 'center'; x.fillText('λmin', Math.max(X(lm), ml + 16), mt - 12);
      }
      x.textAlign = 'left';
      const ev = l => (1.24 / l).toFixed(2), vk = g.vk.toFixed(g.vk < 10 ? 2 : 1);
      out.innerHTML = tx(`<dl class="stats"><dt>Shortest wavelength λ<sub>min</sub></dt><dd>1240 ÷ ${kv * 1000} V = ${lm.toFixed(4)} nm</dd><dt>${g.n} K<sub>α</sub> (L → K)</dt><dd>${g.ka.toFixed(4)} nm, ${ev(g.ka)} keV</dd><dt>${g.n} K<sub>β</sub> (M → K)</dt><dd>${g.kb.toFixed(4)} nm, ${ev(g.kb)} keV</dd><dt>Needed to remove a K electron</dt><dd>${vk} kV</dd></dl><p>${on ? `<span class="pill ok">Characteristic lines present</span> ${kv} kV is above ${vk} kV, so the electrons can knock K electrons out of ${g.n}.` : `<span class="pill bad">Continuous X-rays only</span> ${kv} kV is below ${vk} kV. The electrons cannot remove a K electron from ${g.n}, so no characteristic line appears.`}</p><p class="note">The higher the voltage, the shorter λ<sub>min</sub> and the stronger the whole spectrum. The wavelength of the characteristic lines depends only on the target and does not change with the voltage.</p>`, `<dl class="stats"><dt>最短波長 λ<sub>min</sub></dt><dd>1240 ÷ ${kv * 1000} V = ${lm.toFixed(4)} nm</dd><dt>${g.n} K<sub>α</sub>（L → K）</dt><dd>${g.ka.toFixed(4)} nm，${ev(g.ka)} keV</dd><dt>${g.n} K<sub>β</sub>（M → K）</dt><dd>${g.kb.toFixed(4)} nm，${ev(g.kb)} keV</dd><dt>撞出 K 層電子所需電壓</dt><dd>${vk} kV</dd></dl><p>${on ? `<span class="pill ok">有特性線</span>　${kv} kV 高於 ${vk} kV，電子能把 ${g.n} 的 K 層電子撞出來。` : `<span class="pill bad">只有連續 X 光</span>　${kv} kV 低於 ${vk} kV，電子撞不出 ${g.n} 的 K 層電子，所以沒有特性線。`}</p><p class="note">電壓越高，λ<sub>min</sub> 越短，整個光譜也越強；但特性線的波長只由靶材決定，不隨電壓改變。</p>`);
    }
    draw = canvas2d($('#tb-cv'), paint);
    sl.addEventListener('input', draw);
    seg($('#tb-t'), v => { st.t = v; draw(); });
    return () => draw();
  }

  /* =====================================================================
     09-3 Bragg's law canvas
     ===================================================================== */
  function secBragg() {
    const th = $('#br-th'), dd = $('#br-d'), ll = $('#br-l'), out = $('#br-out');
    let draw;
    function state() { return { t: +th.value, d: +dd.value, l: +ll.value }; }
    function paint(x, W, H) {
      const { t, d, l } = state(), s = Math.sin(t * D2R), c = Math.cos(t * D2R);
      const pd = 2 * d * s, ratio = pd / l, n = Math.round(ratio), ok = n >= 1 && Math.abs(ratio - n) < 0.03;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const top = 250, sc = 300, dp = d * sc;
      const y1 = 92, y2 = y1 + dp, y3 = y2 + dp, cx = W * 0.5, sp = 40;
      // atom planes
      [y1, y2, y3].forEach((y, i) => {
        if (y > top - 8) return;
        x.strokeStyle = T.grid; x.lineWidth = 1; x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke();
        for (let ax = cx % sp; ax < W; ax += sp) { x.fillStyle = i ? COL.corner : COL.corner; x.globalAlpha = 0.85; x.beginPath(); x.arc(ax, y, 6, 0, 7); x.fill(); x.globalAlpha = 1; }
      });
      const L = Math.max(W, 600), kin = [c, s], kout = [c, -s];
      const ray = (px, py, col, w) => {
        x.strokeStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(px - kin[0] * L, py - kin[1] * L); x.lineTo(px, py); x.lineTo(px + kout[0] * L, py + kout[1] * L); x.stroke();
      };
      x.save(); x.beginPath(); x.rect(0, 0, W, top); x.clip();
      ray(cx, y1, T.accent, 2); ray(cx, y2, T.accent, 2);
      const ds = d * s * sc;
      const F1 = [cx - kin[0] * ds, y2 - kin[1] * ds], F2 = [cx + kout[0] * ds, y2 + kout[1] * ds];
      x.setLineDash([4, 4]); x.strokeStyle = T.muted; x.lineWidth = 1.2;
      x.beginPath(); x.moveTo(cx, y1); x.lineTo(F1[0], F1[1]); x.moveTo(cx, y1); x.lineTo(F2[0], F2[1]); x.stroke(); x.setLineDash([]);
      x.strokeStyle = T.hi; x.lineWidth = 4.5; x.beginPath(); x.moveTo(F1[0], F1[1]); x.lineTo(cx, y2); x.lineTo(F2[0], F2[1]); x.stroke();
      // theta arc
      x.strokeStyle = T.ink; x.lineWidth = 1.3; x.beginPath(); x.arc(cx, y1, 34, Math.PI, Math.PI + t * D2R); x.stroke();
      x.fillStyle = T.ink; x.font = FONT(700, 15); x.textAlign = 'center'; x.fillText('θ', cx - 50 * Math.cos(t * D2R / 2), y1 - 50 * Math.sin(t * D2R / 2) + 5); x.textAlign = 'left';
      // d marker
      const dx = 26; x.strokeStyle = T.ink; x.lineWidth = 1.2; x.beginPath(); x.moveTo(dx, y1); x.lineTo(dx, y2); x.moveTo(dx - 5, y1); x.lineTo(dx + 5, y1); x.moveTo(dx - 5, y2); x.lineTo(dx + 5, y2); x.stroke();
      x.font = MFONT(600, 13); x.fillText('d', dx + 8, (y1 + y2) / 2 + 4);
      x.fillStyle = T.hi; x.font = MFONT(600, 12); x.fillText('d sinθ', F2[0] + 8, (F2[1] + y2) / 2 + 4);
      x.fillStyle = T.ink; x.font = MFONT(600, 12); x.fillText('O', cx + 7, y1 - 8); x.fillText('G', cx - 4, y2 + 17); x.fillText('F', F1[0] - 14, F1[1] + 4); x.fillText('H', F2[0] + 2, F2[1] - 9);
      x.fillStyle = T.muted; x.font = FONT(500, 12); x.fillText(tx('Incident X-rays', '入射 X 光'), 12, 22); x.textAlign = 'right'; x.fillText(tx('Scattered X-rays → detector', '散射 X 光 → 偵測器'), W - 12, 22); x.textAlign = 'left';
      x.restore();
      // waves panel
      const wy = top + 14;
      x.strokeStyle = T.line; x.beginPath(); x.moveTo(0, top); x.lineTo(W, top); x.stroke();
      const phi = 2 * Math.PI * ratio, amp = 12, x0 = 110, x1 = W - 16;
      const wave = (yc, ph, col, a, lw) => { x.strokeStyle = col; x.lineWidth = lw; x.beginPath(); for (let px = x0; px <= x1; px += 2) { const yy = yc - a * Math.sin((px - x0) / 26 - ph); px === x0 ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); };
      x.font = FONT(500, 12); x.fillStyle = T.muted;
      x.fillText(tx('Ray from layer 1', '第 1 層的光'), 12, wy + 18); wave(wy + 14, 0, T.accent, amp, 1.6);
      x.fillText(tx('Ray from layer 2', '第 2 層的光'), 12, wy + 50); wave(wy + 46, phi, T.accent, amp, 1.6);
      x.fillStyle = T.ink; x.fillText(tx('Both added', '兩道光相加'), 12, wy + 98);
      const sumA = 2 * amp * Math.abs(Math.cos(phi / 2));
      wave(wy + 94, phi / 2, ok ? T.ok : T.hi, sumA, 2.6);
      out.innerHTML = tx(`<dl class="stats"><dt>Extra path</dt><dd>2d sinθ = ${pd.toFixed(4)} nm</dd><dt>In wavelengths</dt><dd>${ratio.toFixed(3)} λ</dd></dl>
        <p>${ok ? `<span class="pill ok">In phase: bright spot (n = ${n})</span> The extra path is exactly ${n} wavelength${n > 1 ? 's' : ''}, so crest meets crest.` : `<span class="pill bad">Out of phase: weaker</span> Off by ${Math.abs(ratio - n).toFixed(2)} of a wavelength. A real crystal has tens of thousands of layers, so even a slight phase difference cancels the rays completely.`}</p>`, `<dl class="stats"><dt>多走的路</dt><dd>2d sinθ = ${pd.toFixed(4)} nm</dd><dt>等於幾個波長</dt><dd>${ratio.toFixed(3)} λ</dd></dl>
        <p>${ok ? `<span class="pill ok">同相：亮點（n = ${n}）</span>　多走的路剛好是 ${n} 個波長，波峰對波峰。` : `<span class="pill bad">不同相：互相削弱</span>　差了 ${Math.abs(ratio - n).toFixed(2)} 個波長。真實晶體有上萬層，只要稍微不同相就會完全抵消。`}</p>`);
      $('#br-th-v').textContent = t.toFixed(1) + '°'; $('#br-d-v').textContent = d.toFixed(3) + ' nm'; $('#br-l-v').textContent = l.toFixed(3) + ' nm';
    }
    draw = canvas2d($('#br-cv'), paint);
    [th, dd, ll].forEach(e => e.addEventListener('input', draw));
    $('#br-next').addEventListener('click', () => {
      const { t, d, l } = state(); const r = 2 * d * Math.sin(t * D2R) / l; let n = Math.floor(r + 0.03) + 1;
      if (n * l / (2 * d) > Math.sin(85 * D2R)) n = 1;
      th.value = (Math.asin(Math.min(1, n * l / (2 * d))) / D2R).toFixed(1); draw();
    });
    $('#br-cu').addEventListener('click', () => { dd.value = (0.3615 / S3).toFixed(3); ll.value = 0.154; th.value = (Math.asin(0.154 / (2 * 0.3615 / S3)) / D2R).toFixed(1); draw(); });
    return () => draw();
  }

  /* =====================================================================
     09-4 Diffractometer scan (copper powder, Cu Kα)
     ===================================================================== */
  function secScan() {
    const sl = $('#df-tt'), out = $('#df-out'), LAM = 0.15406, T0 = 30, T1 = 125;
    const P = peaks('FCC', 0.3615, LAM).filter(p => p.ok.length && p.tt < T1);
    const inten = t => P.reduce((s, p) => s + p.I * Math.exp(-(((t - p.tt) / 0.45) ** 2)), 0);
    const name = p => p.ok.map(f => '(' + f.join('') + ')').join(' ');
    let draw, raf = 0;
    function paint(x, W, H) {
      const tt = +sl.value, th = tt / 2 * D2R, t2 = tt * D2R, hit = P.find(p => Math.abs(p.tt - tt) < 0.36), I = inten(tt), lit = I > 2;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const gH = Math.round(H * 0.57), cx = W / 2, cy = gH - 52, R = Math.min(W * 0.4, gH - 98);
      // the circle the detector rides on, and the straight-through direction
      x.strokeStyle = T.grid; x.lineWidth = 1; x.beginPath(); x.arc(cx, cy, R, Math.PI, 2 * Math.PI); x.stroke();
      x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      for (let a = 0; a <= 180; a += 10) { const c = Math.cos(a * D2R), s = Math.sin(a * D2R), big = a % 30 === 0; x.beginPath(); x.moveTo(cx + R * c, cy - R * s); x.lineTo(cx + (R + (big ? 7 : 4)) * c, cy - (R + (big ? 7 : 4)) * s); x.stroke(); if (big && a > 0 && a < 180) x.fillText(String(a), cx + (R - 13) * c, cy - (R - 13) * s + 4); }
      x.save(); x.setLineDash([4, 4]); x.strokeStyle = T.muted; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + R, cy); x.stroke(); x.restore();
      // incident beam and tube
      x.strokeStyle = T.accent; x.lineWidth = 2; x.beginPath(); x.moveTo(cx - R, cy); x.lineTo(cx, cy); x.stroke();
      x.fillStyle = T.accent; x.fillRect(cx - R - 8, cy - 8, 16, 16);
      // sample: its surface is tilted by θ, its body lies on the side away from the tube and the detector
      const ux = Math.cos(th), uy = -Math.sin(th), nx = Math.sin(th), ny = Math.cos(th), hl = 38, tk = 13;
      x.beginPath(); x.moveTo(cx - ux * hl, cy - uy * hl); x.lineTo(cx + ux * hl, cy + uy * hl); x.lineTo(cx + ux * hl + nx * tk, cy + uy * hl + ny * tk); x.lineTo(cx - ux * hl + nx * tk, cy - uy * hl + ny * tk); x.closePath();
      x.fillStyle = T.surface; x.fill(); x.strokeStyle = T.ink; x.lineWidth = 1.4; x.stroke();
      x.strokeStyle = T.muted; x.lineWidth = 1; [4.5, 9].forEach(o => { x.beginPath(); x.moveTo(cx - ux * hl + nx * o, cy - uy * hl + ny * o); x.lineTo(cx + ux * hl + nx * o, cy + uy * hl + ny * o); x.stroke(); });
      // diffracted ray and detector
      const dx = cx + R * Math.cos(t2), dy = cy - R * Math.sin(t2);
      x.save(); if (lit) { x.strokeStyle = T.ok; x.lineWidth = 1.5 + I / 100 * 3.5; } else { x.strokeStyle = T.muted; x.lineWidth = 1; x.setLineDash([2, 5]); }
      x.beginPath(); x.moveTo(cx, cy); x.lineTo(dx, dy); x.stroke(); x.restore();
      x.fillStyle = lit ? T.ok : T.muted; x.beginPath(); x.arc(dx, dy, 9, 0, 7); x.fill();
      // angles
      x.strokeStyle = T.ink; x.lineWidth = 1.3; x.beginPath(); x.arc(cx, cy, 54, -t2, 0); x.stroke();
      x.beginPath(); x.arc(cx, cy, 30, Math.PI - th, Math.PI); x.stroke();
      x.fillStyle = T.ink; x.font = FONT(700, 14); x.textAlign = 'center';
      x.fillText('2θ', cx + 72 * Math.cos(t2 * 0.24), cy - 72 * Math.sin(t2 * 0.24) + 5);
      x.fillText('θ', cx - 44 * Math.cos(th / 2), cy + 44 * Math.sin(th / 2) + 5);
      x.fillStyle = T.muted; x.font = FONT(500, 12);
      x.fillText(tx('Detector', '偵測器'), Math.max(34, Math.min(W - 34, dx)), dy - 16);
      x.textAlign = 'left'; x.fillText(tx('X-ray tube', 'X 光管'), Math.max(8, cx - R - 8), cy + 26); x.fillText(tx('Sample', '樣品'), cx + 30, cy + 34);
      // the pattern recorded so far
      x.strokeStyle = T.line; x.lineWidth = 1; x.beginPath(); x.moveTo(0, gH + 0.5); x.lineTo(W, gH + 0.5); x.stroke();
      const ml = 16, mr = 16, pt = gH + 46, pb = H - 38, X = t => ml + (t - T0) / (T1 - T0) * (W - ml - mr), Y = v => pb - v / 100 * (pb - pt);
      x.font = MFONT(400, 11); x.textAlign = 'center';
      for (let t = 40; t <= 120; t += 20) { x.strokeStyle = T.grid; x.beginPath(); x.moveTo(X(t), pt - 8); x.lineTo(X(t), pb); x.stroke(); x.fillStyle = T.muted; x.fillText(String(t), X(t), pb + 15); }
      x.fillStyle = T.muted; x.font = FONT(500, 12); x.fillText(tx('2θ (degrees)', '2θ（度）'), W / 2, H - 7);
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, pb); x.lineTo(W - mr, pb); x.stroke();
      x.strokeStyle = T.accent; x.lineWidth = 1.8; x.beginPath();
      for (let t = T0; t <= tt + 1e-9; t += 0.15) { const yy = Y(Math.min(inten(t), 100)); t === T0 ? x.moveTo(X(t), yy) : x.lineTo(X(t), yy); }
      x.lineTo(X(tt), Y(Math.min(I, 100))); x.stroke();
      P.filter(p => p.tt <= tt + 0.05).forEach(p => { x.save(); x.translate(X(p.tt) + 4, Y(p.I) - 6); x.rotate(-Math.PI / 2); x.textAlign = 'left'; x.fillStyle = T.ink; x.font = MFONT(600, 11); x.fillText(p.ok.map(f => f.join('')).join('/'), 0, 0); x.restore(); });
      x.strokeStyle = T.hi; x.lineWidth = 1.5; x.beginPath(); x.moveTo(X(tt), gH + 10); x.lineTo(X(tt), pb); x.stroke();
      x.textAlign = 'left';
      const d = LAM / (2 * Math.sin(th));
      out.innerHTML = tx(`<dl class="stats"><dt>Detector angle 2θ</dt><dd>${tt.toFixed(1)}°</dd><dt>Beam to sample surface θ</dt><dd>${(tt / 2).toFixed(2)}°</dd><dt>Spacing that fits Bragg's law here</dt><dd>λ ÷ 2 sinθ = ${d.toFixed(4)} nm</dd></dl><p>${hit ? `<span class="pill ok">Peak ${name(hit)}</span> Copper has planes with exactly this spacing: ${name(hit)}, d = ${hit.d.toFixed(4)} nm. The grains that hold these planes at θ to the beam send X-rays into the detector.` : '<span class="pill bad">Background only</span> No set of planes in copper has this spacing. The scattered waves cancel and the detector counts almost nothing.'}</p><p class="note">Sample: copper powder (FCC, a = 0.3615 nm). X-rays: Cu Kα, λ = 0.1541 nm.</p>`, `<dl class="stats"><dt>偵測器角度 2θ</dt><dd>${tt.toFixed(1)}°</dd><dt>入射光與樣品表面夾角 θ</dt><dd>${(tt / 2).toFixed(2)}°</dd><dt>這個角度符合布拉格定律的間距</dt><dd>λ ÷ 2 sinθ = ${d.toFixed(4)} nm</dd></dl><p>${hit ? `<span class="pill ok">繞射峰 ${name(hit)}</span>　銅剛好有這個間距的晶面：${name(hit)}，d = ${hit.d.toFixed(4)} nm。晶面恰好和入射光夾 θ 角的那些晶粒，把 X 光送進偵測器。` : '<span class="pill bad">只有背景</span>　銅沒有任何一組晶面是這個間距。散射波互相抵銷，偵測器幾乎數不到東西。'}</p><p class="note">樣品：銅粉末（FCC，a = 0.3615 nm）。X 光：Cu Kα，λ = 0.1541 nm。</p>`);
      $('#df-v').textContent = tt.toFixed(1) + '°';
    }
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    draw = canvas2d($('#df-cv'), paint);
    sl.addEventListener('input', () => { stop(); draw(); });
    $('#df-scan').addEventListener('click', () => {
      if (raf) { stop(); return; }
      if (REDUCED) { sl.value = T1; draw(); return; }
      const t0 = performance.now();
      const step = now => { const u = Math.min(1, (now - t0) / 9000); sl.value = (T0 + (T1 - T0) * u).toFixed(1); draw(); raf = u < 1 ? requestAnimationFrame(step) : 0; };
      raf = requestAnimationFrame(step);
    });
    $('#df-next').addEventListener('click', () => { stop(); const p = P.find(q => q.tt > +sl.value + 0.4) || P[0]; sl.value = p.tt.toFixed(1); draw(); });
    return () => draw();
  }

  /* =====================================================================
     09-5 Structure-factor phasors
     ===================================================================== */
  function secPhasor() {
    const st = { s: 'BCC' }, out = $('#ph-out'), ins = ['#ph-h', '#ph-k', '#ph-l'];
    let draw;
    const pre = [[1, 0, 0], [1, 1, 0], [1, 1, 1], [2, 0, 0], [2, 2, 0], [2, 2, 2]];
    $('#ph-pre').innerHTML = pre.map(d => `<button type="button" data-v="${d.join(',')}">${idxHTML(d, '()')}</button>`).join('');
    function atomsOf(s) {
      const b = BASIS[s]; return b.map((p, i) => ({ p, c: s === 'DIA' ? (i < 4 ? COL.corner : COL.body) : (i === 0 ? COL.corner : s === 'BCC' ? COL.body : COL.face) }));
    }
    const lagTxt = t => (t < EPS ? tx('in step', '同步') : tx(`${fracStr(t)} λ behind`, `慢 ${fracStr(t)} 個波長`));
    function paint(x, W, H) {
      const hkl = ins.map(s => intIn($(s), 0, 6)), [h, k, l] = hkl;
      const at = atomsOf(st.s), n = at.length;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      if (!h && !k && !l) { out.innerHTML = tx('<p class="warn">h, k and l cannot all be 0.</p>', '<p class="warn">h、k、l 不能同時為 0。</p>'); return; }
      // lag of each atom's wave in wavelengths; only the fractional part matters
      const lag = at.map(({ p }) => h * p[0] + k * p[1] + l * p[2]), turn = lag.map(frac), ph = turn.map(t => 2 * Math.PI * t);
      let sx = 0, sy = 0; ph.forEach(a => { sx += Math.cos(a); sy += Math.sin(a); });
      const F = Math.hypot(sx, sy) < 1e-9 ? 0 : Math.hypot(sx, sy), on = F > 1e-6;
      const groups = [];
      turn.forEach((t, i) => { let g = groups.find(q => Math.abs(q.t - t) < 1e-6); if (!g) groups.push(g = { t, cols: [] }); g.cols.push(at[i].c); });
      groups.sort((p, q) => p.t - q.t);

      const side = W >= 520, wW = side ? Math.round(W * 0.56) : W, wH = side ? H : Math.round(H * 0.54);
      const aX = side ? wW : 0, aY = side ? 0 : wH, aW = W - aX, aH = H - aY;
      x.strokeStyle = T.line; x.lineWidth = 1; x.beginPath(); if (side) { x.moveTo(wW + 0.5, 0); x.lineTo(wW + 0.5, H); } else { x.moveTo(0, wH + 0.5); x.lineTo(W, wH + 0.5); } x.stroke();
      x.fillStyle = T.muted; x.font = MFONT(500, 11); x.textAlign = 'left';
      x.fillText(tx('1  WAVE FROM EACH ATOM', '1  各原子的散射波'), 12, 20); x.fillText(tx('2  THE SAME WAVES AS ARROWS', '2  同樣的波畫成箭頭'), aX + 12, aY + 20);

      // panel 1: one row per distinct lag, then the sum
      const rows = groups.length + 1, top = 32, rh = (wH - top - 8) / rows, x0 = 118, x1 = wW - 14, per = Math.max(60, (x1 - x0) / 2.6);
      const unit = rh * 0.36 / Math.max(F, ...groups.map(g => g.cols.length));
      x.save(); x.setLineDash([3, 4]); x.strokeStyle = T.grid; x.lineWidth = 1;
      for (let px = x0; px <= x1; px += per) { x.beginPath(); x.moveTo(px, top); x.lineTo(px, wH - 8); x.stroke(); }
      x.restore();
      const wave = (yc, a, t, col, lw) => { x.strokeStyle = col; x.lineWidth = lw; x.beginPath(); for (let px = x0; px <= x1; px += 2) { const yy = yc - a * Math.cos(2 * Math.PI * ((px - x0) / per - t)); px === x0 ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); };
      groups.forEach((g, i) => {
        const yc = top + rh * (i + 0.5);
        g.cols.forEach((c, j) => { x.fillStyle = c; x.beginPath(); x.arc(17 + j * 11, yc - 9, 4.2, 0, 7); x.fill(); });
        x.fillStyle = T.muted; x.font = FONT(500, 12); x.fillText(lagTxt(g.t), 12, yc + 11);
        wave(yc, unit * g.cols.length, g.t, T.accent, 1.6);
      });
      const ys = top + rh * (rows - 0.5), tot = Math.atan2(sy, sx) / (2 * Math.PI);
      x.strokeStyle = T.line; x.beginPath(); x.moveTo(12, ys - rh / 2); x.lineTo(wW - 12, ys - rh / 2); x.stroke();
      x.fillStyle = T.ink; x.font = FONT(700, 12); x.fillText(tx('All added', '全部相加'), 12, ys - 3);
      x.fillStyle = on ? T.ok : T.bad; x.font = FONT(500, 12); x.fillText(on ? tx('peak', '有峰') : tx('nothing left', '完全抵銷'), 12, ys + 14);
      wave(ys, unit * F, tot, on ? T.ok : T.bad, 2.6);

      // panel 2: arrows joined head to tail
      let ux = 0, uy = 0, bx0 = 0, bx1 = 0, by0 = 0, by1 = 0;
      ph.forEach(a => { ux += Math.cos(a); uy += Math.sin(a); bx0 = Math.min(bx0, ux); bx1 = Math.max(bx1, ux); by0 = Math.min(by0, uy); by1 = Math.max(by1, uy); });
      const padX = 38, padT = 46, padB = 30, Lu = Math.min(62, (aW - 2 * padX) / Math.max(bx1 - bx0, 0.001), (aH - padT - padB) / Math.max(by1 - by0, 0.001));
      const cx = aX + aW / 2 - (bx0 + bx1) / 2 * Lu, cy = aY + (padT + aH - padB) / 2 + (by0 + by1) / 2 * Lu;
      x.save(); x.beginPath(); x.rect(aX + 1, aY + 1, aW - 1, aH - 1); x.clip();
      x.strokeStyle = T.grid; x.lineWidth = 1; x.beginPath(); x.moveTo(aX, cy); x.lineTo(aX + aW, cy); x.moveTo(cx, aY + 28); x.lineTo(cx, aY + aH); x.stroke();
      x.fillStyle = T.muted; x.font = MFONT(500, 11); x.textAlign = 'right'; x.fillText('0°', aX + aW - 8, cy - 6); x.textAlign = 'left'; x.fillText('180°', aX + 8, cy - 6); x.fillText('90°', cx + 6, aY + 40);
      let px = cx, py = cy;
      const off = {}; // arrows that retrace the same line are nudged apart so both stay visible
      at.forEach(({ c }, i) => {
        const dx = Math.cos(ph[i]), dy = Math.sin(ph[i]), nx = px + dx * Lu, ny = py - dy * Lu, fwd = nx > px + 0.5 || (Math.abs(nx - px) <= 0.5 && ny > py);
        const key = (fwd ? [px, py, nx, ny] : [nx, ny, px, py]).map(Math.round).join(), o = (off[key] = (off[key] || 0) + 1) - 1;
        const sh = 6 * Math.ceil(o / 2) * (o % 2 ? 1 : -1) * (fwd ? 1 : -1);
        arrow2(x, px + dy * sh, py + dx * sh, nx + dy * sh, ny + dx * sh, c, 2.4); px = nx; py = ny;
      });
      if (on) { arrow2(x, cx, cy, cx + sx * Lu, cy - sy * Lu, T.hi, 3.6); x.fillStyle = T.hi; x.font = MFONT(600, 13); x.fillText('F', cx + sx * Lu / 2 - 4, cy - sy * Lu / 2 + 20); }
      x.fillStyle = T.ink; x.beginPath(); x.arc(cx, cy, 3.5, 0, 7); x.fill();
      if (!on) { x.fillStyle = T.bad; x.font = FONT(500, 12); x.textAlign = 'center'; x.fillText(tx('back at the start: F = 0', '回到起點：F = 0'), aX + aW / 2, aY + aH - 12); x.textAlign = 'left'; }
      x.restore();

      const term = (m, c) => (m && c ? `${m}·${fracStr(c)}` : null);
      const lines = at.map(({ p, c }, i) => {
        const ts = [term(h, p[0]), term(k, p[1]), term(l, p[2])].filter(Boolean), deg = Math.round(turn[i] * 360);
        return `<tr><td><i style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${c}"></i>(${p.map(fracStr).join(', ')})</td><td>${ts.length ? ts.join(' + ') + ' = ' : ''}${fracStr(lag[i])}</td><td>${deg}°</td></tr>`;
      }).join('');
      const ix = idxHTML(hkl);
      let why;
      if (groups.length === 1) why = tx(`All ${n > 1 ? n + ' waves are' : 'there is only one wave, so nothing can cancel it. The waves are'} in step, so they add up fully.`, n > 1 ? `${n} 道波全部同步，完整疊加。` : '只有一道波，沒有別的波能抵銷它。');
      else if (!on) why = tx('The waves are spread evenly around one wavelength, so crests fill troughs and nothing is left.', '這些波平均錯開在一個波長裡，波峰剛好填滿波谷，什麼都不剩。');
      else why = tx('The waves are not all in step, but they do not cancel completely either.', '這些波沒有全部同步，但也沒有完全抵銷。');
      out.innerHTML = tx(`<p>${on ? '<span class="pill ok">Peak present</span>' : '<span class="pill bad">Extinct</span>'} ${ix}: ${why}</p>
        <dl class="stats"><dt>Total arrow |F|</dt><dd>${fmt(F, 3)} f</dd><dt>Intensity ∝ |F|²</dt><dd>${fmt(F * F, 1)} f²</dd></dl>
        <div style="overflow-x:auto"><table><thead><tr><th>Atom at</th><th>hx + ky + lz</th><th>Angle</th></tr></thead><tbody class="mono">${lines}</tbody></table></div>
        <p class="note">hx + ky + lz is how many wavelengths the wave of that atom lags. Whole wavelengths change nothing, so only the fraction left over sets the angle: one wavelength is 360°.</p>`, `<p>${on ? '<span class="pill ok">有繞射峰</span>' : '<span class="pill bad">消光</span>'}　${ix}：${why}</p>
        <dl class="stats"><dt>總和箭頭 |F|</dt><dd>${fmt(F, 3)} f</dd><dt>強度 ∝ |F|²</dt><dd>${fmt(F * F, 1)} f²</dd></dl>
        <div style="overflow-x:auto"><table><thead><tr><th>原子位置</th><th>hx + ky + lz</th><th>角度</th></tr></thead><tbody class="mono">${lines}</tbody></table></div>
        <p class="note">hx + ky + lz 是這個原子的波慢了幾個波長。整數個波長等於沒差，只有剩下的小數部分決定角度：一個波長對應 360°。</p>`);
    }
    function arrow2(x, x0, y0, x1, y1, col, w) {
      const a = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0), hl = Math.min(11, L * 0.4);
      x.strokeStyle = col; x.fillStyle = col; x.lineWidth = w; x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1 - Math.cos(a) * hl * 0.8, y1 - Math.sin(a) * hl * 0.8); x.stroke();
      x.beginPath(); x.moveTo(x1, y1); x.lineTo(x1 - hl * Math.cos(a - 0.4), y1 - hl * Math.sin(a - 0.4)); x.lineTo(x1 - hl * Math.cos(a + 0.4), y1 - hl * Math.sin(a + 0.4)); x.closePath(); x.fill();
    }
    draw = canvas2d($('#ph-cv'), paint);
    seg($('#ph-s'), x => { st.s = x; draw(); });
    ins.forEach(s => $(s).addEventListener('input', draw));
    $('#ph-pre').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const a = b.dataset.v.split(',').map(Number); ins.forEach((s, i) => ($(s).value = a[i])); draw(); });
    return () => draw();
  }

  /* =====================================================================
     09-6 Powder XRD simulator
     ===================================================================== */
  let XMAT; dataset(() => { XMAT = [
    { k: 'w', n: tx('Tungsten W (BCC, a = 0.3165 nm)', '鎢 W（BCC，a = 0.3165 nm）'), s: 'BCC', a: 0.3165 },
    { k: 'fe', n: tx('Iron Fe (BCC, a = 0.2866 nm)', '鐵 Fe（BCC，a = 0.2866 nm）'), s: 'BCC', a: 0.2866 },
    { k: 'au', n: tx('Gold Au (FCC, a = 0.4078 nm)', '金 Au（FCC，a = 0.4078 nm）'), s: 'FCC', a: 0.4078 },
    { k: 'cu', n: tx('Copper Cu (FCC, a = 0.3615 nm)', '銅 Cu（FCC，a = 0.3615 nm）'), s: 'FCC', a: 0.3615 },
    { k: 'al', n: tx('Aluminum Al (FCC, a = 0.4049 nm)', '鋁 Al（FCC，a = 0.4049 nm）'), s: 'FCC', a: 0.4049 },
    { k: 'si', n: tx('Silicon Si (diamond, a = 0.5431 nm)', '矽 Si（鑽石，a = 0.5431 nm）'), s: 'DIA', a: 0.5431 },
    { k: 'po', n: tx('Polonium α-Po (SC, a = 0.3359 nm)', '釙 α-Po（SC，a = 0.3359 nm）'), s: 'SC', a: 0.3359 }
  ]; });
  let TUBE; dataset(() => { TUBE = [{ k: 'cu', n: tx('Cu Kα (λ = 0.15406 nm)', 'Cu Kα（λ = 0.15406 nm）'), l: 0.15406 }, { k: 'co', n: tx('Co Kα (λ = 0.17890 nm)', 'Co Kα（λ = 0.17890 nm）'), l: 0.17890 }, { k: 'mo', n: tx('Mo Kα (λ = 0.07093 nm)', 'Mo Kα（λ = 0.07093 nm）'), l: 0.07093 }]; });
  function F2of(s, h, k, l) {
    const allOdd = h % 2 && k % 2 && l % 2, allEven = !(h % 2) && !(k % 2) && !(l % 2);
    if (s === 'SC') return 1;
    if (s === 'BCC') return (h + k + l) % 2 === 0 ? 4 : 0;
    if (s === 'FCC') return allOdd || allEven ? 16 : 0;
    if (allOdd) return 32; if (allEven) return (h + k + l) % 4 === 0 ? 64 : 0; return 0;
  }
  function peaks(s, a, lam) {
    const byN = new Map();
    for (let h = 0; h <= 9; h++) for (let k = 0; k <= h; k++) for (let l = 0; l <= k; l++) {
      if (!h) continue; const N = h * h + k * k + l * l, sn = lam * Math.sqrt(N) / (2 * a); if (sn > 1) continue;
      if (!byN.has(N)) byN.set(N, []); byN.get(N).push([h, k, l]);
    }
    const res = [];
    [...byN.keys()].sort((p, q) => p - q).forEach(N => {
      const fams = byN.get(N), sn = lam * Math.sqrt(N) / (2 * a), th = Math.asin(sn), tt = 2 * th / D2R;
      const sA = sn / (lam * 10), LP = (1 + Math.cos(2 * th) ** 2) / (sn * sn * Math.cos(th)), att = Math.exp(-6 * sA * sA);
      let I = 0; const ok = [];
      fams.forEach(f => { const F2 = F2of(s, ...f); if (F2 > 0) { I += famCount(f) * F2 * LP * att; ok.push(f); } });
      res.push({ N, fams, ok, tt, d: a / Math.sqrt(N), s2: sn * sn, I });
    });
    const max = Math.max(...res.map(r => r.I)); res.forEach(r => (r.I = r.I / max * 100));
    return res;
  }
  function secXRD() {
    const mat = $('#xr-mat'), tube = $('#xr-tube'), ghost = $('#xr-ghost'), tip = $('#xr-tip'), tbl = $('#xr-table');
    mat.innerHTML = XMAT.map(m => `<option value="${m.k}">${m.n}</option>`).join('');
    tube.innerHTML = TUBE.map(m => `<option value="${m.k}">${m.n}</option>`).join('');
    const idxS = f => f.join('');
    let draw;
    function paint(x, W, H) {
      const M = XMAT.find(m => m.k === mat.value), Tb = TUBE.find(t => t.k === tube.value);
      const P = peaks(M.s, M.a, Tb.l), allowed = P.filter(p => p.ok.length);
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 44, mr = 14, mt = 46, mb = 36, x0 = 10, x1 = 160;
      const X = t => ml + (t - x0) / (x1 - x0) * (W - ml - mr), Y = i => H - mb - i / 100 * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 11); x.fillStyle = T.muted; x.textAlign = 'center';
      for (let t = 20; t <= 160; t += 20) { x.beginPath(); x.moveTo(X(t), mt - 6); x.lineTo(X(t), H - mb); x.stroke(); x.fillText(String(t), X(t), H - mb + 16); }
      x.fillText(tx('2θ (degrees)', '2θ（度）'), (ml + W - mr) / 2, H - 4);
      x.textAlign = 'right'; [0, 50, 100].forEach(i => { x.fillText(String(i), ml - 8, Y(i) + 4); });
      x.save(); x.translate(12, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.fillText(tx('Relative intensity', '相對強度'), 0, 0); x.restore();
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, H - mb); x.lineTo(W - mr, H - mb); x.stroke();
      if (ghost.checked) { x.setLineDash([3, 4]); x.strokeStyle = T.ghost3d; x.lineWidth = 1.2; P.filter(p => !p.ok.length && p.tt >= x0 && p.tt <= x1).forEach(p => { x.beginPath(); x.moveTo(X(p.tt), H - mb); x.lineTo(X(p.tt), Y(30)); x.stroke(); }); x.setLineDash([]); }
      x.strokeStyle = T.accent; x.lineWidth = 2.6;
      allowed.filter(p => p.tt >= x0 && p.tt <= x1).forEach(p => {
        x.beginPath(); x.moveTo(X(p.tt), H - mb); x.lineTo(X(p.tt), Y(Math.max(p.I, 1.5))); x.stroke();
        x.save(); x.translate(X(p.tt) + 4, Y(Math.max(p.I, 1.5)) - 6); x.rotate(-Math.PI / 2); x.textAlign = 'left'; x.fillStyle = T.ink; x.font = MFONT(600, 11);
        x.fillText(p.ok.map(idxS).join('/'), 0, 0); x.restore();
      });
      const s1 = allowed[0] ? allowed[0].s2 : 1;
      tbl.innerHTML = tx(`<table><thead><tr><th>#</th><th>(hkl)</th><th>h²+k²+l²</th><th>d (nm)</th><th>2θ (°)</th><th>sin²θ ÷ 1st peak</th><th>Intensity (schematic)</th></tr></thead><tbody>${allowed.map((p, i) => `<tr><td class="num">${i + 1}</td><td class="num">${p.ok.map(f => '(' + idxS(f) + ')').join(' ')}</td><td class="num">${p.N}</td><td class="num">${p.d.toFixed(4)}</td><td class="num">${p.tt.toFixed(2)}</td><td class="num">${(p.s2 / s1).toFixed(3)}</td><td class="num">${p.I.toFixed(0)}</td></tr>`).join('')}</tbody></table>`, `<table><thead><tr><th>#</th><th>(hkl)</th><th>h²+k²+l²</th><th>d（nm）</th><th>2θ（°）</th><th>sin²θ ÷ 第 1 峰</th><th>示意強度</th></tr></thead><tbody>${allowed.map((p, i) => `<tr><td class="num">${i + 1}</td><td class="num">${p.ok.map(f => '(' + idxS(f) + ')').join(' ')}</td><td class="num">${p.N}</td><td class="num">${p.d.toFixed(4)}</td><td class="num">${p.tt.toFixed(2)}</td><td class="num">${(p.s2 / s1).toFixed(3)}</td><td class="num">${p.I.toFixed(0)}</td></tr>`).join('')}</tbody></table>`);
      const rat = allowed.slice(0, 7).map(p => (p.s2 / s1).toFixed(2)).join(' : ');
      const guess = { SC: tx('The ratios are 1 : 2 : 3 : 4 : 5 : 6 : 8 and skip 7 (no three squares of integers add up to 7) → simple cubic', '比值是 1 : 2 : 3 : 4 : 5 : 6 : 8，跳過 7（沒有整數能寫成三個平方和等於 7）→ 簡單立方'), BCC: tx('The ratios are 1 : 2 : 3 : 4 : 5 : 6 : 7, with 7 included → BCC (the real h²+k²+l² = 2, 4, 6…, all divided by 2)', '比值是 1 : 2 : 3 : 4 : 5 : 6 : 7，連 7 都有 → BCC（實際 h²+k²+l² = 2, 4, 6…，全部除以 2）'), FCC: tx('The ratios are 1 : 1.33 : 2.67 : 3.67 : 4 → FCC (h²+k²+l² = 3, 4, 8, 11, 12)', '比值是 1 : 1.33 : 2.67 : 3.67 : 4 → FCC（h²+k²+l² = 3, 4, 8, 11, 12）'), DIA: tx('The ratios are 1 : 2.67 : 3.67 : 5.33 → diamond structure (FCC peaks such as 4 and 12 are missing as well)', '比值是 1 : 2.67 : 3.67 : 5.33 → 鑽石結構（FCC 的 4、12 等峰也消失了）') }[M.s];
      tip.innerHTML = tx(`<h4>Reading the structure from the peaks</h4><div class="eq">sin²θ ratios: ${rat}</div><p>${guess}</p><p class="note">A different X-ray tube shifts every peak, but the sequence of ratios stays the same.</p>`, `<h4>怎麼從峰判斷結構？</h4><div class="eq">sin²θ 比值：${rat}</div><p>${guess}</p><p class="note">換一支 X 光管，峰的位置會整體移動，但比值序列不變。</p>`);
    }
    draw = canvas2d($('#xr-cv'), paint);
    [mat, tube, ghost].forEach(e => e.addEventListener('change', draw));
    onLang(() => { [...mat.options].forEach((o, i) => { o.textContent = XMAT[i].n; }); [...tube.options].forEach((o, i) => { o.textContent = TUBE[i].n; }); });
    return () => draw();
  }

  /* =====================================================================
     09-8 Peak width against crystal size (Si 111, Cu Kα, Scherrer formula)
     ===================================================================== */
  function secSize() {
    const sl = $('#sz-l'), out = $('#sz-out'), LAM = 0.15406, D = 0.5431 / S3, TH = Math.asin(LAM / (2 * D)), TT = 2 * TH / D2R;
    let draw;
    function paint(x, W, H) {
      const L = +(10 ** +sl.value).toPrecision(2), B = 0.9 * LAM / (L * Math.cos(TH)) / D2R, sg = B / 2.3548, pk = Math.min(1, 0.3 / B);
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 16, mr = 16, mt = 34, mb = 40, T0 = TT - 2.5, T1 = TT + 2.5, X = t => ml + (t - T0) / (T1 - T0) * (W - ml - mr), Y = v => H - mb - v * (H - mt - mb);
      x.lineWidth = 1; x.font = MFONT(400, 11); x.textAlign = 'center';
      for (let t = Math.ceil(T0); t <= T1; t++) { x.strokeStyle = T.grid; x.beginPath(); x.moveTo(X(t), mt); x.lineTo(X(t), H - mb); x.stroke(); x.fillStyle = T.muted; x.fillText(String(t), X(t), H - mb + 16); }
      x.fillStyle = T.muted; x.font = FONT(500, 12); x.fillText(tx('2θ (degrees)', '2θ（度）'), W / 2, H - 7);
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, H - mb); x.lineTo(W - mr, H - mb); x.stroke();
      const f = t => pk * Math.exp(-0.5 * ((t - TT) / sg) ** 2), pts = [];
      for (let px = ml; px <= W - mr; px += 1) pts.push([px, Y(f(T0 + (px - ml) / (W - ml - mr) * (T1 - T0)))]);
      x.beginPath(); x.moveTo(ml, Y(0)); pts.forEach(p => x.lineTo(p[0], p[1])); x.lineTo(W - mr, Y(0)); x.closePath(); x.globalAlpha = 0.12; x.fillStyle = T.accent; x.fill(); x.globalAlpha = 1;
      x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.strokeStyle = T.accent; x.lineWidth = 2; x.stroke();
      x.save(); x.setLineDash([4, 4]); x.strokeStyle = T.hi; x.lineWidth = 1.4; x.beginPath(); x.moveTo(X(TT), Y(0)); x.lineTo(X(TT), mt - 6); x.stroke(); x.restore();
      x.fillStyle = T.hi; x.font = FONT(500, 12); x.textAlign = 'left'; x.fillText(tx('bulk silicon (111)', '塊材矽 (111)'), X(TT) + 7, mt - 12);
      const a = Math.max(X(TT - B / 2), ml), b = Math.min(X(TT + B / 2), W - mr), yh = Y(pk / 2);
      x.strokeStyle = T.ink; x.lineWidth = 1.3; x.beginPath(); x.moveTo(a, yh); x.lineTo(b, yh); x.moveTo(a, yh - 4); x.lineTo(a, yh + 4); x.moveTo(b, yh - 4); x.lineTo(b, yh + 4); x.stroke();
      x.fillStyle = T.ink; x.font = MFONT(600, 12); x.fillText('B', b + 6, yh + 4);
      const few = L < 20;
      out.innerHTML = tx(`<dl class="stats"><dt>Crystal size L</dt><dd>${L} nm</dd><dt>(111) layers in one crystal</dt><dd>about ${Math.round(L / D)}</dd><dt>Peak width B</dt><dd>0.9 λ ÷ (L cosθ) = ${B.toFixed(2)}°</dd></dl><p>${few ? 'Few layers. Off the Bragg angle the waves cannot cancel completely, so the peak spreads out.' : 'Many layers. Off the Bragg angle the waves cancel almost completely, so the peak is sharp.'}</p><p class="note">The width here follows the Scherrer formula, which goes beyond the lecture. A real instrument adds some width of its own. A shift of the peak is a separate effect: it means the spacing d, and so the lattice constant, has changed.</p>`, `<dl class="stats"><dt>晶粒大小 L</dt><dd>${L} nm</dd><dt>一顆晶粒裡的 (111) 層數</dt><dd>約 ${Math.round(L / D)} 層</dd><dt>峰寬 B</dt><dd>0.9 λ ÷ (L cosθ) = ${B.toFixed(2)}°</dd></dl><p>${few ? '層數少。偏離布拉格角時，散射波抵銷不完全，峰就攤開了。' : '層數多。偏離布拉格角時，散射波幾乎完全抵銷，峰很尖。'}</p><p class="note">這裡的峰寬用謝樂公式（Scherrer formula）計算，已經超出講義範圍。真實儀器本身也會貢獻一些寬度。峰的位置偏移是另一回事：代表面間距 d 變了，也就是晶格常數變了。</p>`);
      $('#sz-v').textContent = L + ' nm';
    }
    draw = canvas2d($('#sz-cv'), paint);
    sl.addEventListener('input', draw);
    return () => draw();
  }

  /* =====================================================================
     10 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('How many atoms are there in one body-centered cubic (BCC) unit cell?', '體心立方（BCC）的一個單位晶胞裡，總共有幾個原子？'), o: [tx('1 atom', '1 個'), tx('2 atoms', '2 個'), tx('4 atoms', '4 個'), tx('9 atoms', '9 個')], a: 1, e: tx('Each of the 8 corners counts 1/8, which makes 1. Add the 1 atom at the body center and there are 2 in all. You see 9 spheres because the corner atoms are shared with the neighboring cells.', '8 個角落各算 1/8，合計 1 個；加上體心 1 個，共 2 個。看到 9 顆球是因為角落原子和隔壁晶胞共用。') },
    { q: tx('Which two structures have the highest atomic packing factor (APF)?', '下列哪兩種結構的原子堆積因子（APF）最高？'), o: [tx('SC and BCC', 'SC 與 BCC'), tx('BCC and FCC', 'BCC 與 FCC'), tx('FCC and HCP', 'FCC 與 HCP'), tx('SC and HCP', 'SC 與 HCP')], a: 2, e: tx('FCC and HCP are both 0.74. They differ only in the stacking, ABCABC or ABAB.', 'FCC 與 HCP 都是 0.74，差別只在 ABCABC 和 ABAB 的疊法。') },
    { q: tx('In an FCC unit cell, along which line do the atoms touch?', 'FCC 晶胞中，原子沿著哪條線互相接觸？'), o: [tx('The cube edge', '立方體的邊'), tx('The face diagonal', '面對角線'), tx('The body diagonal', '體對角線'), tx('They do not touch', '不會互相接觸')], a: 1, e: tx('A face-center atom touches the four corner atoms of the same face, so √2 a = 4R. Touching along the body diagonal is BCC.', '面心原子和同一面的四個角落原子接觸，所以 √2 a = 4R。BCC 才是沿體對角線。') },
    { q: tx('A plane cuts the x axis at 1 and the y axis at 1/2, and is parallel to the z axis. What are its Miller indices?', '某平面和 x 軸交於 1、y 軸交於 1/2、與 z 軸平行。它的米勒指數是？'), o: ['(1 ½ 0)', '(1 2 0)', '(2 1 0)', '(1 2 ∞)'], a: 1, e: tx('The reciprocals of the intercepts 1, ½, ∞ are 1, 2, 0, so the plane is (120).', '截距 1、½、∞ 取倒數得 1、2、0，所以是 (120)。') },
    { q: tx('In the cubic system, what is the normal direction of the (111) plane?', '立方晶系中，(111) 平面的法線方向是？'), o: ['[100]', '[110]', '[111]', tx('[1̄1̄1̄], unrelated to (111)', '[1̄1̄1̄]，和 (111) 無關')], a: 2, e: tx('In the cubic system the normal to (hkl) is [hkl].', '立方晶系裡 (hkl) 的法線就是 [hkl]。') },
    { q: tx('A cubic crystal has a lattice constant a = 0.40 nm. What is the interplanar spacing of its (200) planes?', '晶格常數 a = 0.40 nm 的立方晶體，(200) 面的面間距是多少？'), o: ['0.40 nm', '0.28 nm', '0.20 nm', '0.10 nm'], a: 2, e: tx('d = a / √(2² + 0 + 0) = 0.40 / 2 = 0.20 nm.', 'd = a / √(2² + 0 + 0) = 0.40 / 2 = 0.20 nm。') },
    { q: tx('In what order do the close-packed planes of HCP stack?', 'HCP 的最密排平面是照什麼順序往上疊？'), o: ['AAAA…', 'ABAB…', 'ABCABC…', 'ABCDABCD…'], a: 1, e: tx('HCP is ABAB. FCC is ABCABC.', 'HCP 是 ABAB；FCC 是 ABCABC。') },
    { q: tx('Cu Kα X-rays (λ = 0.154 nm) hit crystal planes with d = 0.20 nm. About what is θ for first-order (n = 1) diffraction?', '用 Cu Kα（λ = 0.154 nm）照射 d = 0.20 nm 的晶面，第一階（n = 1）繞射的 θ 約是多少？'), o: ['11.1°', '22.6°', '45.2°', '50.4°'], a: 1, e: tx('sinθ = λ / 2d = 0.154 / 0.40 = 0.385, so θ ≈ 22.6°. The horizontal axis of the pattern is 2θ, so the peak shows at about 45.2°.', 'sinθ = λ / 2d = 0.154 / 0.40 = 0.385，θ ≈ 22.6°。圖譜橫軸是 2θ，會在約 45.2° 看到峰。') },
    { q: tx('Why is no (100) diffraction peak measured from a BCC crystal?', 'BCC 晶體為什麼量不到 (100) 繞射峰？'), o: [tx('The X-ray wavelength is not short enough', 'X 光波長不夠短'), tx('The waves scattered by the corner and body-center atoms are 180° out of phase and cancel', '角落與體心原子的散射波相位差 180°，互相抵消'), tx('There are no atoms on the (100) plane', '(100) 面上沒有原子'), tx('BCC has no (100) plane', 'BCC 沒有 (100) 面')], a: 1, e: tx('The body-center atom is at (½,½,½). Its phase is 2π × ½ = π, exactly opposite to the corner atom, so F = f(1 + e^{iπ}) = 0.', '體心原子在 (½,½,½)，相位 2π × ½ = π，與角落原子剛好相反，F = f(1 + e^{iπ}) = 0。') },
    { q: tx('In the XRD pattern of silicon (diamond structure), which of these peaks does not appear?', '矽（鑽石結構）的 XRD 圖譜中，下列哪個峰「不會」出現？'), o: ['(111)', '(220)', '(200)', '(311)'], a: 2, e: tx('(200) is all even, but h + k + l = 2 is not a multiple of 4, so the second FCC lattice of the diamond structure cancels it.', '(200) 全偶但 h + k + l = 2 不是 4 的倍數，被鑽石結構的第二套 FCC 抵消。') }
  ]; });
  function secQuiz() {
    const root = $('#quiz'), sc = $('#quiz-score'); let done = 0, right = 0;
    const verdict = ok => (ok ? tx('<b style="color:var(--ok)">Correct. </b>', '<b style="color:var(--ok)">答對了。</b>') : tx('<b style="color:var(--bad)">Not quite. </b>', '<b style="color:var(--bad)">再想想。</b>'));
    const scoreText = () => { sc.textContent = tx(`Answered ${done} / ${QUIZ.length}, correct ${right}`, `已作答 ${done} / ${QUIZ.length} 題，答對 ${right} 題`); };
    root.innerHTML = QUIZ.map((q, i) => `<div class="q" data-i="${i}"><p class="qt"><span>Q${i + 1}</span>${q.q}</p><div class="opts">${q.o.map((o, j) => `<button type="button" data-j="${j}"><span class="opt-l">${String.fromCharCode(65 + j)}</span><span>${o}</span></button>`).join('')}</div><p class="explain" hidden></p></div>`).join('');
    root.addEventListener('click', e => {
      const b = e.target.closest('.opts button'); if (!b) return; const box = b.closest('.q'), q = QUIZ[+box.dataset.i], j = +b.dataset.j;
      if (box.dataset.done) return; box.dataset.done = '1'; done++; if (j === q.a) right++;
      $$('.opts button', box).forEach((x, k) => { x.disabled = true; if (k === q.a) x.classList.add('right'); else if (k === j) x.classList.add('wrong'); });
      box.dataset.pick = j; const ex = $('.explain', box); ex.hidden = false; ex.innerHTML = verdict(j === q.a) + q.e;
      scoreText();
    });
    onLang(() => {
      $$('.q', root).forEach((box, i) => {
        const q = QUIZ[i];
        $('.qt', box).lastChild.nodeValue = q.q;
        $$('.opts button', box).forEach((x, j) => { x.lastElementChild.textContent = q.o[j]; });
        if (box.dataset.pick) $('.explain', box).innerHTML = verdict(+box.dataset.pick === q.a) + q.e;
      });
      scoreText();
    });
    scoreText();
  }

  /* =====================================================================
     TOC highlight
     ===================================================================== */
  function toc() {
    const links = $$('.toc a'), map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
    const ob = new IntersectionObserver(es => {
      es.forEach(e => { if (e.isIntersecting) { links.forEach(a => a.classList.remove('on')); const a = map.get(e.target.id); if (a) { a.classList.add('on'); const ol = a.closest('ol'); if (a.offsetLeft < ol.scrollLeft || a.offsetLeft + a.offsetWidth > ol.scrollLeft + ol.clientWidth) ol.scrollTo({ left: a.offsetLeft - 16, behavior: REDUCED ? 'auto' : 'smooth' }); } } });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('section.unit').forEach(s => ob.observe(s));
  }

  /* =====================================================================
     Boot
     ===================================================================== */
  const redraw2D = [];
  function boot() {
    if (GL) {
      [heroScene, secLattice, secBravais, secMetal, secStack, secSemi, secMiller, secSpacing, secHex, secDensity3D].forEach(f => { try { f(); } catch (e) { console.error(e); } });
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    secDensity();
    redraw2D.push(secWaves(), secTube(), secBragg(), secScan(), secPhasor(), secXRD(), secSize());
    secQuiz(); toc();
  }
  function onTheme() {
    readTheme(); syncTheme();
    VIEWERS.forEach(v => { if (v.rebuild && !v.init) v.rebuild(); v.dirty = true; });
    redraw2D.forEach(f => f && f());
  }
  /* ---------- language switch: text only, nothing is rebuilt or reset ---------- */
  const ANCHORS = 'header.hero, .unit-head, .unit > h3, .lab, .key, .tbl-wrap, .cards, .flow, .unit > .prose, #quiz .q, footer';
  function syncChrome() {
    const zh = LANG === 'zh';
    document.documentElement.lang = zh ? 'zh-Hant' : 'en';
    document.title = tx('Crystal Structure 3D Classroom', '晶體結構 3D 教室');
    $('#lang-zh').setAttribute('aria-pressed', String(zh)); $('#lang-en').setAttribute('aria-pressed', String(!zh));
  }
  function setLang(lang) {
    if (lang === LANG) return;
    // keep the block nearest the top of the viewport where it is, because the two languages wrap differently
    let anchor = null, off = 0, gap = Infinity;
    if (window.scrollY > 2) $$(ANCHORS).forEach(e => { const t = e.getBoundingClientRect().top, g = Math.abs(t - 80); if (g < gap) { gap = g; anchor = e; off = t; } });
    LANG = lang; X.save(lang);
    syncChrome(); X.apply(lang);
    DATA.forEach(f => f());
    VIEWERS.forEach(v => v.applyLang());
    HOOKS.forEach(f => f());
    redraw2D.forEach(f => f && f());
    if (lang === 'zh' && document.fonts && document.fonts.load) document.fonts.load('500 12px "Noto Sans TC"', '入射光相對強度實部虛部').then(() => redraw2D.forEach(f => f && f()), () => {});
    if (!anchor) return;
    let live = true; const stop = () => { live = false; };
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(t => window.addEventListener(t, stop, { once: true, passive: true }));
    const place = () => { if (live && anchor.isConnected) window.scrollTo({ top: anchor.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); };
    place(); requestAnimationFrame(place); [150, 500, 1200].forEach(ms => setTimeout(place, ms));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  }
  $('#lang-zh').addEventListener('click', () => setLang('zh'));
  $('#lang-en').addEventListener('click', () => setLang('en'));

  const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const syncTheme = () => $('#theme-toggle').setAttribute('aria-pressed', String(isDark()));
  $('#theme-toggle').addEventListener('click', () => {
    const t = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = t;
    try { localStorage.setItem('xtal-theme', t); } catch (e) { /* storage unavailable: the choice lasts for this visit */ }
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  boot(); syncChrome(); syncTheme();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(onTheme);
})();
