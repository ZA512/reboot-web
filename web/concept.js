(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('method') === '1' || window.location.hash === '#methode') {
    window.location.replace('methode.html');
    return;
  }

  const panels = [...document.querySelectorAll('[data-story-step]')];
  const progress = document.querySelector('#storyProgress');
  if (!panels.length) return;

  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    panels.forEach(panel => panel.classList.add('is-visible'));
    if (progress) progress.style.width = '100%';
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      const step = Number(entry.target.dataset.storyStep || 0);
      if (progress) progress.style.width = `${((step + 1) / panels.length) * 100}%`;
    });
  }, { rootMargin: '-18% 0px -28%', threshold: 0.2 });

  panels.forEach(panel => observer.observe(panel));
})();
