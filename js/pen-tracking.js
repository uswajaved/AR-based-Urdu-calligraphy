/* MediaPipe Hands + XR camera-access feed + path scoring / smoothing */
(function (global) {
  // Register before <a-scene> parses (this file is loaded in <head> after A-Frame).
  if (typeof AFRAME !== 'undefined') {
    AFRAME.registerComponent('xr-pen-feed', {
      tick: function () {
        if (global.__penFeedTick) global.__penFeedTick(this.el);
      }
    });
  }

  const PATH_HIT_THRESHOLD = 0.08;
  const PEN_SMOOTHING_ALPHA = 0.4;
  const PATH_SMOOTHING_ALPHA = 0.3;
  const PATH_OUTLIER_THRESHOLD = 0.14;
  const PEN_FEED_TIMEOUT_MS = 8000;
  const XR_CAPTURE_MIN_INTERVAL_MS = 200;
  /** Extra gap after a hard getCameraImage failure before the next attempt. */
  const XR_CAPTURE_RETRY_GAP_MS = 450;
  /** Require this many consecutive hard failures before permanently disabling capture. */
  const XR_CAPTURE_FAIL_LIMIT = 3;

  let projectedScreenPath = [];
  let smoothedProjectedPath = [];
  let smoothedPenX = null;
  let smoothedPenY = null;
  let pendingHandImage = null;
  let lastHandFeedSource = 'none';
  let lastGetCameraImageStatus = 'n/a';
  let xrCameraFeedDisabled = false;
  let xrCameraFeedDisableReason = '';
  let consecutiveCaptureFails = 0;
  let lastXrCaptureAt = 0;
  let nextCaptureGapMs = XR_CAPTURE_MIN_INTERVAL_MS;
  let trackingImageW = 0;
  let trackingImageH = 0;
  let videoStream = null;
  let hands = null;
  let isPenTracking = false;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let penFeedWatchTimeout = null;
  let inkTrail = [];
  let nextWaypointIdx = 0;
  let letterComplete = false;

  function drawDebugMarker(normX, normY, color, label, radius) {
    if (!global.ARDebug || !global.ARDebug.DEBUG || !ctx || !canvasEl) return;
    const x = normX * canvasEl.width;
    const y = normY * canvasEl.height;
    ctx.beginPath();
    ctx.arc(x, y, radius || 10, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (label) {
      ctx.font = 'bold 11px monospace';
      ctx.fillStyle = color;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeText(label, x + 12, y - 8);
      ctx.fillText(label, x + 12, y - 8);
    }
  }

  /** Map image-normalized coords to where they appear after CSS stretch (client pixels). */
  function imageNormToClientPx(nx, ny) {
    if (!canvasEl) return null;
    const cw = canvasEl.clientWidth;
    const ch = canvasEl.clientHeight;
    return { x: nx * cw, y: ny * ch };
  }

  /** object-fit:cover mapping — image norm → buffer px if canvas were cover-fit. */
  function imageNormToCoverBufferPx(nx, ny) {
    if (!canvasEl) return null;
    const iw = canvasEl.width;
    const ih = canvasEl.height;
    const cw = canvasEl.clientWidth;
    const ch = canvasEl.clientHeight;
    if (!iw || !ih || !cw || !ch) return null;
    const imageAspect = iw / ih;
    const displayAspect = cw / ch;
    let scale, offsetX, offsetY;
    if (imageAspect > displayAspect) {
      scale = ch / ih;
      offsetX = (cw - iw * scale) / 2;
      offsetY = 0;
    } else {
      scale = cw / iw;
      offsetX = 0;
      offsetY = (ch - ih * scale) / 2;
    }
    const clientX = offsetX + nx * iw * scale;
    const clientY = offsetY + ny * ih * scale;
    // buffer px (linear map from client box to buffer)
    return {
      x: (clientX / cw) * iw,
      y: (clientY / ch) * ih,
      clientX: clientX,
      clientY: clientY
    };
  }

  function drawDebugMarkerBufferPx(px, py, color, label) {
    if (!global.ARDebug || !global.ARDebug.DEBUG || !ctx || !canvasEl) return;
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    if (label) {
      ctx.font = '10px monospace';
      ctx.fillStyle = color;
      ctx.fillText(label, px + 10, py + 4);
    }
  }

  function resetSmoothingState() {
    smoothedPenX = null;
    smoothedPenY = null;
    smoothedProjectedPath = [];
  }

  function smoothPenTip(rawX, rawY) {
    if (smoothedPenX == null || smoothedPenY == null) {
      smoothedPenX = rawX;
      smoothedPenY = rawY;
    } else {
      smoothedPenX = PEN_SMOOTHING_ALPHA * rawX + (1 - PEN_SMOOTHING_ALPHA) * smoothedPenX;
      smoothedPenY = PEN_SMOOTHING_ALPHA * rawY + (1 - PEN_SMOOTHING_ALPHA) * smoothedPenY;
    }
    return { x: smoothedPenX, y: smoothedPenY };
  }

  function smoothProjectedPath(rawPath) {
    if (!rawPath.length) {
      smoothedProjectedPath = [];
      return smoothedProjectedPath;
    }
    if (smoothedProjectedPath.length !== rawPath.length) {
      smoothedProjectedPath = rawPath.map(function (p) { return { x: p.x, y: p.y }; });
      return smoothedProjectedPath;
    }
    for (let i = 0; i < rawPath.length; i++) {
      const raw = rawPath[i];
      const prev = smoothedProjectedPath[i];
      const jump = Math.hypot(raw.x - prev.x, raw.y - prev.y);
      if (jump > PATH_OUTLIER_THRESHOLD) continue;
      prev.x = PATH_SMOOTHING_ALPHA * raw.x + (1 - PATH_SMOOTHING_ALPHA) * prev.x;
      prev.y = PATH_SMOOTHING_ALPHA * raw.y + (1 - PATH_SMOOTHING_ALPHA) * prev.y;
    }
    return smoothedProjectedPath;
  }

  /** Warm-up / missing pose — log and retry; do not count toward permanent disable. */
  function noteCaptureWarmup(reason) {
    lastGetCameraImageStatus = reason;
    nextCaptureGapMs = XR_CAPTURE_RETRY_GAP_MS;
    if (global.ARDebug) {
      global.ARDebug.logCaptureAttempt(reason + ' (warmup, retry)');
    }
  }

  /** Hard getCameraImage / readback failure — count toward fail-soft disable. */
  function noteCaptureFailure(reason) {
    consecutiveCaptureFails += 1;
    lastGetCameraImageStatus = reason;
    nextCaptureGapMs = XR_CAPTURE_RETRY_GAP_MS;
    if (global.ARDebug) {
      global.ARDebug.logCaptureAttempt(
        reason + ' (fail ' + consecutiveCaptureFails + '/' + XR_CAPTURE_FAIL_LIMIT + ')'
      );
    }
    if (consecutiveCaptureFails >= XR_CAPTURE_FAIL_LIMIT) {
      disableXrCameraFeed(reason + ' ×' + consecutiveCaptureFails);
    }
  }

  function noteCaptureSuccess(status) {
    consecutiveCaptureFails = 0;
    nextCaptureGapMs = XR_CAPTURE_MIN_INTERVAL_MS;
    lastGetCameraImageStatus = status;
    if (global.ARDebug) {
      global.ARDebug.logCaptureAttempt(status + ' (ok)');
    }
  }

  function disableXrCameraFeed(reason) {
    if (xrCameraFeedDisabled) return;
    xrCameraFeedDisabled = true;
    xrCameraFeedDisableReason = reason || 'unknown';
    lastGetCameraImageStatus = xrCameraFeedDisableReason;
    if (global.ARDebug) {
      global.ARDebug.logOnce(
        'getCameraImage-final',
        'getCameraImage: ' + xrCameraFeedDisableReason + ' (capture disabled)'
      );
    }
  }

  function clearPenFeedWatch() {
    if (penFeedWatchTimeout) {
      clearTimeout(penFeedWatchTimeout);
      penFeedWatchTimeout = null;
    }
  }

  function startPenFeedWatch() {
    clearPenFeedWatch();
    lastHandFeedSource = 'none';
    penFeedWatchTimeout = setTimeout(function () {
      penFeedWatchTimeout = null;
      if (!isPenTracking || lastHandFeedSource !== 'none' || xrCameraFeedDisabled) return;
      isPenTracking = false;
      setPenOverlayActive(false);
      const hint = document.getElementById('place-hint');
      if (hint) {
        hint.textContent = 'Pen tracing unavailable on this device';
        hint.style.display = 'block';
      }
      disableXrCameraFeed(lastGetCameraImageStatus || 'timeout (feed never started)');
    }, PEN_FEED_TIMEOUT_MS);
  }

  const xrCameraFeed = (function () {
    let binding = null;
    let readbackFb = null;
    let feedCanvas = null;
    let feedCtx = null;
    let readbackPixels = null;
    let boundSession = null;

    function capture(scene) {
      if (xrCameraFeedDisabled) return null;
      if (!scene || !scene.renderer || !scene.frame || !window.XRWebGLBinding) return null;

      const now = performance.now();
      if (now - lastXrCaptureAt < nextCaptureGapMs) return null;
      lastXrCaptureAt = now;

      const renderer = scene.renderer;
      const session = renderer.xr.getSession();
      const frame = scene.frame;
      if (!session) return null;

      if (boundSession !== session) {
        binding = null;
        readbackFb = null;
        boundSession = session;
        consecutiveCaptureFails = 0;
        nextCaptureGapMs = XR_CAPTURE_MIN_INTERVAL_MS;
      }

      const gl = renderer.getContext();
      if (!binding) binding = new XRWebGLBinding(session, gl);

      const refSpace = renderer.xr.getReferenceSpace();
      const pose = frame.getViewerPose(refSpace);
      if (!pose || !pose.views.length) {
        noteCaptureWarmup('no viewer pose');
        return null;
      }

      let cameraView = null;
      for (let i = 0; i < pose.views.length; i++) {
        if (pose.views[i].camera) {
          cameraView = pose.views[i];
          break;
        }
      }
      if (!cameraView) {
        // Warm-up: camera-access may not expose view.camera on the first frames.
        noteCaptureWarmup('no view.camera yet');
        return null;
      }

      const cam = cameraView.camera;
      const w = cam.width;
      const h = cam.height;
      if (!w || !h) {
        noteCaptureWarmup('camera size 0');
        return null;
      }

      let texture = null;
      try {
        texture = binding.getCameraImage(cam);
      } catch (e) {
        noteCaptureFailure('threw: ' + (e && e.message ? e.message : String(e)));
        return null;
      }
      if (!texture) {
        noteCaptureFailure('null');
        return null;
      }

      if (!readbackFb) readbackFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, readbackFb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        noteCaptureFailure('framebuffer incomplete');
        return null;
      }

      const byteLen = w * h * 4;
      if (!readbackPixels || readbackPixels.length !== byteLen) {
        readbackPixels = new Uint8ClampedArray(byteLen);
      }
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, readbackPixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      if (!feedCanvas) {
        feedCanvas = document.createElement('canvas');
        feedCtx = feedCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (feedCanvas.width !== w || feedCanvas.height !== h) {
        feedCanvas.width = w;
        feedCanvas.height = h;
      }

      const imageData = feedCtx.createImageData(w, h);
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        const srcStart = (h - 1 - y) * rowBytes;
        imageData.data.set(readbackPixels.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
      }
      feedCtx.putImageData(imageData, 0, 0);
      trackingImageW = w;
      trackingImageH = h;
      noteCaptureSuccess(
        (texture.constructor && texture.constructor.name) || typeof texture
      );
      return feedCanvas;
    }

    return {
      capture: capture,
      getSize: function () {
        return trackingImageW && trackingImageH
          ? { w: trackingImageW, h: trackingImageH }
          : null;
      },
      resetSessionState: function () {
        binding = null;
        readbackFb = null;
        boundSession = null;
        xrCameraFeedDisabled = false;
        xrCameraFeedDisableReason = '';
        consecutiveCaptureFails = 0;
        lastGetCameraImageStatus = 'n/a';
        lastXrCaptureAt = 0;
        nextCaptureGapMs = XR_CAPTURE_MIN_INTERVAL_MS;
        if (global.ARDebug) {
          global.ARDebug.clearOnceKey('getCameraImage-final');
        }
      }
    };
  })();

  function getTrackingImageSize() {
    const scene = document.querySelector('a-scene');
    if (scene && scene.is('ar-mode')) {
      const xrSize = xrCameraFeed.getSize();
      if (xrSize) return xrSize;
    }
    if (videoEl && videoEl.videoWidth > 0) {
      return { w: videoEl.videoWidth, h: videoEl.videoHeight };
    }
    if (canvasEl && canvasEl.width > 0) {
      return { w: canvasEl.width, h: canvasEl.height };
    }
    return null;
  }

  function syncTrackingCanvasSize() {
    const size = getTrackingImageSize();
    if (!size || !canvasEl) return;
    if (canvasEl.width !== size.w || canvasEl.height !== size.h) {
      canvasEl.width = size.w;
      canvasEl.height = size.h;
    }
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function minDistToPath(px, py, path) {
    if (path.length === 0) return Infinity;
    if (path.length === 1) return Math.hypot(px - path[0].x, py - path[0].y);
    let min = Infinity;
    for (let i = 0; i < path.length - 1; i++) {
      const d = distToSegment(px, py, path[i].x, path[i].y, path[i + 1].x, path[i + 1].y);
      if (d < min) min = d;
    }
    return min;
  }

  function letterUVToLocal(u, v) {
    return new THREE.Vector3(u - 0.5, 0.5 - v, 0);
  }

  function viewportNormToVideoNorm(vx, vy, viewportW, viewportH, imageW, imageH) {
    const size = getTrackingImageSize();
    const iw = imageW || (size ? size.w : 0) || (canvasEl ? canvasEl.width : 0);
    const ih = imageH || (size ? size.h : 0) || (canvasEl ? canvasEl.height : 0);
    if (!iw || !ih || !viewportW || !viewportH) return null;
    const imageAspect = iw / ih;
    const containerAspect = viewportW / viewportH;
    let visibleW, visibleH, offsetX, offsetY;
    if (imageAspect > containerAspect) {
      visibleH = ih;
      visibleW = ih * containerAspect;
      offsetX = (iw - visibleW) / 2;
      offsetY = 0;
    } else {
      visibleW = iw;
      visibleH = iw / containerAspect;
      offsetX = 0;
      offsetY = (ih - visibleH) / 2;
    }
    const px = offsetX + vx * visibleW;
    const py = offsetY + vy * visibleH;
    return { x: px / iw, y: py / ih };
  }

  function projectLetterPathToVideoNorm(pathUV) {
    const anchorEl = document.querySelector('#letter-anchor');
    const letterEl = document.querySelector('#urdu-letter');
    const sceneEl = document.querySelector('a-scene');
    const isVis = global.ARPlacement
      ? global.ARPlacement.isAFrameVisible(anchorEl)
      : (anchorEl && (anchorEl.getAttribute('visible') === true || anchorEl.getAttribute('visible') === 'true'));
    if (!anchorEl || !isVis || !letterEl || !sceneEl || !sceneEl.renderer || !sceneEl.camera) {
      return [];
    }
    const threeCam = sceneEl.camera;
    const letterObj = letterEl.object3D;
    const afCanvas = sceneEl.renderer.domElement;
    const cw = afCanvas.clientWidth;
    const ch = afCanvas.clientHeight;
    if (!cw || !ch || !pathUV.length) return [];

    letterObj.updateWorldMatrix(true, false);
    const imageSize = getTrackingImageSize();
    const projected = [];

    if (global.ARDebug && global.ARDebug.DEBUG && global.ARDebug.logProjectionDebug) {
      const xrCam = sceneEl.renderer.xr && sceneEl.renderer.xr.getCamera
        ? sceneEl.renderer.xr.getCamera()
        : null;
      const lines = [
        'proj: MediaPipe callback (not A-Frame tick)',
        'afCanvas: ' + cw + '×' + ch + ' buffer=' + afCanvas.width + '×' + afCanvas.height,
        'trackCanvas: ' + (canvasEl ? canvasEl.clientWidth + '×' + canvasEl.clientHeight : 'n/a') +
          ' buffer=' + (canvasEl ? canvasEl.width + '×' + canvasEl.height : 'n/a'),
        'image: ' + (imageSize ? imageSize.w + '×' + imageSize.h : 'n/a'),
        'cam: scene.camera' + (xrCam ? ' xrCam=' + (xrCam === threeCam ? 'same' : 'DIFFERENT') : ''),
        'ar-mode: ' + (sceneEl.is('ar-mode') ? 'yes' : 'no')
      ];
      if (imageSize && canvasEl) {
        lines.push(
          'aspect image=' + (imageSize.w / imageSize.h).toFixed(3) +
          ' client=' + (canvasEl.clientWidth / canvasEl.clientHeight).toFixed(3) +
          ' buffer=' + (canvasEl.width / canvasEl.height).toFixed(3)
        );
      }
      global.ARDebug.logProjectionDebug(lines);
    }

    for (let i = 0; i < pathUV.length; i++) {
      const uv = pathUV[i];
      const world = letterUVToLocal(uv.x, uv.y).applyMatrix4(letterObj.matrixWorld);
      const ndc = world.clone().project(threeCam);
      if (ndc.z < -1 || ndc.z > 1) continue;
      const videoNorm = viewportNormToVideoNorm(
        (ndc.x + 1) / 2,
        (-ndc.y + 1) / 2,
        cw,
        ch,
        imageSize ? imageSize.w : 0,
        imageSize ? imageSize.h : 0
      );
      if (videoNorm) projected.push(videoNorm);
    }
    return projected;
  }

  /** Debug: project one UV through full pipeline; returns intermediates. */
  function projectUVDebug(uv) {
    const letterEl = document.querySelector('#urdu-letter');
    const sceneEl = document.querySelector('a-scene');
    if (!letterEl || !sceneEl || !sceneEl.camera || !sceneEl.renderer) return null;
    const threeCam = sceneEl.camera;
    const letterObj = letterEl.object3D;
    const afCanvas = sceneEl.renderer.domElement;
    const cw = afCanvas.clientWidth;
    const ch = afCanvas.clientHeight;
    const imageSize = getTrackingImageSize();
    letterObj.updateWorldMatrix(true, false);
    const world = letterUVToLocal(uv.x, uv.y).applyMatrix4(letterObj.matrixWorld);
    const ndc = world.clone().project(threeCam);
    const vx = (ndc.x + 1) / 2;
    const vy = (-ndc.y + 1) / 2;
    const videoNorm = viewportNormToVideoNorm(
      vx, vy, cw, ch,
      imageSize ? imageSize.w : 0,
      imageSize ? imageSize.h : 0
    );
    return { ndc: ndc, viewportNorm: { x: vx, y: vy }, videoNorm: videoNorm };
  }

  function drawProjectedPath(path, strokeStyle) {
    if (!path.length || !ctx || !canvasEl) return;
    ctx.beginPath();
    ctx.moveTo(path[0].x * canvasEl.width, path[0].y * canvasEl.height);
    for (let i = 1; i < path.length; i++) {
      ctx.lineTo(path[i].x * canvasEl.width, path[i].y * canvasEl.height);
    }
    ctx.lineWidth = 8;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  }

  function onHandResults(results) {
    if (!ctx || !canvasEl) return;
    syncTrackingCanvasSize();
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const pathUV = global.ARLetters ? global.ARLetters.currentTargetPathUV : [];
    const pathIsDefault = global.ARLetters ? global.ARLetters.currentPathIsDefault : true;

    let rawProjectedPath = [];
    if (isPenTracking) {
      rawProjectedPath = projectLetterPathToVideoNorm(pathUV);
      projectedScreenPath = smoothProjectedPath(rawProjectedPath);
    } else {
      projectedScreenPath = [];
      smoothedProjectedPath = [];
    }

    const activePath = projectedScreenPath;
    const debugState = {
      feedSource: lastHandFeedSource,
      handDetected: false,
      penX: null,
      penY: null,
      isOnPath: false,
      minDist: null,
      nextWaypoint: nextWaypointIdx,
      pathLength: activePath.length,
      projectedPts: activePath.length
    };

    if (activePath.length > 0) {
      drawProjectedPath(
        activePath,
        pathIsDefault ? 'rgba(255, 165, 0, 0.35)' : 'rgba(0, 123, 255, 0.3)'
      );
    }

    // ?debug=1: letter-center projection markers (guide-line drift)
    if (isPenTracking && global.ARDebug && global.ARDebug.DEBUG) {
      const center = projectUVDebug({ x: 0.5, y: 0.5 });
      if (center && center.videoNorm) {
        drawDebugMarker(center.videoNorm.x, center.videoNorm.y, 'rgba(255, 0, 255, 0.95)', 'ctr', 12);
        if (center.viewportNorm) {
          drawDebugMarker(center.viewportNorm.x, center.viewportNorm.y, 'rgba(255, 255, 0, 0.8)', 'ndc', 8);
        }
        const coverPx = imageNormToCoverBufferPx(center.videoNorm.x, center.videoNorm.y);
        if (coverPx) {
          drawDebugMarkerBufferPx(coverPx.x, coverPx.y, 'rgba(0, 255, 255, 0.9)', 'cover');
        }
      }
    }

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0 && isPenTracking) {
      debugState.handDetected = true;
      const landmarks = results.multiHandLandmarks[0];
      const indexMcp = landmarks[5];
      const indexTip = landmarks[8];
      const dirX = indexTip.x - indexMcp.x;
      const dirY = indexTip.y - indexMcp.y;
      const rawPenX = indexTip.x + dirX * 0.8;
      const rawPenY = indexTip.y + dirY * 0.8;
      const pen = smoothPenTip(rawPenX, rawPenY);
      const penTipX = pen.x;
      const penTipY = pen.y;
      debugState.penX = penTipX;
      debugState.penY = penTipY;
      debugState.rawTipX = indexTip.x;
      debugState.rawTipY = indexTip.y;
      debugState.rawPenX = rawPenX;
      debugState.rawPenY = rawPenY;
      debugState.mirrorTipX = 1 - indexTip.x;

      const x = penTipX * canvasEl.width;
      const y = penTipY * canvasEl.height;

      // ?debug=1: pen-tip stage markers (fixed offset diagnosis)
      if (global.ARDebug && global.ARDebug.DEBUG) {
        drawDebugMarker(indexTip.x, indexTip.y, 'rgba(255, 255, 0, 0.95)', 'tip', 11);
        drawDebugMarker(rawPenX, rawPenY, 'rgba(255, 140, 0, 0.95)', 'ext', 9);
        drawDebugMarker(1 - indexTip.x, indexTip.y, 'rgba(180, 0, 255, 0.85)', 'mir', 9);
        const coverTip = imageNormToCoverBufferPx(indexTip.x, indexTip.y);
        if (coverTip) {
          drawDebugMarkerBufferPx(coverTip.x, coverTip.y, 'rgba(255, 255, 255, 0.9)', 'tipC');
        }
      }

      ctx.beginPath();
      ctx.moveTo(indexTip.x * canvasEl.width, indexTip.y * canvasEl.height);
      ctx.lineTo(x, y);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.stroke();

      let isOnPath = false;
      if (activePath.length > 0 && !letterComplete) {
        const minDist = minDistToPath(penTipX, penTipY, activePath);
        debugState.minDist = minDist;
        if (minDist < PATH_HIT_THRESHOLD) {
          isOnPath = true;
          inkTrail.push({ x: penTipX, y: penTipY });
          if (nextWaypointIdx < activePath.length) {
            const wp = activePath[nextWaypointIdx];
            if (Math.hypot(penTipX - wp.x, penTipY - wp.y) < PATH_HIT_THRESHOLD) {
              nextWaypointIdx++;
              debugState.nextWaypoint = nextWaypointIdx;
            }
          }
        }
      }
      debugState.isOnPath = isOnPath;

      if (inkTrail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(inkTrail[0].x * canvasEl.width, inkTrail[0].y * canvasEl.height);
        for (let i = 1; i < inkTrail.length; i++) {
          ctx.lineTo(inkTrail[i].x * canvasEl.width, inkTrail[i].y * canvasEl.height);
        }
        ctx.lineWidth = 10;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, 12, 0, 2 * Math.PI);
      ctx.fillStyle = isOnPath ? 'rgba(0, 255, 0, 0.9)' : 'rgba(255, 0, 0, 0.9)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (global.ARDebug && global.ARDebug.DEBUG) {
        ctx.font = '10px monospace';
        ctx.fillStyle = '#fff';
        ctx.fillText('pen', x + 14, y + 4);
      }

      if (!letterComplete && activePath.length > 0 && nextWaypointIdx >= activePath.length) {
        letterComplete = true;
        document.getElementById('place-hint').textContent =
          '✅ Letter Complete! Tap PLACE to reposition or pick another letter.';
        document.getElementById('place-hint').style.display = 'block';
        if (global.ARPlacement) global.ARPlacement.clearPlaceHintTimeout();
      }
    } else if (isPenTracking && !letterComplete) {
      document.getElementById('place-hint').textContent = 'Show your hand holding the pen to the camera';
      document.getElementById('place-hint').style.display = 'block';
    }

    if (global.ARDebug) {
      global.ARDebug.updatePenDebugPanel(debugState, {
        penTracking: isPenTracking,
        getCameraImageStatus: lastGetCameraImageStatus,
        consecutiveFails: consecutiveCaptureFails,
        xrFeedDisabled: xrCameraFeedDisabled,
        zoom: global.ARPlacement ? global.ARPlacement.currentZoom : 1,
        defaultPath: pathIsDefault,
        letterOps: global.ARDebug.letterOpSummary ? global.ARDebug.letterOpSummary() : ''
      });
    }
  }

  async function initCamera() {
    if (!videoEl) return;
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      videoEl.srcObject = videoStream;
      await videoEl.play();
    } catch (err) {
      console.error('Camera access denied or failed:', err);
      alert('Could not access the camera. Please allow camera permissions and reload.');
    }
  }

  function stopDomCamera() {
    if (videoStream) {
      videoStream.getTracks().forEach(function (track) { track.stop(); });
      videoStream = null;
    }
  }

  function setPenOverlayActive(active) {
    if (canvasEl) {
      canvasEl.style.display = active ? '' : 'none';
      canvasEl.classList.toggle('pen-overlay-active', active);
    }
  }

  function stopPenTracking() {
    isPenTracking = false;
    clearPenFeedWatch();
    pendingHandImage = null;
    inkTrail = [];
    nextWaypointIdx = 0;
    letterComplete = false;
    resetSmoothingState();
    setPenOverlayActive(false);
  }

  function startPenTrackingAfterPlace() {
    consecutiveCaptureFails = 0;
    xrCameraFeedDisabled = false;
    xrCameraFeedDisableReason = '';
    lastGetCameraImageStatus = 'n/a';
    nextCaptureGapMs = XR_CAPTURE_MIN_INTERVAL_MS;
    isPenTracking = true;
    inkTrail = [];
    nextWaypointIdx = 0;
    letterComplete = false;
    resetSmoothingState();
    setPenOverlayActive(true);
    startPenFeedWatch();
    if (global.ARDebug) {
      global.ARDebug.logOnce('pen-start', 'pen tracking started after place');
    }
  }

  function onTraceReset() {
    projectedScreenPath = [];
    smoothedProjectedPath = [];
    inkTrail = [];
    nextWaypointIdx = 0;
    letterComplete = false;
    resetSmoothingState();
  }

  document.addEventListener('DOMContentLoaded', function () {
    videoEl = document.getElementById('cam-video');
    canvasEl = document.getElementById('tracking-canvas');
    if (canvasEl) ctx = canvasEl.getContext('2d');

    global.__penFeedTick = function (sceneEl) {
      if (!isPenTracking || !sceneEl.is('ar-mode') || xrCameraFeedDisabled) return;
      try {
        pendingHandImage = xrCameraFeed.capture(sceneEl);
      } catch (e) {
        noteCaptureFailure('tick threw: ' + (e && e.message ? e.message : String(e)));
        pendingHandImage = null;
      }
    };

    if (typeof Hands !== 'undefined') {
      hands = new Hands({
        locateFile: function (file) {
          return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/' + file;
        }
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      hands.onResults(onHandResults);
    }

    async function processFrame() {
      if (isPenTracking && hands) {
        let imageSource = pendingHandImage;
        let feedSource = null;
        if (imageSource) {
          feedSource = 'xr-camera';
        } else if (videoEl && videoEl.readyState >= 2) {
          imageSource = videoEl;
          feedSource = 'getUserMedia';
          trackingImageW = videoEl.videoWidth;
          trackingImageH = videoEl.videoHeight;
        }
        if (imageSource && feedSource) {
          lastHandFeedSource = feedSource;
          clearPenFeedWatch();
          pendingHandImage = null;
          try {
            await hands.send({ image: imageSource });
          } catch (err) {
            console.error('MediaPipe hands.send failed:', err);
          }
        }
      }
      requestAnimationFrame(processFrame);
    }
    processFrame();
  });

  global.ARPen = {
    setPenOverlayActive: setPenOverlayActive,
    stopPenTracking: stopPenTracking,
    startPenTrackingAfterPlace: startPenTrackingAfterPlace,
    stopDomCamera: stopDomCamera,
    resetCameraFeedSession: function () { xrCameraFeed.resetSessionState(); },
    onTraceReset: onTraceReset,
    isPenTracking: function () { return isPenTracking; },
    isLetterComplete: function () { return letterComplete; }
  };
})(window);
