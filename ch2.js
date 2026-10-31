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
     2D canvas helper
     ===================================================================== */
  function canvas2d(cv, draw) {
    const fit = () => {
      if (!cv || !cv.parentElement) return;
      const r = cv.parentElement.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (!r.width || !r.height) return;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); draw(x, r.width, r.height);
    };
    if (cv && cv.parentElement) {
      new ResizeObserver(fit).observe(cv.parentElement);
      requestAnimationFrame(fit);
    }
    return fit;
  }
  const FONT = (w, s) => tx(`${w} ${s}px "IBM Plex Sans",system-ui,sans-serif`, `${w} ${s}px "Noto Sans TC","PingFang TC",sans-serif`);
  const MFONT = (w, s) => `${w} ${s}px "IBM Plex Mono",monospace`;

  /* =====================================================================
     Chapter 4: shared pieces
     ===================================================================== */
  if (GL) { GEO.lo = new THREE.SphereGeometry(1, 18, 10); GEO.lo.userData.shared = true; }
  const rng = s => () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const sci = (x, d = 1) => {
    if (!x) return '0';
    let e = Math.floor(Math.log10(Math.abs(x))), m = (x / 10 ** e).toFixed(d);
    if (Math.abs(+m) >= 10) { e++; m = (x / 10 ** e).toFixed(d); }
    return `${m} × 10${String(e).replace(/[-\d]/g, c => SUP[c])}`;
  };
  const EV = 1.602e-19;
  // Many equal spheres in one draw call
  function cloud(g, pts, r, color, o = {}) {
    if (!pts.length) return null;
    const m = new THREE.InstancedMesh(pts.length > 500 ? GEO.lo : GEO.sphere, mStd(color, o), pts.length), M = new THREE.Matrix4();
    pts.forEach((p, i) => { M.makeScale(r, r, r); M.setPosition(p.x, p.y, p.z); m.setMatrixAt(i, M); });
    m.instanceMatrix.needsUpdate = true; m.frustumCulled = false; if (o.order) m.renderOrder = o.order; g.add(m); return m;
  }
  function shell(g, p, r, color, opacity) { const m = atom(g, p, r, color, { opacity, order: 6 }); return m; }
  function path(g, pts, r, mat, order) { for (let i = 1; i < pts.length; i++) { const m = rod(g, pts[i - 1], pts[i], r, mat); if (m && order) m.renderOrder = order; } }
  function arc(g, a, b, rad, color) {
    const pts = []; for (let i = 0; i <= 16; i++) pts.push(a.clone().lerp(b, i / 16).normalize().multiplyScalar(rad));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
  }
  // Triangles of the convex hull of a few points
  function hullFaces(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
      const n = pts[j].clone().sub(pts[i]).cross(pts[k].clone().sub(pts[i])); if (n.length() < 1e-6) continue;
      let pos = 0, neg = 0; pts.forEach(p => { const d = n.dot(p.clone().sub(pts[i])); if (d > 1e-6) pos++; else if (d < -1e-6) neg++; });
      if (!pos || !neg) out.push([pts[i], pts[j], pts[k]]);
    }
    return out;
  }
  const slide = (id, f) => { const e = $(id); e.addEventListener('input', f); return e; };

  /* =====================================================================
     Chapter 2: shared pieces
     ===================================================================== */
  const redraw2D = [];
  const sciH = (x, d = 2) => { const e = Math.floor(Math.log10(Math.abs(x))); return `${(x / 10 ** e).toFixed(d)} × 10<sup>${String(e).replace('-', '−')}</sup>`; };
  // Soft round dots: one texture per material, because Viewer.clear() disposes maps
  function dotTex() {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
  }
  // Point cloud with a fixed on-screen dot size (the shared renderer's size would distort attenuated points)
  function points(g, pos, cols, px, o = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: px * Math.min(devicePixelRatio || 1, 2), sizeAttenuation: false, vertexColors: true, map: dotTex(), transparent: true, opacity: o.opacity ?? 0.85, depthWrite: false, alphaTest: 0.03 }));
    m.renderOrder = o.order || 2; m.frustumCulled = false; g.add(m); return m;
  }
  const rgb = c => { const k = new THREE.Color(c); return [k.r, k.g, k.b]; };
  // Directions spread evenly over a sphere
  const FIB = (() => { const out = [], N = 420, ga = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < N; i++) { const z = 1 - 2 * (i + 0.5) / N, s = Math.sqrt(1 - z * z); out.push([s * Math.cos(i * ga), s * Math.sin(i * ga), z]); } return out; })();
  const randDir = rnd => { const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z); return [s * Math.cos(t), s * Math.sin(t), z]; };

  /* Exact rejection sampler for a density f(x,y,z)² (f is the signed wave function).
     Proposal: radius from r²·M(r), with M(r) the largest f² on the sphere of radius r; direction uniform.
     Accept with f² / M(r). Returns { pos, sgn } (sgn = sign of f). */
  function sampler(f, L) {
    const NR = 360, M = new Float64Array(NR + 1), cdf = new Float64Array(NR + 1);
    for (let i = 0; i <= NR; i++) {
      const r = (i + 0.5) / NR * L; let m = 0;
      for (const d of FIB) { const v = f(d[0] * r, d[1] * r, d[2] * r); if (v * v > m) m = v * v; }
      M[i] = m * 1.3 + 1e-30;
    }
    for (let i = 1; i <= NR; i++) { const r = (i - 0.5) / NR * L; cdf[i] = cdf[i - 1] + r * r * Math.max(M[i - 1], M[i]); }
    for (let i = 1; i <= NR; i++) cdf[i] /= cdf[NR];
    return (N, seed, keep) => {
      const rnd = rng(seed), pos = [], sgn = [];
      let guard = N * 300;
      while (sgn.length < N && guard-- > 0) {
        const u = rnd(); let lo = 0, hi = NR; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid; else hi = mid; }
        const r = (lo + (u - cdf[lo]) / ((cdf[hi] - cdf[lo]) || 1)) / NR * L, d = randDir(rnd);
        const x = d[0] * r, y = d[1] * r, z = d[2] * r, v = f(x, y, z);
        if (v * v < rnd() * Math.max(M[lo], M[hi])) continue;
        if (keep && !keep(x, y, z)) continue;
        pos.push(x, y, z); sgn.push(v >= 0 ? 1 : -1);
      }
      return { pos, sgn };
    };
  }
  function cloudPts(g, smp, px, o = {}) {
    const cp = rgb(o.pos || COL.corner), cn = rgb(o.neg || COL.body), cols = [];
    smp.sgn.forEach(s => cols.push(...(s > 0 ? cp : cn)));
    return points(g, smp.pos, cols, px, o);
  }

  /* ---------- hydrogen atom: lengths in Bohr radii ---------- */
  function lag(k, a, x) { if (k === 0) return 1; let L0 = 1, L1 = 1 + a - x; for (let i = 1; i < k; i++) { const L2 = ((2 * i + 1 + a - x) * L1 - (i + a) * L0) / (i + 1); L0 = L1; L1 = L2; } return L1; }
  const Rnl = (n, l, r) => { const p = 2 * r / n; return p ** l * Math.exp(-p / 2) * lag(n - l - 1, 2 * l + 1, p); };
  // Real angular parts as functions of the unit vector; h = orbital name, m = |m| it comes from
  const ANG = [
    [{ h: 's', m: '0', f: () => 1 }],
    [{ h: 'p<sub>z</sub>', m: '0', f: (x, y, z) => z }, { h: 'p<sub>x</sub>', m: '±1', f: x => x }, { h: 'p<sub>y</sub>', m: '±1', f: (x, y) => y }],
    [{ h: 'd<sub>z²</sub>', m: '0', f: (x, y, z) => 3 * z * z - 1 }, { h: 'd<sub>xz</sub>', m: '±1', f: (x, y, z) => x * z }, { h: 'd<sub>yz</sub>', m: '±1', f: (x, y, z) => y * z },
      { h: 'd<sub>x²−y²</sub>', m: '±2', f: (x, y) => x * x - y * y }, { h: 'd<sub>xy</sub>', m: '±2', f: (x, y) => x * y }],
    [{ h: 'f<sub>z³</sub>', m: '0', f: (x, y, z) => z * (5 * z * z - 3) }, { h: 'f<sub>xz²</sub>', m: '±1', f: (x, y, z) => x * (5 * z * z - 1) }, { h: 'f<sub>yz²</sub>', m: '±1', f: (x, y, z) => y * (5 * z * z - 1) },
      { h: 'f<sub>z(x²−y²)</sub>', m: '±2', f: (x, y, z) => z * (x * x - y * y) }, { h: 'f<sub>xyz</sub>', m: '±2', f: (x, y, z) => x * y * z },
      { h: 'f<sub>x(x²−3y²)</sub>', m: '±3', f: (x, y) => x * (x * x - 3 * y * y) }, { h: 'f<sub>y(3x²−y²)</sub>', m: '±3', f: (x, y) => y * (3 * x * x - y * y) }]
  ];
  const orbF = (n, l, a) => (x, y, z) => { const r = Math.hypot(x, y, z) || 1e-9; return Rnl(n, l, r) * a.f(x / r, y / r, z / r); };
  const orbL = n => n * n * 2.1 + 7 * n;  // radius that holds essentially all of the cloud
  const SAMP = new Map();
  function orbSampler(n, l, mi) { const k = `${n}${l}${mi}`; if (!SAMP.has(k)) SAMP.set(k, sampler(orbF(n, l, ANG[l][mi]), orbL(n))); return SAMP.get(k); }
  /* Boundary surface |ψ| = c by marching tetrahedra on an N³ grid over [−L, L]³ (each cube split into six
     tetrahedra around its main diagonal). Returns one triangle list per sign of ψ, with normals from the gradient. */
  const CUBE = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const TETS = [[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]];
  function isoSurface(f, L, N, c) {
    const h = 2 * L / N, M = N + 1, val = new Float32Array(M * M * M), at = (i, j, k) => (k * M + j) * M + i;
    for (let k = 0; k < M; k++) for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) val[at(i, j, k)] = f(-L + i * h, -L + j * h, -L + k * h);
    const out = [{ pos: [], nor: [] }, { pos: [], nor: [] }], e = h * 0.2, P = [], V = [];
    const vert = (a, b, sg) => {
      const t = V[a] / (V[a] - V[b]), p = [0, 1, 2].map(q => -L + (P[a][q] + t * (P[b][q] - P[a][q])) * h);
      const [x, y, z] = p, gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e);
      const k = -sg / (Math.hypot(gx, gy, gz) || 1); return { p, n: [gx * k, gy * k, gz * k] };  // outward = down the slope of sg·ψ
    };
    const tri = (o, a, b, c3) => {
      const u = a.p.map((s, q) => b.p[q] - s), w = a.p.map((s, q) => c3.p[q] - s);
      const fn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const m = a.n[0] + b.n[0] + c3.n[0], m1 = a.n[1] + b.n[1] + c3.n[1], m2 = a.n[2] + b.n[2] + c3.n[2];
      const vs = fn[0] * m + fn[1] * m1 + fn[2] * m2 < 0 ? [a, c3, b] : [a, b, c3];
      vs.forEach(v => { o.pos.push(...v.p); o.nor.push(...v.n); });
    };
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let mx = 0; for (const d of CUBE) mx = Math.max(mx, Math.abs(val[at(i + d[0], j + d[1], k + d[2])]));
      if (mx <= c) continue;
      for (let s = 0; s < 2; s++) {
        const sg = s ? -1 : 1;
        for (const t of TETS) {
          const A = [], B = [];
          for (let q = 0; q < 4; q++) { const d = CUBE[t[q]]; P[q] = [i + d[0], j + d[1], k + d[2]]; V[q] = sg * val[at(i + d[0], j + d[1], k + d[2])] - c; (V[q] > 0 ? A : B).push(q); }
          if (!A.length || !B.length) continue;
          if (A.length === 2) { const a0 = vert(A[0], B[0], sg), a1 = vert(A[0], B[1], sg), a2 = vert(A[1], B[1], sg), a3 = vert(A[1], B[0], sg); tri(out[s], a0, a1, a2); tri(out[s], a0, a2, a3); }
          else { const [one, rest] = A.length === 1 ? [A[0], B] : [B[0], A]; tri(out[s], ...rest.map(r => vert(A.length === 1 ? one : r, A.length === 1 ? r : one, sg))); }
        }
      }
    }
    return out;
  }
  // 90% boundary surface of an orbital: the level c with 90% of the sampled electron positions at |ψ| > c
  const SURF = new Map();
  function orbSurface(n, l, mi, smp) {
    const k = `${n}${l}${mi}`; if (SURF.has(k)) return SURF.get(k);
    const f = orbF(n, l, ANG[l][mi]), a = [];
    for (let i = 0; i < smp.pos.length; i += 3) a.push(Math.abs(f(smp.pos[i], smp.pos[i + 1], smp.pos[i + 2])));
    const sorted = a.slice().sort((x, y) => x - y), c = sorted[Math.floor(sorted.length * 0.1)];
    let L = 0; a.forEach((v, i) => { if (v >= c) L = Math.max(L, Math.hypot(smp.pos[3 * i], smp.pos[3 * i + 1], smp.pos[3 * i + 2])); });
    const out = isoSurface(f, L * 1.1, 64, c); SURF.set(k, out); return out;
  }
  // Radial probability r²R² on a grid, normalized to unit area
  function radialP(n, l, rmax, N = 500) {
    const xs = [], ys = []; let s = 0;
    for (let i = 0; i <= N; i++) { const r = i / N * rmax, R = Rnl(n, l, r), y = r * r * R * R; xs.push(r); ys.push(y); s += y; }
    const k = 1 / (s * rmax / N); return { xs, ys: ys.map(y => y * k) };
  }
  const radius95 = pos => { const rs = []; for (let i = 0; i < pos.length; i += 3) rs.push(Math.hypot(pos[i], pos[i + 1], pos[i + 2])); rs.sort((a, b) => a - b); return rs[Math.floor(rs.length * 0.96)] || 1; };
  const LNAME = 'spdf';

  // A light-colour approximation of a wavelength in nm; null outside the visible range
  function wlColor(nm) {
    if (nm < 380 || nm > 750) return null;
    let r = 0, g = 0, b = 0;
    if (nm < 440) { r = (440 - nm) / 60; b = 1; } else if (nm < 490) { g = (nm - 440) / 50; b = 1; } else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
    else if (nm < 580) { r = (nm - 510) / 70; g = 1; } else if (nm < 645) { r = 1; g = (645 - nm) / 65; } else r = 1;
    const f = nm < 420 ? 0.35 + 0.65 * (nm - 380) / 40 : nm > 700 ? 0.35 + 0.65 * (750 - nm) / 50 : 1;
    const c = v => Math.round(255 * Math.pow(v * f, 0.8));
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const region = nm => nm < 380 ? tx('ultraviolet', '紫外光') : nm > 750 ? tx('infrared', '紅外光') : tx('visible', '可見光');
  // hydrogen lines between two levels (99 = ∞)
  const NINF = 99, En = n => n >= NINF ? 0 : -13.6 / (n * n), lineNm = (up, lo) => 1240 / (En(up) - En(lo));
  const SERIES = [['Lyman', '來曼'], ['Balmer', '巴耳末'], ['Paschen', '帕申'], ['Brackett', '布拉克'], ['Pfund', '蒲芬德']];
  const nTxt = n => (n >= NINF ? '∞' : String(n));

  /* =====================================================================
     Hero: hydrogen 3d z² cloud on the film plate
     ===================================================================== */
  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [1, -0.55, 0.32], label: () => tx('Electron cloud of the hydrogen 3d z² orbital', '氫原子 3d z² 軌域的電子雲'), clear: 0 });
    let smp = null;
    v.rebuild = () => {
      v.clear(); if (!smp) smp = orbSampler(3, 2, 0)(16000, 7);
      cloudPts(v.root, smp, 2.1, { opacity: 0.8 });
      atom(v.root, V3(0, 0, 0), 0.35, '#DDE7EA');
    };
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 17); if (!REDUCED) v.setSpin(true); });
  }

  /* =====================================================================
     01 Rutherford scattering
     ===================================================================== */
  function secRu() {
    const info = $('#ru-info'), st = { mode: 'ru', fired: false, t: 1 };
    const LAY = [[-0.55, 0, 0], [0, 0.5, 0.5], [0.55, 0.5, 0]], NA = 3.5, NP = 400;
    const nuclei = [];
    LAY.forEach(([x, oy, oz]) => { for (let j = -3; j <= 3; j++) for (let k = -3; k <= 3; k++) { const y = j + oy - 0.25, z = k + oz - 0.25; if (Math.abs(y) <= NA && Math.abs(z) <= NA) nuclei.push(V3(x, y, z)); } });
    // deflection angle: Rutherford 2·atan(D / 2b) near the nucleus, screened by the atom's own electrons farther out
    const D2 = 0.04, B0 = 0.04, LS = 0.03;
    const theta = b => 2 * Math.atan(D2 / Math.max(b, 1e-4)) * (b < B0 ? 1 : Math.exp(-(b - B0) / LS));
    let paths = [], counts = [0, 0, 0];
    function shoot() {
      const rnd = rng(st.mode === 'ru' ? 41 : 17); paths = []; counts = [0, 0, 0];
      for (let i = 0; i < NP; i++) {
        const y = (rnd() * 2 - 1) * NA * 0.95, z = (rnd() * 2 - 1) * NA * 0.95;
        let best = 0, hit = null, dir = null;
        if (st.mode === 'ru') {
          LAY.forEach(([x]) => {
            let nb = null, bb = 1e9; nuclei.forEach(p => { if (p.x !== x) return; const b = Math.hypot(y - p.y, z - p.z); if (b < bb) { bb = b; nb = p; } });
            const th = theta(bb); if (th > best) { best = th; hit = V3(x, y, z); dir = V3(0, (y - nb.y) / bb, (z - nb.z) / bb); }
          });
        } else {
          // the pudding spreads the charge out: only tiny random nudges
          best = Math.abs((rnd() + rnd() + rnd() - 1.5) * 0.012); hit = V3(0, y, z); const a = rnd() * 6.283; dir = V3(0, Math.cos(a), Math.sin(a));
        }
        const out = V3(Math.cos(best), 0, 0).addScaledVector(dir, Math.sin(best));
        const p0 = V3(-7, y, z), p2 = hit.clone().addScaledVector(out, 7.5);
        const deg = best / D2R; counts[deg < 2 ? 0 : deg < 90 ? 1 : 2]++;
        paths.push({ p0, p1: hit, p2, L1: p0.distanceTo(hit), L2: 7.5, deg });
      }
    }
    const v = GL ? new Viewer($('#v-ru'), { view: [0.32, -1, 0.42], label: () => tx('Alpha particles fired at a gold foil', 'α 粒子打向金箔') }) : null;
    let lines = null, heads = null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root;
      if (st.mode === 'ru') {
        cloud(g, nuclei, 0.42, T.ghost3d, { opacity: 0.12 });
        cloud(g, nuclei, 0.05, COL.body);
      } else {
        cloud(g, nuclei, 0.42, COL.body, { opacity: 0.2 });
        const rnd = rng(5), el = []; nuclei.forEach(p => { for (let k = 0; k < 3; k++) el.push(p.clone().add(V3(rnd() - .5, rnd() - .5, rnd() - .5).multiplyScalar(0.55))); });
        cloud(g, el, 0.035, T.hi);
      }
      // source and screen
      atom(g, V3(-7.3, 0, 0), 0.28, T.edge3d);
      label(g, tx('α source', 'α 射源'), V3(-7.3, 0, 0.9), { size: 0.62 });
      label(g, tx('gold foil', '金箔'), V3(0, -NA - 0.4, NA + 0.6), { size: 0.62 });
      const mk = col => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(NP * 12), 3)); const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: col === T.hi ? 1 : 0.13, depthWrite: false })); l.frustumCulled = false; g.add(l); return l; };
      lines = [mk(T.edge3d), mk(T.hi)];
      const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(NP * 3), 3));
      heads = new THREE.Points(hg, new THREE.PointsMaterial({ size: 3 * Math.min(devicePixelRatio || 1, 2), sizeAttenuation: false, color: T.ink, map: dotTex(), transparent: true, alphaTest: 0.05 }));
      heads.frustumCulled = false; g.add(heads);
      draw();
    };
    function draw() {
      if (!lines) return;
      const pa = lines.map(l => l.geometry.attributes.position.array), ha = heads.geometry.attributes.position.array, k = [0, 0];
      const d = st.t * 15;
      paths.forEach((p, i) => {
        const w = p.deg > 10 ? 1 : 0, a = pa[w];
        const put = (A, B) => { a.set([A.x, A.y, A.z, B.x, B.y, B.z], k[w]); k[w] += 6; };
        let tip;
        if (d <= p.L1) { tip = p.p0.clone().lerp(p.p1, d / p.L1); put(p.p0, tip); }
        else { tip = p.p1.clone().lerp(p.p2, Math.min(1, (d - p.L1) / p.L2)); put(p.p0, p.p1); put(p.p1, tip); }
        ha.set(st.t >= 1 ? [0, 0, -999] : [tip.x, tip.y, tip.z], i * 3);
      });
      pa.forEach((a, w) => a.fill(0, k[w]));
      lines.forEach(l => { l.geometry.attributes.position.needsUpdate = true; });
      heads.geometry.attributes.position.needsUpdate = true; heads.visible = st.t < 1;
      v.dirty = true;
    }
    function text() {
      const [a, b, c] = counts, f = st.t >= 1 && st.fired;
      info.innerHTML = (st.mode === 'ru' ? tx('<h4>Rutherford: a tiny, heavy nucleus</h4>', '<h4>拉塞福：又小又重的原子核</h4>') : tx('<h4>Thomson: charge spread through the atom</h4>', '<h4>湯姆森：正電散布在整個原子</h4>')) +
        (f ? tx(`<dl class="stats"><dt>Nearly straight (&lt; 2°)</dt><dd>${a}</dd><dt>Deflected 2° – 90°</dt><dd>${b}</dd><dt>Bounced back (&gt; 90°)</dt><dd>${c}</dd></dl>`,
          `<dl class="stats"><dt>幾乎直直穿過（&lt; 2°）</dt><dd>${a}</dd><dt>偏轉 2° – 90°</dt><dd>${b}</dd><dt>反彈（&gt; 90°）</dt><dd>${c}</dd></dl>`) : '') +
        (st.mode === 'ru' ? tx('<p>Most α particles miss every nucleus by a wide margin and fly straight through the empty atom. The rare one that comes very close to a nucleus feels its full, concentrated charge and is thrown off sharply, sometimes straight back.</p>', '<p>大多數 α 粒子離每個原子核都很遠，直接穿過幾乎是空的原子。極少數非常靠近原子核的，感受到集中在一點的全部正電，被猛力甩開，有時直接彈回來。</p>')
          : tx('<p>The positive charge is spread over the whole atom, so the push on an α particle is weak everywhere. Every particle gets a tiny nudge and none comes back. That is not what the experiment showed.</p>', '<p>正電散布在整個原子裡，α 粒子在哪裡受到的推力都很弱。每個粒子只被輕輕推一下，沒有一個彈回來。這和實驗結果不符。</p>'));
    }
    const fire = () => { st.fired = true; shoot(); st.t = REDUCED ? 1 : 0; t0 = null; if (v && !v.init) v.rebuild(); text(); };
    let t0 = null;
    seg($('#ru-mode'), m => { st.mode = m; fire(); });
    $('#ru-fire').addEventListener('click', fire);
    if (v) {
      v.anim = t => { if (st.t >= 1) return; if (t0 === null) t0 = t; st.t = Math.min(1, (t - t0) / 2600); draw(); if (st.t >= 1) text(); };
      v.lazy(() => { shoot(); st.fired = true; st.t = REDUCED ? 1 : 0; v.rebuild(); v.frame(V3(0, 0, 0), 7.6); text(); });
    } else { shoot(); st.fired = true; }
    text(); onLang(text);
  }

  /* =====================================================================
     02 Classical collapse (2D)
     ===================================================================== */
  function secCl() {
    const cv = $('#cl-cv'), info = $('#cl-info');
    const R0 = 8, st = { t: -1 }; // t: -1 = steady orbit (not yet released), 0..1 collapse, 1 = done
    const OBS = [121.6, 102.6, 97.3, 95.0, 656.3, 486.1, 434.0, 410.2, 397.0, 388.9];
    const rAt = t => R0 * Math.cbrt(Math.max(0, 1 - t)), lamAt = r => 45.6 * Math.pow(r, 1.5); // nm, classical orbit frequency at radius r (a0)
    let last = null, ang = 0, prev = 0, on = false, trail = [];
    function paint(x, W, H) {
      last = { x, W, H }; if (W < 120 || H < 120) return;
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const narrow = W < 560, S = narrow ? Math.min(W, H * 0.55) : Math.min(H, W * 0.42);
      const cx = narrow ? W / 2 : S / 2 + 8, cy = narrow ? S / 2 + 4 : H / 2, sc = (S / 2 - 18) / R0;
      // atom
      x.strokeStyle = T.grid; x.lineWidth = 1; x.beginPath(); x.arc(cx, cy, R0 * sc, 0, 7); x.stroke();
      x.strokeStyle = T.hi; x.globalAlpha = 0.5; x.lineWidth = 1.4; x.beginPath(); trail.forEach((p, i) => { const px = cx + p[0] * sc, py = cy + p[1] * sc; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); x.globalAlpha = 1;
      x.fillStyle = COL.body; x.beginPath(); x.arc(cx, cy, 5, 0, 7); x.fill();
      const r = st.t < 0 ? R0 : rAt(st.t);
      if (st.t < 1) { x.fillStyle = T.hi; x.beginPath(); x.arc(cx + r * Math.cos(ang) * sc, cy + r * Math.sin(ang) * sc, 5, 0, 7); x.fill(); }
      x.fillStyle = T.muted; x.font = MFONT(500, 11); x.textAlign = 'left';
      const tl = st.t < 0 ? tx('electron held on a circle', '電子固定在圓周上') : st.t < 1 ? `t = ${(st.t * 1.56).toFixed(2)} × 10⁻¹¹ s` : tx('crashed into the nucleus', '撞進原子核了');
      x.fillText(tl, narrow ? 10 : 10, narrow ? S + 2 : H - 10);
      // spectra
      const x0 = narrow ? 14 : S + 40, x1 = W - 16, w = x1 - x0, y0 = narrow ? S + 30 : H * 0.22;
      const L0 = Math.log(90), L1 = Math.log(1100), X = nm => x0 + (Math.log(nm) - L0) / (L1 - L0) * w;
      const band = (y, h, title) => { x.fillStyle = T.ink; x.font = FONT(600, 12); x.textAlign = 'left'; x.fillText(title, x0, y - 8); x.strokeStyle = T.line; x.strokeRect(x0, y, w, h); x.fillStyle = T.surface; x.fillRect(x0 + 0.5, y + 0.5, w - 1, h - 1); };
      const hb = narrow ? 26 : 32, gap = narrow ? 40 : 52;
      band(y0, hb, tx('Classical prediction: light given off while spiralling in', '古典預測：螺旋掉進去時放出的光'));
      const lamNow = st.t < 0 ? null : lamAt(r);
      if (lamNow) {
        for (let nm = Math.min(1100, lamAt(R0)); nm >= Math.max(90, lamNow); nm *= 0.995) { x.fillStyle = wlColor(nm) || T.ghost3d; x.fillRect(X(nm), y0 + 1, Math.max(1, X(nm / 0.995) - X(nm)) + 0.6, hb - 2); }
      }
      band(y0 + hb + gap, hb, tx('Observed: hot hydrogen gas', '實際觀察：熱的氫氣'));
      OBS.forEach(nm => { x.fillStyle = wlColor(nm) || T.ink; x.fillRect(X(nm) - 1, y0 + hb + gap + 1, 2.2, hb - 2); });
      // axis
      const ya = y0 + 2 * hb + gap + 16; x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      [100, 200, 400, 700, 1000].forEach(nm => { x.fillText(nm, X(nm), ya); });
      x.textAlign = 'right'; x.fillText(tx('wavelength (nm)', '波長（nm）'), x1, ya + 14);
      x.textAlign = 'left'; x.fillStyle = T.muted; x.font = FONT(500, 11);
      const yr = y0 + hb + 15; x.fillText(tx('UV', '紫外'), X(110), yr); x.fillText(tx('visible', '可見'), X(430), yr); x.fillText(tx('IR', '紅外'), X(820), yr);
    }
    function text() {
      info.innerHTML = tx(`<p>A charge moving in a circle radiates. Losing energy, the classical electron falls inward, circles faster, and radiates at ever shorter wavelengths. From the first Bohr radius it would reach the nucleus in about 1.6 × 10<sup>−11</sup> s.</p><p class="note">The model starts the electron at 8 a<sub>0</sub> so the sweep crosses the visible range. Real hydrogen shows only the sharp lines in the lower bar.</p>`,
        `<p>做圓周運動的電荷會放出電磁波。古典電子一邊失去能量一邊往內掉，轉得越來越快，放出的波長越來越短。從第一波耳半徑出發，大約 1.6 × 10<sup>−11</sup> s 就會撞上原子核。</p><p class="note">模型讓電子從 8 a<sub>0</sub> 出發，這樣掃過的範圍才會經過可見光。真實的氫只放出下面那條的幾根細線。</p>`);
    }
    const fit = canvas2d(cv, paint), again = () => { if (last) paint(last.x, last.W, last.H); };
    $('#cl-go').addEventListener('click', () => { st.t = 0; trail = []; ang = 0; });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { on = es[0].isIntersecting; }).observe(cv); else on = true;
    const frame = now => {
      const dt = Math.min(50, now - prev) / 1000; prev = now;
      if (on && !REDUCED) {
        const r = st.t < 0 ? R0 : rAt(st.t);
        if (st.t < 1) { ang += dt * 2.2 * Math.pow(R0 / Math.max(r, 0.25), 1.5); }
        if (st.t >= 0 && st.t < 1) { st.t = Math.min(1, st.t + dt / 5); trail.push([r * Math.cos(ang), r * Math.sin(ang)]); }
        again();
      }
      requestAnimationFrame(frame);
    };
    if (REDUCED) { st.t = 1; for (let i = 0; i <= 400; i++) { const t = i / 400, r = rAt(t); trail.push([r * Math.cos(t * 40), r * Math.sin(t * 40)]); } }
    requestAnimationFrame(frame);
    text(); onLang(text);
    return () => { fit(); };
  }

  /* =====================================================================
     02-1 Standing wave on an orbit
     ===================================================================== */
  function secSw() {
    const qS = $('#sw-q'), lapsC = $('#sw-laps'), info = $('#sw-info');
    const R = 2.2, A = 0.5, NSUM = 12, NG = 5, SEG = 360;
    const q = () => +qS.value;
    const ampAfter = qq => { const s = Math.sin(Math.PI * qq); return Math.abs(s) < 1e-6 ? 1 : Math.abs(Math.sin(NSUM * Math.PI * qq) / (NSUM * s)); };
    const v = GL ? new Viewer($('#v-sw'), { view: [0.15, -1, 0.62], label: () => tx('An electron wave wrapped around a circular orbit', '繞在圓形軌道上的電子波') }) : null;
    let grp = null, c = 1;
    const wave = (lap, k) => { const pts = []; for (let i = 0; i <= SEG; i++) { const p = i / SEG * 2 * Math.PI; pts.push(V3(R * Math.cos(p), R * Math.sin(p), A * c * k * Math.cos(q() * (p + 2 * Math.PI * lap)))); } return pts; };
    const sumWave = () => { const pts = []; for (let i = 0; i <= SEG; i++) { const p = i / SEG * 2 * Math.PI; let s = 0; for (let j = 0; j < NSUM; j++) s += Math.cos(q() * (p + 2 * Math.PI * j)); pts.push(V3(R * Math.cos(p), R * Math.sin(p), A * c * s / NSUM)); } return pts; };
    function waves() {
      if (!grp) return;
      grp.children.slice().forEach(o => { grp.remove(o); o.geometry.dispose(); o.material.dispose(); });
      const tube = (pts, r, col, op = 1) => { const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), SEG, r, 6, false), mStd(col, { opacity: op })); grp.add(m); return m; };
      if (lapsC.checked) for (let j = 1; j <= NG; j++) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(wave(j, 1)), new THREE.LineBasicMaterial({ color: T.ghost3d, transparent: true, opacity: 0.9 - j * 0.12 })); grp.add(l); }
      tube(wave(0, 1), 0.035, COL.corner);
      tube(sumWave(), 0.05, T.hi);
      // where the first lap ends against where it started
      const z0 = A * c, z1 = A * c * Math.cos(q() * 2 * Math.PI);
      const s0 = new THREE.Mesh(GEO.sphere, mStd(COL.corner)); s0.position.set(R, 0, z0); s0.scale.setScalar(0.08); grp.add(s0);
      if (Math.abs(z1 - z0) > 0.03) { const s1 = new THREE.Mesh(GEO.sphere, mStd(COL.corner)); s1.position.set(R, 0, z1); s1.scale.setScalar(0.08); grp.add(s1); const r = rod(grp, V3(R + 0.16, 0, z0), V3(R + 0.16, 0, z1), 0.02, mStd(T.hi)); }
      v.dirty = true;
    }
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(R, 0.02, 8, 160), mStd(COL.plane)); g.add(ring);
      atom(g, V3(0, 0, 0), 0.18, COL.body);
      grp = new THREE.Group(); g.add(grp);
      label(g, tx('start', '起點'), V3(R + 0.45, 0, A + 0.2), { size: 0.22, color: T.muted });
      waves();
    };
    function text() {
      const qq = q(), n = Math.round(qq), fr = qq - Math.floor(qq), ok = Math.abs(qq - n) < 0.005, amp = ampAfter(qq);
      $('#sw-q-v').textContent = qq.toFixed(2);
      const mis = Math.round(Math.min(fr, 1 - fr) * 360);
      info.innerHTML = (ok ? tx(`<p><span class="pill ok">Allowed</span> n = ${n}: the wave closes on itself.</p>`, `<p><span class="pill ok">允許</span>　n = ${n}：波頭尾接得起來。</p>`)
        : tx(`<p><span class="pill bad">Forbidden</span> The first lap ends ${mis}° out of step with where it started.</p>`, `<p><span class="pill bad">不允許</span>　第一圈結束時，和起點錯開了 ${mis}°。</p>`)) +
        tx(`<dl class="stats"><dt>Left after ${NSUM} laps</dt><dd>${Math.round(amp * 100)}%</dd></dl>`, `<dl class="stats"><dt>${NSUM} 圈後剩下</dt><dd>${Math.round(amp * 100)}%</dd></dl>`) +
        (ok ? tx(`<div class="eq">nλ = 2πr → λ<sub>${n}</sub> = 2πr<sub>${n}</sub> / ${n}<br>Bohr: r<sub>${n}</sub> = ${n * n} a<sub>0</sub>, λ<sub>${n}</sub> = ${(2 * Math.PI * n).toFixed(2)} a<sub>0</sub></div><p class="note">Bohr's radii grow as n², so the real orbit for n = ${n} is ${n * n} times larger than for n = 1. Here the ring is kept the same size to compare the waves.</p>`,
          `<div class="eq">nλ = 2πr → λ<sub>${n}</sub> = 2πr<sub>${n}</sub> / ${n}<br>波耳：r<sub>${n}</sub> = ${n * n} a<sub>0</sub>，λ<sub>${n}</sub> = ${(2 * Math.PI * n).toFixed(2)} a<sub>0</sub></div><p class="note">波耳半徑隨 n² 變大，所以 n = ${n} 的真實軌道比 n = 1 大 ${n * n} 倍。這裡讓圓圈保持一樣大，方便比較波。</p>`)
          : tx('<p class="note">Each new lap starts where the last one ended, out of step, so crests land on troughs. The sum (red) shrinks toward zero: the wave destroys itself and this orbit cannot exist.</p>', '<p class="note">每一圈都從上一圈結束的地方開始，相位錯開，波峰落在波谷上。加總（紅線）越來越接近零：波自己毀掉自己，這個軌道不存在。</p>'));
    }
    qS.addEventListener('input', () => { waves(); text(); });
    lapsC.addEventListener('change', waves);
    $('#sw-snap').addEventListener('click', () => { qS.value = Math.min(6, Math.max(1, Math.round(q()))); waves(); text(); });
    if (v) {
      let lastT = 0;
      v.anim = t => { if (REDUCED || t - lastT < 33) return; lastT = t; c = Math.cos(t / 420); waves(); };
      v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), R + 0.7); });
    }
    text(); onLang(text);
  }

  /* =====================================================================
     03 Bohr levels: orbits (3D) and level diagram (2D)
     ===================================================================== */
  function secBohr() {
    const st = { up: 3, lo: 2, dir: 'em' }, info = $('#bo-info');
    const rOf = n => (n >= NINF ? 46 : n * n);
    const v = GL ? new Viewer($('#v-bo'), { view: [0.25, -1, 0.9], label: () => tx('Bohr orbits of hydrogen drawn to scale', '照比例畫的氫原子波耳軌道') }) : null;
    let el = null, ph = null, FR = 10, rNow = 9, ang = 0, job = null, lastT = 0;
    const startN = () => (st.dir === 'em' ? st.up : st.lo), endN = () => (st.dir === 'em' ? st.lo : st.up);
    const nm = () => lineNm(st.up, st.lo);
    function frameR() { return rOf(Math.min(st.up, 6)) * (st.up >= NINF ? 1.3 : 1.18); }
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root; FR = frameR();
      for (let n = 1; n <= 6; n++) {
        const on = n === st.up || n === st.lo;
        g.add(new THREE.Mesh(new THREE.TorusGeometry(n * n, FR * (on ? 0.006 : 0.003), 8, 200), mStd(COL.plane, { opacity: on ? 1 : 0.45 })));
        if (n * n < FR * 1.05) label(g, 'n=' + n, V3(n * n * 0.7071, -n * n * 0.7071, 0), { size: FR * 0.065, color: on ? T.ink : T.muted });
      }
      atom(g, V3(0, 0, 0), FR * 0.022, COL.body);
      el = atom(g, V3(rNow, 0, 0), FR * 0.03, T.hi);
      ph = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 160 }, () => V3(0, 0, 0))), new THREE.LineBasicMaterial({ color: T.hi }));
      ph.visible = false; ph.frustumCulled = false; g.add(ph);
    };
    function placePhoton(from, u, len, t) {
      const c = wlColor(nm()); ph.material.color.set(c || T.muted);
      const pos = ph.geometry.attributes.position, k = FR * 0.09, A = FR * 0.035;
      for (let i = 0; i < 160; i++) { const s = i / 159 * len; const p = from.clone().addScaledVector(u, s); p.z += A * Math.sin(s / k * 2 * Math.PI - t / 60); pos.setXYZ(i, p.x, p.y, p.z); }
      pos.needsUpdate = true; ph.visible = true;
    }
    function go() { job = { t0: null }; rNow = rOf(startN()); if (ph) ph.visible = false; }
    if (v) v.anim = t => {
      const dt = Math.min(60, t - lastT) / 1000; lastT = t; if (!el) return;
      ang += dt * 1.8 / Math.pow(Math.max(rNow, 1), 0.75);
      if (job) {
        if (job.t0 === null) job.t0 = t;
        const s = (t - job.t0) / 1000, from = rOf(startN()), to = rOf(endN()), ease = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
        const u = V3(Math.cos(ang), Math.sin(ang), 0), Lp = FR * 0.55;
        if (st.dir === 'em') {
          rNow = from + (to - from) * ease((s - 0.4) / 0.6);
          if (s > 0.7) { const d = (s - 0.7) * FR * 0.9; const base = V3(to * Math.cos(job.a ?? (job.a = ang)), to * Math.sin(job.a), 0), uu = V3(Math.cos(job.a), Math.sin(job.a), 0); placePhoton(base.clone().addScaledVector(uu, d), uu, Lp, t); }
          if (s > 2.6) { job = null; ph.visible = false; }
        } else {
          if (s < 1.2) { if (job.a === undefined) job.a = ang + 1.2 * 1.8 / Math.pow(Math.max(from, 1), 0.75); const uu = V3(Math.cos(job.a), Math.sin(job.a), 0), target = V3(from * Math.cos(job.a), from * Math.sin(job.a), 0); const d = (1.2 - s) * FR * 0.9; placePhoton(target.clone().addScaledVector(uu, d), uu, Lp, t); }
          else ph.visible = false;
          rNow = from + (to - from) * ease((s - 1.2) / 0.7);
          if (s > 2.1) job = null;
        }
      }
      el.position.set(rNow * Math.cos(ang), rNow * Math.sin(ang), 0); v.dirty = true;
    };
    // ---------- level diagram ----------
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const nar = W < 520, ml = 14, mr = nar ? 96 : 110, mt = 16, specH = 74, mb = specH + 18;
      const Emin = -14.4, Emax = 1.2, Y = e => mt + (Emax - e) / (Emax - Emin) * (H - mt - mb), PW = W - ml - mr;
      x.fillStyle = T.surface; x.fillRect(ml, Y(Emax), PW, Y(0) - Y(Emax));
      x.fillStyle = T.muted; x.font = FONT(500, 11); x.textAlign = 'left'; x.fillText(tx('continuum: electron set free', '連續區：電子被釋放'), ml + 6, Y(0) - 6);
      for (let n = 1; n <= 7; n++) {
        const e = En(n), yy = Y(e), on = n === st.up || n === st.lo;
        x.strokeStyle = on ? T.ink : T.edge3d; x.lineWidth = on ? 1.8 : 1; x.beginPath(); x.moveTo(ml, yy); x.lineTo(ml + PW, yy); x.stroke();
        x.fillStyle = on ? T.ink : T.muted; x.font = MFONT(on ? 600 : 400, nar ? 10 : 11); x.textAlign = 'left';
        if (n <= 4 || on) x.fillText(`n=${n} ${e.toFixed(2)}${nar ? '' : ' eV'}`, ml + PW + 6, yy + 4);
      }
      x.strokeStyle = T.ink; x.lineWidth = 1; x.beginPath(); x.moveTo(ml, Y(0)); x.lineTo(ml + PW, Y(0)); x.stroke();
      x.fillStyle = T.muted; x.fillText(nar ? 'n=∞ 0 eV' : 'n=∞  0 eV', ml + PW + 6, Y(0) + 4);
      const cols = [0.09, 0.33, 0.56, 0.75, 0.9];
      for (let lo = 1; lo <= 5; lo++) {
        const ups = [...Array(6 - lo).keys()].map(i => lo + 1 + i).concat([NINF]), cx = ml + PW * cols[lo - 1], sp = Math.min(9, PW * 0.12 / ups.length);
        x.fillStyle = T.muted; x.font = FONT(600, 11); x.textAlign = 'center';
        if (lo <= 3 || W > 600) x.fillText(tx(SERIES[lo - 1][0], SERIES[lo - 1][1]), cx, Y(En(lo)) + 15);
        ups.forEach((up, i) => {
          const xx = cx + (i - (ups.length - 1) / 2) * sp, sel = up === st.up && lo === st.lo, w = lineNm(up, lo), col = wlColor(w);
          x.strokeStyle = sel ? (col || T.hi) : (col || T.ghost3d); x.globalAlpha = sel ? 1 : 0.75; x.lineWidth = sel ? 3.2 : 1.2;
          const ya = Y(En(up)), yb = Y(En(lo));
          x.beginPath(); x.moveTo(xx, ya); x.lineTo(xx, yb - 5); x.stroke();
          x.fillStyle = x.strokeStyle; x.beginPath();
          if (sel && st.dir === 'ab') { x.moveTo(xx, ya); x.lineTo(xx - 4, ya + 7); x.lineTo(xx + 4, ya + 7); }
          else { x.moveTo(xx, yb); x.lineTo(xx - 4, yb - 7); x.lineTo(xx + 4, yb - 7); }
          x.fill(); x.globalAlpha = 1;
        });
      }
      // spectrum strip
      const sy = H - specH + 6, sh = 22, L0 = Math.log(90), L1 = Math.log(8000), X = w => ml + (Math.log(w) - L0) / (L1 - L0) * (W - ml - 14);
      x.fillStyle = T.surface; x.fillRect(ml, sy, W - ml - 14, sh); x.strokeStyle = T.line; x.strokeRect(ml, sy, W - ml - 14, sh);
      const g = x.createLinearGradient(X(380), 0, X(750), 0); [380, 440, 490, 510, 580, 645, 700, 750].forEach(w => g.addColorStop((w - 380) / 370, wlColor(w)));
      x.globalAlpha = 0.22; x.fillStyle = g; x.fillRect(X(380), sy, X(750) - X(380), sh); x.globalAlpha = 1;
      for (let lo = 1; lo <= 5; lo++) for (let up = lo + 1; up <= 7; up++) { const w = lineNm(up, lo); x.fillStyle = wlColor(w) || T.edge3d; x.fillRect(X(w) - 0.75, sy + 3, 1.5, sh - 6); }
      const w = nm(), xs = X(w);
      x.fillStyle = wlColor(w) || T.hi; x.fillRect(xs - 1.6, sy - 4, 3.2, sh + 8);
      x.fillStyle = T.ink; x.font = MFONT(600, 11); x.textAlign = xs > W - 80 ? 'right' : xs < 60 ? 'left' : 'center'; x.fillText(`${w.toFixed(w < 1000 ? 1 : 0)} nm`, xs, sy - 7);
      x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      [100, 200, 500, 1000, 2000, 5000].forEach(t => x.fillText(t, X(t), sy + sh + 13));
      x.font = FONT(500, 11); x.fillText(tx('UV', '紫外'), X(150), sy + sh + 27); x.fillText(tx('visible', '可見'), X(530), sy + sh + 27); x.fillText(nar ? tx('IR', '紅外') : tx('infrared', '紅外'), X(2500), sy + sh + 27);
      x.textAlign = 'right'; x.fillText(nar ? 'nm' : tx('wavelength, nm', '波長 nm'), W - 14, sy + sh + 27);
    }
    function text() {
      const dE = En(st.up) - En(st.lo), w = nm(), s = SERIES[st.lo - 1], em = st.dir === 'em';
      info.innerHTML = tx(`<h4>${nTxt(st.up)} ${em ? '→' : '←'} ${st.lo}: ${s[0]} series</h4>`, `<h4>${nTxt(st.up)} ${em ? '→' : '←'} ${st.lo}：${s[1]}系</h4>`) +
        `<div class="eq">ΔE = 13.6 (1/${st.lo}² − ${st.up >= NINF ? '0' : '1/' + st.up + '²'}) = ${dE.toFixed(2)} eV<br>λ = 1240 / ${dE.toFixed(2)} = ${w.toFixed(1)} nm</div>` +
        tx(`<dl class="stats"><dt>Photon energy</dt><dd>${sciH(dE * EV)} J</dd><dt>Light</dt><dd>${region(w)}</dd><dt>Orbit radii</dt><dd>r<sub>${st.lo}</sub> = ${(st.lo * st.lo * 0.0529).toFixed(3)} nm${st.up < NINF ? `, r<sub>${st.up}</sub> = ${(st.up * st.up * 0.0529).toFixed(3)} nm` : ''}</dd></dl>`,
          `<dl class="stats"><dt>光子能量</dt><dd>${sciH(dE * EV)} J</dd><dt>光的種類</dt><dd>${region(w)}</dd><dt>軌道半徑</dt><dd>r<sub>${st.lo}</sub> = ${(st.lo * st.lo * 0.0529).toFixed(3)} nm${st.up < NINF ? `，r<sub>${st.up}</sub> = ${(st.up * st.up * 0.0529).toFixed(3)} nm` : ''}</dd></dl>`) +
        (st.up >= NINF ? (em ? tx('<p class="note">A free electron captured by a proton. Running it the other way, 13.6 / n² eV is the energy needed to set the electron free.</p>', '<p class="note">自由電子被質子抓住。反過來，13.6 / n² eV 就是把電子放走所需的能量。</p>') : tx(`<p class="note">This photon sets the electron free: ionization from n = ${st.lo} takes ${(13.6 / st.lo / st.lo).toFixed(2)} eV.</p>`, `<p class="note">這顆光子讓電子脫離：從 n = ${st.lo} 游離需要 ${(13.6 / st.lo / st.lo).toFixed(2)} eV。</p>`))
          : tx(`<p class="note">${em ? 'The electron gives the energy difference away as one photon.' : 'Only a photon of exactly this energy is absorbed. Others pass straight through.'}</p>`, `<p class="note">${em ? '電子把能量差變成一顆光子放出去。' : '只有能量剛好等於這個差值的光子會被吸收，其他的直接穿過去。'}</p>`));
    }
    const draw = canvas2d($('#lv-cv'), paint);
    const sync = () => {
      $$('#bo-up button').forEach(b => { b.disabled = +b.dataset.v <= st.lo; });
      setSeg($('#bo-up'), String(st.up)); setSeg($('#bo-lo'), String(st.lo));
      if (v && !v.init) { rNow = rOf(startN()); job = null; v.rebuild(); v.frame(V3(0, 0, 0), FR); }
      draw(); text();
    };
    seg($('#bo-up'), u => { st.up = +u; sync(); });
    seg($('#bo-lo'), l => { st.lo = +l; if (st.up <= st.lo) st.up = st.lo + 1; sync(); });
    seg($('#bo-dir'), d => { st.dir = d; sync(); });
    $('#bo-go').addEventListener('click', () => { if (v && !v.init) go(); });
    if (v) v.lazy(() => { rNow = rOf(startN()); v.rebuild(); v.frame(V3(0, 0, 0), FR, [0.25, -1, 0.9]); });
    sync(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     04-1 Wave packet (2D)
     ===================================================================== */
  function secWp() {
    const dk = $('#wp-dk'), comp = $('#wp-comp'), info = $('#wp-info');
    const K = 15, k0 = 1.6, XR = 40;
    const sig = () => 0.012 + 0.38 * +dk.value;
    const comps = () => { const s = sig(); return Array.from({ length: K }, (_, j) => { const u = -2.2 + 4.4 * j / (K - 1); return { k: k0 + s * u, w: Math.exp(-u * u / 2) }; }); };
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 12, mr = 12, top = 22, mid = H * 0.6, bot = H - 34, cs = comps(), ws = cs.reduce((a, c) => a + c.w, 0);
      const X = xx => ml + (xx + XR) / (2 * XR) * (W - ml - mr), yW = top + (mid - top) / 2, aW = (mid - top) / 2 - 6;
      const psi = xx => cs.reduce((a, c) => a + c.w * Math.cos(c.k * xx), 0) / ws;
      x.strokeStyle = T.grid; x.lineWidth = 1; x.beginPath(); x.moveTo(ml, yW); x.lineTo(W - mr, yW); x.moveTo(ml, bot); x.lineTo(W - mr, bot); x.stroke();
      if (comp.checked) cs.forEach((c, j) => { if (j % 2) return; x.strokeStyle = T.ghost3d; x.globalAlpha = 0.25 + 0.6 * c.w; x.lineWidth = 1; x.beginPath(); for (let px = ml; px <= W - mr; px += 2) { const xx = (px - ml) / (W - ml - mr) * 2 * XR - XR, yy = yW - aW * Math.cos(c.k * xx); px === ml ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); });
      x.globalAlpha = 1; x.strokeStyle = COL.corner; x.lineWidth = 2.2; x.beginPath();
      for (let px = ml; px <= W - mr; px += 1.5) { const xx = (px - ml) / (W - ml - mr) * 2 * XR - XR, yy = yW - aW * psi(xx); px === ml ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke();
      // |ψ|² below
      const hP = bot - mid - 18; x.fillStyle = COL.corner; x.globalAlpha = 0.35; x.beginPath(); x.moveTo(ml, bot);
      for (let px = ml; px <= W - mr; px += 1.5) { const xx = (px - ml) / (W - ml - mr) * 2 * XR - XR, p = psi(xx); x.lineTo(px, bot - hP * p * p); } x.lineTo(W - mr, bot); x.closePath(); x.fill(); x.globalAlpha = 1;
      const s = sig(), dx = 1 / (Math.SQRT2 * s);
      if (dx < XR) { x.strokeStyle = T.hi; x.fillStyle = T.hi; x.lineWidth = 1.5; const ya = bot + 10; x.beginPath(); x.moveTo(X(-dx), ya); x.lineTo(X(dx), ya); x.moveTo(X(-dx), ya - 4); x.lineTo(X(-dx), ya + 4); x.moveTo(X(dx), ya - 4); x.lineTo(X(dx), ya + 4); x.stroke(); x.font = MFONT(600, 11); x.textAlign = 'left'; x.fillText('2Δx', X(dx) + 6, ya + 4); }
      x.fillStyle = T.muted; x.font = FONT(600, 11); x.textAlign = 'left';
      x.fillText(tx('ψ: the sum of the waves', 'ψ：所有波的和'), ml + 2, top - 6); x.fillText(tx('|ψ|²: probability density', '|ψ|²：機率密度'), ml + 2, mid + 12);
      // spectrum inset
      const iw = Math.min(150, W * 0.28), ih = 44, ix = W - mr - iw, iy = mid + 2;
      x.strokeStyle = T.line; x.strokeRect(ix, iy, iw, ih); x.fillStyle = T.muted; x.font = FONT(500, 10); x.textAlign = 'center'; x.fillText(tx('weights of the wave numbers k', '各波數 k 的權重'), ix + iw / 2, iy + ih + 11);
      const kx = k => ix + 6 + (k - (k0 - 1)) / 2 * (iw - 12);
      cs.forEach(c => { x.fillStyle = COL.corner; x.fillRect(kx(c.k) - 1, iy + ih - 4 - c.w * (ih - 10), 2.2, c.w * (ih - 10)); });
    }
    function text() {
      const s = sig(), dx = 1 / (Math.SQRT2 * s), dkk = s / Math.SQRT2;
      $('#wp-dk-v').textContent = dkk.toFixed(3);
      info.innerHTML = tx(`<dl class="stats"><dt>Spread in k (Δk)</dt><dd>${dkk.toFixed(3)}</dd><dt>Width of the packet (Δx)</dt><dd>${dx > XR ? '&gt; ' + XR : dx.toFixed(1)}</dd><dt>Δx · Δk</dt><dd>${(dx * dkk).toFixed(2)}</dd></dl>
        <p>${s < 0.05 ? 'Almost one wavelength: the wave runs on and on. Its momentum is sharp, but the particle could be anywhere.' : s > 0.3 ? 'Many wavelengths: the particle is pinned to a small region, but its momentum is now spread wide.' : 'Mixing more wavelengths makes the packet narrower. Position and momentum trade off.'}</p>
        <div class="eq">p = h / λ = ħk&emsp;⇒&emsp;Δx · Δp = ħ (Δx · Δk) ≥ ħ / 2 = h / 4π</div><p class="note">A Gaussian packet like this one reaches the limit exactly: Δx · Δk = 0.5.</p>`,
        `<dl class="stats"><dt>波數範圍 Δk</dt><dd>${dkk.toFixed(3)}</dd><dt>波包寬度 Δx</dt><dd>${dx > XR ? '&gt; ' + XR : dx.toFixed(1)}</dd><dt>Δx · Δk</dt><dd>${(dx * dkk).toFixed(2)}</dd></dl>
        <p>${s < 0.05 ? '幾乎只有一個波長：波一直延伸下去。動量很確定，但粒子可能在任何地方。' : s > 0.3 ? '混了很多波長：粒子被限制在一小區，但動量變得很分散。' : '混入越多波長，波包越窄。位置和動量此消彼長。'}</p>
        <div class="eq">p = h / λ = ħk　⇒　Δx · Δp = ħ (Δx · Δk) ≥ ħ / 2 = h / 4π</div><p class="note">像這樣的高斯波包剛好達到極限：Δx · Δk = 0.5。</p>`);
    }
    const draw = canvas2d($('#wp-cv'), paint);
    dk.addEventListener('input', () => { draw(); text(); }); comp.addEventListener('change', draw);
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     05 Orbitals: dot cloud, half cloud, density map, radial probability
     ===================================================================== */
  function secOrb() {
    const st = { n: 2, l: 1, m: 0, view: 'dots' }, info = $('#orb-info'), bohr = $('#orb-bohr');
    const mBox = $('#orb-m');
    const name = () => st.n + ANG[st.l][st.m].h;
    function mButtons() {
      mBox.innerHTML = ANG[st.l].map((a, i) => `<button type="button" data-v="${i}"${i === st.m ? ' aria-pressed="true"' : ''}>${a.h}<small>${a.m}</small></button>`).join('');
    }
    // the plane through the nucleus that shows most of the orbital
    function bestPlane() {
      const a = ANG[st.l][st.m].f, P = { xz: [V3(1, 0, 0), V3(0, 0, 1)], yz: [V3(0, 1, 0), V3(0, 0, 1)], xy: [V3(1, 0, 0), V3(0, 1, 0)] };
      let best = 'xz', bv = -1;
      for (const k of ['xz', 'yz', 'xy']) { let s = 0; for (let i = 0; i < 90; i++) { const t = i / 90 * 2 * Math.PI, d = P[k][0].clone().multiplyScalar(Math.cos(t)).addScaledVector(P[k][1], Math.sin(t)); s += a(d.x, d.y, d.z) ** 2; } if (s > bv * 1.02) { bv = s; best = k; } }
      return { k: best, u: P[best][0], w: P[best][1] };
    }
    const v = GL ? new Viewer($('#v-orb'), { view: [0.42, -1, 0.42], label: () => tx(`Electron cloud of the hydrogen ${name().replace(/<[^>]+>/g, '')} orbital`, `氫原子 ${name().replace(/<[^>]+>/g, '')} 軌域的電子雲`) }) : null;
    let Lv = 5, planeDir = null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root, s = orbSampler(st.n, st.l, st.m), f = orbF(st.n, st.l, ANG[st.l][st.m]);
      const full = s(st.view === 'slice' ? 20000 : 12000, 3 + st.n * 7 + st.l * 3 + st.m, st.view === 'slice' ? (x, y) => y >= 0 : null);
      Lv = radius95(full.pos) * 1.08;
      if (st.view === 'plane') {
        const P = bestPlane(), N = 256, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), img = x.createImageData(N, N);
        let mx = 0; const vals = new Float32Array(N * N);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = (i / (N - 1) * 2 - 1) * Lv, b = (1 - j / (N - 1) * 2) * Lv; const p = P.u.clone().multiplyScalar(a).addScaledVector(P.w, b); const val = f(p.x, p.y, p.z) * Math.hypot(a, b); vals[j * N + i] = val; mx = Math.max(mx, Math.abs(val)); }
        const cp = rgb(COL.corner), cn = rgb(COL.body);
        for (let k = 0; k < N * N; k++) { const val = vals[k], c3 = val >= 0 ? cp : cn, al = Math.pow(Math.abs(val) / mx, 0.55); img.data.set([c3[0] * 255, c3[1] * 255, c3[2] * 255, al * 245], k * 4); }
        x.putImageData(img, 0, 0);
        const tex = new THREE.CanvasTexture(c), pl = new THREE.Mesh(new THREE.PlaneGeometry(2 * Lv, 2 * Lv), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        pl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(P.u, P.w, P.u.clone().cross(P.w))); g.add(pl);
        planeDir = P.u.clone().cross(P.w).addScaledVector(P.w, 0.3).addScaledVector(P.u, 0.15);
        const e = Lv; dashed(g, [[P.u.clone().multiplyScalar(-e).addScaledVector(P.w, -e), P.u.clone().multiplyScalar(e).addScaledVector(P.w, -e)], [P.u.clone().multiplyScalar(e).addScaledVector(P.w, -e), P.u.clone().multiplyScalar(e).addScaledVector(P.w, e)], [P.u.clone().multiplyScalar(e).addScaledVector(P.w, e), P.u.clone().multiplyScalar(-e).addScaledVector(P.w, e)], [P.u.clone().multiplyScalar(-e).addScaledVector(P.w, e), P.u.clone().multiplyScalar(-e).addScaledVector(P.w, -e)]], T.edge3d, { dash: Lv * 0.04, gap: Lv * 0.03 });
        label(g, P.k + tx(' plane', ' 平面'), P.u.clone().multiplyScalar(Lv * 0.75).addScaledVector(P.w, Lv * 0.92), { size: Lv * 0.06, color: T.muted });
        cloudPts(g, s(2500, 99), 1.6, { opacity: 0.18 });
      } else if (st.view === 'surf') {
        orbSurface(st.n, st.l, st.m, full).forEach((o, i) => {
          if (!o.pos.length) return;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(o.pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.nor, 3));
          g.add(new THREE.Mesh(geo, mStd(i ? COL.body : COL.corner, { rough: 0.35 })));
        });
      } else cloudPts(g, full, st.view === 'slice' ? 2 : 2.2, { opacity: 0.8 });
      atom(g, V3(0, 0, 0), Lv * 0.018, T.ink);
      if (bohr.checked) g.add(new THREE.Mesh(new THREE.TorusGeometry(st.n * st.n, Lv * 0.005, 8, 200), mStd(COL.plane)));
      // axes
      const ax = Lv * 1.02, am = mBasic(T.edge3d, { opacity: 0.6 });
      [[V3(1, 0, 0), 'x'], [V3(0, 1, 0), 'y'], [V3(0, 0, 1), 'z']].forEach(([d, s2]) => { rod(g, d.clone().multiplyScalar(-ax), d.clone().multiplyScalar(ax), Lv * 0.003, am); label(g, s2, d.clone().multiplyScalar(ax * 1.06), { size: Lv * 0.06, color: T.muted }); });
    };
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 46, mr = 16, mt = 22, mb = 34, rmax = [0, 9, 22, 36, 52][st.n], X = r => ml + r / rmax * (W - ml - mr);
      const curves = []; for (let l = 0; l < st.n; l++) curves.push({ l, ...radialP(st.n, l, rmax) });
      const ymax = Math.max(...curves.map(c => Math.max(...c.ys))) * 1.12, Y = p => H - mb - p / ymax * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      const step = rmax > 30 ? 10 : rmax > 15 ? 5 : 2;
      for (let r = 0; r <= rmax; r += step) { x.beginPath(); x.moveTo(X(r), mt); x.lineTo(X(r), H - mb); x.stroke(); x.fillText(r, X(r), H - mb + 14); }
      x.fillText(tx('distance from the nucleus r (in units of a₀ = 0.0529 nm)', '離原子核的距離 r（單位 a₀ = 0.0529 nm）'), (ml + W - mr) / 2, H - 6);
      x.save(); x.translate(14, (mt + H - mb) / 2); x.rotate(-Math.PI / 2); x.fillText('P(r) = r²R²', 0, 0); x.restore();
      x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, H - mb); x.lineTo(W - mr, H - mb); x.stroke();
      // Bohr radius
      const rb = st.n * st.n; x.setLineDash([4, 4]); x.strokeStyle = COL.plane; x.lineWidth = 1.4; x.beginPath(); x.moveTo(X(rb), mt); x.lineTo(X(rb), H - mb); x.stroke(); x.setLineDash([]);
      x.fillStyle = COL.plane; x.font = FONT(600, 11); x.textAlign = 'left'; x.fillText(tx(`Bohr orbit ${rb}a₀`, `波耳軌道 ${rb}a₀`), X(rb) + 5, H - mb - 8);
      curves.forEach(c => {
        const on = c.l === st.l; x.strokeStyle = on ? T.accent : T.ghost3d; x.lineWidth = on ? 2.6 : 1.4; x.beginPath();
        c.xs.forEach((r, i) => { const px = X(r), py = Y(c.ys[i]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
        let im = 0; c.ys.forEach((y, i) => { if (y > c.ys[im]) im = i; });
        x.fillStyle = on ? T.ink : T.muted; x.font = MFONT(on ? 600 : 400, 11); x.textAlign = 'center'; x.fillText(st.n + LNAME[c.l], X(c.xs[im]), Y(c.ys[im]) - 7);
        if (on) {
          x.fillStyle = T.hi; x.beginPath(); x.arc(X(c.xs[im]), Y(c.ys[im]), 4, 0, 7); x.fill();
          for (let i = 2; i < c.xs.length; i++) { const a = Rnl(st.n, st.l, c.xs[i - 1]), b = Rnl(st.n, st.l, c.xs[i]); if (a * b < 0) { x.strokeStyle = T.hi; x.lineWidth = 1.5; x.beginPath(); x.arc(X(c.xs[i]), H - mb, 4, 0, 7); x.stroke(); } }
        }
      });
    }
    function text() {
      const n = st.n, l = st.l, rn = n - l - 1, an = l, P = radialP(n, l, [0, 9, 22, 36, 52][n]); let im = 0; P.ys.forEach((y, i) => { if (y > P.ys[im]) im = i; });
      const rm = P.xs[im], mean = (3 * n * n - l * (l + 1)) / 2;
      info.innerHTML = `<h4>${name()}</h4>` + tx(`<dl class="stats"><dt>Quantum numbers</dt><dd>n = ${n}, l = ${l}, m<sub>l</sub> = ${ANG[l][st.m].m}</dd><dt>Energy</dt><dd>${(-13.6 / n / n).toFixed(2)} eV</dd><dt>Radial nodes (spheres)</dt><dd>${rn}</dd><dt>Angular nodes (planes, cones)</dt><dd>${an}</dd><dt>Most likely r</dt><dd>${rm.toFixed(1)} a<sub>0</sub> = ${(rm * 0.0529).toFixed(3)} nm</dd><dt>Average r</dt><dd>${mean.toFixed(1)} a<sub>0</sub></dd></dl>`,
        `<dl class="stats"><dt>量子數</dt><dd>n = ${n}、l = ${l}、m<sub>l</sub> = ${ANG[l][st.m].m}</dd><dt>能量</dt><dd>${(-13.6 / n / n).toFixed(2)} eV</dd><dt>徑向節面（球面）</dt><dd>${rn}</dd><dt>角節面（平面、錐面）</dt><dd>${an}</dd><dt>最可能的 r</dt><dd>${rm.toFixed(1)} a<sub>0</sub> = ${(rm * 0.0529).toFixed(3)} nm</dd><dt>平均 r</dt><dd>${mean.toFixed(1)} a<sub>0</sub></dd></dl>`) +
        (n === 1 ? tx('<p class="note">The most likely distance is exactly a<sub>0</sub>, Bohr\'s first radius. Turn on the Bohr orbit to compare.</p>', '<p class="note">最可能的距離剛好是 a<sub>0</sub>，波耳的第一軌道半徑。打開波耳軌道比較看看。</p>')
          : tx(`<p class="note">Shell n = ${n} has ${n * n} orbitals (${[...Array(n).keys()].map(k => (2 * k + 1) + ' × ' + n + LNAME[k]).join(' + ')}), all at the same energy in hydrogen. With spin, it holds 2n² = ${2 * n * n} electrons.</p>`, `<p class="note">n = ${n} 這一層有 ${n * n} 個軌域（${[...Array(n).keys()].map(k => (2 * k + 1) + ' 個 ' + n + LNAME[k]).join(' + ')}），在氫原子裡能量全都一樣。算上自旋，可以放 2n² = ${2 * n * n} 個電子。</p>`)) +
        (st.view === 'surf' ? tx(`<p class="note">Boundary surface: the surface |ψ| = constant that holds 90% of the dot cloud, the shape drawn in textbooks (a ball for s, a dumbbell for p, a four-leaf clover for most d). It hides what is inside${n - l - 1 ? `: this orbital also has ${n - l - 1} inner radial node${n - l - 1 > 1 ? 's' : ''}, seen with Cut in half` : ''}.</p>`, `<p class="note">邊界面：把 90% 點雲包起來、|ψ| 相同的那一層表面，就是課本上畫的形狀（s 是球，p 是啞鈴，大部分 d 是四葉草）。它會遮住裡面的結構${n - l - 1 ? `：這個軌域裡面還有 ${n - l - 1} 個徑向節面，切到「剖半」才看得到` : ''}。</p>`) : st.view === 'plane' ? tx('<p class="note">Density map: one plane through the nucleus, coloured by the sign of ψ. The strength follows r·|ψ| so that the outer shells show as clearly as the inner ones. Blank lines and rings are nodes.</p>', '<p class="note">密度截面：穿過原子核的一個平面，顏色代表 ψ 的正負號。深淺按 r·|ψ| 畫，外層殼才會和內層一樣清楚。空白的線和圓圈就是節面。</p>') : st.view === 'slice' ? tx('<p class="note">The front half is cut away, so you look into the cloud. Empty shells inside are radial nodes.</p>', '<p class="note">前半邊切掉了，可以看進電子雲裡面。裡面空掉的球殼就是徑向節面。</p>') : '');
    }
    const draw = canvas2d($('#rad-cv'), paint);
    const up = (reframe) => { if (v && !v.init) { v.rebuild(); if (reframe) v.frame(V3(0, 0, 0), Lv * 1.12, st.view === 'plane' && planeDir ? planeDir.toArray() : null); } draw(); text(); };
    const syncL = () => { $$('#orb-l button').forEach(b => { b.disabled = +b.dataset.v >= st.n; }); setSeg($('#orb-l'), String(st.l)); mButtons(); };
    seg($('#orb-n'), n => { st.n = +n; if (st.l >= st.n) { st.l = st.n - 1; st.m = 0; } syncL(); up(true); });
    seg($('#orb-l'), l => { st.l = +l; st.m = 0; mButtons(); up(true); });
    seg(mBox, m => { st.m = +m; up(false); });
    seg($('#orb-view'), m => { st.view = m; up(true); });
    bohr.addEventListener('change', () => up(false));
    syncL();
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), Lv * 1.12); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     06 Electron configuration
     ===================================================================== */
  const ELS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr'.split(' ');
  const ELZ = '氫 氦 鋰 鈹 硼 碳 氮 氧 氟 氖 鈉 鎂 鋁 矽 磷 硫 氯 氬 鉀 鈣 鈧 鈦 釩 鉻 錳 鐵 鈷 鎳 銅 鋅 鎵 鍺 砷 硒 溴 氪'.split(' ');
  const ELE = 'Hydrogen Helium Lithium Beryllium Boron Carbon Nitrogen Oxygen Fluorine Neon Sodium Magnesium Aluminium Silicon Phosphorus Sulfur Chlorine Argon Potassium Calcium Scandium Titanium Vanadium Chromium Manganese Iron Cobalt Nickel Copper Zinc Gallium Germanium Arsenic Selenium Bromine Krypton'.split(' ');
  const SUBS = [[1, 0], [2, 0], [2, 1], [3, 0], [3, 1], [4, 0], [3, 2], [4, 1], [5, 0]];
  const SUPN = s => String(s).replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  function config(Z, q) {
    const occ = SUBS.map(() => 0); let e = Z;
    SUBS.forEach(([n, l], i) => { const c = Math.min(e, 4 * l + 2); occ[i] = c; e -= c; });
    if (Z === 24 || Z === 29) { occ[5] = 1; occ[6] += 1; } // Cr, Cu: one 4s electron moves to 3d
    let left = Z - q;
    if (q > 0) { // remove from the highest n first, then highest l
      const order = SUBS.map((s, i) => i).sort((a, b) => SUBS[b][0] - SUBS[a][0] || SUBS[b][1] - SUBS[a][1]);
      let r = q; for (const i of order) { const t = Math.min(r, occ[i]); occ[i] -= t; r -= t; if (!r) break; }
    } else if (q < 0) { let a = -q; SUBS.forEach(([n, l], i) => { const t = Math.min(a, 4 * l + 2 - occ[i]); occ[i] += t; a -= t; }); }
    return { occ, total: Math.max(0, left) };
  }
  function secEc() {
    const zS = $('#ec-z'), box = $('#ec-boxes'), info = $('#ec-info'); let q = 0;
    function render() {
      const Z = +zS.value, { occ, total } = config(Z, q);
      $('#ec-z-v').textContent = `${Z} · ${ELS[Z - 1]}`;
      const nmax = Math.max(0, ...SUBS.map(([n], i) => (occ[i] ? n : 0)));
      box.innerHTML = SUBS.slice().map((s, i) => [s, i]).reverse().filter(([[n, l], i]) => i <= 7).map(([[n, l], i]) => {
        const k = 2 * l + 1, c = occ[i], arrows = []; for (let b = 0; b < k; b++) arrows.push((c > b ? '↑' : '') + (c > k + b ? '↓' : ''));
        return `<div class="sub${n === nmax && c ? ' val' : ''}"><span>${n}${LNAME[l]}</span><span class="bx">${arrows.map(a => `<i>${a}</i>`).join('')}</span><span class="note">${c}/${2 * k}</span></div>`;
      }).join('') + `<p class="note">${tx('Higher rows are higher in energy (filling order for neutral atoms).', '越上面的列能量越高（中性原子的填入順序）。')}</p>`;
      // configuration written by n, with a noble-gas core
      const byN = SUBS.map((s, i) => ({ n: s[0], l: s[1], c: occ[i] })).filter(o => o.c).sort((a, b) => a.n - b.n || a.l - b.l);
      const full = byN.map(o => `${o.n}${LNAME[o.l]}<sup>${o.c}</sup>`).join(' ');
      const cores = [[18, '[Ar]', 5], [10, '[Ne]', 3], [2, '[He]', 1]];
      let short = full;
      for (const [ne, sym, cnt] of cores) {
        const core = SUBS.slice(0, cnt).map(([n, l]) => ({ n, l })), ok = core.every(cs => { const o = byN.find(b => b.n === cs.n && b.l === cs.l); return o && o.c === 4 * cs.l + 2; });
        if (ok && total > ne) { short = sym + ' ' + byN.filter(o => !core.some(cs => cs.n === o.n && cs.l === o.l)).map(o => `${o.n}${LNAME[o.l]}<sup>${o.c}</sup>`).join(' '); break; }
      }
      let unp = 0; SUBS.forEach(([n, l], i) => { const k = 2 * l + 1, c = occ[i]; unp += c <= k ? c : 2 * k - c; });
      const ion = q ? `${ELS[Z - 1]}${q > 0 ? (q > 1 ? q : '') + '⁺' : (-q > 1 ? -q : '') + '⁻'}`.replace(/(\d)([⁺⁻])/, (m, d, s) => SUPN(d) + s) : ELS[Z - 1];
      const notes = [];
      if (!q && (Z === 24 || Z === 29)) notes.push(tx(`Exception: one 4s electron moves into 3d, giving a ${Z === 24 ? 'half-full' : 'full'} 3d set, which is extra stable.`, `例外：一個 4s 電子移進 3d，讓 3d ${Z === 24 ? '半滿' : '全滿'}，特別穩定。`));
      if (q > 0 && Z >= 21 && Z <= 30) notes.push(tx('The 4s electrons leave first, even though 4s filled before 3d.', '4s 電子先離開，雖然 4s 比 3d 先填。'));
      if ([2, 10, 18, 36].includes(total) && total > 0) notes.push(tx('Noble-gas configuration: every shell that is occupied is full.', '惰性氣體組態：有電子的殼層都是滿的。'));
      if (q < 0 && total > 36) notes.push(tx('Beyond what this table shows.', '超出這張表的範圍。'));
      info.innerHTML = `<h4>${ion} · ${tx(ELE[Z - 1], ELZ[Z - 1])}</h4>` + (total ? `<p class="conf">${full}</p>${short !== full ? `<p class="conf">= ${short}</p>` : ''}` : `<p>${tx('No electrons left: a bare nucleus.', '沒有電子了：只剩原子核。')}</p>`) +
        tx(`<dl class="stats"><dt>Electrons</dt><dd>${total}</dd><dt>Unpaired electrons</dt><dd>${unp}</dd></dl>`, `<dl class="stats"><dt>電子數</dt><dd>${total}</dd><dt>未配對電子</dt><dd>${unp}</dd></dl>`) +
        notes.map(t => `<p class="note">${t}</p>`).join('');
      $$('#ec-q button').forEach(b => { const qq = +b.dataset.v; b.disabled = Z - qq < 0 || Z - qq > 36; });
    }
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 46, mr = 16, mt = 26, mb = 34, rmax = 40, X = r => ml + r / rmax * (W - ml - mr);
      const c4 = radialP(4, 0, rmax), c3 = radialP(3, 2, rmax), ymax = Math.max(...c3.ys) * 1.1, Y = p => H - mb - p / ymax * (H - mt - mb);
      x.fillStyle = T.surface; x.fillRect(ml, mt, X(2.2) - ml, H - mt - mb);
      x.fillStyle = T.muted; x.font = FONT(500, 11); x.textAlign = 'left'; x.fillText(tx('inside the 1s, 2s shells', '1s、2s 殼層裡面'), ml + 4, mt - 8);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.textAlign = 'center';
      for (let r = 0; r <= rmax; r += 5) { x.beginPath(); x.moveTo(X(r), mt); x.lineTo(X(r), H - mb); x.stroke(); x.fillText(r, X(r), H - mb + 14); }
      x.fillText(tx('r (a₀), hydrogen-like shapes', 'r（a₀），類氫原子的形狀'), (ml + W - mr) / 2, H - 6);
      [[c3, COL.body, '3d'], [c4, COL.corner, '4s']].forEach(([c, col, nmz]) => {
        x.strokeStyle = col; x.lineWidth = 2.4; x.beginPath(); c.xs.forEach((r, i) => { const px = X(r), py = Y(c.ys[i]); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
        let im = 0; c.ys.forEach((y, i) => { if (y > c.ys[im]) im = i; }); x.fillStyle = col; x.font = MFONT(600, 12); x.textAlign = 'center'; x.fillText(nmz, X(c.xs[im]), Y(c.ys[im]) - 8);
      });
      x.fillStyle = COL.corner; x.font = FONT(600, 11); x.textAlign = 'left'; x.fillText(tx('← the small 4s humps reach in here, where shielding is weak', '← 4s 的小峰伸進這裡，這裡的屏蔽很弱'), X(2.6), mt + 14);
    }
    zS.addEventListener('input', () => { if (+zS.value - q < 0 || +zS.value - q > 36) { q = 0; setSeg($('#ec-q'), '0'); } render(); });
    $$('[data-z]').forEach(b => b.addEventListener('click', () => { zS.value = b.dataset.z; q = 0; setSeg($('#ec-q'), '0'); render(); }));
    seg($('#ec-q'), v2 => { q = +v2; render(); });
    const draw = canvas2d($('#pen-cv'), paint);
    render(); onLang(render);
    return () => draw();
  }

  /* =====================================================================
     07 Electronegativity bars
     ===================================================================== */
  // [symbol, period, group, X] Pauling values as tabulated by Callister
  const EN = `H 1 1 2.1|Li 2 1 1.0|Be 2 2 1.5|B 2 13 2.0|C 2 14 2.5|N 2 15 3.0|O 2 16 3.5|F 2 17 4.0|Na 3 1 0.9|Mg 3 2 1.2|Al 3 13 1.5|Si 3 14 1.8|P 3 15 2.1|S 3 16 2.5|Cl 3 17 3.0|K 4 1 0.8|Ca 4 2 1.0|Sc 4 3 1.3|Ti 4 4 1.5|V 4 5 1.6|Cr 4 6 1.6|Mn 4 7 1.5|Fe 4 8 1.8|Co 4 9 1.8|Ni 4 10 1.8|Cu 4 11 1.9|Zn 4 12 1.6|Ga 4 13 1.6|Ge 4 14 1.8|As 4 15 2.0|Se 4 16 2.4|Br 4 17 2.8|Rb 5 1 0.8|Sr 5 2 1.0|Y 5 3 1.2|Zr 5 4 1.4|Nb 5 5 1.6|Mo 5 6 1.8|Tc 5 7 1.9|Ru 5 8 2.2|Rh 5 9 2.2|Pd 5 10 2.2|Ag 5 11 1.9|Cd 5 12 1.7|In 5 13 1.7|Sn 5 14 1.8|Sb 5 15 1.9|Te 5 16 2.1|I 5 17 2.5|Cs 6 1 0.7|Ba 6 2 0.9|La 6 3 1.1|Hf 6 4 1.3|Ta 6 5 1.5|W 6 6 1.7|Re 6 7 1.9|Os 6 8 2.2|Ir 6 9 2.2|Pt 6 10 2.2|Au 6 11 2.4|Hg 6 12 1.9|Tl 6 13 1.8|Pb 6 14 1.8|Bi 6 15 1.9|Po 6 16 2.0|At 6 17 2.2|Fr 7 1 0.7|Ra 7 2 0.9`
    .split('|').map(s => { const [sym, p, g, x] = s.split(' '); return { sym, p: +p, g: +g, x: +x }; });
  const NONMETAL = new Set('H C N O F P S Cl Se Br I'.split(' ')), METALLOID = new Set('B Si Ge As Sb Te Po At'.split(' '));
  function secEn() {
    const info = $('#en-info'), sa = $('#en-a'), sb = $('#en-b'), st = { a: 'Na', b: 'Cl', next: 'a' };
    const opts = EN.map(e => `<option value="${e.sym}">${e.sym} · ${e.x.toFixed(1)}</option>`).join(''); sa.innerHTML = opts; sb.innerHTML = opts;
    const get = s => EN.find(e => e.sym === s);
    const pos = e => V3(e.g - 9.5, 4 - e.p, 0);
    const v = GL ? new Viewer($('#v-en'), { view: [0.05, -1, 1.05], label: () => tx('Periodic table with bars as tall as the electronegativity', '柱高等於電負度的週期表') }) : null;
    let bars = [];
    const ramp = x => new THREE.Color(COL.body).lerp(new THREE.Color(COL.corner), Math.min(1, Math.max(0, (x - 0.7) / 3.3)));
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root; bars = [];
      const box = new THREE.BoxGeometry(0.84, 0.84, 1);
      EN.forEach(e => {
        const sel = e.sym === st.a ? T.hi : e.sym === st.b ? COL.face : null, h = e.x * 1.1, p = pos(e);
        const m = new THREE.Mesh(box, mStd(sel || ramp(e.x))); m.scale.z = h; m.position.set(p.x, p.y, h / 2); m.userData.sym = e.sym; g.add(m); bars.push(m);
        label(g, e.sym, V3(p.x, p.y - 0.05, h + 0.32), { size: sel ? 0.42 : 0.3, color: sel ? T.ink : T.muted, weight: sel ? 700 : 500 });
      });
      const base = new THREE.Mesh(new THREE.PlaneGeometry(19, 8), mBasic(T.grid, { opacity: 0.6, side: THREE.DoubleSide })); base.position.set(0, 0, -0.01); g.add(base);
      label(g, tx('electropositive', '正電性'), V3(-8.5, -3.9, 0.1), { size: 0.38, color: COL.body });
      label(g, tx('electronegative', '負電性'), V3(7.5, 3.6, 0.1), { size: 0.38, color: COL.corner });
    };
    if (v) {
      let down = null; const ray = new THREE.Raycaster();
      v.cv.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
      v.cv.addEventListener('pointerup', e => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5 || (COARSE && !v.live)) return;
        const r = v.cv.getBoundingClientRect(); ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, v.cam);
        const hit = ray.intersectObjects(bars)[0]; if (!hit) return;
        st[st.next] = hit.object.userData.sym; st.next = st.next === 'a' ? 'b' : 'a'; setSeg($('#en-pre'), ''); up();
      });
    }
    function text() {
      const A = get(st.a), B = get(st.b), d = Math.abs(A.x - B.x), pc = (1 - Math.exp(-0.25 * d * d)) * 100;
      const metal = s => !NONMETAL.has(s) && !METALLOID.has(s);
      const kind = metal(A.sym) && metal(B.sym) ? tx('Both are metals: metallic bonding (Unit 10).', '兩個都是金屬：金屬鍵（第 10 單元）。')
        : d < 0.05 ? tx('Identical pull: a purely covalent bond.', '拉力一樣：純共價鍵。') : pc < 10 ? tx('Mostly covalent, slightly polar.', '大致是共價鍵，帶一點極性。')
          : pc < 50 ? tx('Polar covalent: shared, but unequally.', '極性共價鍵：共用，但不平均。') : tx('Mostly ionic: the electron is largely transferred.', '大致是離子鍵：電子大部分被搬走。');
      sa.value = st.a; sb.value = st.b;
      info.innerHTML = tx(`<dl class="stats"><dt>X<sub>A</sub> (${A.sym})</dt><dd>${A.x.toFixed(1)}</dd><dt>X<sub>B</sub> (${B.sym})</dt><dd>${B.x.toFixed(1)}</dd><dt>ΔX</dt><dd>${d.toFixed(1)}</dd><dt>Ionic character</dt><dd>${pc.toFixed(0)}%</dd></dl>`,
        `<dl class="stats"><dt>X<sub>A</sub>（${A.sym}）</dt><dd>${A.x.toFixed(1)}</dd><dt>X<sub>B</sub>（${B.sym}）</dt><dd>${B.x.toFixed(1)}</dd><dt>ΔX</dt><dd>${d.toFixed(1)}</dd><dt>離子性</dt><dd>${pc.toFixed(0)}%</dd></dl>`) +
        `<div class="eq">1 − exp(−¼ × ${d.toFixed(1)}²) = ${(pc / 100).toFixed(3)}</div><p>${kind}</p>` + tx(`<p class="note">Next click on a bar sets atom ${st.next.toUpperCase()}.</p>`, `<p class="note">下一次點柱子會設定原子 ${st.next.toUpperCase()}。</p>`);
    }
    const up = () => { if (v && !v.init) v.rebuild(); text(); };
    seg($('#en-pre'), p => { [st.a, st.b] = p.split(','); st.next = 'a'; up(); });
    sa.addEventListener('change', () => { st.a = sa.value; setSeg($('#en-pre'), ''); up(); });
    sb.addEventListener('change', () => { st.b = sb.value; setSeg($('#en-pre'), ''); up(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 1.2), 9.6); });
    text(); onLang(up);
  }

  /* =====================================================================
     08 Ion pair: force and energy curves (2D)
     ===================================================================== */
  function secPe() {
    const nS = $('#pe-n'), tS = $('#pe-T'), info = $('#pe-info'); let Z = 1;
    const KE = 1.44; // e²/4πε0 in eV·nm
    const a0 = () => (Z === 1 ? 0.276 : 0.210), n = () => +nS.value;
    const b = () => Z * KE * a0() ** (n() - 1) / n();
    const E = a => -Z * KE / a + b() / a ** n(), Ea = a => -Z * KE / a, Er = a => b() / a ** n();
    const F = a => (Z * KE / (a * a) - n() * b() / a ** (n() + 1)) * 0.1602; // nN, attraction positive (slide convention)
    const Fa = a => Z * KE / (a * a) * 0.1602, Fr = a => -n() * b() / a ** (n() + 1) * 0.1602;
    const E0 = () => E(a0());
    // turning points at energy level e (bisection on each side of a0)
    function turns(e) {
      const bis = (lo, hi) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if ((E(m) - e) * (E(lo) - e) > 0) lo = m; else hi = m; } return (lo + hi) / 2; };
      return [bis(a0() * 0.5, a0()), bis(a0(), a0() * 8)];
    }
    function paint(x, W, H) {
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const ml = 54, mr = 14, gap = 30, mt = 18, mb = 34, xmin = 0.12, xmax = 0.8, ph = (H - mt - mb - gap) / 2;
      const X = a => ml + (a - xmin) / (xmax - xmin) * (W - ml - mr);
      const e0 = E0(), fmax = Fa(a0()) * 2.6, emax = -e0 * 1.6;
      const panel = (y0, lo, hi, ylab, ticks) => {
        const Y = v2 => y0 + (hi - v2) / (hi - lo) * ph;
        x.strokeStyle = T.grid; x.lineWidth = 1; x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'right';
        ticks.forEach(t => { x.beginPath(); x.moveTo(ml, Y(t)); x.lineTo(W - mr, Y(t)); x.stroke(); x.fillText(t.toFixed(Math.abs(t) < 10 && t % 1 ? 1 : 0), ml - 6, Y(t) + 3); });
        x.strokeStyle = T.edge3d; x.beginPath(); x.moveTo(ml, Y(0)); x.lineTo(W - mr, Y(0)); x.stroke();
        x.save(); x.translate(13, y0 + ph / 2); x.rotate(-Math.PI / 2); x.textAlign = 'center'; x.font = FONT(500, 11); x.fillText(ylab, 0, 0); x.restore();
        return Y;
      };
      const curve = (Y, f, col, lw, lo, hi, dash) => { x.save(); x.beginPath(); x.rect(ml, Y(hi), W - ml - mr, Y(lo) - Y(hi)); x.clip(); x.strokeStyle = col; x.lineWidth = lw; x.setLineDash(dash || []); x.beginPath(); for (let px = ml; px <= W - mr; px += 1.5) { const a = xmin + (px - ml) / (W - ml - mr) * (xmax - xmin), yy = Math.max(-1e4, Math.min(1e4, Y(f(a)))); px === ml ? x.moveTo(px, yy) : x.lineTo(px, yy); } x.stroke(); x.restore(); };
      const fstep = fmax > 12 ? 10 : fmax > 5 ? 2 : 1, ft = []; for (let t = Math.ceil(-fmax / fstep) * fstep; t <= fmax; t += fstep) ft.push(t);
      const YF = panel(mt, -fmax, fmax, tx('force (nN)', '力（nN）'), ft);
      curve(YF, Fa, COL.corner, 1.5, -fmax, fmax, [5, 4]); curve(YF, Fr, COL.body, 1.5, -fmax, fmax, [5, 4]); curve(YF, F, T.accent, 2.4, -fmax, fmax);
      x.fillStyle = T.muted; x.font = FONT(500, 11); x.textAlign = 'left'; x.fillText(tx('attraction (+)', '吸引（+）'), X(0.52), YF(Fa(0.52)) - 6); x.fillText(tx('repulsion (−)', '排斥（−）'), X(a0() * 0.86) + 8, YF(-fmax * 0.8));
      const y1 = mt + ph + gap, estep = emax > 20 ? 10 : emax > 6 ? 2 : 1, et = []; for (let t = -Math.floor(emax / estep) * estep; t <= emax; t += estep) et.push(t);
      const YE = panel(y1, -emax, emax, tx('energy (eV)', '能量（eV）'), et);
      curve(YE, Ea, COL.corner, 1.5, -emax, emax, [5, 4]); curve(YE, Er, COL.body, 1.5, -emax, emax, [5, 4]); curve(YE, E, T.accent, 2.4, -emax, emax);
      // a0 line through both panels
      x.setLineDash([3, 4]); x.strokeStyle = COL.plane; x.lineWidth = 1.3; x.beginPath(); x.moveTo(X(a0()), mt); x.lineTo(X(a0()), y1 + ph); x.stroke(); x.setLineDash([]);
      x.fillStyle = COL.plane; x.font = MFONT(600, 11); x.textAlign = 'left'; x.fillText(`a₀ = ${a0().toFixed(3)} nm`, X(a0()) + 5, mt + 11);
      x.fillText(`E₀ = ${e0.toFixed(2)} eV`, X(a0()) + 5, YE(e0) + 15);
      // vibration at temperature T: turning points and their midpoint, plus the locus of midpoints
      const T0 = +tS.value;
      x.strokeStyle = T.hi; x.setLineDash([2, 3]); x.lineWidth = 1.2; x.beginPath();
      for (let k = 0; k <= 30; k++) { const e = e0 * (1 - 0.65 * k / 30), [l, r] = turns(e), xm = X((l + r) / 2), yy = YE(e); k ? x.lineTo(xm, yy) : x.moveTo(xm, yy); } x.stroke(); x.setLineDash([]);
      if (T0 > 0.005) {
        const e = e0 * (1 - 0.65 * T0), [l, r] = turns(e); x.strokeStyle = T.hi; x.lineWidth = 2; x.beginPath(); x.moveTo(X(l), YE(e)); x.lineTo(X(r), YE(e)); x.stroke();
        x.fillStyle = T.hi; x.beginPath(); x.arc(X((l + r) / 2), YE(e), 4.5, 0, 7); x.fill();
      }
      x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      for (let a = 0.2; a <= xmax + 1e-9; a += 0.1) x.fillText(a.toFixed(1), X(a), H - mb + 14);
      x.fillText(tx('distance between ion centres a (nm)', '離子中心距離 a（nm）'), (ml + W - mr) / 2, H - 5);
    }
    function text() {
      const e0 = E0(), T0 = +tS.value, [l, r] = turns(e0 * (1 - 0.65 * T0)), mean = T0 > 0.005 ? (l + r) / 2 : a0();
      const h = 1e-4, k = (E(a0() + h) - 2 * e0 + E(a0() - h)) / (h * h);
      $('#pe-n-v').textContent = n(); $('#pe-T-v').textContent = T0 < 0.01 ? '0 K' : tx(`${Math.round(T0 * 100)}% of the way to breaking`, `已達斷鍵的 ${Math.round(T0 * 100)}%`);
      info.innerHTML = tx(`<dl class="stats"><dt>Equilibrium a₀</dt><dd>${a0().toFixed(3)} nm</dd><dt>Bond energy E₀</dt><dd>${e0.toFixed(2)} eV = ${sciH(e0 * EV)} J</dd><dt>Attraction at a₀</dt><dd>${Fa(a0()).toFixed(2)} nN</dd><dt>Curvature at a₀</dt><dd>${k.toFixed(0)} eV/nm²</dd><dt>Mean spacing at this T</dt><dd>${mean.toFixed(4)} nm (+${((mean / a0() - 1) * 100).toFixed(1)}%)</dd></dl>`,
        `<dl class="stats"><dt>平衡距離 a₀</dt><dd>${a0().toFixed(3)} nm</dd><dt>鍵能 E₀</dt><dd>${e0.toFixed(2)} eV = ${sciH(e0 * EV)} J</dd><dt>a₀ 處的吸引力</dt><dd>${Fa(a0()).toFixed(2)} nN</dd><dt>a₀ 處的曲率</dt><dd>${k.toFixed(0)} eV/nm²</dd><dt>這個溫度的平均間距</dt><dd>${mean.toFixed(4)} nm（+${((mean / a0() - 1) * 100).toFixed(1)}%）</dd></dl>`) +
        (Z === 1 && n() === 9 ? tx('<div class="eq">b = 8.59 × 10⁻¹⁰⁶ N·m¹⁰ (slide 47)<br>E = −8.34 × 10⁻¹⁹ + 0.92 × 10⁻¹⁹ = −7.42 × 10⁻¹⁹ J</div>', '<div class="eq">b = 8.59 × 10⁻¹⁰⁶ N·m¹⁰（投影片第 47 頁）<br>E = −8.34 × 10⁻¹⁹ + 0.92 × 10⁻¹⁹ = −7.42 × 10⁻¹⁹ J</div>') : '') +
        tx(`<p class="note">${Z === 4 ? 'Doubling both charges makes the attraction four times stronger: the well is about five times deeper and much steeper. This is why MgO melts at 2852 °C and NaCl at 801 °C.' : 'Raise the temperature: the pair vibrates between the two ends of the red line. The outer wall is gentler, so the midpoint (the mean spacing) moves outward. That is thermal expansion.'}</p>`,
          `<p class="note">${Z === 4 ? '兩邊電荷都加倍，吸引力變成四倍：井深了大約五倍，也陡了很多。所以 MgO 的熔點是 2852 °C，NaCl 只有 801 °C。' : '把溫度調高：離子對在紅線兩端之間振動。外側井壁比較緩，所以中點（平均間距）往外移。這就是熱膨脹。'}</p>`);
    }
    const draw = canvas2d($('#pe-cv'), paint);
    const up = () => { draw(); text(); };
    nS.addEventListener('input', up); tS.addEventListener('input', up); seg($('#pe-z'), z => { Z = +z; up(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     08-1 Radius ratio and coordination number (3D)
     ===================================================================== */
  function secCn() {
    const rS = $('#cn-r'), info = $('#cn-info'); let force = 0;
    const s3 = 1 / S3;
    const GEOM = {
      3: { d: [[1, 0, 0], [-0.5, 0.866, 0], [-0.5, -0.866, 0]], f: S3, crit: 2 / S3 - 1, en: 'triangle', zh: '三角形' },
      4: { d: [[s3, s3, s3], [s3, -s3, -s3], [-s3, s3, -s3], [-s3, -s3, s3]], f: Math.sqrt(8 / 3), crit: Math.sqrt(1.5) - 1, en: 'tetrahedron', zh: '四面體' },
      6: { d: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], f: S2, crit: S2 - 1, en: 'octahedron', zh: '八面體' },
      8: { d: [[s3, s3, s3], [s3, s3, -s3], [s3, -s3, s3], [s3, -s3, -s3], [-s3, s3, s3], [-s3, s3, -s3], [-s3, -s3, s3], [-s3, -s3, -s3]], f: 2 / S3, crit: S3 - 1, en: 'cube', zh: '立方體' }
    };
    const best = r => (r >= GEOM[8].crit ? 8 : r >= GEOM[6].crit ? 6 : r >= GEOM[4].crit ? 4 : 3);
    const cn = () => force || best(+rS.value);
    const v = GL ? new Viewer($('#v-cn'), { view: [1, -0.62, 0.5], label: () => tx('A cation surrounded by anions', '被陰離子包圍的陽離子') }) : null;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root, r = +rS.value, G = GEOM[cn()], d = Math.max(1 + r, 2 / G.f);
      const ps = G.d.map(a => V3(...a).multiplyScalar(d));
      atom(g, V3(0, 0, 0), r, COL.body);
      ps.forEach(p => atom(g, p, 1, COL.corner, { opacity: 0.42, order: 5 }));
      ps.forEach(p => rod(g, V3(0, 0, 0), p, 0.025, mStd(T.edge3d)));
      // edges of the coordination polyhedron (nearest anion pairs)
      const em = mStd(COL.plane), dmin = Math.min(...ps.flatMap((p, i) => ps.slice(i + 1).map(q => p.distanceTo(q))));
      ps.forEach((p, i) => ps.slice(i + 1).forEach(q => { if (p.distanceTo(q) < dmin * 1.01) rod(g, p, q, 0.02, em); }));
      if (d > 1 + r + 0.004) ps.forEach(p => { const u = p.clone().normalize(); rod(g, u.clone().multiplyScalar(r), u.clone().multiplyScalar(d - 1), 0.045, mStd(T.hi)); });
    };
    function text() {
      const r = +rS.value, c = cn(), G = GEOM[c], b = best(r), rattle = r < G.crit - 1e-9;
      $('#cn-r-v').textContent = r.toFixed(3);
      const der = { 3: '2r<sub>A</sub> = √3 (r<sub>A</sub> + r<sub>C</sub>) ⇒ r<sub>C</sub>/r<sub>A</sub> = 2/√3 − 1 = 0.155', 4: '2r<sub>A</sub> = √(8/3) (r<sub>A</sub> + r<sub>C</sub>) ⇒ r<sub>C</sub>/r<sub>A</sub> = √(3/2) − 1 = 0.225', 6: '2r<sub>A</sub> = √2 (r<sub>A</sub> + r<sub>C</sub>) ⇒ r<sub>C</sub>/r<sub>A</sub> = √2 − 1 = 0.414', 8: '2r<sub>A</sub> = (2/√3)(r<sub>A</sub> + r<sub>C</sub>) ⇒ r<sub>C</sub>/r<sub>A</sub> = √3 − 1 = 0.732' }[c];
      info.innerHTML = tx(`<h4>CN ${c}: ${G.en}</h4>`, `<h4>CN ${c}：${G.zh}</h4>`) +
        (rattle ? tx(`<p><span class="pill bad">Unstable</span> The anions touch each other before they reach the cation. The cation rattles in its cage (red gaps). It needs r<sub>C</sub>/r<sub>A</sub> ≥ ${G.crit.toFixed(3)}.</p>`, `<p><span class="pill bad">不穩定</span>　陰離子還沒碰到陽離子就先互相碰到了，陽離子在籠子裡晃（紅色空隙）。需要 r<sub>C</sub>/r<sub>A</sub> ≥ ${G.crit.toFixed(3)}。</p>`)
          : c < b ? tx(`<p><span class="pill ok">Stable</span> but wasteful: this cation is big enough for CN ${b}, so it would take more neighbors.</p>`, `<p><span class="pill ok">穩定</span>　但浪費：這個陽離子大到可以有 CN ${b}，它會想要更多鄰居。</p>`)
            : tx(`<p><span class="pill ok">Stable</span> Every anion touches the cation${Math.abs(r - G.crit) < 0.006 ? ', and at this exact ratio the anions also touch each other' : ''}.</p>`, `<p><span class="pill ok">穩定</span>　每個陰離子都碰得到陽離子${Math.abs(r - G.crit) < 0.006 ? '，而且剛好在這個比例時陰離子之間也互相接觸' : ''}。</p>`)) +
        `<div class="eq">${der}</div>`;
    }
    const up = () => { if (v && !v.init) v.rebuild(); text(); };
    rS.addEventListener('input', up);
    $$('[data-r]').forEach(b => b.addEventListener('click', () => { rS.value = b.dataset.r; force = 0; setSeg($('#cn-cn'), '0'); up(); }));
    seg($('#cn-cn'), c => { force = +c; up(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 3.6); });
    text(); onLang(text);
  }

  /* =====================================================================
     09 sp³ hybrids from hydrogen 2s and 2p
     ===================================================================== */
  function secSp() {
    const info = $('#sp-info'); let mode = 'h1';
    const R20 = r => (2 - r) * Math.exp(-r / 2) / (2 * S2), R21 = r => r * Math.exp(-r / 2) / (2 * Math.sqrt(6));
    const Y0 = 1 / (2 * Math.sqrt(Math.PI)), Y1 = Math.sqrt(3 / (4 * Math.PI));
    // phase chosen so the outer (valence) part of 2s is positive; only relative signs matter
    const s2 = (x, y, z) => -R20(Math.hypot(x, y, z)) * Y0;
    const p2 = k => (x, y, z) => { const r = Math.hypot(x, y, z) || 1e-9; return R21(r) * Y1 * [x, y, z][k] / r; };
    const TET = [[1, 1, 1], [-1, -1, 1], [1, -1, -1], [-1, 1, -1]];
    const hyb = s => (x, y, z) => 0.5 * (s2(x, y, z) + s[0] * p2(0)(x, y, z) + s[1] * p2(1)(x, y, z) + s[2] * p2(2)(x, y, z));
    const CACHE = new Map(), smp = (k, f) => { if (!CACHE.has(k)) CACHE.set(k, sampler(f, 18)); return CACHE.get(k); };
    const v = GL ? new Viewer($('#v-sp'), { view: [1, -0.7, 0.45], label: () => tx('Carbon 2s, 2p and sp³ orbitals', '碳的 2s、2p 與 sp³ 軌域') }) : null;
    let FR = 12;
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root;
      const cl = (key, f, N, seed, op = 0.8, keep, col) => cloudPts(g, smp(key, f)(N, seed, keep), 2, { opacity: op, pos: col, neg: col });
      const HC4 = [COL.corner, COL.face, COL.body, COL.plane];
      // the dense core of one hybrid's big lobe: where ψ is above a third of its peak
      const lobe = s => { const f = hyb(s), d = V3(...s).normalize(); let mx = 0; for (let r = 0; r < 12; r += 0.05) mx = Math.max(mx, f(d.x * r, d.y * r, d.z * r)); return (x, y, z) => f(x, y, z) > mx * 0.45; };
      const dirs = TET.map(a => V3(...a).normalize());
      const spokes = (L, col) => dirs.forEach(d => rod(g, V3(0, 0, 0), d.clone().multiplyScalar(L), 0.04, mStd(col || T.edge3d)));
      const angle = L => { arc(g, dirs[0].clone().multiplyScalar(L), dirs[1].clone().multiplyScalar(L), L, T.hi); label(g, '109.5°', dirs[0].clone().add(dirs[1]).normalize().multiplyScalar(L * 1.3), { size: 0.85, color: T.hi }); };
      if (mode === 's') { cl('s', s2, 9000, 3); FR = 12; }
      else if (mode === 'p') { [0, 1, 2].forEach(k => cl('p' + k, p2(k), 4500, 5 + k)); FR = 13; }
      else if (mode === 'h1') { cl('h0', hyb(TET[0]), 9000, 11); spokes(9); FR = 12; }
      else if (mode === 'h4') { TET.forEach((s, i) => cl('h' + i, hyb(s), 2500, 11 + i, 0.8, lobe(s), HC4[i])); spokes(9); angle(5); FR = 11; }
      else if (mode === 'ch4') {
        TET.forEach((s, i) => cl('h' + i, hyb(s), 1800, 21 + i, 0.6, lobe(s), HC4[i])); atom(g, V3(0, 0, 0), 0.9, T.edge3d);
        dirs.forEach(d => { atom(g, d.clone().multiplyScalar(6.2), 1.1, COL.face); rod(g, V3(0, 0, 0), d.clone().multiplyScalar(6.2), 0.12, mStd(T.edge3d)); });
        angle(3.6); FR = 9;
      } else {
        const a = 6, sites = sitesIn(BASIS.DIA).map(s => V3(...s.p).multiplyScalar(a).sub(V3(a / 2, a / 2, a / 2))), bl = a * S3 / 4;
        const c = V3(a / 4, a / 4, a / 4).sub(V3(a / 2, a / 2, a / 2));
        sites.forEach(p => atom(g, p, 0.5, p.distanceTo(c) < 1e-6 ? T.hi : T.edge3d));
        const bm = mStd(T.ghost3d);
        sites.forEach((p, i) => sites.slice(i + 1).forEach(q => { if (Math.abs(p.distanceTo(q) - bl) < 1e-4) rod(g, p, q, 0.12, bm); }));
        const nb = sites.filter(p => Math.abs(p.distanceTo(c) - bl) < 1e-4); hullFaces(nb).forEach(f => poly(g, f, COL.plane, 0.18));
        cellEdges(g, V3(-a / 2, -a / 2, -a / 2), V3(a, 0, 0), V3(0, a, 0), V3(0, 0, a), 0.04, mStd(T.edge3d));
        FR = 5.6;
      }
      if (mode !== 'dia') atom(g, V3(0, 0, 0), 0.25, T.ink);
    };
    function text() {
      const T2 = {
        s: tx('<h4>2s: a sphere</h4><p>The same in every direction. It has one radial node at r = 2a<sub>0</sub>, so a small inner sphere (orange) sits inside an outer shell of the opposite sign (blue). The outer shell is the part that takes part in bonding.</p>', '<h4>2s：球形</h4><p>各方向都一樣。在 r = 2a<sub>0</sub> 有一個徑向節面，所以裡面有一顆小球（橘），外面包一層正負號相反的殼（藍）。參與成鍵的是外面這層。</p>'),
        p: tx('<h4>2p<sub>x</sub>, 2p<sub>y</sub>, 2p<sub>z</sub>: three dumbbells</h4><p>Each has a + lobe and a − lobe along its own axis, 90° from the others. Bonds made from pure p orbitals would be 90° apart, not the 109.5° measured in CH<sub>4</sub>.</p>', '<h4>2p<sub>x</sub>、2p<sub>y</sub>、2p<sub>z</sub>：三個啞鈴</h4><p>每個沿自己的軸有一個 + 瓣和一個 − 瓣，彼此夾 90°。如果只用純 p 軌域成鍵，鍵角會是 90°，不是 CH<sub>4</sub> 實測的 109.5°。</p>'),
        h1: tx('<h4>One sp³ = ½ (s + p<sub>x</sub> + p<sub>y</sub> + p<sub>z</sub>)</h4><p>Add the waves point by point. Toward (1, 1, 1) the s wave and the three + p lobes have the same sign and reinforce: one big lobe. On the opposite side they cancel, leaving only a small tail. The orbital now points one way, which is just what a bond needs.</p>', '<h4>一個 sp³ = ½ (s + p<sub>x</sub> + p<sub>y</sub> + p<sub>z</sub>)</h4><p>逐點把波加起來。往 (1, 1, 1) 方向，s 波和三個 p 的 + 瓣同號，互相加強，形成一個大瓣；反方向互相抵消，只剩一條小尾巴。軌域現在指向一個方向，正是成鍵需要的。</p>'),
        h4: tx('<h4>Four sp³ orbitals</h4><p>Only the dense core of each big lobe is drawn, each hybrid in its own colour; the four full clouds overlap into a sphere. The four sign choices (+ + +), (− − +), (+ − −), (− + −) give four identical lobes pointing to the corners of a tetrahedron, 109.5° apart. Each holds one electron, ready to pair with one electron from a neighbor.</p>', '<h4>四個 sp³ 軌域</h4><p>這裡只畫每個大瓣最密的核心，每個混成軌域各用一種顏色；四團完整的電子雲疊起來會變回一顆球。四種正負號組合 (+ + +)、(− − +)、(+ − −)、(− + −) 給出四個一模一樣的瓣，指向正四面體的四個角，彼此夾 109.5°。每個放一個電子，準備和鄰居的一個電子配對。</p>'),
        ch4: tx('<h4>Methane, CH<sub>4</sub></h4><p>Each sp³ lobe overlaps the 1s orbital of a hydrogen atom, and the two electrons are shared. Four identical C–H bonds, 109.5° apart. The molecule is symmetric, which matters in Unit 11.</p>', '<h4>甲烷 CH<sub>4</sub></h4><p>每個 sp³ 瓣和一個氫原子的 1s 軌域重疊，兩個電子共用。四個相同的 C–H 鍵，彼此夾 109.5°。這個分子很對稱，第 11 單元會用到。</p>'),
        dia: tx('<h4>Diamond</h4><p>Every carbon uses its four sp³ orbitals to bond to four other carbons. The red atom and its four neighbors (purple tetrahedron) repeat through the whole crystal, a three-dimensional network of strong, directional bonds. Chapter 3 returns to this structure.</p>', '<h4>鑽石</h4><p>每個碳用四個 sp³ 軌域和另外四個碳鍵結。紅色原子和它的四個鄰居（紫色四面體）在整塊晶體裡不斷重複，形成由強而有方向性的鍵構成的三維網路。第 3 章會再回到這個結構。</p>')
      };
      info.innerHTML = T2[mode];
    }
    seg($('#sp-mode'), m => { mode = m; if (v && !v.init) { v.rebuild(); v.frame(V3(0, 0, 0), FR); } text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), FR); });
    text(); onLang(text);
  }

  /* =====================================================================
     10 Sliding layers: metal vs ionic crystal (2D)
     ===================================================================== */
  function secSl() {
    const cv = $('#sl-cv'), xS = $('#sl-x'), info = $('#sl-info'); let kind = 'm', last = null, on = false;
    const COLS = 9, ROWS = 5, TOP = 2;
    const rnd = rng(9), el = Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd(), vx: rnd() - 0.5, vy: rnd() - 0.5 }));
    const Eion = s => -Math.cos(Math.PI * s), Emet = s => 0.08 * (1 - Math.cos(2 * Math.PI * s)) - 1;
    function paint(x, W, H) {
      last = { x, W, H };
      x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H);
      const insetW = W < 520 ? 0 : 150, BW = W - insetW - 30, a = Math.min(BW / (COLS + 1), (H - 40) / (ROWS + 0.8)), s = +xS.value;
      const lift = kind === 'i' ? Math.max(0, Eion(s)) * a * 0.35 : 0;
      const x0 = 18 + a * 0.7, y0 = (H - (ROWS - 1) * a) / 2 + 8;
      const ions = [];
      for (let j = 0; j < ROWS; j++) for (let i = -1; i <= COLS; i++) {
        const top = j < TOP, xx = x0 + (i + (top ? s : 0)) * a, yy = y0 + j * a - (top ? lift : 0);
        if (xx < x0 - a * 0.6 || xx > x0 + (COLS - 1) * a + a * 0.6) continue;
        ions.push({ xx, yy, q: kind === 'm' ? 1 : ((i + j) & 1 ? 1 : -1), top, j, i });
      }
      // slip plane
      const yp = y0 + (TOP - 0.5) * a - lift / 2; x.setLineDash([5, 5]); x.strokeStyle = COL.plane; x.lineWidth = 1.2; x.beginPath(); x.moveTo(x0 - a * 0.6, yp); x.lineTo(x0 + (COLS - 1) * a + a * 0.6, yp); x.stroke(); x.setLineDash([]);
      x.fillStyle = COL.plane; x.font = FONT(500, 11); x.textAlign = 'left'; x.fillText(tx('slip plane', '滑移面'), x0 - a * 0.6, yp - 5);
      if (kind === 'm') {
        x.fillStyle = T.hi; const L = x0 - a * 0.6, R = x0 + (COLS - 1) * a + a * 0.6, Tp = y0 - a * 0.6, B = y0 + (ROWS - 1) * a + a * 0.6;
        el.forEach(e => { const top = e.y < TOP / ROWS; const ex = L + ((e.x + (top ? s * a / (R - L) : 0)) % 1) * (R - L), ey = Tp + e.y * (B - Tp); x.beginPath(); x.arc(ex, ey, 2.2, 0, 7); x.fill(); });
      }
      ions.forEach(o => {
        const r = kind === 'm' ? a * 0.36 : o.q > 0 ? a * 0.27 : a * 0.42;
        x.fillStyle = o.q > 0 && kind === 'i' ? COL.body : COL.corner; x.globalAlpha = kind === 'm' ? 0.9 : 1; x.beginPath(); x.arc(o.xx, o.yy, r, 0, 7); x.fill(); x.globalAlpha = 1;
        x.fillStyle = '#fff'; x.font = MFONT(700, Math.max(10, a * 0.3)); x.textAlign = 'center'; x.fillText(o.q > 0 ? '+' : '−', o.xx, o.yy + a * 0.1);
      });
      // repulsion between like charges facing each other across the plane
      if (kind === 'i' && s > 0.6) {
        x.strokeStyle = T.hi; x.fillStyle = T.hi; x.lineWidth = 2; x.globalAlpha = Math.min(1, (s - 0.6) / 0.3);
        const tri = (ax, tip, d) => { x.beginPath(); x.moveTo(ax, tip); x.lineTo(ax - 4, tip - d * 7); x.lineTo(ax + 4, tip - d * 7); x.closePath(); x.fill(); };
        ions.filter(o => o.j === TOP - 1).forEach(o => {
          const below = ions.find(b => b.j === TOP && Math.abs(b.xx - o.xx) < a * 0.3 && b.q === o.q); if (!below) return;
          const ax = o.xx + a * 0.5, ym = (o.yy + below.yy) / 2, h = a * 0.32;
          x.beginPath(); x.moveTo(ax, ym - h + 6); x.lineTo(ax, ym + h - 6); x.stroke(); tri(ax, ym - h, -1); tri(ax, ym + h, 1);
        });
        x.globalAlpha = 1;
      }
      // energy inset
      if (insetW) {
        const ix = W - insetW - 6, iy = 30, iw = insetW - 10, ih = H - 80, E = kind === 'm' ? Emet : Eion, Y = e => iy + (1.15 - e) / 2.4 * ih;
        x.strokeStyle = T.line; x.strokeRect(ix, iy, iw, ih);
        x.strokeStyle = T.grid; x.beginPath(); x.moveTo(ix, Y(0)); x.lineTo(ix + iw, Y(0)); x.stroke();
        x.strokeStyle = T.accent; x.lineWidth = 2; x.beginPath(); for (let k = 0; k <= 50; k++) { const ss = k / 50, px = ix + ss * iw, py = Y(E(ss)); k ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
        x.fillStyle = T.hi; x.beginPath(); x.arc(ix + s * iw, Y(E(s)), 4.5, 0, 7); x.fill();
        x.fillStyle = T.muted; x.font = FONT(500, 11); x.textAlign = 'center'; x.fillText(tx('energy across the plane', '跨滑移面的能量'), ix + iw / 2, iy - 8);
        x.font = MFONT(400, 10); x.fillText('0', ix, iy + ih + 13); x.fillText(tx('1 spacing', '1 個間距'), ix + iw - 16, iy + ih + 13);
        x.textAlign = 'left'; x.fillText(tx('attract', '吸引'), ix + 4, Y(-1) + 14); x.fillText(tx('repel', '排斥'), ix + 4, Y(1) - 6);
      }
    }
    function text() {
      const s = +xS.value; $('#sl-x-v').textContent = tx(`${s.toFixed(2)} ion spacing`, `${s.toFixed(2)} 個離子間距`);
      info.innerHTML = kind === 'm' ? tx(`<p><span class="pill ok">Still bonded</span> Every ion core is surrounded by the same electron sea before, during and after the slide. The energy barely changes, so the layers glide and the metal deforms plastically.</p>`, `<p><span class="pill ok">鍵還在</span>　滑動前、中、後，每個離子核都泡在同樣的電子海裡。能量幾乎不變，所以原子層可以滑過去，金屬發生塑性變形。</p>`)
        : s < 0.35 ? tx('<p>Each cation sits next to anions across the plane, as in the perfect crystal. Start sliding.</p>', '<p>跨過滑移面，每個陽離子旁邊都是陰離子，和完美晶體一樣。開始滑動吧。</p>')
          : s < 0.75 ? tx('<p>Halfway: the attraction across the plane is weakening fast.</p>', '<p>滑到一半：跨面的吸引力迅速減弱。</p>')
            : tx('<p><span class="pill bad">Cleaves</span> After one ion spacing every ion faces an ion of the same charge. The layers repel and split apart: the crystal is brittle.</p>', '<p><span class="pill bad">裂開</span>　滑過一個離子間距後，每個離子都正對著同號的離子。層與層互相排斥而分開：晶體很脆。</p>');
    }
    const fit = canvas2d(cv, paint), again = () => { if (last) paint(last.x, last.W, last.H); };
    xS.addEventListener('input', () => { again(); text(); });
    seg($('#sl-kind'), k => { kind = k; again(); text(); });
    if ('IntersectionObserver' in window) new IntersectionObserver(es => { on = es[0].isIntersecting; }).observe(cv); else on = true;
    let prev = 0;
    const frame = now => { const dt = Math.min(50, now - prev) / 1000; prev = now; if (on && kind === 'm' && !REDUCED) { el.forEach(e => { e.x = (e.x + e.vx * dt * 0.25 + 1) % 1; e.y += e.vy * dt * 0.25; if (e.y < 0 || e.y > 1) { e.vy *= -1; e.y = Math.min(1, Math.max(0, e.y)); } }); again(); } requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    text(); onLang(text);
    return () => { fit(); };
  }

  /* =====================================================================
     11 Secondary bonds (3D)
     ===================================================================== */
  function secSb() {
    const info = $('#sb-info'); let mode = 'fl', ar = null;
    const TETD = [[1, 1, 1], [-1, -1, 1], [1, -1, -1], [-1, 1, -1]].map(a => V3(...a).normalize());
    const HC = () => T.ghost3d, CC = () => T.edge3d, CL = COL.face, OC = () => T.hi;
    const v = GL ? new Viewer($('#v-sb'), { view: [0.2, -1, 0.45], label: () => tx('Atoms and molecules held by secondary bonds', '靠次鍵結吸引的原子和分子') }) : null;
    let FR = 4;
    function molecule(g, c, dirs, kinds) { // carbon at c with substituents
      atom(g, c, 0.36, CC());
      dirs.forEach((d, i) => { const L = kinds[i] === 'Cl' ? 1.78 : 1.09, p = c.clone().addScaledVector(d, L); atom(g, p, kinds[i] === 'Cl' ? 0.5 : 0.28, kinds[i] === 'Cl' ? CL : HC()); rod(g, c, p, 0.07, mStd(T.edge3d)); });
    }
    if (v) v.rebuild = () => {
      v.clear(); const g = v.root; ar = null;
      if (mode === 'fl') {
        ar = [];
        [-1.7, 1.7].forEach((x0, i) => {
          const grp = new THREE.Group(); grp.position.set(x0, 0, 0); g.add(grp);
          atom(grp, V3(0, 0, 0), 0.13, T.ink);
          const rnd = rng(31 + i), pos = [], cols = [], c = rgb(COL.corner);
          for (let k = 0; k < 2600; k++) { let x, y, z, r2; do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; r2 = x * x + y * y + z * z; } while (r2 > 1); const s = 0.95 * Math.pow(rnd(), 0.6) / Math.sqrt(r2 || 1); pos.push(x * s, y * s, z * s); cols.push(...c); }
          const cl = points(grp, pos, cols, 1.8, { opacity: 0.55 });
          const minus = label(grp, 'δ−', V3(0, 0, 0), { size: 0.34, color: COL.corner }), plus = label(grp, 'δ+', V3(0, 0, 0), { size: 0.34, color: COL.body }); minus.visible = plus.visible = false;
          ar.push({ cl, minus, plus, x0 });
        });
        FR = 3.6;
      } else if (mode === 'pm') {
        const q = new THREE.Quaternion().setFromUnitVectors(TETD[0], V3(1, 0, 0)), D = TETD.map(d => d.clone().applyQuaternion(q));
        molecule(g, V3(-2.4, 0, 0), D, ['H', 'H', 'H', 'H']);
        molecule(g, V3(2.0, 0, 0), D, ['Cl', 'H', 'H', 'H']);
        // bond dipoles point toward the more electronegative end
        D.forEach(d => arrow(g, V3(-2.4, 0, 0).addScaledVector(d, 1.45), V3(-2.4, 0, 0).addScaledVector(d, 0.42), 0.04, COL.plane));
        arrow(g, V3(2.0, 0, -1.55), V3(3.6, 0, -1.55), 0.07, COL.plane);
        label(g, 'CH₄', V3(-2.4, 0, 1.6), { size: 0.38 }); label(g, 'CH₃Cl', V3(2.4, 0, 1.6), { size: 0.38 });
        label(g, tx('net = 0', '淨偶極 = 0'), V3(-2.4, 0, -1.55), { size: 0.3, color: COL.plane }); label(g, tx('net dipole', '淨偶極'), V3(2.8, 0, -1.95), { size: 0.3, color: COL.plane });
        label(g, 'δ−', V3(3.95, 0, 0.55), { size: 0.3, color: COL.corner });
        FR = 4.3;
      } else {
        const OO = 2.8, OH = 0.96, th = 52.5 * D2R;
        const water = (o, h1, h2) => { atom(g, o, 0.42, OC()); [h1, h2].forEach(h => { const p = o.clone().addScaledVector(h, OH); atom(g, p, 0.24, HC()); rod(g, o, p, 0.08, mStd(T.edge3d)); }); };
        const perp = d => { const a = Math.abs(d.z) < 0.9 ? V3(0, 0, 1) : V3(1, 0, 0); return a.clone().cross(d).normalize(); };
        const hd = [TETD[0], TETD[1]];
        water(V3(0, 0, 0), hd[0], hd[1]);
        const hb = [];
        TETD.forEach((t, i) => {
          const o = t.clone().multiplyScalar(OO), p = perp(t);
          if (i < 2) { water(o, t.clone().multiplyScalar(Math.cos(th)).addScaledVector(p, Math.sin(th)).normalize(), t.clone().multiplyScalar(Math.cos(th)).addScaledVector(p, -Math.sin(th)).normalize()); hb.push([t.clone().multiplyScalar(OH + 0.25), o.clone().addScaledVector(t, -0.45)]); }
          else { const back = t.clone().negate(); water(o, back, back.clone().multiplyScalar(Math.cos(105 * D2R)).addScaledVector(p, Math.sin(105 * D2R)).normalize()); hb.push([o.clone().addScaledVector(t, -(OH + 0.25)), t.clone().multiplyScalar(0.45)]); }
        });
        dashed(g, hb, T.ink, { dash: 0.12, gap: 0.09, opacity: 1 });
        label(g, 'δ−', V3(0, 0, 0).addScaledVector(TETD[2].clone().add(TETD[3]).normalize(), 0.75), { size: 0.3, color: COL.corner });
        FR = 4.4;
      }
    };
    if (v) v.anim = t => {
      if (!ar || REDUCED) return;
      const d = 0.26 * Math.sin(t / 380) * (0.6 + 0.4 * Math.sin(t / 1270));
      ar.forEach(a => { a.cl.position.x = d; const s = Math.sign(d) || 1, vis = Math.abs(d) > 0.07; a.minus.visible = a.plus.visible = vis; a.minus.position.set(s * 1.2, 0, 0.75); a.plus.position.set(-s * 1.2, 0, 0.75); });
      v.dirty = true;
    };
    function text() {
      info.innerHTML = {
        fl: tx('<h4>Fluctuating dipoles in argon</h4><p>For an instant the electron cloud of one atom drifts to one side. That atom is now a small dipole, and its field pushes the neighbor\'s cloud the same way. The two dipoles line up head to tail and attract. A moment later both flip, and they still attract.</p><p class="note">Blue dots: electron cloud. Black dot: nucleus.</p>', '<h4>氬原子的擾動偶極</h4><p>某一瞬間，一個原子的電子雲偏到一邊，這個原子就成了小偶極，它的電場把鄰居的電子雲也推向同一邊。兩個偶極頭尾相接，互相吸引。下一刻兩個都翻過來，還是互相吸引。</p><p class="note">藍點：電子雲。黑點：原子核。</p>'),
        pm: tx('<h4>Permanent dipoles: shape decides</h4><p>Each bond dipole (purple arrow) points toward the more electronegative atom. In CH<sub>4</sub> the four C–H dipoles point to the corners of a tetrahedron and cancel exactly. In CH<sub>3</sub>Cl the C–Cl bond is far more polar than the C–H bonds, so a net dipole remains along the C–Cl direction.</p><p class="note">Gray: C. Light gray: H. Green: Cl.</p>', '<h4>永久偶極：形狀決定</h4><p>每個鍵的偶極（紫色箭頭）指向電負度比較大的原子。CH<sub>4</sub> 的四個 C–H 偶極指向正四面體的四個角，剛好抵消。CH<sub>3</sub>Cl 的 C–Cl 鍵極性比 C–H 強得多，所以沿 C–Cl 方向留下淨偶極。</p><p class="note">深灰：C。淺灰：H。綠：Cl。</p>'),
        hb: tx('<h4>Hydrogen bonds in water</h4><p>The O–H bonds are strongly polar and the molecule is bent (about 105°), so O carries δ− and each H carries δ+. Each nearly bare H is attracted to the O of a neighboring molecule (dashed lines). The central molecule donates two hydrogen bonds and accepts two, the arrangement found in ice.</p><p class="note">Red: O. Light gray: H.</p>', '<h4>水的氫鍵</h4><p>O–H 鍵極性很強，分子又彎成約 105°，所以 O 帶 δ−、每個 H 帶 δ+。幾乎被剝光的 H 被鄰近分子的 O 吸引（虛線）。中間這個分子提供兩個氫鍵、接受兩個，這就是冰裡的排法。</p><p class="note">紅：O。淺灰：H。</p>')
      }[mode];
    }
    seg($('#sb-mode'), m => { mode = m; if (v && !v.init) { v.rebuild(); v.frame(V3(0, 0, 0), FR); } text(); });
    if (v) v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), FR); });
    text(); onLang(text);
  }

  /* =====================================================================
     12 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('Why did back-scattered α particles rule out Thomson\'s model?', '為什麼 α 粒子會反彈，就推翻了湯姆森模型？'), o: [tx('Spread-out charge is too weak to turn a heavy particle around', '散開的正電太弱，無法讓重的粒子掉頭'), tx('Electrons are heavy enough to bounce the α particle back', '電子夠重，可以把 α 粒子彈回來'), tx('Gold atoms are packed too tightly for α particles to pass', '金原子排得太密，α 粒子穿不過去'), tx('α particles lose their charge inside the gold foil', 'α 粒子在金箔裡失去電荷')], a: 0, e: tx('An α particle is about 7300 times heavier than an electron. Only a dense, heavy concentration of positive charge, a nucleus, can push it straight back.', 'α 粒子比電子重大約 7300 倍。只有又密又重、集中在一點的正電，也就是原子核，才能把它直接推回來。') },
    { q: tx('According to classical physics, what should happen to an electron circling a nucleus?', '依照古典物理，繞原子核轉的電子會怎樣？'), o: [tx('It radiates, loses energy and spirals into the nucleus', '放出電磁波、失去能量，螺旋掉進原子核'), tx('It keeps circling forever at the same radius', '永遠在同一個半徑上繞下去'), tx('It slowly drifts outward and leaves the atom', '慢慢往外飄，離開原子'), tx('It emits light only at a few sharp wavelengths', '只放出幾條特定波長的光')], a: 0, e: tx('An accelerating charge radiates. The classical electron would collapse in about 10⁻¹¹ s, giving a continuous spectrum. Real atoms are stable and give sharp lines.', '加速的電荷會輻射。古典電子大約 10⁻¹¹ s 就會崩潰，並放出連續光譜。真實原子很穩定，放出的是細線。') },
    { q: tx('What is the physical meaning of Bohr\'s condition nλ = 2πr?', '波耳條件 nλ = 2πr 的物理意義是什麼？'), o: [tx('A whole number of electron wavelengths fits around the orbit', '軌道周長剛好裝得下整數個電子波長'), tx('The electron travels n times around the orbit each second', '電子每秒繞軌道 n 圈'), tx('The orbit radius is n times the electron wavelength', '軌道半徑是電子波長的 n 倍'), tx('The electron emits n photons on every lap of the orbit', '電子每繞一圈放出 n 個光子')], a: 0, e: tx('Only a wave that closes on itself survives as a standing wave. With λ = h / mv this becomes mvr = nh / 2π.', '只有頭尾接得起來的波能形成駐波留下來。代入 λ = h / mv 就變成 mvr = nh / 2π。') },
    { q: tx('A hydrogen electron drops from n = 3 to n = 2. What is emitted?', '氫原子的電子從 n = 3 掉到 n = 2，放出什麼？'), o: [tx('A 1.89 eV photon of red light at 656 nm', '1.89 eV、656 nm 的紅光光子'), tx('A 10.2 eV photon of ultraviolet light at 122 nm', '10.2 eV、122 nm 的紫外光光子'), tx('A 1.51 eV photon of infrared light at 821 nm', '1.51 eV、821 nm 的紅外光光子'), tx('A 3.40 eV photon of violet light at 365 nm', '3.40 eV、365 nm 的紫光光子')], a: 0, e: tx('ΔE = 13.6 (1/4 − 1/9) = 1.89 eV, λ = 1240 / 1.89 = 656 nm, the H<sub>α</sub> line of the Balmer series.', 'ΔE = 13.6 (1/4 − 1/9) = 1.89 eV，λ = 1240 / 1.89 = 656 nm，就是巴耳末系的 H<sub>α</sub> 線。') },
    { q: tx('Why do electrons in atoms need to be treated as waves, while baseballs do not?', '為什麼原子裡的電子要當成波，棒球卻不用？'), o: [tx('An electron\'s wavelength is about the size of an atom', '電子的波長和原子差不多大'), tx('Electrons move faster than light inside atoms', '電子在原子裡跑得比光還快'), tx('Baseballs have no momentum when thrown slowly', '棒球丟得慢時沒有動量'), tx('Only charged particles have a de Broglie wavelength', '只有帶電粒子才有德布羅意波長')], a: 0, e: tx('λ = h / p. For the n = 1 electron λ = 0.33 nm, about the size of the atom. For a baseball λ ≈ 10⁻³⁴ m, far too small to notice.', 'λ = h / p。n = 1 的電子 λ = 0.33 nm，和原子差不多大；棒球 λ ≈ 10⁻³⁴ m，小到完全察覺不到。') },
    { q: tx('To squeeze a wave packet into a smaller region, you must…', '想把波包擠到更小的範圍，必須……'), o: [tx('mix in a wider range of wavelengths', '混入範圍更廣的波長'), tx('use a single, longer wavelength', '只用一個更長的波長'), tx('lower the amplitude of every wave', '降低每道波的振幅'), tx('remove the waves with short wavelengths', '拿掉短波長的波')], a: 0, e: tx('A narrow packet needs many wave numbers, so the momentum is spread out: Δx · Δp ≥ h / 4π.', '窄的波包需要很多波數，所以動量變得分散：Δx · Δp ≥ h / 4π。') },
    { q: tx('How many radial and angular nodes does a 3p orbital have?', '3p 軌域有幾個徑向節面和角節面？'), o: [tx('1 radial node and 1 angular node', '1 個徑向節面、1 個角節面'), tx('2 radial nodes and 0 angular nodes', '2 個徑向節面、0 個角節面'), tx('0 radial nodes and 2 angular nodes', '0 個徑向節面、2 個角節面'), tx('1 radial node and 2 angular nodes', '1 個徑向節面、2 個角節面')], a: 0, e: tx('Radial nodes = n − l − 1 = 3 − 1 − 1 = 1. Angular nodes = l = 1. Total n − 1 = 2.', '徑向節面 = n − l − 1 = 3 − 1 − 1 = 1。角節面 = l = 1。總共 n − 1 = 2。') },
    { q: tx('Where is the 1s electron of hydrogen most likely to be found?', '氫原子 1s 電子最可能出現在哪裡？'), o: [tx('At r = a₀, in a thin shell around the nucleus', '在 r = a₀ 附近的薄球殼裡'), tx('Exactly on a circle of radius a₀ in one plane', '剛好在一個半徑 a₀ 的圓上'), tx('At the nucleus, where |ψ|² is the largest', '在原子核上，因為那裡 |ψ|² 最大'), tx('Anywhere inside the atom with equal chance', '原子裡任何地方機率都一樣')], a: 0, e: tx('|ψ|² is largest at the nucleus, but the volume of a shell grows as r². The radial probability r²R² peaks at a₀, Bohr\'s radius, without confining the electron to a circle.', '|ψ|² 在原子核最大，但球殼的體積隨 r² 變大。徑向機率 r²R² 的峰在 a₀，也就是波耳半徑，但電子並不被限制在一個圓上。') },
    { q: tx('What is the electron configuration of Fe²⁺?', 'Fe²⁺ 的電子組態是什麼？'), o: [tx('[Ar] 3d⁶', '[Ar] 3d⁶'), tx('[Ar] 3d⁴ 4s²', '[Ar] 3d⁴ 4s²'), tx('[Ar] 3d⁵ 4s¹', '[Ar] 3d⁵ 4s¹'), tx('[Ar] 3d⁶ 4s²', '[Ar] 3d⁶ 4s²')], a: 0, e: tx('Fe is [Ar] 3d⁶ 4s². Transition metals lose the 4s electrons first, so Fe²⁺ is [Ar] 3d⁶ and Fe³⁺ is [Ar] 3d⁵.', 'Fe 是 [Ar] 3d⁶ 4s²。過渡金屬先失去 4s 電子，所以 Fe²⁺ 是 [Ar] 3d⁶，Fe³⁺ 是 [Ar] 3d⁵。') },
    { q: tx('Using Pauling\'s formula, roughly how ionic is a bond with ΔX = 2.1 (NaCl)?', '用鮑林公式，ΔX = 2.1（NaCl）的鍵離子性大約多少？'), o: [tx('About 67%', '大約 67%'), tx('About 21%', '大約 21%'), tx('About 95%', '大約 95%'), tx('About 44%', '大約 44%')], a: 0, e: tx('1 − exp(−¼ × 2.1²) = 1 − exp(−1.10) = 0.67.', '1 − exp(−¼ × 2.1²) = 1 − exp(−1.10) = 0.67。') },
    { q: tx('On the ion-pair energy curve, which feature sets the thermal expansion?', '在離子對的能量曲線上，哪個特徵決定熱膨脹？'), o: [tx('The well is lopsided: its outer wall is gentler', '井不對稱：外側井壁比較緩'), tx('The well is deep: E₀ is large and negative', '井很深：E₀ 是很大的負值'), tx('The well is narrow: its bottom is sharply curved', '井很窄：井底曲率很大'), tx('The well sits at a small spacing a₀', '井底位在很小的間距 a₀')], a: 0, e: tx('Because the outer wall rises more slowly, a vibrating pair spends more time stretched, so its mean spacing grows with temperature. Depth sets the melting point, curvature the stiffness.', '外側井壁上升得比較慢，振動時有比較多時間處在拉長的狀態，所以平均間距隨溫度變大。井深決定熔點，曲率決定剛性。') },
    { q: tx('NaCl has r<sub>C</sub>/r<sub>A</sub> = 0.525. Which coordination number does it take?', 'NaCl 的 r<sub>C</sub>/r<sub>A</sub> = 0.525，配位數是多少？'), o: [tx('6, since 0.414 ≤ 0.525 &lt; 0.732', '6，因為 0.414 ≤ 0.525 &lt; 0.732'), tx('8, since 0.525 is above 0.414', '8，因為 0.525 大於 0.414'), tx('4, since 0.525 is above 0.225', '4，因為 0.525 大於 0.225'), tx('3, since 0.525 is above 0.155', '3，因為 0.525 大於 0.155')], a: 0, e: tx('The highest CN whose critical ratio the cation still meets. 0.525 passes 0.414 (CN 6) but not 0.732 (CN 8).', '取陽離子還能滿足臨界比的最高配位數。0.525 超過 0.414（CN 6），但沒到 0.732（CN 8）。') }
  ]; });
  // Shuffle the options once per page load so the right answer is not always A, then keep that order in both languages
  const QPERM = (() => { const r = rng(20261028); return Array.from({ length: 12 }, () => { const p = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; }); })();
  dataset(() => { QUIZ.forEach((q, i) => { const p = QPERM[i], o = q.o.slice(); q.o = p.map(k => o[k]); q.a = p.indexOf(q.a); }); });

  function boot() {
    if (GL) {
      try { heroScene(); } catch (e) { console.error(e); }
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    // every section builds its 3D stage only when WebGL works; the text and 2D plots work either way
    [secRu, secSw, secEn, secCn, secSp, secSb].forEach(f => { try { f(); } catch (e) { console.error(e); } });
    [secCl, secBohr, secWp, secOrb, secEc, secPe, secSl].forEach(f => { try { redraw2D.push(f()); } catch (e) { console.error(e); } });
    secQuiz(); toc();
  }

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
      es.forEach(e => {
        if (!e.isIntersecting) return;
        links.forEach(a => a.classList.remove('on')); const a = map.get(e.target.id); if (!a) return;
        a.classList.add('on');
        // measure against the scrolling list itself: offsetLeft counts from nav.toc and is off by the centred column's margin
        const ol = a.closest('ol'), x = a.getBoundingClientRect().left - ol.getBoundingClientRect().left + ol.scrollLeft;
        if (x < ol.scrollLeft || x + a.offsetWidth > ol.scrollLeft + ol.clientWidth) ol.scrollTo({ left: x - (ol.clientWidth - a.offsetWidth) / 2, behavior: REDUCED ? 'auto' : 'smooth' });
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('section.unit').forEach(s => ob.observe(s));
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
    document.title = tx("Atoms and Bonding 3D Classroom", "原子結構與鍵結 3D 教室");
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
