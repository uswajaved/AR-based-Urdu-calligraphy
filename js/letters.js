/* Letter UV stroke paths + home/nav selection */
(function (global) {
  const letterPaths = {
    'Alif.svg': [
      { x: 0.5, y: 0.12 },
      { x: 0.5, y: 0.88 }
    ],
    'Be.svg': [
      { x: 0.18, y: 0.72 },
      { x: 0.18, y: 0.38 },
      { x: 0.35, y: 0.22 },
      { x: 0.55, y: 0.18 },
      { x: 0.72, y: 0.28 },
      { x: 0.82, y: 0.48 },
      { x: 0.78, y: 0.68 },
      { x: 0.55, y: 0.78 },
      { x: 0.32, y: 0.72 }
    ],
    'Baa.svg': [
      { x: 0.18, y: 0.72 },
      { x: 0.18, y: 0.38 },
      { x: 0.35, y: 0.22 },
      { x: 0.55, y: 0.18 },
      { x: 0.72, y: 0.28 },
      { x: 0.82, y: 0.48 },
      { x: 0.78, y: 0.68 },
      { x: 0.55, y: 0.78 },
      { x: 0.32, y: 0.72 }
    ],
    'Jeem.svg': [
      { x: 0.7, y: 0.15 },
      { x: 0.45, y: 0.35 },
      { x: 0.45, y: 0.6 },
      { x: 0.75, y: 0.75 }
    ]
  };

  const DEFAULT_LETTER_PATH = [
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.8 }
  ];

  let currentLetterFilename = 'Baa.svg';
  let currentTargetPathUV = letterPaths['Baa.svg'].slice();
  let currentPathIsDefault = false;

  function getLetterPathUV(filename) {
    return letterPaths[filename] || DEFAULT_LETTER_PATH;
  }

  function resetTraceProgress(filename) {
    currentLetterFilename = filename;
    currentTargetPathUV = getLetterPathUV(filename);
    currentPathIsDefault = !letterPaths[filename];
    if (global.ARPen && typeof global.ARPen.onTraceReset === 'function') {
      global.ARPen.onTraceReset();
    }
  }

  function traceHintText() {
    if (currentPathIsDefault) {
      return 'Trace the letter (default guide — path not defined yet for this letter)';
    }
    return 'Hold phone steady and trace the letter';
  }

  function setLetterSrc(filename) {
    const letterEl = document.querySelector('#urdu-letter');
    if (!letterEl) return;
    const prev = letterEl.getAttribute('src');
    const assetId = '#' + filename.replace(/\.svg$/i, '').replace(/\./g, '');
    if (prev === filename || prev === assetId) {
      if (global.ARDebug && global.ARDebug.logLetterOp) {
        global.ARDebug.logLetterOp('setLetterSrc.skip', 'unchanged src=' + prev);
      }
      return;
    }
    if (global.ARDebug && global.ARDebug.logLetterOp) {
      global.ARDebug.logLetterOp('setLetterSrc', filename + ' (was ' + prev + ')');
    }
    if (global.ARDebug) {
      global.ARDebug.logOnce(
        'letter-src-' + filename,
        'letter texture src → ' + filename + ' (was ' + prev + ')'
      );
    }
    if (global.ARPlacement && typeof global.ARPlacement.bindLetterTextureLoadLogging === 'function') {
      global.ARPlacement.bindLetterTextureLoadLogging(letterEl);
    }
    letterEl.setAttribute('src', filename);
  }

  async function selectLetter(filename, character) {
    resetTraceProgress(filename);

    document.querySelector('#home-screen').style.display = 'none';
    document.querySelector('#top-nav').style.display = 'flex';
    document.querySelector('#bottom-nav').style.display = 'flex';

    setLetterSrc(filename);

    document.querySelectorAll('.nav-letter').forEach(function (el) {
      el.classList.remove('active');
      if (el.innerText === character) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }
    });

    if (global.ARPlacement) global.ARPlacement.resetPlacement();
    if (global.ARPlacement) global.ARPlacement.enterARFromSelection();
  }

  async function changeLetterNav(filename, element) {
    resetTraceProgress(filename);
    setLetterSrc(filename);

    document.querySelectorAll('.nav-letter').forEach(function (el) { el.classList.remove('active'); });
    element.classList.add('active');
    element.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    const anchor = document.querySelector('#letter-anchor');
    if (global.ARPlacement && global.ARPlacement.isAFrameVisible(anchor)) {
      document.getElementById('place-hint').textContent = traceHintText();
      document.getElementById('place-hint').style.display = 'block';
    }
  }

  function scrollNav(amount) {
    document.getElementById('letter-scroller').scrollBy({ left: amount, behavior: 'smooth' });
  }

  (function enableDragScroll() {
    function bind() {
      const scroller = document.getElementById('letter-scroller');
      if (!scroller) return;
      let isDown = false, startX, scrollLeft;
      scroller.addEventListener('mousedown', function (e) {
        isDown = true;
        startX = e.pageX - scroller.offsetLeft;
        scrollLeft = scroller.scrollLeft;
      });
      window.addEventListener('mouseup', function () { isDown = false; });
      window.addEventListener('mousemove', function (e) {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - scroller.offsetLeft;
        scroller.scrollLeft = scrollLeft - (x - startX) * 1.2;
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bind);
    } else {
      bind();
    }
  })();

  global.ARLetters = {
    letterPaths: letterPaths,
    getLetterPathUV: getLetterPathUV,
    resetTraceProgress: resetTraceProgress,
    traceHintText: traceHintText,
    get currentLetterFilename() { return currentLetterFilename; },
    get currentTargetPathUV() { return currentTargetPathUV; },
    get currentPathIsDefault() { return currentPathIsDefault; }
  };

  // onclick handlers from HTML
  global.selectLetter = selectLetter;
  global.changeLetterNav = changeLetterNav;
  global.scrollNav = scrollNav;
})(window);
