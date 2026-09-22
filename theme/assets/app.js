/**
 * Lyra Kids — motion + interaction layer.
 *
 * GSAP/ScrollTrigger drive the reveals. Everything degrades safely: if GSAP
 * fails to load or the visitor prefers reduced motion, `gsap-ready` is never
 * set and all content renders in its final state via CSS.
 */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasGSAP = typeof window.gsap !== 'undefined';

  /* ── Header: always visible, gains a shadow once the page scrolls ─── */
  function initHeader() {
    var header = document.querySelector('[data-header]');
    if (!header) return;
    var threshold = 24;

    function onScroll() {
      header.classList.toggle('is-stuck', window.scrollY > threshold);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ── Scroll reveals ─────────────────────────────────────────── */
  function initReveals() {
    if (!hasGSAP || reduced) return;
    gsap.registerPlugin(ScrollTrigger);
    document.documentElement.classList.add('gsap-ready');

    var EASE = 'power3.out';

    // Simple fade-up elements
    gsap.utils.toArray('[data-anim="fade-up"]').forEach(function (el) {
      gsap.from(el, {
        y: 40, opacity: 0, duration: 1.1, ease: EASE,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true }
      });
    });

    // Staggered children
    gsap.utils.toArray('[data-anim="stagger"]').forEach(function (group) {
      gsap.from(group.children, {
        y: 44, opacity: 0, duration: 1, ease: EASE, stagger: 0.09,
        scrollTrigger: { trigger: group, start: 'top 85%', once: true }
      });
    });

    // Image mask reveal — the wrapper's clip opens upward
    gsap.utils.toArray('[data-anim="reveal"]').forEach(function (el) {
      gsap.fromTo(el,
        { clipPath: 'inset(100% 0% 0% 0%)' },
        {
          clipPath: 'inset(0% 0% 0% 0%)', duration: 1.4, ease: 'power4.out',
          scrollTrigger: { trigger: el, start: 'top 90%', once: true }
        }
      );
    });

    // Gentle parallax on tagged media
    gsap.utils.toArray('[data-parallax]').forEach(function (el) {
      var amount = parseFloat(el.getAttribute('data-parallax')) || 12;
      gsap.to(el, {
        yPercent: amount, ease: 'none',
        scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true }
      });
    });

    // Hero: words rise in sequence on load
    var heroWords = document.querySelectorAll('[data-hero-line]');
    if (heroWords.length) {
      gsap.from(heroWords, {
        yPercent: 110, opacity: 0, duration: 1.3, ease: 'power4.out', stagger: 0.12, delay: 0.15
      });
    }
  }

  /* ── Carousel (new arrivals) ────────────────────────────────── */
  function initCarousels() {
    document.querySelectorAll('[data-carousel]').forEach(function (root) {
      var track = root.querySelector('[data-carousel-track]');
      var prev = root.querySelector('[data-carousel-prev]');
      var next = root.querySelector('[data-carousel-next]');
      if (!track) return;

      function step() {
        var card = track.querySelector(':scope > *');
        if (!card) return 320;
        var gap = parseFloat(getComputedStyle(track).columnGap || '0') || 0;
        return card.getBoundingClientRect().width + gap;
      }
      function sync() {
        if (!prev || !next) return;
        var max = track.scrollWidth - track.clientWidth - 2;
        prev.disabled = track.scrollLeft <= 2;
        next.disabled = track.scrollLeft >= max;
      }
      prev && prev.addEventListener('click', function () {
        track.scrollBy({ left: -step(), behavior: 'smooth' });
      });
      next && next.addEventListener('click', function () {
        track.scrollBy({ left: step(), behavior: 'smooth' });
      });
      track.addEventListener('scroll', sync, { passive: true });
      window.addEventListener('resize', sync);
      sync();

      /* Drag-to-scroll, mouse only. Touch devices keep the browser's native
         panning, which is smoother than anything we could synthesise. */
      var dragging = false;
      var moved = 0;
      var suppressClick = false;
      var startX = 0;
      var startLeft = 0;

      track.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        dragging = true;
        moved = 0;
        suppressClick = false;
        startX = e.clientX;
        startLeft = track.scrollLeft;
        track.classList.add('is-dragging');
        /* Capture once, here. Calling this per-move can throw on a stale
           pointer id, which would abort the handler before the scroll below. */
        try { track.setPointerCapture(e.pointerId); } catch (err) {}
      });

      track.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        e.preventDefault();
        var dx = e.clientX - startX;
        moved = Math.abs(dx);
        track.scrollLeft = startLeft - dx;
      });

      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        /* Arm a one-shot click suppressor so the release at the end of a drag
           does not also open the product it happens to land on. Cleared on the
           next pointerdown, so an ordinary click is never swallowed. */
        if (moved > 5) suppressClick = true;
        track.classList.remove('is-dragging');
        if (e && e.pointerId != null && track.hasPointerCapture(e.pointerId)) {
          track.releasePointerCapture(e.pointerId);
        }
      }
      /* No pointerleave listener: setPointerCapture fires boundary events, which
         would end the drag the instant it starts. Capture guarantees pointerup
         lands here, and lostpointercapture covers every other exit. */
      /* Dragging across a card would otherwise start a native HTML drag on the
         link/image, and the browser cancels our pointer stream to do it. */
      track.addEventListener('dragstart', function (e) { e.preventDefault(); });

      track.addEventListener('pointerup', endDrag);
      track.addEventListener('pointercancel', endDrag);
      track.addEventListener('lostpointercapture', endDrag);

      /* A drag that moved should not also open the product it finished on. */
      track.addEventListener('click', function (e) {
        if (!suppressClick) return;
        suppressClick = false;
        if (e.target.closest('a')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    });
  }

  /* ── Mobile menu ────────────────────────────────────────────── */
  function initMenu() {
    var toggle = document.querySelector('[data-menu-toggle]');
    var panel = document.querySelector('[data-menu-panel]');
    if (!toggle || !panel) return;

    function setOpen(open) {
      panel.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('overflow-hidden', open);
      if (open) document.body.setAttribute('data-overlay-open', '');
      else document.body.removeAttribute('data-overlay-open');
    }
    toggle.addEventListener('click', function () {
      setOpen(!panel.classList.contains('is-open'));
    });
    panel.querySelectorAll('[data-menu-close]').forEach(function (b) {
      b.addEventListener('click', function () { setOpen(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
  }

  function init() {
    initHeader();
    initMenu();
    initCarousels();
    initReveals();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
