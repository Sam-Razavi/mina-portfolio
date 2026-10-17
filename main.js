(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Hero: point-cloud mountains at dusk ---------- */
  (function terrain() {
    var canvas = document.getElementById('terrain');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W, H, dpr, running = true, t0 = performance.now();
    var mouse = { x: 0, y: 0, tx: 0, ty: 0 };

    // Hash-based value noise + fbm
    function hash(x, y) {
      var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return h - Math.floor(h);
    }
    function noise(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      var a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    function ridged(x, y) {
      var s = 0, amp = 0.55, f = 1;
      for (var i = 0; i < 5; i++) {
        var n = 1 - Math.abs(noise(x * f, y * f) * 2 - 1);
        s += n * n * amp; amp *= 0.5; f *= 2.03;
      }
      return s;
    }

    var COLS = 150, ROWS = 90, NEAR = 1.2, FAR = 60, SPAN = 58;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      COLS = W < 700 ? 90 : 150;
      ROWS = W < 700 ? 64 : 90;
    }

    var stars = [];
    for (var i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random() * 0.45, r: Math.random() * 1.1 + 0.2, p: Math.random() * 6.28 });

    function frame(now) {
      if (!running) return;
      var t = (now - t0) / 1000;
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;

      ctx.clearRect(0, 0, W, H);

      // stars
      for (var s = 0; s < stars.length; s++) {
        var st = stars[s];
        var a = 0.25 + 0.35 * Math.sin(t * 1.3 + st.p);
        ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
        ctx.fillRect(st.x * W - mouse.x * 6, st.y * H - mouse.y * 4, st.r, st.r);
      }

      var horizon = H * (0.74 + mouse.y * 0.02);
      var focal = Math.max(W, H) * 0.62;
      var camY = 2.4;
      var travel = t * 0.7;
      var yaw = mouse.x * 0.18;
      var cy = Math.cos(yaw), sy = Math.sin(yaw);

      // back to front so near ridges and points draw over far ones
      var xs = new Float32Array(COLS), ys = new Float32Array(COLS);
      for (var r = ROWS - 1; r >= 0; r--) {
        var zf = r / (ROWS - 1);
        var z = NEAR + (FAR - NEAR) * zf * zf;
        var wz = z + travel;
        var depth = zf;
        var n = 0;
        for (var c = 0; c < COLS; c++) {
          var x = (c / (COLS - 1) - 0.5) * SPAN * (0.3 + zf * 1.6);
          // mountains rise with distance, a valley runs down the middle
          var valley = Math.min(1, Math.abs(x) / (3 + z * 0.35));
          var hgt = ridged(x * 0.07, wz * 0.07) * (0.5 + Math.pow(depth, 2.2) * 30) * (0.3 + 0.7 * valley) - 0.3;
          xs[n] = W / 2 + ((x * cy - z * sy) / z) * focal;
          ys[n] = horizon - ((hgt - camY) / z) * focal * 0.42;
          n++;
        }

        // every few rows, a solid ridge layer in atmospheric haze
        if (r % 6 === 0 && depth > 0.18) {
          var k = Math.pow(depth, 0.9);
          ctx.fillStyle = 'rgb(' + Math.round(24 + 78 * k) + ',' + Math.round(21 + 70 * k) + ',' + Math.round(25 + 74 * k) + ')';
          ctx.beginPath();
          ctx.moveTo(Math.min(xs[0], 0), H);
          ctx.lineTo(Math.min(xs[0], 0), ys[0]);
          for (var j = 0; j < n; j++) ctx.lineTo(xs[j], ys[j]);
          ctx.lineTo(Math.max(xs[n - 1], W), ys[n - 1]);
          ctx.lineTo(Math.max(xs[n - 1], W), H);
          ctx.closePath();
          ctx.fill();
        }

        // dusk tint: far = cool slate, near = warm ember
        var fog = 1 - Math.pow(depth, 1.4) * 0.55;
        var cr = Math.round(170 + 80 * (1 - depth)), cg = Math.round(165 + 25 * (1 - depth)), cb = Math.round(200 - 60 * (1 - depth));
        var size = 0.7 + (1 - depth) * 1.8;
        ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (0.55 * fog).toFixed(3) + ')';
        for (var q = 0; q < n; q++) {
          if (xs[q] < -4 || xs[q] > W + 4) continue;
          ctx.fillRect(xs[q], ys[q], size, size);
        }
      }

      if (!reduceMotion) requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', function (e) {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });

    if ('IntersectionObserver' in window && !reduceMotion) {
      new IntersectionObserver(function (entries) {
        var vis = entries[0].isIntersecting;
        if (vis && !running) { running = true; requestAnimationFrame(frame); }
        else if (!vis) running = false;
      }).observe(canvas);
    }
    requestAnimationFrame(frame);
  })();

  /* ---------- Split headings into words for the reveal ---------- */
  document.querySelectorAll('.split').forEach(function (el) {
    var i = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var frag = document.createDocumentFragment();
          child.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            var w = document.createElement('span'); w.className = 'w';
            var inner = document.createElement('span'); inner.textContent = part;
            inner.style.transitionDelay = (i++ * 0.06) + 's';
            w.appendChild(inner); frag.appendChild(w);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    })(el);
  });

  /* ---------- Reveal on scroll ---------- */
  var revealables = document.querySelectorAll('.reveal, .split, .stats, .bench-card');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        onReveal(e.target);
        io.unobserve(e.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('in'); onReveal(el); });
  }

  function onReveal(el) {
    if (el.classList.contains('stats')) el.querySelectorAll('[data-count]').forEach(countUp);
    if (el.classList.contains('bench-card')) fillBars(el);
  }

  function fillBars(scope) {
    scope.querySelectorAll('.track i[data-w]').forEach(function (bar) {
      requestAnimationFrame(function () { bar.style.width = bar.getAttribute('data-w') + '%'; });
    });
  }

  function countUp(el) {
    var target = +el.getAttribute('data-count');
    if (reduceMotion) { el.textContent = target; return; }
    var start = performance.now(), dur = 1600;
    (function step(now) {
      var p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }

  /* ---------- Nav ---------- */
  var nav = document.getElementById('nav');
  var menuBtn = document.getElementById('menuBtn');
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 40); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  menuBtn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open);
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  document.querySelectorAll('#navLinks a').forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  });

  // Highlight the section in view
  var navLinks = document.querySelectorAll('#navLinks a');
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        navLinks.forEach(function (a) { a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['work', 'projects', 'about', 'skills'].forEach(function (id) {
      var s = document.getElementById(id); if (s) spy.observe(s);
    });
  }

  /* ---------- Case study dialogs ---------- */
  function openCase(id, anchor) {
    var dlg = document.getElementById(id);
    if (!dlg || typeof dlg.showModal !== 'function') return false;
    dlg.showModal();
    document.documentElement.style.overflow = 'hidden';
    var scroller = dlg.querySelector('.case-scroll');
    scroller.scrollTop = 0;
    if (anchor) {
      var target = dlg.querySelector('#' + anchor);
      if (target) scroller.scrollTop = target.offsetTop - 80;
    }
    fillBars(dlg);
    return true;
  }
  document.querySelectorAll('[data-case]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (openCase(a.getAttribute('data-case'), a.getAttribute('data-anchor'))) e.preventDefault();
    });
  });
  document.querySelectorAll('dialog.case').forEach(function (dlg) {
    dlg.addEventListener('close', function () { document.documentElement.style.overflow = ''; });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', function () { dlg.close(); }); });
  });

  /* ---------- Cursor spotlight on cards ---------- */
  document.querySelectorAll('.card').forEach(function (card) {
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  /* ---------- Tilt device mocks toward the cursor ---------- */
  if (!reduceMotion && window.matchMedia('(hover: hover)').matches) {
    document.querySelectorAll('[data-tilt]').forEach(function (stage) {
      var device = stage.querySelector('.device');
      stage.addEventListener('pointermove', function (e) {
        var r = stage.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        device.style.transform = 'rotateX(' + (8 - y * 10) + 'deg) rotateY(' + (x * 14) + 'deg) rotateZ(' + (x * 2) + 'deg)';
      });
      stage.addEventListener('pointerleave', function () { device.style.transform = ''; });
    });
  }

  /* ---------- HRTF calibration loop mock ---------- */
  (function hrtf() {
    var ray = document.getElementById('hrtfRay'), tgt = document.getElementById('hrtfTarget');
    if (!ray) return;
    var rT = document.getElementById('rTarget'), rP = document.getElementById('rPoint'), rI = document.getElementById('rItd'), meter = document.getElementById('rMeter');
    var targets = [42, -65, 120, -20, 75];
    var ti = 0, target = targets[0], point = target + 22, itd = 0.12;
    function render() {
      tgt.setAttribute('transform', 'rotate(' + target + ' 110 110)');
      ray.setAttribute('transform', 'rotate(' + point.toFixed(1) + ' 110 110)');
      rT.textContent = Math.round(target) + '°';
      rP.textContent = Math.round(point) + '°';
      rI.textContent = (itd >= 0 ? '+' : '') + itd.toFixed(2) + ' ms';
      meter.style.width = Math.max(6, 100 - Math.abs(point - target) * 3) + '%';
    }
    render();
    if (reduceMotion) return;
    setInterval(function () {
      var err = point - target;
      if (Math.abs(err) < 1.5) {
        ti = (ti + 1) % targets.length;
        target = targets[ti];
        point = target + (Math.random() > 0.5 ? 1 : -1) * (18 + Math.random() * 14);
        itd = (Math.random() - 0.5) * 0.4;
      } else {
        point -= err * 0.45;
        itd -= err * 0.004;
      }
      render();
    }, 900);
  })();

  /* ---------- Twin dashboard live data mock ---------- */
  (function twin() {
    var line = document.getElementById('sparkLine'), fill = document.getElementById('sparkFill');
    if (!line) return;
    var wind = document.getElementById('tWind'), volt = document.getElementById('tVolt');
    var pts = [], N = 40, v = 2.3;
    for (var i = 0; i < N; i++) { v += (Math.random() - 0.5) * 0.25; v = Math.min(3, Math.max(1.6, v)); pts.push(v); }
    function draw() {
      var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + (i / (N - 1) * 300).toFixed(1) + ' ' + (56 - (p - 1.4) / 1.8 * 50).toFixed(1); }).join(' ');
      line.setAttribute('d', d);
      fill.setAttribute('d', d + ' L300 56 L0 56 Z');
      var last = pts[pts.length - 1];
      volt.textContent = last.toFixed(2) + ' V';
      wind.textContent = (last * 2.75).toFixed(1) + ' m/s';
    }
    draw();
    if (reduceMotion) return;
    setInterval(function () {
      v += (Math.random() - 0.5) * 0.25; v = Math.min(3, Math.max(1.6, v));
      pts.shift(); pts.push(v); draw();
    }, 700);
  })();

  /* ---------- Copy email ---------- */
  var copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', function () {
    var text = document.getElementById('mail').textContent;
    function done(msg) { copyBtn.textContent = msg; setTimeout(function () { copyBtn.textContent = 'Copy email'; }, 1800); }
    function fallback() {
      var r = document.createRange(); r.selectNodeContents(document.getElementById('mail'));
      var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); done('Selected');
    }
    try { navigator.clipboard.writeText(text).then(function () { done('Copied ✓'); }, fallback); } catch (e) { fallback(); }
  });
})();
