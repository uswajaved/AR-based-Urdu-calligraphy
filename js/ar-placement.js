/* Hit-test, enterAR, letter placement, visibility, zoom/opacity */
(function (global) {
  const BASE_SCALE = 0.3;
  let currentZoom = 1;
  let currentOpacity = 0.5;
  let placeHintTimeout = null;

  function isAFrameVisible(el) {
    if (!el) return false;
    const v = el.getAttribute('visible');
    return v === true || v === 'true';
  }

  function setLetterAnchorVisible(visible) {
    const anchor = document.querySelector('#letter-anchor');
    if (!anchor) return;
    const next = !!visible;
    const prev = isAFrameVisible(anchor);
    if (prev === next) return; // avoid redundant attribute writes that can re-trigger systems
    anchor.setAttribute('visible', next);
    if (global.ARDebug) {
      global.ARDebug.logOnce(
        'letter-visible-' + next,
        'letter-anchor visible → ' + next
      );
    }
  }

  function bindLetterTextureLoadLogging(letterEl) {
    if (!letterEl || letterEl.__textureLogBound) return;
    letterEl.__textureLogBound = true;
    letterEl.addEventListener('materialtextureloaded', function () {
      if (global.ARDebug) {
        global.ARDebug.logOnce(
          'letter-tex-ok-' + (letterEl.getAttribute('src') || ''),
          'letter texture loaded: ' + letterEl.getAttribute('src')
        );
      }
    });
    letterEl.addEventListener('error', function (evt) {
      if (global.ARDebug) {
        global.ARDebug.logOnce(
          'letter-tex-fail-' + (letterEl.getAttribute('src') || ''),
          'letter texture FAILED: ' + letterEl.getAttribute('src')
        );
      }
    });
  }

  function applySettings() {
    const letterEl = document.querySelector('#urdu-letter');
    if (!letterEl) return;
    const s = BASE_SCALE * currentZoom;
    // Only update scale / opacity — avoid rewriting full material string every call
    // (full material rewrite reloads texture and causes blink).
    letterEl.setAttribute('scale', s + ' ' + s + ' 1');
    const mesh = letterEl.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.opacity = currentOpacity;
      mesh.material.transparent = true;
      mesh.material.needsUpdate = true;
    } else {
      letterEl.setAttribute(
        'material',
        'shader: flat; transparent: true; opacity: ' + currentOpacity
      );
    }
  }

  function setPassthroughLayersVisible(show) {
    const videoEl = document.getElementById('cam-video');
    if (videoEl) videoEl.style.display = show ? '' : 'none';
    if (global.ARPen) {
      if (!show) global.ARPen.setPenOverlayActive(global.ARPen.isPenTracking());
      else global.ARPen.setPenOverlayActive(false);
    }
  }

  function resetHitTestPlacement() {
    const scene = document.querySelector('a-scene');
    if (!scene || !scene.is('ar-mode')) return;
    const hitTestComp = scene.components['ar-hit-test'];
    if (!hitTestComp) return;
    hitTestComp.hasPosedOnce = false;
    if (hitTestComp.bboxMesh) hitTestComp.bboxMesh.visible = false;
    if (hitTestComp.viewerHitTest) {
      hitTestComp.hitTest = hitTestComp.viewerHitTest;
    }
  }

  function resetPlacement() {
    if (global.ARPen) global.ARPen.stopPenTracking();
    setLetterAnchorVisible(false);
    resetHitTestPlacement();
    const scene = document.querySelector('a-scene');
    if (scene) {
      try {
        scene.setAttribute('ar-hit-test', 'enabled', true);
        if (global.ARPen) global.ARPen.resetCameraFeedSession();
      } catch (e) {}
    }
    const hint = document.getElementById('place-hint');
    if (hint) {
      hint.textContent = 'Move your phone to find a surface, then tap to place';
      hint.style.display = 'block';
    }
  }

  function goHome() {
    if (global.ARPen) global.ARPen.stopPenTracking();
    document.querySelector('#home-screen').style.display = 'flex';
    document.querySelector('#top-nav').style.display = 'none';
    document.querySelector('#bottom-nav').style.display = 'none';
    document.getElementById('place-hint').style.display = 'none';
    setLetterAnchorVisible(false);
    if (placeHintTimeout) clearTimeout(placeHintTimeout);
    if (global.ARPen) global.ARPen.stopDomCamera();
    const scene = document.querySelector('a-scene');
    if (scene && (scene.is('vr-mode') || scene.is('ar-mode'))) {
      scene.exitVR();
    }
  }

  function enterARFromSelection() {
    const scene = document.querySelector('a-scene');
    if (!scene) return;

    if (!scene.hasLoaded) {
      if (typeof scene.play === 'function') {
        try { scene.play(); } catch (e) { /* already playing */ }
      }
      scene.hasLoaded = true;
      scene.emit('loaded');
    }

    if (scene.is('vr-mode') || scene.is('ar-mode')) return;

    try {
      const p = scene.enterAR();
      if (p && typeof p.then === 'function') {
        p.catch(function (e) { console.error('enterAR failed', e); });
      }
    } catch (e) {
      console.error('enterAR threw', e);
    }
  }

  function openModal(id) { document.getElementById(id).style.display = 'flex'; }
  function closeModal(id) {
    document.getElementById(id).style.display = 'none';
    applySettings();
  }
  function updateZoomPreview(val) { currentZoom = parseFloat(val); applySettings(); }
  function setZoom(val) {
    currentZoom = val;
    document.getElementById('zoom-slider').value = val;
    applySettings();
  }
  function updateOpacityPreview(val) { currentOpacity = parseFloat(val); applySettings(); }
  function setOpacity(val) {
    currentOpacity = val;
    document.getElementById('opacity-slider').value = val;
    applySettings();
  }

  function onLetterPlaced(scene) {
    // Settle visibility once — do not rewrite material/src (blinks the texture).
    setLetterAnchorVisible(true);
    // Scale only if zoom changed from default path; opacity left as-is on mesh.
    const letterEl = document.querySelector('#urdu-letter');
    if (letterEl) {
      const s = BASE_SCALE * currentZoom;
      letterEl.setAttribute('scale', s + ' ' + s + ' 1');
      bindLetterTextureLoadLogging(letterEl);
    }

    const hint = document.getElementById('place-hint');
    if (hint) {
      hint.textContent = global.ARLetters ? global.ARLetters.traceHintText() : 'Hold phone steady and trace the letter';
      hint.style.display = 'block';
    }

    // Stop hit-test/reticle from continuing to update after placement.
    try {
      scene.setAttribute('ar-hit-test', 'enabled', false);
      if (global.ARDebug) {
        global.ARDebug.logOnce('hit-test-off', 'ar-hit-test enabled → false after place');
      }
    } catch (e) {}

    // Start pen tracking (fail-soft lives in ARPen).
    requestAnimationFrame(function () {
      if (global.ARPen) global.ARPen.startPenTrackingAfterPlace();
    });

    if (placeHintTimeout) clearTimeout(placeHintTimeout);
    placeHintTimeout = setTimeout(function () {
      if (global.ARPen && !global.ARPen.isLetterComplete()) {
        hint.style.display = 'none';
      }
    }, 15000);
  }

  function wireScene() {
    const scene = document.querySelector('a-scene');
    if (!scene) return;

    scene.addEventListener('loaded', function () {
      if (scene.renderer) scene.renderer.setClearColor(0x000000, 0);
    });

    scene.addEventListener('enter-vr', function () {
      if (global.ARPen) global.ARPen.stopDomCamera();
      const videoEl = document.getElementById('cam-video');
      if (videoEl) videoEl.style.display = 'none';
      // Dummy mesh: show once for Chrome multi-texture workaround; do not toggle every frame.
      const dummy = document.querySelector('#cam-access-dummy');
      if (dummy && !isAFrameVisible(dummy)) {
        dummy.setAttribute('visible', true);
        if (global.ARDebug) global.ARDebug.logOnce('dummy-on', 'cam-access-dummy visible → true');
      }
    });

    scene.addEventListener('exit-vr', function () {
      setPassthroughLayersVisible(true);
      if (global.ARPen) {
        global.ARPen.setPenOverlayActive(false);
        global.ARPen.resetCameraFeedSession();
      }
      const dummy = document.querySelector('#cam-access-dummy');
      if (dummy && isAFrameVisible(dummy)) {
        dummy.setAttribute('visible', false);
        if (global.ARDebug) global.ARDebug.logOnce('dummy-off', 'cam-access-dummy visible → false');
      }
    });

    const hint = document.getElementById('place-hint');

    scene.addEventListener('ar-hit-test-start', function () {
      if (!hint) return;
      hint.textContent = 'Move your phone to find a surface, then tap to place';
      hint.style.display = 'block';
    });

    scene.addEventListener('ar-hit-test-achieved', function () {
      if (!hint) return;
      hint.textContent = 'Surface found — tap to place the letter';
      hint.style.display = 'block';
    });

    scene.addEventListener('ar-hit-test-select', function () {
      onLetterPlaced(scene);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (global.ARDebug) global.ARDebug.init();
    wireScene();
  });

  global.ARPlacement = {
    BASE_SCALE: BASE_SCALE,
    isAFrameVisible: isAFrameVisible,
    setLetterAnchorVisible: setLetterAnchorVisible,
    bindLetterTextureLoadLogging: bindLetterTextureLoadLogging,
    applySettings: applySettings,
    setPassthroughLayersVisible: setPassthroughLayersVisible,
    resetPlacement: resetPlacement,
    enterARFromSelection: enterARFromSelection,
    get currentZoom() { return currentZoom; },
    get currentOpacity() { return currentOpacity; },
    clearPlaceHintTimeout: function () {
      if (placeHintTimeout) {
        clearTimeout(placeHintTimeout);
        placeHintTimeout = null;
      }
    }
  };

  global.goHome = goHome;
  global.resetPlacement = resetPlacement;
  global.openModal = openModal;
  global.closeModal = closeModal;
  global.updateZoomPreview = updateZoomPreview;
  global.setZoom = setZoom;
  global.updateOpacityPreview = updateOpacityPreview;
  global.setOpacity = setOpacity;
})(window);
