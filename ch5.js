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
     Chapter 5: shared pieces
     ===================================================================== */
  const redraw2D = [];
  const KB = 8.617e-5, RG = 8.314;
  const sciH = (x, d = 1) => {
    if (!x) return '0';
    let e = Math.floor(Math.log10(Math.abs(x))), m = (x / 10 ** e).toFixed(d);
    if (Math.abs(+m) >= 10) { e++; m = (x / 10 ** e).toFixed(d); }
    return e === 0 ? m : `${m} × 10<sup>${String(e).replace('-', '−')}</sup>`;
  };
  // erf: Abramowitz & Stegun 7.1.26, error below 1.5 × 10⁻⁷
  function erf(x) {
    const s = Math.sign(x); x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  /* formulas: KaTeX renders \( … \) in the static text, and TeX`…` / TeXd`…` (display size) in generated text */
  const tex = (t, disp) => (typeof katex === 'undefined' ? t : katex.renderToString((disp ? '\\displaystyle ' : '') + t, { throwOnError: false }));
  const TeX = (str, ...v) => tex(String.raw(str, ...v)), TeXd = (str, ...v) => tex(String.raw(str, ...v), true);
  const sciT = (x, d = 2) => { let e = Math.floor(Math.log10(Math.abs(x))), m = (x / 10 ** e).toFixed(d); if (Math.abs(+m) >= 10) { e++; m = (x / 10 ** e).toFixed(d); } return e === 0 ? m : `${m}\\times10^{${e}}`; };
  const renderTeX = () => { if (typeof renderMathInElement === 'function') renderMathInElement(document.body, { delimiters: [{ left: '\\(', right: '\\)', display: false }], throwOnError: false }); };
  renderTeX(); onLang(renderTeX);
  const kC = K => `${K} K (${K - 273} °C)`;
  const supE = e => String(e).replace(/[-\d]/g, c => SUP[c]);
  // plot box helper: blank stage, returns the drawing area
  function blank(x, W, H) { x.clearRect(0, 0, W, H); x.fillStyle = T.stage; x.fillRect(0, 0, W, H); }
  function axisLabel(x, s, px, py, rot, color) {
    x.save(); x.translate(px, py); if (rot) x.rotate(rot); x.font = FONT(500, 11); x.fillStyle = color || T.muted; x.textAlign = 'center'; x.fillText(s, 0, 0); x.restore();
  }
  function arrow2d(x, x0, y0, x1, y1, color, w = 2) {
    const a = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0); if (L < 2) return;
    const h = Math.min(9, L * 0.45);
    x.strokeStyle = color; x.fillStyle = color; x.lineWidth = w;
    x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1 - h * Math.cos(a) * 0.8, y1 - h * Math.sin(a) * 0.8); x.stroke();
    x.beginPath(); x.moveTo(x1, y1); x.lineTo(x1 - h * Math.cos(a - 0.42), y1 - h * Math.sin(a - 0.42)); x.lineTo(x1 - h * Math.cos(a + 0.42), y1 - h * Math.sin(a + 0.42)); x.closePath(); x.fill();
  }
  /* =====================================================================
     Hero: a Cu | Zn couple after annealing (3D)
     ===================================================================== */
  function heroScene() {
    const v = new Viewer($('#v-hero'), { view: [0.3, -1, 0.42], label: () => tx('A copper block and a zinc block whose atoms have mixed across the interface', '銅塊和鋅塊，原子已經越過界面互相混合'), clear: 0 });
    v.rebuild = () => {
      v.clear(); const g = v.root, rnd = rng(11), cu = [], zn = [];
      for (let i = -7; i <= 7; i++) for (let j = 0; j < 5; j++) for (let k = 0; k < 5; k++) {
        const p = V3(i * 0.92, (j - 2) * 0.92, (k - 2) * 0.92);
        (rnd() < 0.5 * (1 - erf(i / 2.6)) ? zn : cu).push(p);
      }
      cloud(g, cu, 0.4, COL.corner); cloud(g, zn, 0.4, COL.body);
    };
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 7.2); if (!REDUCED) v.setSpin(true); });
  }

  /* =====================================================================
     01 Energy barrier and the Boltzmann tail (2D)
     ===================================================================== */
  function secEB() {
    const tS = $('#eb-T'), eS = $('#eb-E'), info = $('#eb-info');
    const EP = -0.5, Y0 = -0.8, Y1 = 2.4;
    function path(s, Es) {
      if (s < 0.15) return 0; if (s > 0.85) return EP;
      const u = (s - 0.15) / 0.7;
      return u < 0.5 ? Es * (1 - Math.cos(2 * Math.PI * u)) / 2 : EP + (Es - EP) * (1 + Math.cos(2 * Math.PI * (u - 0.5))) / 2;
    }
    function paint(x, W, H) {
      blank(x, W, H);
      const kT = KB * +tS.value, Es = +eS.value;
      const ml = 44, mt = 16, mb = 30, split = Math.round(W * 0.54), Y = e => mt + (Y1 - e) / (Y1 - Y0) * (H - mt - mb);
      // energy axis
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted; x.textAlign = 'right';
      for (let e = -0.5; e <= 2.01; e += 0.5) { x.beginPath(); x.moveTo(ml, Y(e)); x.lineTo(W - 10, Y(e)); x.stroke(); x.fillText(e.toFixed(1), ml - 6, Y(e) + 3); }
      axisLabel(x, tx('energy (eV)', '能量（eV）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
      // left: reaction path
      const X0 = ml + 8, X1 = split - 16, XS = s => X0 + s * (X1 - X0);
      x.strokeStyle = COL.corner; x.lineWidth = 2.4; x.beginPath();
      for (let i = 0; i <= 120; i++) { const s = i / 120, px = XS(s), py = Y(path(s, Es)); i ? x.lineTo(px, py) : x.moveTo(px, py); }
      x.stroke();
      x.setLineDash([4, 4]); x.strokeStyle = T.hi; x.lineWidth = 1; x.beginPath(); x.moveTo(XS(0), Y(Es)); x.lineTo(W - 10, Y(Es)); x.stroke(); x.setLineDash([]);
      arrow2d(x, XS(0.1), Y(0), XS(0.1), Y(Es), T.hi, 1.5);
      x.fillStyle = T.hi; x.font = FONT(600, 11); x.textAlign = 'left'; x.fillText('ΔE*', XS(0.1) + 6, (Y(0) + Y(Es)) / 2 + 4);
      x.fillStyle = T.ink; x.font = FONT(600, 11); x.textAlign = 'center';
      x.fillText(tx('reactants', '反應物'), XS(0.07), Y(0) + 16); x.fillText(tx('products', '生成物'), XS(0.93), Y(EP) + 16); x.fillText('M*', XS(0.5), Y(Es) - 7);
      x.fillStyle = T.muted; x.font = FONT(500, 11); x.fillText(tx('reaction coordinate', '反應座標'), (X0 + X1) / 2, H - 10);
      // right: population on a log scale
      const R0 = split + 6, R1 = W - 12, LG = 20, XP = lf => R0 + Math.max(0, (lf + LG) / LG) * (R1 - R0);
      x.strokeStyle = T.edge3d; x.lineWidth = 1; x.beginPath(); x.moveTo(R0, mt); x.lineTo(R0, H - mb); x.stroke();
      // shaded tail above E*
      x.fillStyle = T.hi; x.globalAlpha = 0.28; x.beginPath(); x.moveTo(R0, Y(Es));
      for (let e = Es; e <= Y1; e += 0.01) x.lineTo(XP(-e / kT / Math.LN10), Y(e));
      x.lineTo(R0, Y(Y1)); x.closePath(); x.fill(); x.globalAlpha = 1;
      x.strokeStyle = COL.body; x.lineWidth = 2.4; x.beginPath();
      for (let e = 0, f = true; e <= Y1; e += 0.01) { const px = XP(-e / kT / Math.LN10); if (px <= R0 + 0.5) break; f ? x.moveTo(px, Y(e)) : x.lineTo(px, Y(e)); f = false; }
      x.stroke();
      x.fillStyle = T.muted; x.font = MFONT(400, 10); x.textAlign = 'center';
      [0, -5, -10, -15].forEach(l => x.fillText('10' + supE(l), XP(l), H - mb + 14));
      x.font = FONT(500, 11); x.fillText(tx('share of atoms (log)', '原子所占比例（對數）'), (R0 + R1) / 2, H - 4);
    }
    function text() {
      const Tk = +tS.value, Es = +eS.value, f = Math.exp(-Es / (KB * Tk)), f2 = Math.exp(-Es / (KB * (Tk + 100)));
      $('#eb-T-v').textContent = kC(Tk); $('#eb-E-v').textContent = Es.toFixed(2) + ' eV';
      const jumps = 1e13 * f;
      info.innerHTML = tx(`<div class="eq">${TeXd`e^{-E^*/kT} = \exp\!\left(-\frac{${Es.toFixed(2)}}{8.62\times10^{-5}\times ${Tk}}\right)`} = <b>${sciH(f)}</b></div>
        <dl class="stats"><dt>kT at this temperature</dt><dd>${(KB * Tk).toFixed(4)} eV</dd><dt>Heat by another 100 K</dt><dd>× ${f2 / f >= 1e4 ? sciH(f2 / f) : (f2 / f).toPrecision(3)}</dd><dt>Successful jumps per atom</dt><dd>${sciH(jumps)} per second</dd></dl>
        <p class="note">An atom vibrates about 10<sup>13</sup> times a second, and each vibration is one attempt. Multiply by the fraction above E* to get the successful jumps.</p>`,
        `<div class="eq">${TeXd`e^{-E^*/kT} = \exp\!\left(-\frac{${Es.toFixed(2)}}{8.62\times10^{-5}\times ${Tk}}\right)`} = <b>${sciH(f)}</b></div>
        <dl class="stats"><dt>這個溫度的 kT</dt><dd>${(KB * Tk).toFixed(4)} eV</dd><dt>再升溫 100 K</dt><dd>× ${f2 / f >= 1e4 ? sciH(f2 / f) : (f2 / f).toPrecision(3)}</dd><dt>每個原子成功跳躍的次數</dt><dd>每秒 ${sciH(jumps)} 次</dd></dl>
        <p class="note">原子每秒振動約 10<sup>13</sup> 次，每次振動就是一次嘗試。乘上能量超過 E* 的比例，就是成功跳躍的次數。</p>`);
    }
    const draw = canvas2d($('#eb-cv'), paint);
    [tS, eS].forEach(s => s.addEventListener('input', () => { draw(); text(); }));
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     02 Arrhenius plot (2D)
     ===================================================================== */
  function secAR() {
    const qS = $('#ar-Q'), t1 = $('#ar-T1'), t2 = $('#ar-T2'), info = $('#ar-info');
    const IX0 = 0.6, IX1 = 3.4, LY0 = -55, LY1 = 0;
    function paint(x, W, H) {
      blank(x, W, H);
      const ml = 46, mr = 14, mt = 30, mb = 34, X = i => ml + (i - IX0) / (IX1 - IX0) * (W - ml - mr), Y = l => mt + (LY1 - l) / (LY1 - LY0) * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted;
      x.textAlign = 'right'; for (let l = 0; l >= LY0; l -= 10) { x.beginPath(); x.moveTo(ml, Y(l)); x.lineTo(W - mr, Y(l)); x.stroke(); x.fillText(String(l).replace('-', '−'), ml - 6, Y(l) + 3); }
      x.textAlign = 'center'; for (let i = 1; i <= 3; i += 0.5) { x.beginPath(); x.moveTo(X(i), mt); x.lineTo(X(i), H - mb); x.stroke(); x.fillText(i.toFixed(1), X(i), H - mb + 14); }
      [1500, 1000, 700, 500, 400, 300].forEach(K => { x.fillText(K + ' K', X(1000 / K), mt - 8); });
      axisLabel(x, tx('1000 / T (K⁻¹)  ·  hot ←    → cold', '1000 / T（K⁻¹）・高溫 ←　→ 低溫'), (ml + W - mr) / 2, H - 6);
      axisLabel(x, 'log₁₀(rate / C)', 12, (mt + H - mb) / 2, -Math.PI / 2);
      const line = (Q, color, dash, w) => {
        x.save(); x.beginPath(); x.rect(ml, mt, W - ml - mr, H - mt - mb); x.clip();
        x.setLineDash(dash); x.strokeStyle = color; x.lineWidth = w; x.beginPath();
        x.moveTo(X(IX0), Y(-Q * 1000 * IX0 / 1000 / (2.303 * RG))); x.lineTo(X(IX1), Y(-Q * 1000 * IX1 / 1000 / (2.303 * RG))); x.stroke(); x.restore(); x.setLineDash([]);
      };
      line(50, T.edge3d, [5, 4], 1.2);
      const Q = +qS.value; line(Q, COL.corner, [], 2.4);
      [[+t1.value, COL.body], [+t2.value, T.hi]].forEach(([K, c]) => {
        const l = -Q * 1000 / (2.303 * RG * K);
        if (l < LY0) return;
        x.fillStyle = c; x.beginPath(); x.arc(X(1000 / K), Y(l), 5.5, 0, 7); x.fill();
        x.setLineDash([2, 3]); x.strokeStyle = c; x.lineWidth = 1; x.beginPath(); x.moveTo(X(1000 / K), Y(l)); x.lineTo(X(1000 / K), H - mb); x.stroke(); x.setLineDash([]);
      });
    }
    function text() {
      const Q = +qS.value, A = +t1.value, B = +t2.value, r = Math.exp(Q * 1000 / RG * (1 / A - 1 / B));
      $('#ar-Q-v').textContent = `${Q} kJ/mol (${(Q / 96.49).toFixed(2)} eV)`; $('#ar-T1-v').textContent = kC(A); $('#ar-T2-v').textContent = kC(B);
      const big = v => (v >= 1e4 || v < 1e-3 ? sciH(v, 2) : v.toPrecision(3));
      info.innerHTML = tx(`<dl class="stats"><dt>Slope ${TeX`-Q/(2.303\,R)`}</dt><dd>${(-Q * 1000 / (2.303 * RG)).toFixed(0)} K</dd><dt>rate(T<sub>2</sub>) / rate(T<sub>1</sub>)</dt><dd>${big(r)}</dd></dl>
        <div class="eq">${TeXd`\text{ratio} = \exp\!\left[\frac{Q}{R}\left(\frac{1}{T_1} - \frac{1}{T_2}\right)\right]`}</div>
        <p class="note">Try Q = 50 kJ/mol with T<sub>1</sub> = 300 K and T<sub>2</sub> = 310 K: the rate nearly doubles. That is the old rule that a reaction near room temperature doubles every 10 °C, and it only holds for barriers of about this size.</p>`,
        `<dl class="stats"><dt>斜率 ${TeX`-Q/(2.303\,R)`}</dt><dd>${(-Q * 1000 / (2.303 * RG)).toFixed(0)} K</dd><dt>速率(T<sub>2</sub>) / 速率(T<sub>1</sub>)</dt><dd>${big(r)}</dd></dl>
        <div class="eq">${TeXd`\text{比值} = \exp\!\left[\frac{Q}{R}\left(\frac{1}{T_1} - \frac{1}{T_2}\right)\right]`}</div>
        <p class="note">試試 Q = 50 kJ/mol、T<sub>1</sub> = 300 K、T<sub>2</sub> = 310 K：速率差不多翻倍。這就是「室溫附近每升 10 °C 反應快一倍」的老規則，只對大約這麼高的能障成立。</p>`);
    }
    const draw = canvas2d($('#ar-cv'), paint);
    [qS, t1, t2].forEach(s => s.addEventListener('input', () => { draw(); text(); }));
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     03 Vacancy and interstitial jumps (3D, animated)
     ===================================================================== */
  function secMech() {
    const v = new Viewer($('#v-mech'), { view: [0.15, -0.75, 1], label: () => tx('One atomic layer in which a vacancy or an interstitial atom jumps from site to site', '一層原子，空位或間隙原子在裡面一格一格地跳') });
    const info = $('#mc-info'), N = 9, C = (N - 1) / 2;
    const st = { mode: 'vac', run: !REDUCED, hops: 0 };
    let sim = null;
    const P = (i, j, z = 0) => V3(i - C, j - C, z);
    v.rebuild = () => {
      v.clear(); const g = v.root, rnd = rng(5);
      cloud(g, (() => { const a = []; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) a.push(P(i, j, -1)); return a; })(), 0.4, T.ghost3d, { opacity: 0.35 });
      const meshes = {};
      if (st.mode === 'vac') {
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (!(i === 4 && j === 4)) meshes[i + ',' + j] = atom(g, P(i, j), 0.42, COL.corner);
        const ring = atom(g, P(4, 4), 0.2, COL.plane, { opacity: 0.85 });
        sim = { g, rnd, meshes, at: [4, 4], ring, trail: [], phase: 0, mover: null };
      } else {
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) atom(g, P(i, j), 0.42, COL.corner, { opacity: 0.9 });
        const c = atom(g, P(3.5, 3.5), 0.19, COL.body);
        sim = { g, rnd, c, at: [3.5, 3.5], trail: [], phase: 0, mover: null };
      }
      st.hops = 0;
    };
    const HOP = () => (st.mode === 'vac' ? 1.1 : 0.55), MOVE = () => (st.mode === 'vac' ? 0.55 : 0.32);
    function next() {
      const s = sim, [i, j] = s.at, lo = st.mode === 'vac' ? 1 : 0.5, hi = st.mode === 'vac' ? N - 2 : N - 1.5;
      const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [i + a, j + b]).filter(([a, b]) => a >= lo && a <= hi && b >= lo && b <= hi);
      return opts[Math.floor(s.rnd() * opts.length)];
    }
    function addTrail(a, b) {
      const s = sim, m = rod(s.g, P(a[0], a[1], 0.5), P(b[0], b[1], 0.5), 0.05, mStd(COL.plane, { opacity: 0.85 }));
      s.trail.push(m);
      if (s.trail.length > 40) { const o = s.trail.shift(); s.g.remove(o); o.material.dispose(); }
    }
    let t0 = null;
    v.anim = t => {
      if (!sim) return;
      const now = t / 1000; if (t0 === null) t0 = now; const dt = Math.min(0.05, now - t0); t0 = now;
      if (!st.run) return;
      const s = sim; s.phase += dt;
      if (!s.mover && s.phase >= HOP()) {
        s.phase = 0; const to = next();
        if (st.mode === 'vac') {
          // the neighbor atom at `to` jumps into the vacancy at `at`
          const m = s.meshes[to[0] + ',' + to[1]]; m.material.color.set(T.hi);
          s.mover = { m, from: P(to[0], to[1]), dest: P(s.at[0], s.at[1]), a: s.at, b: to, k: 0 };
        } else {
          s.c.material.color.set(T.hi);
          s.mover = { m: s.c, from: P(s.at[0], s.at[1]), dest: P(to[0], to[1]), a: s.at, b: to, k: 0 };
        }
      }
      if (s.mover) {
        const mv = s.mover; mv.k = Math.min(1, mv.k + dt / MOVE());
        const e = mv.k * mv.k * (3 - 2 * mv.k);
        mv.m.position.copy(mv.from).lerp(mv.dest, e); mv.m.position.z += Math.sin(Math.PI * e) * (st.mode === 'vac' ? 0.38 : 0.12);
        if (mv.k >= 1) {
          if (st.mode === 'vac') {
            delete s.meshes[mv.b[0] + ',' + mv.b[1]]; s.meshes[mv.a[0] + ',' + mv.a[1]] = mv.m; mv.m.material.color.set(COL.corner);
            addTrail(mv.a, mv.b); s.at = mv.b; s.ring.position.copy(P(mv.b[0], mv.b[1]));
          } else {
            mv.m.material.color.set(COL.body); addTrail(mv.a, mv.b); s.at = mv.b;
          }
          s.mover = null; st.hops++; text();
        }
      }
      v.dirty = true;
    };
    function legend() {
      $('#mc-legend').innerHTML = st.mode === 'vac'
        ? tx('<span><i style="background:var(--c-corner)"></i>Host atoms</span><span><i style="background:var(--hi)"></i>Atom jumping now</span><span><i style="background:var(--c-plane)"></i>Vacancy and its path</span>', '<span><i style="background:var(--c-corner)"></i>母材原子</span><span><i style="background:var(--hi)"></i>正在跳的原子</span><span><i style="background:var(--c-plane)"></i>空位與它走過的路</span>')
        : tx('<span><i style="background:var(--c-corner)"></i>Host atoms</span><span><i style="background:var(--c-body)"></i>Small interstitial atom (C)</span><span><i class="sq" style="background:var(--c-plane)"></i>Its path</span>', '<span><i style="background:var(--c-corner)"></i>母材原子</span><span><i style="background:var(--c-body)"></i>小的間隙原子（C）</span><span><i class="sq" style="background:var(--c-plane)"></i>它走過的路</span>');
    }
    function text() {
      const d = sim ? Math.hypot(sim.at[0] - (st.mode === 'vac' ? 4 : 3.5), sim.at[1] - (st.mode === 'vac' ? 4 : 3.5)) : 0, n = st.hops;
      const walk = tx(`<dl class="stats"><dt>Jumps so far</dt><dd>${n}</dd><dt>Distance from the start</dt><dd>${d.toFixed(1)} spacings</dd><dt>Typical for a random walk, √n</dt><dd>${Math.sqrt(n).toFixed(1)} spacings</dd></dl>`,
        `<dl class="stats"><dt>目前跳了</dt><dd>${n} 次</dd><dt>離起點的距離</dt><dd>${d.toFixed(1)} 個間距</dd><dt>隨機漫步的典型值 √n</dt><dd>${Math.sqrt(n).toFixed(1)} 個間距</dd></dl>`);
      info.innerHTML = (st.mode === 'vac'
        ? tx('<h4>Vacancy mechanism</h4><div class="eq">' + TeXd`E^* = E_v + E_m` + '</div><p>Each time, one neighbor of the vacancy (red) jumps into it. The atom moves one step, the vacancy moves one step back. Follow the purple trail: the vacancy wanders far, while each atom moves only when the vacancy happens to pass by. On top of the jump itself, a vacancy has to exist next to the atom, which costs E<sub>v</sub>.</p>', '<h4>空位機制</h4><div class="eq">' + TeXd`E^* = E_v + E_m` + '</div><p>每一次，空位旁邊的一個原子（紅）跳進空位。原子走一步，空位就倒退一步。跟著紫色軌跡看：空位四處遊走，而每個原子只有在空位剛好經過時才動一下。除了跳躍本身，原子旁邊還得先有一個空位，這要付出 E<sub>v</sub>。</p>')
        : tx('<h4>Interstitial mechanism</h4><div class="eq">' + TeXd`E^* = E_m` + '</div><p>The small carbon atom sits in the gap between four host atoms and squeezes between two of them into the next gap. The neighboring gaps are almost always empty, so no vacancy needs to form and the atom can jump at every chance. That is why it hops about twice as often here, and in real iron millions of times more often.</p>', '<h4>間隙機制</h4><div class="eq">' + TeXd`E^* = E_m` + '</div><p>小小的碳原子待在四個母材原子之間的空隙，從其中兩個原子之間擠過去，到下一個空隙。旁邊的空隙幾乎總是空的，不必形成空位，每次機會都能跳。所以這裡它跳得大約快一倍；在真實的鐵裡，快的是幾百萬倍。</p>')) + walk;
    }
    seg($('#mc-s'), m => { st.mode = m; v.rebuild(); legend(); text(); });
    seg($('#mc-run'), a => {
      if (a === 'reset') { v.rebuild(); st.run = true; setSeg($('#mc-run'), 'run'); text(); return; }
      st.run = a === 'run';
    });
    if (!st.run) setSeg($('#mc-run'), 'stop');
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, -0.3), 5.6); text(); });
    legend(); text(); onLang(() => { legend(); text(); });
    // theme change rebuilds the scene: restart the walk cleanly
    const rb = v.rebuild; v.rebuild = () => { rb(); text(); };
  }

  /* =====================================================================
     04 Kirkendall effect: Darken's equations for a Zn | Cu couple (2D)
     ===================================================================== */
  function secKK() {
    const tS = $('#kk-t'), info = $('#kk-info'); let r = 2.3;
    const NX = 161, L = 1, dx = 2 * L / (NX - 1), TAU = 0.05, SNAP = 100;
    let snaps = null, marks = null;
    function solve() {
      // X = zinc fraction; Zn on the left. D_Cu = 1, D_Zn = r. Interdiffusion D̃ = X·D_Cu + (1 − X)·D_Zn.
      let Xa = new Float64Array(NX); for (let i = 0; i < NX; i++) { const xx = -L + i * dx; Xa[i] = xx < -1e-9 ? 1 : xx > 1e-9 ? 0 : 0.5; }
      const dt = 0.22 * dx * dx / Math.max(r, 1), steps = Math.ceil(TAU / dt), per = steps / SNAP;
      snaps = [Float64Array.from(Xa)]; marks = [0];
      let xm = 0, nb = new Float64Array(NX), nextSnap = per;
      const grad = (A, p) => { const f = (p + L) / dx, i = Math.max(1, Math.min(NX - 2, Math.round(f))); return (A[i + 1] - A[i - 1]) / (2 * dx); };
      for (let s = 1; s <= steps; s++) {
        for (let i = 1; i < NX - 1; i++) {
          const Dp = (Xa[i] + Xa[i + 1]) / 2, Dm = (Xa[i] + Xa[i - 1]) / 2;
          const Dr = Dp + (1 - Dp) * r, Dl = Dm + (1 - Dm) * r;
          nb[i] = Xa[i] + dt / (dx * dx) * (Dr * (Xa[i + 1] - Xa[i]) - Dl * (Xa[i] - Xa[i - 1]));
        }
        nb[0] = nb[1]; nb[NX - 1] = nb[NX - 2];
        [Xa, nb] = [nb, Xa];
        xm += (r - 1) * grad(Xa, xm) * dt;
        if (s >= nextSnap) { snaps.push(Float64Array.from(Xa)); marks.push(xm); nextSnap += per; }
      }
      while (snaps.length <= SNAP) { snaps.push(Float64Array.from(Xa)); marks.push(xm); }
    }
    const voids = (() => { const q = rng(9); return Array.from({ length: 60 }, () => [q(), q(), 0.5 + q()]); })();
    function paint(x, W, H) {
      blank(x, W, H);
      const k = +tS.value, Xa = snaps[k], xm = marks[k];
      const ml = 40, mr = 14, mt = 64, barH = 46, mb = 34 + barH + 14, XX = p => ml + (p + L) / (2 * L) * (W - ml - mr), Y = v => mt + (1 - v) * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted; x.textAlign = 'right';
      [0, 0.5, 1].forEach(v => { x.beginPath(); x.moveTo(ml, Y(v)); x.lineTo(W - mr, Y(v)); x.stroke(); x.fillText(v.toFixed(1), ml - 6, Y(v) + 3); });
      axisLabel(x, 'X(Zn)', 12, (mt + H - mb) / 2, -Math.PI / 2, COL.body);
      // starting interface
      x.setLineDash([5, 4]); x.strokeStyle = T.edge3d; x.lineWidth = 1.2; x.beginPath(); x.moveTo(XX(0), mt - 6); x.lineTo(XX(0), H - 34); x.stroke(); x.setLineDash([]);
      // profile
      x.strokeStyle = COL.body; x.lineWidth = 2.4; x.beginPath(); for (let i = 0; i < NX; i++) { const px = XX(-L + i * dx), py = Y(Xa[i]); i ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
      // the specimen: colored by composition
      const by = H - 34 - barH;
      for (let i = 0; i < NX - 1; i++) { const v = Xa[i]; x.fillStyle = v > 0.5 ? COL.body : COL.corner; x.globalAlpha = 0.35 + 0.6 * Math.abs(v - 0.5); x.fillRect(XX(-L + i * dx), by, XX(-L + (i + 1) * dx) - XX(-L + i * dx) + 0.6, barH); }
      x.globalAlpha = 1;
      // voids on the zinc side, in proportion to the vacancies that arrived there
      const nV = Math.round(Math.min(60, Math.abs(xm) * 240));
      x.fillStyle = T.stage; x.strokeStyle = COL.plane; x.lineWidth = 1.2;
      for (let i = 0; i < nV; i++) { const [a, b, s] = voids[i], px = XX(xm - 0.04 - a * 0.42), py = by + 6 + b * (barH - 12); x.beginPath(); x.arc(px, py, 2.2 * s + 1, 0, 7); x.fill(); x.stroke(); }
      // marker
      x.fillStyle = COL.plane; x.strokeStyle = COL.plane; x.lineWidth = 2.4;
      x.beginPath(); x.moveTo(XX(xm), by - 4); x.lineTo(XX(xm), by + barH + 4); x.stroke();
      x.beginPath(); x.moveTo(XX(xm), by - 4); x.lineTo(XX(xm) - 6, by - 13); x.lineTo(XX(xm) + 6, by - 13); x.closePath(); x.fill();
      x.fillStyle = T.ink; x.font = FONT(600, 11); x.textAlign = 'left'; x.fillText('Zn', ml + 4, by + barH + 16); x.textAlign = 'right'; x.fillText('Cu', W - mr - 4, by + barH + 16);
      x.textAlign = 'center'; x.fillStyle = COL.plane; x.fillText(tx('marker', '標記'), XX(xm), by + barH + 16);
      // fluxes at the marker
      const gi = Math.max(1, Math.min(NX - 2, Math.round((xm + L) / dx))), g = Math.abs((Xa[gi + 1] - Xa[gi - 1]) / (2 * dx));
      if (k > 0 && g > 1e-6) {
        // J(Zn) always gets a quarter of the width; the other two are drawn to the same scale
        const sc = (W - ml - mr) * 0.25 / (r * g), cx = XX(xm);
        const rows = [[r * g, COL.body, 'J(Zn)', 1, 14], [g, COL.corner, 'J(Cu)', -1, 32], [(r - 1) * g, COL.plane, 'J(v)', -1, 50]];
        rows.forEach(([m, c, s, d, y]) => {
          const len = m * sc; x.fillStyle = c; x.font = MFONT(600, 11); x.textAlign = d > 0 ? 'right' : 'left';
          if (len < 2) { x.fillText(s + ' = 0', cx + (d > 0 ? -6 : 6), y + 4); return; }
          arrow2d(x, cx, y, cx + d * len, y, c, 2.4); x.fillStyle = c; x.textAlign = d > 0 ? 'right' : 'left'; x.fillText(s, cx - d * 6, y + 4);
        });
      }
    }
    function text() {
      const k = +tS.value, xm = marks[k];
      $('#kk-t-v').textContent = (k / 100).toFixed(2) + tx(' (relative)', '（相對值）');
      const where = r === 1 ? tx('stays exactly at the starting interface', '一直停在原本的界面上') : tx(`has moved ${(Math.abs(xm) / (2 * L) * 100).toFixed(1)} % of the bar length toward the zinc`, `已經往鋅那邊移動了試片長度的 ${(Math.abs(xm) / (2 * L) * 100).toFixed(1)} %`);
      info.innerHTML = tx(`<dl class="stats"><dt>D<sub>Zn</sub> / D<sub>Cu</sub></dt><dd>${r}</dd><dt>At the marker</dt><dd>J<sub>Zn</sub> : J<sub>Cu</sub> : J<sub>v</sub> = ${r} : 1 : ${(r - 1).toFixed(1)}</dd></dl>
        <p>The marker ${where}.</p>
        <div class="eq">marker velocity ${TeXd`v = (D_\text{Zn} - D_\text{Cu})\,\frac{\partial X_\text{Zn}}{\partial x}`}</div>
        <p class="note">${r === 1 ? 'Equal diffusivities: as many atoms leave each side as arrive, no vacancy flux, no drift, no voids.' : 'More zinc atoms leave the left than copper atoms arrive. The missing atoms are vacancies flowing left (J<sub>v</sub>), which collect as voids on the zinc side.'}</p>`,
        `<dl class="stats"><dt>D<sub>Zn</sub> / D<sub>Cu</sub></dt><dd>${r}</dd><dt>在標記處</dt><dd>J<sub>Zn</sub> : J<sub>Cu</sub> : J<sub>v</sub> = ${r} : 1 : ${(r - 1).toFixed(1)}</dd></dl>
        <p>標記${where}。</p>
        <div class="eq">標記速度 ${TeXd`v = (D_\text{Zn} - D_\text{Cu})\,\frac{\partial X_\text{Zn}}{\partial x}`}</div>
        <p class="note">${r === 1 ? '擴散係數相同：每一側離開的原子和進來的一樣多，沒有空位通量、不會漂移、也沒有孔洞。' : '離開左邊的鋅原子比進來的銅原子多。少掉的原子就是往左流的空位（J<sub>v</sub>），在鋅那一側聚成孔洞。'}</p>`);
    }
    solve();
    const draw = canvas2d($('#kk-cv'), paint);
    tS.addEventListener('input', () => { draw(); text(); });
    seg($('#kk-r'), v => { r = +v; solve(); draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     05 Fick's first law: a random walk between a full and an empty end (3D)
     ===================================================================== */
  function secFick() {
    const v = new Viewer($('#v-fick'), { view: [0.25, -1, 0.45], label: () => tx('A bar in which atoms random-walk from a full left end to an empty right end', '一根棒子，原子從滿的左端隨機漫步到空的右端') });
    const cS = $('#f1-c'), dS = $('#f1-d'), info = $('#f1-info');
    const L = 10, RHO = 6, AREA = 4, CAP = 420, D0 = 4;
    const rnd = rng(3); let pts = [], mesh = null, win = [], tAcc = 0, lastText = 0, simT = 0;
    const rho1 = () => RHO * +cS.value / 100;
    const gauss = () => { let u = 0, w = 0; while (!u) u = rnd(); w = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
    const put = (x0, x1) => ({ x: x0 + rnd() * (x1 - x0), y: rnd() * 2 - 1, z: rnd() * 2 - 1 });
    function seed() {
      pts = []; const r1 = rho1();
      for (let i = 0; i < Math.round(r1 * AREA); i++) pts.push(put(-1, 0));
      // start from the steady straight-line profile
      for (let b = 0; b < 20; b++) { const x0 = b * L / 20, n = r1 * (1 - (b + 0.5) / 20) * AREA * L / 20; for (let i = 0; i < Math.round(n); i++) pts.push(put(x0, x0 + L / 20)); }
      win = []; simT = 0;
    }
    v.rebuild = () => {
      v.clear(); const g = v.root, O = V3(-L / 2, 0, 0);
      const box = (x0, x1, color, op) => {
        const c = [[x0, -1, -1], [x1, -1, -1], [x1, 1, -1], [x0, 1, -1], [x0, -1, 1], [x1, -1, 1], [x1, 1, 1], [x0, 1, 1]].map(p => V3(...p).add(O));
        [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([a, b]) => rod(g, c[a], c[b], 0.018, mStd(color, { opacity: op })));
      };
      box(0, L, T.edge3d, 0.9); box(-1, 0, COL.body, 0.6); box(L, L + 1, T.edge3d, 0.5);
      poly(g, [V3(L / 2, -1, -1), V3(L / 2, 1, -1), V3(L / 2, 1, 1), V3(L / 2, -1, 1)].map(p => p.add(O)), COL.plane, 0.22, true);
      label(g, 'C₁', V3(-0.5, 0, 1.55).add(O), { size: 0.42, color: COL.body });
      label(g, 'C₂ ≈ 0', V3(L + 0.5, 0, 1.55).add(O), { size: 0.42 });
      label(g, tx('counting plane', '計數平面'), V3(L / 2, 0, 1.5).add(O), { size: 0.3, color: COL.plane });
      mesh = new THREE.InstancedMesh(GEO.sphere, mStd(COL.body), CAP); mesh.frustumCulled = false; g.add(mesh);
      place();
    };
    const M4 = GL ? new THREE.Matrix4() : null;
    function place() {
      if (!mesh) return; const n = Math.min(CAP, pts.length);
      for (let i = 0; i < n; i++) { const p = pts[i]; M4.makeScale(0.11, 0.11, 0.11); M4.setPosition(p.x - L / 2, p.y, p.z); mesh.setMatrixAt(i, M4); }
      mesh.count = n; mesh.instanceMatrix.needsUpdate = true; v.dirty = true;
    }
    function step(dt) {
      const D = D0 * +dS.value, s = Math.sqrt(2 * D * dt), mid = L / 2; let net = 0;
      for (const p of pts) {
        const ox = p.x; p.x += s * gauss(); p.y += s * gauss(); p.z += s * gauss();
        if (p.y > 1) p.y = 2 - p.y; if (p.y < -1) p.y = -2 - p.y; if (p.z > 1) p.z = 2 - p.z; if (p.z < -1) p.z = -2 - p.z;
        if (ox < mid && p.x >= mid) net++; else if (ox >= mid && p.x < mid) net--;
      }
      pts = pts.filter(p => p.x > -1 && p.x < L + 1);
      // hold the two ends at their densities
      const inL = pts.filter(p => p.x < 0), want = Math.round(rho1() * AREA);
      if (inL.length < want) for (let i = inL.length; i < want; i++) pts.push(put(-1, 0));
      else if (inL.length > want) { let drop = inL.length - want; pts = pts.filter(p => !(p.x < 0 && drop-- > 0)); }
      pts = pts.filter(p => p.x < L);
      if (pts.length > CAP) pts.length = CAP;
      // density in six 1-unit bins across the middle of the bar, for the measured gradient
      const bins = [0, 0, 0, 0, 0, 0]; for (const p of pts) if (p.x >= 2 && p.x < 8) bins[Math.floor(p.x - 2)]++;
      simT += dt; win.push([simT, net, dt, bins]); while (win.length && win[0][0] < simT - 8) win.shift();
    }
    let t0 = null;
    v.anim = t => {
      const now = t / 1000; if (t0 === null) t0 = now; const dt = Math.min(0.05, now - t0); t0 = now;
      if (REDUCED || !mesh) return;
      step(dt); place();
      tAcc += dt; if (tAcc - lastText > 0.5) { lastText = tAcc; text(); }
    };
    function text() {
      const D = D0 * +dS.value;
      $('#f1-c-v').textContent = `${cS.value} %`; $('#f1-d-v').textContent = `× ${(+dS.value).toFixed(2)}`;
      const span = win.reduce((a, w) => a + w[2], 0);
      if (REDUCED || span < 2) {
        info.innerHTML = tx(`<div class="eq">${TeXd`J = -D\,\frac{dC}{dx}`}</div><p>${REDUCED ? 'Animation is off (reduced motion), so nothing is counted. With the ends held at C<sub>1</sub> and about 0, the profile is a straight line and J ≈ D · C<sub>1</sub> / L.' : 'Counting… give it a few seconds.'}</p>`,
          `<div class="eq">${TeXd`J = -D\,\frac{dC}{dx}`}</div><p>${REDUCED ? '動畫已關閉（減少動態效果），所以沒有計數。兩端固定在 C<sub>1</sub> 和約 0 時，分布是直線，J ≈ D · C<sub>1</sub> / L。' : '計數中……等幾秒。'}</p>`);
        return;
      }
      // time-averaged density per bin (atoms per unit volume), then a least-squares slope
      const c = [0, 1, 2, 3, 4, 5].map(i => win.reduce((a, w) => a + w[3][i] * w[2], 0) / span / AREA);
      const mc = c.reduce((a, b) => a + b) / 6; let num = 0, den = 0; c.forEach((v, i) => { num += (i - 2.5) * (v - mc); den += (i - 2.5) ** 2; });
      const g = num / den, Jf = -D * g, Jm = win.reduce((a, w) => a + w[1], 0) / (AREA * (win[win.length - 1][0] - win[0][0] || 1));
      info.innerHTML = tx(`<div class="eq">${TeXd`J = -D\,\frac{dC}{dx}`}</div>
        <dl class="stats"><dt>Measured gradient dC/dx</dt><dd>${g.toFixed(3)}</dd><dt>−D · dC/dx</dt><dd>${Jf.toFixed(2)}</dd><dt>J counted at the purple plane</dt><dd>${Jm.toFixed(2)}</dd></dl>
        <p class="note">Both are measured from the moving atoms over the last 8 s, in model units (atoms per unit area per second). They agree to within the noise, which is Fick's first law. Halve C<sub>1</sub> or D and both halve.</p>`,
        `<div class="eq">${TeXd`J = -D\,\frac{dC}{dx}`}</div>
        <dl class="stats"><dt>量到的梯度 dC/dx</dt><dd>${g.toFixed(3)}</dd><dt>−D · dC/dx</dt><dd>${Jf.toFixed(2)}</dd><dt>紫色平面數到的 J</dt><dd>${Jm.toFixed(2)}</dd></dl>
        <p class="note">兩個數字都是從最近 8 秒移動的原子量出來的，單位是模型單位（每秒、每單位面積的原子數）。兩者在雜訊範圍內相符，這就是 Fick’s first law。C<sub>1</sub> 或 D 減半，兩者都減半。</p>`);
    }
    cS.addEventListener('input', () => { seed(); place(); text(); });
    dS.addEventListener('input', () => { win = []; text(); });
    seed();
    v.lazy(() => { v.rebuild(); v.frame(V3(0, 0, 0), 5.5); });
    text(); onLang(text);
  }

  /* =====================================================================
     06 Fick's second law: Ni–Cu couple and thin layer at 400 °C (2D)
     ===================================================================== */
  function secF2() {
    const tS = $('#f2-t'), xS = $('#f2-x'), info = $('#f2-info'); let mode = 'couple';
    const D = 6e-8 * Math.exp(-0.98 / (KB * 673)) * 1e8, C0 = 60, H0 = 0.05; // D in µm²/s
    const CFG = { couple: { xr: 2, tmax: 25 * 86400 }, film: { xr: 0.2, tmax: 7200 } };
    const tNow = () => (+tS.value / 100) ** 2 * CFG[mode].tmax;
    function C(xx, t) {
      if (mode === 'couple') { if (t <= 0) return xx < 0 ? C0 : xx > 0 ? 0 : C0 / 2; return C0 / 2 * (1 - erf(xx / (2 * Math.sqrt(D * t)))); }
      if (t <= 0) return Math.abs(xx) <= H0 / 2 ? C0 : 0;
      const w = 2 * Math.sqrt(D * t); return C0 / 2 * (erf((H0 / 2 - xx) / w) + erf((H0 / 2 + xx) / w));
    }
    const dC = (xx, t, h) => (C(xx + h, t) - C(xx - h, t)) / (2 * h), d2C = (xx, t, h) => (C(xx + h, t) - 2 * C(xx, t) + C(xx - h, t)) / (h * h);
    const fmtT = t => (t < 3600 ? tx(`${(t / 60).toFixed(0)} min`, `${(t / 60).toFixed(0)} 分鐘`) : t < 86400 * 1.5 ? tx(`${(t / 3600).toFixed(1)} h`, `${(t / 3600).toFixed(1)} 小時`) : tx(`${(t / 86400).toFixed(1)} days`, `${(t / 86400).toFixed(1)} 天`));
    function paint(x, W, H) {
      blank(x, W, H);
      const { xr } = CFG[mode], t = tNow(), ml = 44, mr = 14, mt = 16, mb = 34, XX = p => ml + (p + xr) / (2 * xr) * (W - ml - mr), Y = c => mt + (C0 * 1.08 - c) / (C0 * 1.08) * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted; x.textAlign = 'right';
      [0, 20, 40, 60].forEach(c => { x.beginPath(); x.moveTo(ml, Y(c)); x.lineTo(W - mr, Y(c)); x.stroke(); x.fillText(c, ml - 6, Y(c) + 3); });
      x.textAlign = 'center'; for (let i = -4; i <= 4; i++) { const p = i * xr / 4; x.fillText((Math.abs(p) < 1e-9 ? 0 : p).toFixed(mode === 'couple' ? 1 : 2), XX(p), H - mb + 14); }
      axisLabel(x, tx('x (µm)', 'x（µm）'), (ml + W - mr) / 2, H - 6); axisLabel(x, tx('Cu (at%)', 'Cu（at%）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
      const n = 240, h = 2 * xr / n;
      if (t > 0) for (let i = 0; i < n; i++) {
        const p = -xr + (i + 0.5) * h, c2 = d2C(p, t, h), c = C(p, t);
        if (Math.abs(c2) * (xr * xr) < 0.6) continue;
        // whole-pixel strips so neighbors neither overlap nor leave gaps
        const p0 = Math.round(XX(p - h / 2)), p1 = Math.round(XX(p + h / 2));
        x.fillStyle = c2 > 0 ? COL.face : T.hi; x.globalAlpha = 0.22; x.fillRect(p0, Y(c), p1 - p0, Y(0) - Y(c));
      }
      x.globalAlpha = 1;
      const curve = (tt, color, w, dash) => { x.setLineDash(dash); x.strokeStyle = color; x.lineWidth = w; x.beginPath(); for (let i = 0; i <= n; i++) { const p = -xr + i * h, py = Y(C(p, tt)); i ? x.lineTo(XX(p), py) : x.moveTo(XX(p), py); } x.stroke(); x.setLineDash([]); };
      curve(0, T.edge3d, 1.2, [5, 4]); if (t > 0) curve(t, COL.body, 2.4, []);
      // slice with flux in and out
      const xs = +xS.value / 100 * xr * 0.9, dw = xr * 0.06;
      x.fillStyle = T.ink; x.globalAlpha = 0.1; x.fillRect(XX(xs - dw / 2), mt, XX(xs + dw / 2) - XX(xs - dw / 2), H - mt - mb); x.globalAlpha = 1;
      x.strokeStyle = T.ink; x.lineWidth = 1; [xs - dw / 2, xs + dw / 2].forEach(p => { x.beginPath(); x.moveTo(XX(p), mt); x.lineTo(XX(p), H - mb); x.stroke(); });
      if (t > 0) {
        let jmax = 0; for (let i = 0; i <= n; i++) jmax = Math.max(jmax, Math.abs(dC(-xr + i * h, t, h)));
        const sc = (XX(xr) - XX(-xr)) * 0.09 / (jmax || 1), yA = mt + 18;
        [[xs - dw / 2, 'J(x)'], [xs + dw / 2, 'J(x+Δx)']].forEach(([p, s], i) => {
          const J = -dC(p, t, h), len = J * sc, y = yA + i * 22;
          if (Math.abs(len) > 1.5) arrow2d(x, XX(p) - len / 2, y, XX(p) + len / 2, y, T.ink, 2);
          x.fillStyle = T.ink; x.font = MFONT(600, 10); x.textAlign = 'left'; x.fillText(s, XX(p) + Math.abs(len) / 2 + 5, y + 4);
        });
      }
    }
    function text() {
      const t = tNow(), { xr } = CFG[mode], xs = +xS.value / 100 * xr * 0.9, h = 2 * xr / 240, L = Math.sqrt(D * t);
      $('#f2-t-v').textContent = t ? fmtT(t) : '0'; $('#f2-x-v').textContent = `x = ${xs.toFixed(mode === 'couple' ? 2 : 3)} µm`;
      if (!t) { info.innerHTML = tx('<p>t = 0: nothing has moved yet. Drag the time slider.</p>', '<p>t = 0：還沒有任何原子移動。拖動時間滑桿。</p>'); return; }
      const c2 = d2C(xs, t, h), rate = D * c2;
      const verdict = Math.abs(c2) * xr * xr < 0.6 ? tx('about the same: the profile is nearly straight here, so C hardly changes', '差不多：這裡的分布幾乎是直線，C 幾乎不變') : c2 > 0 ? tx('more flows in than out: C is rising', '流進比流出多：C 正在上升') : tx('more flows out than in: C is falling', '流出比流進多：C 正在下降');
      const peak = mode === 'film' ? tx(`<dt>Peak concentration</dt><dd>${C(0, t).toFixed(1)} at%</dd>`, `<dt>峰值濃度</dt><dd>${C(0, t).toFixed(1)} at%</dd>`) : tx(`<dt>At the interface</dt><dd>${C(0, t).toFixed(0)} at% = C<sub>0</sub>/2</dd>`, `<dt>界面上</dt><dd>${C(0, t).toFixed(0)} at% = C<sub>0</sub>/2</dd>`);
      info.innerHTML = tx(`<dl class="stats"><dt>D (Cu in Ni, 400 °C)</dt><dd>${sciH(D * 1e-8, 1)} cm²/s</dd><dt>Diffusion length ${TeX`\sqrt{Dt}`}</dt><dd>${L < 0.1 ? (L * 1000).toFixed(0) + ' nm' : L.toFixed(2) + ' µm'}</dd>${peak}<dt>In the slice</dt><dd style="font-family:var(--f-body)">${verdict}</dd><dt>${TeX`\partial C/\partial t = D\,\partial^2 C/\partial x^2`}</dt><dd>${(rate * 3600).toFixed(rate * 3600 > 10 ? 0 : 2)} at% per hour</dd></dl>`,
        `<dl class="stats"><dt>D（Cu 在 Ni 中，400 °C）</dt><dd>${sciH(D * 1e-8, 1)} cm²/s</dd><dt>擴散長度 ${TeX`\sqrt{Dt}`}</dt><dd>${L < 0.1 ? (L * 1000).toFixed(0) + ' nm' : L.toFixed(2) + ' µm'}</dd>${peak}<dt>薄層裡</dt><dd style="font-family:var(--f-body)">${verdict}</dd><dt>${TeX`\partial C/\partial t = D\,\partial^2 C/\partial x^2`}</dt><dd>每小時 ${(rate * 3600).toFixed(rate * 3600 > 10 ? 0 : 2)} at%</dd></dl>`) +
        (mode === 'film' ? tx('<p class="note">Once ' + TeX`\sqrt{Dt}` + ' is well past the 50 nm layer, the curve is the Gaussian ' + TeX`\frac{n}{\sqrt{4\pi Dt}}\,e^{-x^2/4Dt}` + ' with n = 60 at% × 0.05 µm. Its area never changes: no atoms are lost, they only spread.</p>', '<p class="note">當 ' + TeX`\sqrt{Dt}` + ' 遠大於 50 nm 的層厚，曲線就是高斯函數 ' + TeX`\frac{n}{\sqrt{4\pi Dt}}\,e^{-x^2/4Dt}` + '，n = 60 at% × 0.05 µm。它的面積始終不變：原子沒有消失，只是散開。</p>')
          : tx('<p class="note">The profile keeps the same shape and only stretches as ' + TeX`\sqrt{Dt}` + ': 25 days spreads it √5 ≈ 2.2 times wider than 5 days.</p>', '<p class="note">分布的形狀不變，只是依 ' + TeX`\sqrt{Dt}` + ' 拉寬：25 天比 5 天寬 √5 ≈ 2.2 倍。</p>'));
    }
    const draw = canvas2d($('#f2-cv'), paint);
    [tS, xS].forEach(s => s.addEventListener('input', () => { draw(); text(); }));
    seg($('#f2-m'), m => { mode = m; draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     07 Carburizing a 1018 steel gear (2D)
     ===================================================================== */
  function secCB() {
    const xS = $('#cb-x'), tS = $('#cb-t'), info = $('#cb-info'); let TK = 1200;
    const CS = 1.15, C0 = 0.18, CT = 0.35, XR = 1.6;
    const Dt = () => 1.28e-11 * Math.exp(-148000 / RG * (1 / TK - 1 / 1200));
    const prof = (xmm, ts) => (ts <= 0 ? (xmm <= 0 ? CS : C0) : CS - (CS - C0) * erf(xmm * 1e-3 / (2 * Math.sqrt(Dt() * ts))));
    function paint(x, W, H) {
      blank(x, W, H);
      const ml = 44, mr = 14, mt = 16, mb = 34, XX = p => ml + p / XR * (W - ml - mr), Y = c => mt + (1.25 - c) / 1.25 * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted; x.textAlign = 'right';
      [0, 0.25, 0.5, 0.75, 1, 1.25].forEach(c => { x.beginPath(); x.moveTo(ml, Y(c)); x.lineTo(W - mr, Y(c)); x.stroke(); x.fillText(c.toFixed(2), ml - 6, Y(c) + 3); });
      x.textAlign = 'center'; for (let p = 0; p <= XR + 1e-9; p += 0.25) x.fillText(p.toFixed(2), XX(p), H - mb + 14);
      axisLabel(x, tx('depth below the surface (mm)', '表面下的深度（mm）'), (ml + W - mr) / 2, H - 6); axisLabel(x, 'wt% C', 12, (mt + H - mb) / 2, -Math.PI / 2);
      const curve = (ts, color, w) => { x.strokeStyle = color; x.lineWidth = w; x.beginPath(); for (let i = 0; i <= 200; i++) { const p = i / 200 * XR, py = Y(prof(p, ts)); i ? x.lineTo(XX(p), py) : x.moveTo(XX(p), py); } x.stroke(); };
      const tm = +tS.value;
      for (let m = 30; m < tm; m += 30) curve(m * 60, T.edge3d, 1);
      curve(tm * 60, COL.body, 2.6);
      x.setLineDash([4, 4]); x.strokeStyle = T.hi; x.lineWidth = 1;
      const xt = +xS.value; x.beginPath(); x.moveTo(XX(xt), mt); x.lineTo(XX(xt), H - mb); x.moveTo(ml, Y(CT)); x.lineTo(W - mr, Y(CT)); x.stroke(); x.setLineDash([]);
      x.fillStyle = T.hi; x.beginPath(); x.arc(XX(xt), Y(CT), 5.5, 0, 7); x.fill();
      x.fillStyle = T.muted; x.font = FONT(500, 11); x.textAlign = 'right'; x.fillText(tx('core: 0.18 wt%', '心部：0.18 wt%'), W - mr - 4, Y(C0) - 6);
      x.textAlign = 'left'; x.fillText(tx('surface: 1.15 wt%', '表面：1.15 wt%'), ml + 6, Y(CS) - 6);
    }
    function text() {
      const xt = +xS.value, tm = +tS.value, D = Dt(), ratio = (CS - CT) / (CS - C0), z = 0.95 + 0.05 * (ratio - erf(0.95)) / (erf(1.0) - erf(0.95)), tNeed = (xt * 1e-3) ** 2 / (4 * D * z * z), cNow = prof(xt, tm * 60);
      $('#cb-x-v').textContent = `${xt.toFixed(2)} mm`; $('#cb-t-v').textContent = tm < 60 ? tx(`${tm} min`, `${tm} 分鐘`) : tx(`${(tm / 60).toFixed(2)} h (${tm} min)`, `${(tm / 60).toFixed(2)} 小時（${tm} 分鐘）`);
      const ok = cNow >= CT;
      const e0 = erf(0.95), e1 = erf(1.0);
      info.innerHTML = tx(`<div class="eq">${TeXd`\frac{1.15 - 0.35}{1.15 - 0.18} = ${ratio.toFixed(4)} = \operatorname{erf}(z)`}</div>
        <p>From the table, erf(0.95) = ${e0.toFixed(4)} and erf(1.00) = ${e1.toFixed(4)}, so z = 0.95 + 0.05 × (${ratio.toFixed(4)} − ${e0.toFixed(4)}) / (${e1.toFixed(4)} − ${e0.toFixed(4)}) = <b>${z.toFixed(3)}</b>.</p>
        <div class="eq">${TeXd`t = \frac{x^2}{4Dz^2} = \frac{(${sciT(xt * 1e-3)}\ \text{m})^2}{4\times ${sciT(D)}\times ${z.toFixed(3)}^2}`}</div>
        <dl class="stats"><dt>D at this temperature</dt><dd>${sci(D, 2)} m²/s</dd><dt>Time needed</dt><dd>${tNeed.toFixed(0)} s = ${(tNeed / 60).toFixed(0)} min</dd><dt>Carbon at ${xt.toFixed(2)} mm now</dt><dd>${cNow.toFixed(3)} wt% ${ok ? tx('(reached)', '（已達到）') : tx('(not yet)', '（還沒到）')}</dd></dl>
        <p class="note">${TK === 1200 && Math.abs(xt - 0.4) < 1e-6 ? 'This is the slide example: about 3 400 s, just under an hour.' : 'Double the depth and the time goes up four times. Raising the temperature raises D and cuts the time.'}</p>`,
        `<div class="eq">${TeXd`\frac{1.15 - 0.35}{1.15 - 0.18} = ${ratio.toFixed(4)} = \operatorname{erf}(z)`}</div>
        <p>查表 erf(0.95) = ${e0.toFixed(4)}、erf(1.00) = ${e1.toFixed(4)}，所以 z = 0.95 + 0.05 × (${ratio.toFixed(4)} − ${e0.toFixed(4)}) / (${e1.toFixed(4)} − ${e0.toFixed(4)}) = <b>${z.toFixed(3)}</b>。</p>
        <div class="eq">${TeXd`t = \frac{x^2}{4Dz^2} = \frac{(${sciT(xt * 1e-3)}\ \text{m})^2}{4\times ${sciT(D)}\times ${z.toFixed(3)}^2}`}</div>
        <dl class="stats"><dt>這個溫度的 D</dt><dd>${sci(D, 2)} m²/s</dd><dt>需要的時間</dt><dd>${tNeed.toFixed(0)} s = ${(tNeed / 60).toFixed(0)} 分鐘</dd><dt>現在 ${xt.toFixed(2)} mm 處的碳</dt><dd>${cNow.toFixed(3)} wt% ${ok ? '（已達到）' : '（還沒到）'}</dd></dl>
        <p class="note">${TK === 1200 && Math.abs(xt - 0.4) < 1e-6 ? '這就是投影片例題：約 3 400 s，不到一小時。' : '深度加倍，時間變成四倍。提高溫度可以讓 D 變大、時間縮短。'}</p>`);
    }
    const draw = canvas2d($('#cb-cv'), paint);
    [xS, tS].forEach(s => s.addEventListener('input', () => { draw(); text(); }));
    seg($('#cb-T'), v => { TK = +v; draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     08 Arrhenius plot of D for the systems in Table 5.2 (2D)
     ===================================================================== */
  function secTD() {
    const tS = $('#td-T'), info = $('#td-info'); let grp = 'mech';
    // [English, 中文, D at 500 °C, D at 1000 °C, groups, host melting point °C]
    const SYS = [
      ['C in FCC Fe', 'C 在 FCC 鐵', 5e-15, 3e-11, 'mech xtal', Infinity],
      ['C in BCC Fe', 'C 在 BCC 鐵', 1e-12, 2e-9, 'xtal', Infinity],
      ['Fe in FCC Fe', 'Fe 在 FCC 鐵', 2e-23, 2e-16, 'mech xtal', Infinity],
      ['Fe in BCC Fe', 'Fe 在 BCC 鐵', 1e-20, 3e-14, 'xtal', Infinity],
      ['Ni in FCC Fe', 'Ni 在 FCC 鐵', 1e-23, 2e-16, 'mech', Infinity],
      ['Mn in FCC Fe', 'Mn 在 FCC 鐵', 3e-24, 1e-16, 'mech', Infinity],
      ['Zn in Cu', 'Zn 在 Cu', 4e-18, 5e-13, 'cu', 1083],
      ['Cu in Cu', 'Cu 在 Cu', 1e-18, 2e-13, 'cu', 1083],
      ['Cu in Al', 'Cu 在 Al', 4e-14, 1e-10, 'cu', 660],
      ['Ag in Ag', 'Ag 在 Ag', 1e-17, 1e-12, 'cu', 962],
      ['C in HCP Ti', 'C 在 HCP 鈦', 3e-16, 2e-11, '', Infinity]
    ].map(([en, zh, a, b, gs, tm]) => {
      const i1 = 1000 / 773.15, i2 = 1000 / 1273.15, s = (Math.log10(b) - Math.log10(a)) / (i2 - i1);
      return { en, zh, gs: gs.split(' '), tm, at: inv => Math.log10(a) + s * (inv - i1), Q: -s * 1000 * Math.LN10 * RG / 1000, D0: 10 ** (Math.log10(a) - s * i1) };
    });
    const PAL = () => [COL.corner, COL.body, COL.face, COL.plane, T.hi, T.ink];
    const shown = () => SYS.filter(s => grp === 'all' || s.gs.includes(grp));
    const IX0 = 0.6, IX1 = 1.5, LY0 = -24, LY1 = -8;
    function paint(x, W, H) {
      blank(x, W, H);
      const ml = 50, mr = 14, mt = 30, mb = 34, X = i => ml + (i - IX0) / (IX1 - IX0) * (W - ml - mr), Y = l => mt + (LY1 - l) / (LY1 - LY0) * (H - mt - mb);
      x.strokeStyle = T.grid; x.lineWidth = 1; x.font = MFONT(400, 10); x.fillStyle = T.muted;
      x.textAlign = 'right'; for (let l = LY0; l <= LY1; l += 2) { x.beginPath(); x.moveTo(ml, Y(l)); x.lineTo(W - mr, Y(l)); x.stroke(); x.fillText('10' + supE(l), ml - 6, Y(l) + 3); }
      x.textAlign = 'center'; for (let i = 0.6; i <= 1.501; i += 0.1) x.fillText(i.toFixed(1), X(i), H - mb + 14);
      [1400, 1200, 1000, 800, 600, 500, 400].forEach(c => { const i = 1000 / (c + 273.15); if (i >= IX0 && i <= IX1) x.fillText(c + ' °C', X(i), mt - 8); });
      axisLabel(x, tx('1000 / T (K⁻¹)', '1000 / T（K⁻¹）'), (ml + W - mr) / 2, H - 6); axisLabel(x, tx('D (m²/s)', 'D（m²/s）'), 12, (mt + H - mb) / 2, -Math.PI / 2);
      const Tc = +tS.value, inv = 1000 / (Tc + 273.15), pal = PAL();
      x.setLineDash([3, 3]); x.strokeStyle = T.hi; x.lineWidth = 1; x.beginPath(); x.moveTo(X(inv), mt); x.lineTo(X(inv), H - mb); x.stroke(); x.setLineDash([]);
      x.save(); x.beginPath(); x.rect(ml, mt, W - ml - mr, H - mt - mb); x.clip();
      const list = shown(), labels = [];
      list.forEach((s, k) => {
        const c = pal[k % pal.length], dash = grp === 'all' && k >= pal.length ? [6, 4] : [];
        const iLo = Math.max(IX0, 1000 / (s.tm + 273.15));
        x.setLineDash(dash); x.strokeStyle = c; x.lineWidth = 2.2; x.beginPath(); x.moveTo(X(iLo), Y(s.at(iLo))); x.lineTo(X(IX1), Y(s.at(IX1))); x.stroke(); x.setLineDash([]);
        if (Tc <= s.tm) { x.fillStyle = c; x.beginPath(); x.arc(X(inv), Y(s.at(inv)), 4, 0, 7); x.fill(); }
        // labels sit where each line crosses x = 0.7 (or past its melting cutoff), or at the left edge when it is off the plot
        let li = Math.max(0.68, iLo + 0.02); while (li < 1.4 && (s.at(li) > LY1 - 0.4 || s.at(li) < LY0 + 0.4)) li += 0.02;
        labels.push({ y: Y(s.at(li)) - 6, x: X(li), t: tx(s.en, s.zh), c });
      });
      x.restore();
      labels.sort((a, b) => a.y - b.y); for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
      x.font = FONT(600, 11); x.textAlign = 'left';
      labels.forEach(l => { x.lineWidth = 3; x.strokeStyle = T.stage; x.strokeText(l.t, l.x + 4, l.y); x.fillStyle = l.c; x.fillText(l.t, l.x + 4, l.y); });
    }
    function text() {
      const Tc = +tS.value, inv = 1000 / (Tc + 273.15);
      $('#td-T-v').textContent = `${Tc} °C (${(Tc + 273.15).toFixed(0)} K)`;
      const rows = shown().map(s => ({ s, d: Tc > s.tm ? -1 : 10 ** s.at(inv) })).sort((a, b) => b.d - a.d);
      const note = {
        mech: tx('In the same FCC iron, carbon (interstitial) is about a million times faster than iron, nickel or manganese (substitutional).', '在同樣的 FCC 鐵裡，碳（間隙）比鐵、鎳、錳（置換）快大約一百萬倍。'),
        xtal: tx('The BCC lines lie above the FCC lines for both carbon and iron: the more open BCC lattice lets atoms through more easily. Q is also smaller for C in BCC iron.', '不論碳或鐵，BCC 的線都在 FCC 上方：比較鬆的 BCC 晶格讓原子比較容易通過。碳在 BCC 鐵中的 Q 也比較小。'),
        cu: tx('Zinc diffuses faster in copper than copper itself does, which is the root of the Kirkendall effect in Unit 4. Silver in silver gives the 183–188 kJ/mol of the two-point example.', '鋅在銅中擴散得比銅自己還快，這正是第 4 單元 Kirkendall 效應的根源。銀在銀中就是兩點法例題的 183–188 kJ/mol。'),
        all: tx('Steeper lines mean larger Q. Dashed lines continue the color list.', '線越陡，Q 越大。虛線是顏色用完之後接續的線。')
      }[grp];
      info.innerHTML = `<table class="mini"><thead><tr><th>${tx('System', '系統')}</th><th>D</th><th>Q</th></tr></thead><tbody>` +
        rows.map(({ s, d }) => `<tr><td>${tx(s.en, s.zh)}</td><td class="num">${d < 0 ? tx('molten', '已熔化') : sciH(d, 1)}</td><td class="num">${s.Q.toFixed(0)}</td></tr>`).join('') +
        `</tbody></table><p class="note">${tx('D in m²/s at this temperature; Q in kJ/mol from the two table values. ', '這個溫度的 D 單位為 m²/s；Q 由表上兩個值算出，單位 kJ/mol。')}${note}</p>`;
    }
    const draw = canvas2d($('#td-cv'), paint);
    tS.addEventListener('input', () => { draw(); text(); });
    seg($('#td-g'), g => { grp = g; draw(); text(); });
    text(); onLang(text);
    return () => draw();
  }

  /* =====================================================================
     09 Quiz
     ===================================================================== */
  let QUIZ; dataset(() => { QUIZ = [
    { q: tx('Heating a solid from 300 K to 600 K makes a process with E* = 1 eV run how much faster, roughly?', '把固體從 300 K 加熱到 600 K，E* = 1 eV 的過程大約會快多少？'), o: [tx('About 10⁸ times, because T is in the exponent', '約 10⁸ 倍，因為 T 在指數裡'), tx('About 2 times, because T doubled', '約 2 倍，因為 T 加倍了'), tx('About 4 times, because the rate goes as T²', '約 4 倍，因為速率和 T² 成正比'), tx('Not at all, because E* does not change', '完全不變，因為 E* 沒有改變')], a: 0, e: tx(TeX`e^{-E^*/kT}` + ' goes from e<sup>−38.7</sup> to e<sup>−19.3</sup>, a factor of e<sup>19.3</sup> ≈ 2.5 × 10<sup>8</sup>.', TeX`e^{-E^*/kT}` + ' 從 e<sup>−38.7</sup> 變成 e<sup>−19.3</sup>，倍數是 e<sup>19.3</sup> ≈ 2.5 × 10<sup>8</sup>。') },
    { q: tx('On an Arrhenius plot of log(rate) against 1/T, what does the slope give?', '在 log(速率) 對 1/T 的 Arrhenius 圖上，斜率代表什麼？'), o: [tx('−Q / (2.303 R), the activation energy', '−Q / (2.303 R)，也就是活化能'), tx('log C, the rate constant', 'log C，也就是速率常數'), tx('The reaction rate at room temperature', '室溫下的反應速率'), tx('The energy released by the reaction', '反應放出的能量')], a: 0, e: tx('log(rate) = log C − Q/(2.303 R T). The intercept is log C; the slope is −Q/(2.303 R).', 'log(速率) = log C − Q/(2.303 R T)。截距是 log C，斜率是 −Q/(2.303 R)。') },
    { q: tx('Why is interstitial diffusion usually much faster than vacancy diffusion?', '為什麼間隙擴散通常比空位擴散快得多？'), o: [tx('No vacancy has to form first, so E* is only Em', '不必先形成空位，所以 E* 只有 Em'), tx('Interstitial atoms vibrate at a higher temperature', '間隙原子的振動溫度比較高'), tx('Interstitial atoms are pushed by the gradient', '間隙原子會被梯度推著走'), tx('Vacancies can only move along grain boundaries', '空位只能沿著晶界移動')], a: 0, e: tx('A substitutional atom needs a neighboring vacancy, which costs E<sub>v</sub> on top of the jump energy E<sub>m</sub>. Interstitial neighbors are almost always empty, so E* = E<sub>m</sub>.', '置換型原子需要旁邊有空位，除了跳躍能 E<sub>m</sub> 還要付 E<sub>v</sub>。間隙原子旁邊的位置幾乎都是空的，所以 E* = E<sub>m</sub>。') },
    { q: tx('In a Cu–Zn couple, zinc diffuses faster than copper. Which way do the interface markers move?', '銅鋅擴散偶中，鋅擴散得比銅快。界面上的標記往哪裡移？'), o: [tx('Toward the zinc side', '往鋅那一側'), tx('Toward the copper side', '往銅那一側'), tx('They stay at the original interface', '停在原本的界面'), tx('Up and down, at random', '隨機上下移動')], a: 0, e: tx('More atoms leave the zinc side than arrive, so vacancies flow into it and lattice planes there are consumed. The markers drift toward zinc, and voids form on that side.', '離開鋅那一側的原子比進來的多，空位流進那一側、那裡的晶格面被吃掉。標記往鋅漂，孔洞也出現在那一側。') },
    { q: tx('In steady-state diffusion through a plate, what is true?', '穿過一片平板的穩態擴散，下列何者正確？'), o: [tx('The flux J is the same at every depth', '每個深度的通量 J 都一樣'), tx('The concentration is the same at every depth', '每個深度的濃度都一樣'), tx('The flux grows with time', '通量隨時間增加'), tx('The concentration profile is an error function', '濃度分布是 error function')], a: 0, e: tx('Steady state means C(x) no longer changes. By continuity, ∂C/∂t = −∂J/∂x = 0, so J is the same everywhere and the profile is a straight line.', '穩態表示 C(x) 不再改變。由連續方程式，∂C/∂t = −∂J/∂x = 0，所以各處的 J 都一樣，分布是直線。') },
    { q: tx('According to Fick\'s second law, where does the concentration rise fastest?', '依照 Fick’s second law，濃度在哪裡上升得最快？'), o: [tx('Where the profile curves upward most strongly', '分布往上彎得最厲害的地方'), tx('Where the profile is steepest', '分布最陡的地方'), tx('Where the concentration is highest', '濃度最高的地方'), tx('Where the concentration is lowest', '濃度最低的地方')], a: 0, e: tx('∂C/∂t = D ∂²C/∂x². The rate depends on the curvature, not the slope: a straight segment, however steep, does not change.', '∂C/∂t = D ∂²C/∂x²。變化率看的是曲率而不是斜率：一段直線不論多陡都不會改變。') },
    { q: tx('Carburizing for 1 h gives a certain case depth. At the same temperature, how long for twice that depth?', '滲碳 1 小時得到某個表層深度。同樣溫度下，深度要加倍需要多久？'), o: [tx('4 h, because depth grows as √(Dt)', '4 小時，因為深度隨 √(Dt) 成長'), tx('2 h, because depth grows as Dt', '2 小時，因為深度隨 Dt 成長'), tx('1.41 h, because depth grows as t²', '1.41 小時，因為深度隨 t² 成長'), tx('8 h, because depth grows as ∛t', '8 小時，因為深度隨 ∛t 成長')], a: 0, e: tx('A given concentration sits at ' + TeX`x = 2z\sqrt{Dt}` + '. With D fixed, ' + TeX`x \propto \sqrt{t}` + ', so 2x needs 4t.', '某個濃度出現在 ' + TeX`x = 2z\sqrt{Dt}` + '。D 固定時 ' + TeX`x \propto \sqrt{t}` + '，所以 2x 需要 4t。') },
    { q: tx('At 100 °C, which path dominates diffusion in copper?', '100 °C 時，銅裡的擴散主要走哪條路？'), o: [tx('Grain boundaries and surfaces', '晶界和表面'), tx('The lattice, by vacancies', '晶格，靠空位'), tx('The lattice, by interstitials', '晶格，靠間隙'), tx('None: copper is molten', '都不是：銅已經熔化')], a: 0, e: tx('At 0.275 T<sub>m</sub> the lattice D is about 7 × 10<sup>−28</sup> cm²/s, while the grain-boundary D is 3 × 10<sup>−15</sup> and the surface D 10<sup>−12</sup> cm²/s.', '在 0.275 T<sub>m</sub>，晶格 D 約 7 × 10<sup>−28</sup> cm²/s，晶界 D 是 3 × 10<sup>−15</sup>，表面 D 是 10<sup>−12</sup> cm²/s。') }
  ]; });
  const QPERM = (() => { const r = rng(20261107); return Array.from({ length: 8 }, () => { const p = [0, 1, 2, 3]; for (let i = 3; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } return p; }); })();
  dataset(() => { QUIZ.forEach((q, i) => { const p = QPERM[i], o = q.o.slice(); q.o = p.map(k => o[k]); q.a = p.indexOf(q.a); }); });

  function boot() {
    if (GL) {
      [heroScene, secMech, secFick].forEach(f => { try { f(); } catch (e) { console.error(e); } });
      requestAnimationFrame(loop);
    } else {
      const fallback = () => $$('.stage').forEach(s => { s.innerHTML = tx('<div class="stage-fallback">This browser cannot show 3D (WebGL). Please use a recent version of Chrome, Safari, Edge or Firefox.</div>', '<div class="stage-fallback">這個瀏覽器無法顯示 3D（WebGL）。請改用新版 Chrome、Safari、Edge 或 Firefox。</div>'); });
      fallback(); onLang(fallback);
    }
    [secEB, secAR, secKK, secF2, secCB, secTD].forEach(f => { try { redraw2D.push(f()); } catch (e) { console.error(e); } });
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
    document.title = tx("Diffusion in Solids 3D Classroom", "固體中的擴散 3D 教室");
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
