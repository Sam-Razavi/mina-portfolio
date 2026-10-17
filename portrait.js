/* Living portrait: the photo is rendered in WebGL so the head can turn toward
   the cursor (a depth-weighted warp), the irises can follow it inside the
   traced eye openings, and the eyelids can blink. Falls back to the plain
   <img> when WebGL is missing or reduced motion is requested. */
(function () {
  'use strict';

  var frame = document.querySelector('.portrait .frame');
  var tilt = document.querySelector('.portrait-tilt');
  if (!frame || !tilt) return;
  var img = frame.querySelector('img');
  var canvas = frame.querySelector('canvas');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl) return;

  // Source photo is 640 × 800; everything below is in its pixel space.
  var IW = 640, IH = 800;
  var EYES = [
    {
      upper: [[213.5, 201.5], [217, 198.5], [221, 196.2], [226, 194.6], [232, 193.8], [238, 193.8], [243, 195], [247, 197.2], [250.5, 200.5], [252.5, 204]],
      lower: [[213.5, 201.5], [216.5, 205], [221, 208], [227, 209.6], [234, 210.2], [241, 209.6], [246, 208], [250, 206], [252.5, 204]],
      iris: [235.5, 201.5, 9.5],
      sclera: [146, 139, 140],
      lid: [150, 104, 86]
    },
    {
      upper: [[311, 200], [315, 196.5], [320, 194], [326, 192.4], [332, 192], [338, 192.3], [344, 194], [348.5, 196.6], [352, 199.8], [354, 202.5]],
      lower: [[311, 200], [315, 203.5], [320, 205.5], [327, 207], [334, 207.8], [341, 207.3], [346, 206.2], [350.5, 204.5], [354, 202.5]],
      iris: [337.5, 199.5, 9.5],
      sclera: [180, 160, 157],
      lid: [186, 137, 117]
    }
  ];
  var FACE = { x: 300, y: 225 }; // point the head "looks from"

  var VERT = 'attribute vec2 aPos; varying vec2 vUv;' +
    'void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }';

  var FRAG = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uImg; uniform sampler2D uMask;',
    'uniform vec2 uHead; uniform vec2 uGazeL; uniform vec2 uGazeR; uniform float uBlink;',
    'uniform vec3 uIrisL; uniform vec3 uIrisR; uniform vec3 uScleraL; uniform vec3 uScleraR; uniform vec3 uLidL; uniform vec3 uLidR;',
    'varying vec2 vUv;',
    'const vec2 SIZE = vec2(640.0, 800.0);',
    'vec3 tex(vec2 p){ return texture2D(uImg, clamp(p, vec2(0.5), SIZE - 0.5) / SIZE).rgb; }',
    'float ell(vec2 p, vec2 c, vec2 r){ vec2 q = (p - c) / r; return smoothstep(0.0, 1.0, clamp(1.0 - dot(q, q), 0.0, 1.0)); }',
    'void main(){',
    '  vec2 p = vUv * SIZE;',
    // Rough depth: whole head, the face in front of it, the nose in front of that.
    '  vec2 n = (p - vec2(275.0, 262.0)) / 26.0;',
    '  float depth = 0.45 * ell(p, vec2(305.0, 225.0), vec2(185.0, 230.0))',
    '              + 0.45 * ell(p, vec2(300.0, 250.0), vec2(125.0, 150.0))',
    '              + 0.30 * exp(-dot(n, n));',
    '  vec2 s = p - depth * uHead;',
    '  vec3 col = tex(s);',
    '  vec4 m = texture2D(uMask, s / SIZE);',
    '  if (m.r > 0.002 || (m.a > 0.002 && uBlink > 0.001)) {',
    '    bool right = s.x > 285.0;',
    '    vec3 iris = right ? uIrisR : uIrisL;',
    '    vec2 gaze = right ? uGazeR : uGazeL;',
    '    vec3 sclera = right ? uScleraR : uScleraL;',
    '    vec3 lidCol = (right ? uLidR : uLidL) * (1.0 - 0.14 * pow((s.x - iris.x) / 22.0, 2.0));',
    '    float t = m.g;',
    '    sclera *= mix(0.62, 1.0, smoothstep(0.0, 0.6, t)) * mix(1.0, 0.85, smoothstep(0.7, 1.0, t));',
    // Fill where the iris used to be with sclera, then lay the iris at its new spot.
    '    float R = iris.z + 1.6;',
    '    float was = 1.0 - smoothstep(R - 0.5, R + 0.5, length(s - iris.xy));',
    '    vec3 eye = mix(col, sclera, was);',
    '    vec2 src = s - gaze;',
    '    float inside = 1.0 - smoothstep(R - 0.5, R + 0.5, length(src - iris.xy));',
    '    float known = texture2D(uMask, src / SIZE).r;',
    '    vec3 irisPx = mix(vec3(0.13, 0.09, 0.08), tex(src), smoothstep(0.2, 0.9, known));',
    '    eye = mix(eye, irisPx, inside);',
    // Blink: an upper lid in the skin tone just above the eye closes over it, lash line at its edge.
    '    if (uBlink > 0.001) {',
    '      float b = uBlink * 1.08;',
    '      float u = clamp(t / b, 0.0, 1.0);',
    // Borrow skin texture from just under the eye, mirrored, tinted toward the lid tone.
    '      float low = s.y + (1.0 - t) * m.b * 32.0;',
    '      vec2 mp = vec2(s.x, low + 2.5 + (low - s.y) * 0.7);',
    '      vec3 under = (tex(mp) + tex(mp + vec2(1.2, 0.0)) + tex(mp - vec2(1.2, 0.0))) / 3.0;',
    '      vec3 lid = mix(lidCol, under * 1.1, 0.55) * mix(1.02, 0.8, u * u);',
    '      eye = mix(eye, lid, smoothstep(b + 0.05, b - 0.05, t));',
    '      float lash = 1.0 - smoothstep(0.02, 0.1, abs(t - b + 0.03));',
    '      eye = mix(eye, vec3(0.16, 0.1, 0.08), 0.65 * lash * smoothstep(0.02, 0.2, uBlink));',
    '    }',
    '    col = mix(col, eye, m.r);',
    // While blinking, the band just above the opening (the old lash line) becomes lid skin too.
    '    col = mix(col, lidCol, 0.8 * m.a * smoothstep(0.0, 0.35, uBlink));',
    '  }',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  function lerpCurve(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return pts[pts.length - 1][1];
  }

  // Eye mask: R = how much of the pixel is inside the opening,
  // G = position from upper lid (0) to lower lid (1), B = opening height / 32,
  // A = the lash-line band just above the opening.
  function buildMask() {
    var data = new Uint8Array(IW * IH * 4);
    EYES.forEach(function (e) {
      var x0 = Math.floor(e.upper[0][0]) - 2, x1 = Math.ceil(e.upper[e.upper.length - 1][0]) + 2;
      var y0 = Math.floor(Math.min.apply(null, e.upper.map(function (p) { return p[1]; }))) - 3;
      var y1 = Math.ceil(Math.max.apply(null, e.lower.map(function (p) { return p[1]; }))) + 3;
      var xa = e.upper[0][0], xb = e.upper[e.upper.length - 1][0];
      for (var y = y0; y <= y1; y++) {
        for (var x = x0; x <= x1; x++) {
          var cov = 0, band = 0;
          for (var sy = 0; sy < 4; sy++) {
            for (var sx = 0; sx < 4; sx++) {
              var px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
              if (!(px > xa && px < xb)) continue;
              var up = lerpCurve(e.upper, px);
              if (py > up && py < lerpCurve(e.lower, px)) cov++;
              else if (py <= up && py > up - 3.5) band += 1 - (up - py) / 3.5;
            }
          }
          var cx = Math.min(xb - 0.5, Math.max(xa + 0.5, x + 0.5));
          var u = lerpCurve(e.upper, cx), l = lerpCurve(e.lower, cx);
          var h = Math.max(l - u, 0.5);
          var t = Math.min(1, Math.max(0, (y + 0.5 - u) / h));
          var k = (y * IW + x) * 4;
          data[k] = Math.round(cov / 16 * 255);
          data[k + 1] = Math.round(t * 255);
          data[k + 2] = Math.round(Math.min(1, h / 32) * 255);
          data[k + 3] = Math.round(band / 16 * 255);
        }
      }
    });
    return data;
  }

  function texture(unit, source, w, h) {
    var tx = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  function start() {
    var prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (err) {
      return; // keep the static photo
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    texture(0, img);
    texture(1, buildMask(), IW, IH);

    var U = {};
    ['uImg', 'uMask', 'uHead', 'uGazeL', 'uGazeR', 'uBlink', 'uIrisL', 'uIrisR', 'uScleraL', 'uScleraR', 'uLidL', 'uLidR'].forEach(function (n) {
      U[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform1i(U.uImg, 0);
    gl.uniform1i(U.uMask, 1);
    gl.uniform3fv(U.uIrisL, EYES[0].iris);
    gl.uniform3fv(U.uIrisR, EYES[1].iris);
    gl.uniform3fv(U.uScleraL, EYES[0].sclera.map(function (c) { return c / 255; }));
    gl.uniform3fv(U.uScleraR, EYES[1].sclera.map(function (c) { return c / 255; }));
    gl.uniform3fv(U.uLidL, EYES[0].lid.map(function (c) { return c / 255; }));
    gl.uniform3fv(U.uLidR, EYES[1].lid.map(function (c) { return c / 255; }));

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.round(frame.clientWidth * dpr), h = Math.round(frame.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; last = ''; }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    // Where to look: the pointer when it moves, otherwise idle glances.
    var pointer = null, lastMove = 0;
    window.addEventListener('pointermove', function (e) { pointer = { x: e.clientX, y: e.clientY }; lastMove = performance.now(); }, { passive: true });
    window.addEventListener('pointerout', function (e) { if (!e.relatedTarget) pointer = null; }, { passive: true });
    window.addEventListener('blur', function () { pointer = null; });

    var idle = { x: 0, y: 0 }, nextIdle = 0;
    var head = { x: 0, y: 0 }, gaze = { x: 0, y: 0 };
    var blinkStart = 0, nextBlink = performance.now() + 1200, doubleBlink = false;
    var last = '', raf = 0, prevT = 0;

    function rand(a, b) { return a + Math.random() * (b - a); }

    function loop(now) {
      raf = requestAnimationFrame(loop);
      var steps = prevT ? Math.min(now - prevT, 100) / (1000 / 60) : 1;
      prevT = now;
      var ease = function (k) { return 1 - Math.pow(1 - k, steps); };

      var rect = canvas.getBoundingClientRect();
      var scale = rect.width / IW;
      var targetHead, targetGaze;
      if (pointer && now - lastMove < 4000) {
        var fx = rect.left + FACE.x * scale, fy = rect.top + FACE.y * scale;
        var dx = pointer.x - fx, dy = pointer.y - fy;
        var dh = Math.hypot(dx, dy, rect.height * 1.5), de = Math.hypot(dx, dy, rect.height * 0.45);
        targetHead = [dx / dh, dy / dh];
        targetGaze = [dx / de, dy / de];
      } else {
        if (now > nextIdle) {
          var center = Math.random() < 0.35;
          idle.x = center ? 0 : rand(-0.75, 0.75);
          idle.y = center ? 0 : rand(-0.35, 0.45);
          nextIdle = now + rand(1600, 3800);
        }
        targetHead = [idle.x * 0.45, idle.y * 0.45];
        targetGaze = [idle.x, idle.y];
      }

      // The eyes lead, the head follows.
      var kh = ease(0.06), kg = ease(0.2);
      head.x += (targetHead[0] - head.x) * kh; head.y += (targetHead[1] - head.y) * kh;
      gaze.x += (targetGaze[0] - gaze.x) * kg; gaze.y += (targetGaze[1] - gaze.y) * kg;

      var blink = 0;
      if (!blinkStart && now >= nextBlink) blinkStart = now;
      if (blinkStart) {
        var p = (now - blinkStart) / 170;
        if (p >= 1) {
          blinkStart = 0;
          doubleBlink = !doubleBlink && Math.random() < 0.2;
          nextBlink = now + (doubleBlink ? 120 : rand(2600, 6000));
        } else {
          blink = p < 0.45 ? p / 0.45 : 1 - (p - 0.45) / 0.55;
        }
      }
      // Lids drop a little when looking down.
      blink = Math.max(blink, Math.max(0, gaze.y) * 0.22);

      var gx = gaze.x * 4.6, gy = gaze.y * (gaze.y < 0 ? 2 : 1.6);
      var hx = head.x * 9, hy = head.y * 6;
      var key = [hx, hy, gx, gy, blink].map(function (v) { return v.toFixed(2); }).join();
      if (key === last) return;
      last = key;

      tilt.style.transform = 'rotateY(' + (head.x * 7).toFixed(2) + 'deg) rotateX(' + (-head.y * 5).toFixed(2) + 'deg)';
      gl.uniform2f(U.uHead, hx, hy);
      gl.uniform2f(U.uGazeL, gx, gy);
      gl.uniform2f(U.uGazeR, gx, gy);
      gl.uniform1f(U.uBlink, blink);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!frame.classList.contains('live')) frame.classList.add('live');
    }

    resize();
    window.addEventListener('resize', resize);
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !raf) { prevT = 0; last = ''; raf = requestAnimationFrame(loop); }
      else if (!entries[0].isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
    }).observe(frame);
  }

  if (img.complete && img.naturalWidth) start();
  else img.addEventListener('load', start, { once: true });
})();
