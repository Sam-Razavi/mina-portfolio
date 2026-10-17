/* Living portrait: the avatar is rendered in WebGL so the head can turn toward
   the cursor (a depth-weighted warp), the irises can follow it behind the lids,
   and the eyes can blink. When the image loads, each eye is split into layers:
   a "plate" with the iris painted out, an iris layer with its own soft edge,
   and a mask of the lid opening. Falls back to the plain <img> when WebGL is
   missing or reduced motion is requested. */
(function () {
  'use strict';

  var frame = document.querySelector('.portrait .frame');
  var tilt = document.querySelector('.portrait-tilt');
  if (!frame || !tilt) return;
  var img = frame.querySelector('img');
  var canvas = frame.querySelector('canvas');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
  if (!gl || !gl.getExtension('OES_standard_derivatives')) return;

  // Illustrated avatar, 960 × 1200. Coordinates are continuous image pixels:
  // pixel (i, j) covers [i, i + 1) × [j, j + 1). The lid lines run from corner to
  // corner along the edge of the eyeliner / lower lid; the iris circles are
  // least-squares fits to the iris edge.
  var IW = 960, IH = 1200;
  var EYES = [
    {
      upper: [[339.4, 328.5], [340, 322.6], [341, 321.6], [342, 320.2], [343, 319.4], [344, 318.5], [345, 317.8], [346, 317.3], [347, 316.8], [348, 316.3], [349, 315.7], [350, 315.3], [351, 314.95], [352, 314.6], [353, 314.4], [354, 314.15], [355, 313.8], [356, 313.6], [357, 313.3], [358, 313.2], [360, 313.4], [362, 313.9], [366, 314.6], [370, 315.6], [374, 316.8], [377, 318.1], [380, 319.6], [383, 321.1], [386, 322.5], [389, 323.7], [390, 324.3], [391, 325.4], [392, 326.6], [393, 328.1], [394, 329.5], [395.4, 331]],
      lower: [[339.4, 328.5], [340, 333.8], [341, 334.5], [342, 335.3], [343, 336], [344, 336.6], [345, 337.6], [346, 338.3], [347, 338.7], [348, 338.85], [350, 338.7], [352, 338.9], [354, 339], [356, 339.3], [358, 339.3], [360, 339.2], [362, 338.6], [366, 338.4], [370, 338], [372, 337.7], [374, 337.3], [376, 336.8], [378, 336.2], [380, 335.9], [382, 335.8], [384, 335.6], [386, 335.2], [387, 334.8], [388, 334.6], [389, 334.2], [390, 334], [391, 333.9], [392, 333.6], [393, 333], [394, 332.2], [395.4, 331]],
      iris: [371.72, 324.92, 16.95],
      liner: 6.5,
      lash: 11 // lashes up to just above the lid crease
    },
    {
      upper: [[468, 327.5], [470, 323.8], [472, 321.9], [474, 320], [476, 319.3], [478, 318], [480, 316.3], [482, 315], [484, 313.9], [486, 313.6], [488, 313.1], [490, 312], [492, 311.55], [494, 311.13], [496, 310.8], [500, 311.6], [505, 313.1], [510, 313.9], [512, 314.3], [516, 315.3], [520, 316.8], [524, 318.1], [528, 318.9], [529, 319.9], [530, 320.5], [531, 321.5], [532, 322.2], [533, 323], [534, 323.9], [535, 324.7], [536, 325.6], [537, 326.3], [538, 326.5], [539, 326.7], [540.2, 328.6]],
      // the lower line steps over a catchlight on the lid rim at x ≈ 514 so it stays on the lid
      lower: [[468, 327.5], [470, 331], [472, 331.6], [474, 331.6], [476, 331.7], [478, 331.7], [480, 332], [482, 332.7], [484, 333.1], [486, 333.5], [488, 333.7], [490, 334.4], [492, 334.75], [494, 335], [496, 335.3], [498, 334.9], [500, 335.3], [504, 335.8], [508, 335.8], [512, 335.8], [513, 334.2], [514, 333.6], [515, 334.2], [516, 335.4], [518, 335.1], [520, 334.6], [522, 334], [524, 333.4], [526, 332.8], [528, 332.1], [530, 331], [531, 330.8], [532, 331.8], [533, 331.7], [534, 331.6], [536, 331], [538, 330], [540.2, 328.6]],
      iris: [510.5, 321.97, 17.08],
      liner: 8.5,
      lash: 12
    }
  ];
  // Rough depth for the head turn: whole head, the face in front of it, the nose in front of that.
  var DEPTH = { head: [480, 330, 300, 340], face: [470, 385, 170, 225], nose: [415, 405, 38] };
  var LOOK = { x: 442, y: 335 }; // point the head "looks from"
  var SPLIT = 430; // x between the eyes

  var VERT = 'attribute vec2 aPos; varying vec2 vUv;' +
    'void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }';

  var FRAG = [
    '#extension GL_OES_standard_derivatives : enable',
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform sampler2D uImg; uniform sampler2D uPlate; uniform sampler2D uIris; uniform sampler2D uMask; uniform sampler2D uSkin;',
    'uniform vec2 uSize; uniform vec4 uRect; uniform float uSplit;',
    'uniform vec2 uHead; uniform vec4 uHeadE; uniform vec4 uFaceE; uniform vec3 uNose;',
    'uniform vec2 uGaze; uniform float uBlink; uniform float uDroop;',
    'uniform vec2 uLinerPx; uniform vec2 uLashPx;',
    'varying vec2 vUv;',
    'float ell(vec2 p, vec2 c, vec2 r){ vec2 q = (p - c) / r; return smoothstep(0.0, 1.0, clamp(1.0 - dot(q, q), 0.0, 1.0)); }',
    'vec3 img(vec2 p){ return texture2D(uImg, clamp(p, vec2(0.5), uSize - 0.5) / uSize).rgb; }',
    'void main(){',
    '  vec2 p = vUv * uSize;',
    '  vec2 n = (p - uNose.xy) / uNose.z;',
    '  float depth = 0.45 * ell(p, uHeadE.xy, uHeadE.zw) + 0.45 * ell(p, uFaceE.xy, uFaceE.zw) + 0.30 * exp(-dot(n, n));',
    '  vec2 s = clamp(p - depth * uHead, vec2(0.5), uSize - 0.5);',
    '  vec3 col = img(s);',
    // Eye layers live in one rectangle around both eyes; outside it the mask reads as zero.
    // dy is the distance below the eyeliner edge in this column, h the opening height. Their
    // screen-space rates are taken here, before branching, to anti-alias the lid edge.
    '  vec2 q = (s - uRect.xy) / uRect.zw, qc = clamp(q, 0.0, 1.0);',
    '  float inRect = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);',
    '  vec4 m = texture2D(uMask, qc) * inRect;',
    '  float dy = m.g * 80.0 - 32.0, h = m.b * 64.0;',
    '  float wdy = fwidth(dy), wh = fwidth(h);',
    '  if (m.r + m.b > 0.0) {',
    // Eye content = iris layer over the painted-out plate. Show only the change from the
    // resting eye, so the picture is untouched at rest and the lids never move with the iris.
    '    vec3 plate = texture2D(uPlate, qc).rgb;',
    '    vec4 iris = texture2D(uIris, clamp(q - uGaze / uRect.zw, 0.0, 1.0));',
    '    vec4 iris0 = texture2D(uIris, qc);',
    '    vec3 eye = mix(plate, iris.rgb, iris.a);',
    '    vec3 eye0 = mix(plate, iris0.rgb, iris0.a);',
    '    float c = m.r;',
    '    col = c * eye + (1.0 - smoothstep(0.95, 1.0, c)) * (col - c * eye0);',
    // Lids. Closing the lid slides the lid margin (liner, lashes and crease) down by d and
    // fresh lid skin fills in above it. Looking down lowers the margin a little, a blink takes
    // it all the way to the lower lid.
    '    bool right = s.x > uSplit;',
    '    float liner = right ? uLinerPx.y : uLinerPx.x, lash = right ? uLashPx.y : uLashPx.x;',
    '    float k = max(uDroop, uBlink);',
    '    float d = k * h * smoothstep(0.0, 2.0, h);',
    '    float top = s.y - dy, band = -liner - lash;',
    '    vec3 margin = img(vec2(s.x, min(s.y - d, top - 1.2)));',
    '    vec4 lidSkin = texture2D(uSkin, vec2(qc.x, 0.5));',
    // start from the skin just above the lid so the seam disappears, then settle into the
    // smoothed lid tone with a little shading toward the lashes
    '    vec3 edgeSkin = img(vec2(s.x, top + band - 1.5));',
    '    vec3 skin = mix(edgeSkin, lidSkin.rgb, smoothstep(0.0, 5.0, dy - band)) * mix(1.0, 0.9, clamp((dy - band) / max(d, 1.0), 0.0, 1.0));',
    '    float above = 1.0 - clamp(0.5 + (dy - d) / max(wdy + k * wh, 1e-3), 0.0, 1.0);',
    '    float lid = above * clamp((dy - band) / 2.0 + 0.5, 0.0, 1.0) * smoothstep(0.0, 1.5, d) * lidSkin.a;',
    '    float unfold = 1.0 - clamp((dy - band - d) / 1.5 + 0.5, 0.0, 1.0);',
    '    col = mix(col, mix(margin, skin, unfold), lid);',
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

  function smoothstep(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function dist(x, y) { return Math.sqrt(x * x + y * y); }

  function median(values) {
    values.sort(function (a, b) { return a - b; });
    return values.length ? values[values.length >> 1] : 0;
  }

  // Splits both eyes into plate / iris / mask layers covering one rectangle of the image.
  // Mask channels: opening coverage, distance below the lid line, opening height.
  function buildEyes() {
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    EYES.forEach(function (e) {
      e.upper.forEach(function (p) { y0 = Math.min(y0, p[1] - e.liner - e.lash - 8); });
      e.lower.forEach(function (p) { y1 = Math.max(y1, p[1] + 4); });
      x0 = Math.min(x0, e.upper[0][0] - 4);
      x1 = Math.max(x1, e.upper[e.upper.length - 1][0] + 4);
    });
    var R = { x: Math.floor(x0), y: Math.floor(y0) };
    R.w = Math.ceil(x1) - R.x;
    R.h = Math.ceil(y1) - R.y;
    var W = R.w, H = R.h, N = W * H;

    var c2d = document.createElement('canvas');
    c2d.width = W; c2d.height = H;
    var ctx = c2d.getContext('2d', { willReadFrequently: true });
    var sx = img.naturalWidth / IW, sy = img.naturalHeight / IH;
    ctx.drawImage(img, R.x * sx, R.y * sy, W * sx, H * sy, 0, 0, W, H);
    var raw = ctx.getImageData(0, 0, W, H).data;

    var orig = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      orig[i * 3] = raw[i * 4]; orig[i * 3 + 1] = raw[i * 4 + 1]; orig[i * 3 + 2] = raw[i * 4 + 2];
    }
    var plate = new Float32Array(orig), layer = new Float32Array(orig);
    var alpha = new Float32Array(N), cover = new Float32Array(N);
    var mask = new Uint8Array(N * 4), skinRow = new Float32Array(W * 3), skinFade = new Float32Array(W);

    function lum(a, k) { return 0.299 * a[k * 3] + 0.587 * a[k * 3 + 1] + 0.114 * a[k * 3 + 2]; }
    // Bilinear sample of a 3-channel array at continuous image coordinates.
    function sample(a, x, y, out) {
      var fx = Math.min(Math.max(x - R.x - 0.5, 0), W - 1.001), fy = Math.min(Math.max(y - R.y - 0.5, 0), H - 1.001);
      var ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      var k00 = (iy * W + ix) * 3, k10 = k00 + 3, k01 = k00 + W * 3, k11 = k01 + 3;
      for (var ch = 0; ch < 3; ch++) {
        out[ch] = (a[k00 + ch] * (1 - tx) + a[k10 + ch] * tx) * (1 - ty) + (a[k01 + ch] * (1 - tx) + a[k11 + ch] * tx) * ty;
      }
      return out;
    }

    EYES.forEach(function (e) {
      var up = e.upper, lo = e.lower, xa = up[0][0], xb = up[up.length - 1][0];
      var cx = e.iris[0], cy = e.iris[1], r = e.iris[2];
      var ex0 = Math.floor(xa) - 2 - R.x, ex1 = Math.ceil(xb) + 2 - R.x;
      function clampX(x) { return Math.min(xb - 0.01, Math.max(xa + 0.01, x)); }
      function topAt(x) { return lerpCurve(up, clampX(x)); }
      function botAt(x) { return lerpCurve(lo, clampX(x)); }

      // Lid lines sampled once per column and per quarter column.
      var cols = ex1 - ex0, colTop = new Float32Array(cols), colBot = new Float32Array(cols);
      var subTop = new Float32Array(cols * 4), subBot = new Float32Array(cols * 4);
      for (var c = 0; c < cols; c++) {
        colTop[c] = topAt(R.x + ex0 + c + 0.5); colBot[c] = botAt(R.x + ex0 + c + 0.5);
        for (var b = 0; b < 4; b++) {
          var px = R.x + ex0 + c + (b + 0.5) / 4, inX = px > xa && px < xb;
          subTop[c * 4 + b] = inX ? lerpCurve(up, px) : Infinity;
          subBot[c * 4 + b] = inX ? lerpCurve(lo, px) : -Infinity;
        }
      }
      // Opening coverage (4 × 4 samples) and the lid mask.
      for (var j = 0; j < H; j++) {
        for (var i = ex0; i < ex1; i++) {
          var k = j * W + i, Y = R.y + j, n = 0;
          c = i - ex0;
          for (var a = 0; a < 4; a++) {
            var py = Y + (a + 0.5) / 4;
            for (b = 0; b < 4; b++) if (py > subTop[c * 4 + b] && py < subBot[c * 4 + b]) n++;
          }
          cover[k] = n / 16;
          var top = colTop[c], h = Math.max(colBot[c] - top, 0);
          mask[k * 4] = Math.round(cover[k] * 255);
          mask[k * 4 + 1] = Math.round(Math.min(1, Math.max(0, (Y + 0.5 - top + 32) / 80)) * 255);
          mask[k * 4 + 2] = Math.round(Math.min(1, h / 64) * 255);
          mask[k * 4 + 3] = 255;
        }
      }

      // Plate: paint the white of the eye back in where the iris sits. The guess for a pixel
      // interpolates between eye-white samples beside the iris taken at the same depth
      // below the lid, which keeps the lid shadow; a harmonic correction then makes it meet
      // the real eye-white seamlessly.
      var tmp = [0, 0, 0];
      var anchors = [cx - (r + 3), cx + (r + 3)].map(function (x, side) {
        return { x: x, dir: side ? 1 : -1, top: topAt(x), bot: botAt(x) };
      });
      function guess(x, y, out) {
        var dTop = Math.max(y - topAt(x), 0), dBot = Math.max(botAt(x) - y, 0);
        var w = (x - anchors[0].x) / (anchors[1].x - anchors[0].x);
        out[0] = out[1] = out[2] = 0;
        for (var side = 0; side < 2; side++) {
          var an = anchors[side], hh = an.bot - an.top, f = (side ? w : 1 - w) / 3;
          var ya = dTop <= dBot ? an.top + Math.min(dTop, hh / 2) : an.bot - Math.min(dBot, hh / 2);
          for (var o = 0; o < 3; o++) {
            sample(orig, an.x + o * an.dir, ya, tmp);
            out[0] += tmp[0] * f; out[1] += tmp[1] * f; out[2] += tmp[2] * f;
          }
        }
        return out;
      }
      var bx0 = Math.max(0, Math.floor(cx - r - 4) - R.x), bx1 = Math.min(W, Math.ceil(cx + r + 4) - R.x);
      var fill = [], ring = [], role = new Int8Array(N); // 1 = filled, 2 = fixed ring
      for (j = 0; j < H; j++) {
        for (i = bx0; i < bx1; i++) {
          k = j * W + i;
          if (cover[k] > 0 && dist(R.x + i + 0.5 - cx, R.y + j + 0.5 - cy) <= r + 1.5) { role[k] = 1; fill.push(k); }
        }
      }
      fill.forEach(function (k) {
        [k - 1, k + 1, k - W, k + W].forEach(function (nb) {
          if (role[nb] === 0 && cover[nb] > 0.5) { role[nb] = 2; ring.push(nb); }
        });
      });
      var resid = new Float32Array(N * 3), g = [0, 0, 0];
      fill.forEach(function (k) {
        guess(R.x + k % W + 0.5, R.y + Math.floor(k / W) + 0.5, g);
        plate[k * 3] = g[0]; plate[k * 3 + 1] = g[1]; plate[k * 3 + 2] = g[2];
      });
      ring.forEach(function (k) {
        guess(R.x + k % W + 0.5, R.y + Math.floor(k / W) + 0.5, g);
        for (var ch = 0; ch < 3; ch++) resid[k * 3 + ch] = orig[k * 3 + ch] - g[ch];
      });
      for (var it = 0; it < 250; it++) {
        for (var f = 0; f < fill.length; f++) {
          k = fill[f];
          var cnt = 0, s0 = 0, s1 = 0, s2 = 0;
          for (var d = 0; d < 4; d++) {
            var nb = d === 0 ? k - 1 : d === 1 ? k + 1 : d === 2 ? k - W : k + W;
            if (role[nb]) { cnt++; s0 += resid[nb * 3]; s1 += resid[nb * 3 + 1]; s2 += resid[nb * 3 + 2]; }
          }
          if (cnt) {
            resid[k * 3] += 1.8 * (s0 / cnt - resid[k * 3]);
            resid[k * 3 + 1] += 1.8 * (s1 / cnt - resid[k * 3 + 1]);
            resid[k * 3 + 2] += 1.8 * (s2 / cnt - resid[k * 3 + 2]);
          }
        }
      }
      fill.forEach(function (k) {
        for (var ch = 0; ch < 3; ch++) plate[k * 3 + ch] += resid[k * 3 + ch];
      });

      // Lid skin for blinks, per column: the clean skin just above the lashes and crease,
      // taken over a few neighbouring columns so single lashes don't streak it.
      for (i = ex0; i < ex1; i++) {
        var skin = [[], [], []];
        for (var sx = Math.max(0, i - 4); sx <= Math.min(W - 1, i + 4); sx++) {
          var st0 = topAt(R.x + sx + 0.5) - e.liner - e.lash;
          for (var sy = Math.floor(st0 - 5); sy < st0; sy++) {
            var sk = (sy - R.y) * W + sx;
            if (lum(orig, sk) > 80) for (var ch = 0; ch < 3; ch++) skin[ch].push(orig[sk * 3 + ch]);
          }
        }
        if (skin[0].length) for (ch = 0; ch < 3; ch++) skinRow[i * 3 + ch] = median(skin[ch]);
        // the lid fades out over the last few pixels toward each corner
        skinFade[i] = smoothstep(xa, xa + 3, R.x + i + 0.5) * (1 - smoothstep(xb - 3, xb, R.x + i + 0.5));
      }

      // Iris layer: the original iris where it is fully visible; parts hidden under the
      // lids continue the iris outward along rays from the centre, skipping highlights.
      var known = function (k) { return cover[k] >= 0.999; };
      var inner = [], innerRGB = [[], [], []];
      for (j = 0; j < H; j++) {
        for (i = bx0; i < bx1; i++) {
          k = j * W + i;
          if (known(k) && dist(R.x + i + 0.5 - cx, R.y + j + 0.5 - cy) < r - 1.5) {
            inner.push(lum(orig, k));
            for (var ch = 0; ch < 3; ch++) innerRGB[ch].push(orig[k * 3 + ch]);
          }
        }
      }
      var mid = median(inner), limit = mid + 25, typical = innerRGB.map(median);
      // keep the highlights and their soft halo out of the fill
      var glare = new Uint8Array(N);
      for (j = 0; j < H; j++) {
        for (i = bx0; i < bx1; i++) {
          if (lum(orig, j * W + i) <= mid + 40) continue;
          for (var gj = Math.max(0, j - 2); gj <= Math.min(H - 1, j + 2); gj++) {
            for (var gi = Math.max(0, i - 2); gi <= Math.min(W - 1, i + 2); gi++) glare[gj * W + gi] = 1;
          }
        }
      }
      var irisPx = [];
      for (j = 0; j < H; j++) {
        for (i = bx0; i < bx1; i++) {
          k = j * W + i;
          var rho = dist(R.x + i + 0.5 - cx, R.y + j + 0.5 - cy);
          if (rho <= r + 1.5) irisPx.push(k);
          if (rho > r + 1.5 || known(k)) continue;
          var ux = (R.x + i + 0.5 - cx) / Math.max(rho, 1e-6), uy = (R.y + j + 0.5 - cy) / Math.max(rho, 1e-6);
          layer[k * 3] = typical[0]; layer[k * 3 + 1] = typical[1]; layer[k * 3 + 2] = typical[2];
          for (var st = 0.5; st < r + 2; st += 0.5) {
            var rad = Math.max(rho - st, 0);
            var qi = Math.round(cx + ux * rad - R.x - 0.5), qj = Math.round(cy + uy * rad - R.y - 0.5);
            var qk = qj * W + qi;
            if (known(qk) && !glare[qk] && lum(orig, qk) < limit) {
              layer[k * 3] = orig[qk * 3]; layer[k * 3 + 1] = orig[qk * 3 + 1]; layer[k * 3 + 2] = orig[qk * 3 + 2];
              break;
            }
          }
        }
      }
      // The rim takes the colour just inside the iris edge, so no eye-white travels with it.
      var snap = new Float32Array(layer), rc = r - 0.7, rim = [0, 0, 0];
      irisPx.forEach(function (k) {
        var X = R.x + k % W + 0.5, Y = R.y + Math.floor(k / W) + 0.5, rho = dist(X - cx, Y - cy);
        if (rho <= rc) return;
        sample(snap, cx + (X - cx) / rho * rc, cy + (Y - cy) / rho * rc, rim);
        layer[k * 3] = rim[0]; layer[k * 3 + 1] = rim[1]; layer[k * 3 + 2] = rim[2];
      });
      // Soft edge: how much of each rim pixel is iris, solved from original = mix(plate, iris, a).
      irisPx.forEach(function (k) {
        var X = R.x + k % W + 0.5, Y = R.y + Math.floor(k / W) + 0.5, rho = dist(X - cx, Y - cy);
        if (rho <= r - 1.2) { alpha[k] = 1; return; }
        if (rho >= r + 1.5) return;
        if (!known(k)) { alpha[k] = 1 - smoothstep(r - 0.7, r + 0.7, rho); return; }
        var num = 0, den = 0;
        for (var ch = 0; ch < 3; ch++) {
          var dv = layer[k * 3 + ch] - plate[k * 3 + ch];
          num += (orig[k * 3 + ch] - plate[k * 3 + ch]) * dv; den += dv * dv;
        }
        alpha[k] = Math.min(1, Math.max(0, num / Math.max(den, 1)));
      });

    });

    function bytes(rgb, a) {
      var out = new Uint8Array(N * 4);
      for (var i = 0; i < N; i++) {
        out[i * 4] = Math.round(Math.min(255, Math.max(0, rgb[i * 3])));
        out[i * 4 + 1] = Math.round(Math.min(255, Math.max(0, rgb[i * 3 + 1])));
        out[i * 4 + 2] = Math.round(Math.min(255, Math.max(0, rgb[i * 3 + 2])));
        out[i * 4 + 3] = a ? Math.round(a[i] * 255) : 255;
      }
      return out;
    }
    // fill columns where no clean skin was found from their neighbours
    for (var pass = 0; pass < 2; pass++) {
      for (var c = 1; c < W; c++) if (!skinRow[c * 3]) for (var ch = 0; ch < 3; ch++) skinRow[c * 3 + ch] = skinRow[(c - 1) * 3 + ch];
      for (c = W - 2; c >= 0; c--) if (!skinRow[c * 3]) for (ch = 0; ch < 3; ch++) skinRow[c * 3 + ch] = skinRow[(c + 1) * 3 + ch];
    }
    // smooth along the lid so the skin has no vertical banding
    var smooth = new Float32Array(W * 3);
    for (c = 0; c < W; c++) {
      var wsum = 0;
      for (var o = -10; o <= 10; o++) {
        var cc = Math.min(W - 1, Math.max(0, c + o)), wt = Math.exp(-o * o / 32);
        wsum += wt;
        for (ch = 0; ch < 3; ch++) smooth[c * 3 + ch] += skinRow[cc * 3 + ch] * wt;
      }
      for (ch = 0; ch < 3; ch++) smooth[c * 3 + ch] /= wsum;
    }
    var skinBytes = new Uint8Array(W * 4);
    for (c = 0; c < W; c++) {
      for (ch = 0; ch < 3; ch++) skinBytes[c * 4 + ch] = Math.round(smooth[c * 3 + ch]);
      skinBytes[c * 4 + 3] = Math.round(skinFade[c] * 255);
    }
    return { rect: R, plate: bytes(plate), iris: bytes(layer, alpha), mask: mask, skin: skinBytes };
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
    var prog, eyes;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      eyes = buildEyes();
    } catch (err) {
      return; // keep the static image
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var R = eyes.rect;
    texture(0, img);
    texture(1, eyes.plate, R.w, R.h);
    texture(2, eyes.iris, R.w, R.h);
    texture(3, eyes.mask, R.w, R.h);
    texture(4, eyes.skin, R.w, 1);

    var U = {};
    ['uImg', 'uPlate', 'uIris', 'uMask', 'uSize', 'uRect', 'uSplit', 'uHead', 'uHeadE', 'uFaceE', 'uNose',
      'uGaze', 'uBlink', 'uDroop', 'uLinerPx', 'uLashPx', 'uSkin'].forEach(function (n) {
      U[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform1i(U.uImg, 0);
    gl.uniform1i(U.uPlate, 1);
    gl.uniform1i(U.uIris, 2);
    gl.uniform1i(U.uMask, 3);
    gl.uniform2f(U.uSize, IW, IH);
    gl.uniform4f(U.uRect, R.x, R.y, R.w, R.h);
    gl.uniform1f(U.uSplit, SPLIT);
    gl.uniform4fv(U.uHeadE, DEPTH.head);
    gl.uniform4fv(U.uFaceE, DEPTH.face);
    gl.uniform3fv(U.uNose, DEPTH.nose);
    gl.uniform2f(U.uLinerPx, EYES[0].liner, EYES[1].liner);
    gl.uniform2f(U.uLashPx, EYES[0].lash, EYES[1].lash);
    gl.uniform1i(U.uSkin, 4);

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
    var last = '', raf = 0, prevT = 0, lost = false;

    // If the GPU context goes away, fall back to the static image for good.
    canvas.addEventListener('webglcontextlost', function () {
      lost = true;
      frame.classList.remove('live');
      cancelAnimationFrame(raf); raf = 0;
    });

    function rand(a, b) { return a + Math.random() * (b - a); }

    function loop(now) {
      if (lost) return;
      raf = requestAnimationFrame(loop);
      var steps = prevT ? Math.min(now - prevT, 100) / (1000 / 60) : 1;
      prevT = now;
      var ease = function (k) { return 1 - Math.pow(1 - k, steps); };

      var rect = canvas.getBoundingClientRect();
      var scale = rect.width / IW;
      var targetHead, targetGaze;
      if (pointer && now - lastMove < 4000) {
        var fx = rect.left + LOOK.x * scale, fy = rect.top + LOOK.y * scale;
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
      // The upper lid drops a little when looking down.
      var droop = Math.max(0, gaze.y) * 0.18;

      var r = EYES[0].iris[2];
      var gx = gaze.x * r * 0.48, gy = gaze.y * r * (gaze.y < 0 ? 0.21 : 0.17);
      var hx = head.x * IW * 0.014, hy = head.y * IW * 0.0094;
      var key = [hx, hy, gx, gy, blink, droop].map(function (v) { return v.toFixed(2); }).join();
      if (key === last) return;
      last = key;

      tilt.style.transform = 'rotateY(' + (head.x * 7).toFixed(2) + 'deg) rotateX(' + (-head.y * 5).toFixed(2) + 'deg)';
      gl.uniform2f(U.uHead, hx, hy);
      gl.uniform2f(U.uGaze, gx, gy);
      gl.uniform1f(U.uBlink, blink);
      gl.uniform1f(U.uDroop, droop);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!frame.classList.contains('live')) frame.classList.add('live');
    }

    resize();
    window.addEventListener('resize', resize);
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting && !raf && !lost) { prevT = 0; last = ''; raf = requestAnimationFrame(loop); }
      else if (!entries[0].isIntersecting && raf) { cancelAnimationFrame(raf); raf = 0; }
    }).observe(frame);
  }

  // Splitting the eyes into layers takes a moment, so do it when the browser is idle.
  function startWhenIdle() {
    if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 1500 });
    else setTimeout(start, 50);
  }
  if (img.complete && img.naturalWidth) startWhenIdle();
  else img.addEventListener('load', startWhenIdle, { once: true });
})();
