/* ?debug=1 panel + one-time logging helpers */
(function (global) {
  const DEBUG = new URLSearchParams(location.search).has('debug');
  let panelEl = null;
  const onceKeys = Object.create(null);
  const onceMessages = [];
  let recentCaptureLines = [];
  const MAX_CAPTURE_LINES = 6;

  function initDebugPanel() {
    panelEl = document.getElementById('pen-debug-panel');
  }

  function clearOnceKey(key) {
    delete onceKeys[key];
  }

  function logOnce(key, message) {
    if (onceKeys[key]) return;
    onceKeys[key] = true;
    onceMessages.push(message);
    console.log('[AR]', message);
    if (DEBUG && panelEl) {
      panelEl.style.display = 'block';
      panelEl.textContent =
        (panelEl.textContent ? panelEl.textContent + '\n' : 'debug=1\n') + message;
    }
  }

  function logCaptureAttempt(outcome) {
    recentCaptureLines.push('capture: ' + outcome);
    if (recentCaptureLines.length > MAX_CAPTURE_LINES) {
      recentCaptureLines = recentCaptureLines.slice(-MAX_CAPTURE_LINES);
    }
    if (DEBUG && panelEl) panelEl.style.display = 'block';
  }

  function updatePenDebugPanel(state, extras) {
    if (!DEBUG || !panelEl) return;
    extras = extras || {};
    panelEl.style.display = 'block';
    panelEl.textContent =
      'debug=1\n' +
      'penTracking: ' + (extras.penTracking ? 'on' : 'off') + '\n' +
      'feed: ' + (state.feedSource || 'none') + '\n' +
      'getCameraImage: ' + (extras.getCameraImageStatus || 'n/a') + '\n' +
      'captureFails: ' + (extras.consecutiveFails != null ? extras.consecutiveFails : 'n/a') + '\n' +
      'xrFeedDisabled: ' + (extras.xrFeedDisabled ? 'yes' : 'no') + '\n' +
      'hand: ' + (state.handDetected ? 'yes' : 'no') + '\n' +
      'pen: ' + (state.penX != null ? state.penX.toFixed(3) + ', ' + state.penY.toFixed(3) : 'n/a') + '\n' +
      'onPath: ' + (state.isOnPath ? 'yes' : 'no') + '\n' +
      'dist: ' + (state.minDist != null ? state.minDist.toFixed(3) : 'n/a') + '\n' +
      'waypoint: ' + state.nextWaypoint + '/' + state.pathLength + '\n' +
      'projectedPts: ' + state.projectedPts + '\n' +
      'zoom: ' + (extras.zoom != null ? Number(extras.zoom).toFixed(1) : 'n/a') + '\n' +
      'defaultPath: ' + (extras.defaultPath ? 'yes' : 'no') +
      (recentCaptureLines.length ? '\n---\n' + recentCaptureLines.join('\n') : '') +
      (onceMessages.length ? '\n---\n' + onceMessages.join('\n') : '');
  }

  global.ARDebug = {
    DEBUG: DEBUG,
    init: initDebugPanel,
    logOnce: logOnce,
    clearOnceKey: clearOnceKey,
    updatePenDebugPanel: updatePenDebugPanel,
    logCaptureAttempt: logCaptureAttempt,
    get panelEl() { return panelEl; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDebugPanel);
  } else {
    initDebugPanel();
  }
})(window);
