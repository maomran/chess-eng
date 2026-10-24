// Anonymous visitor counts with GoatCounter (https://www.goatcounter.com): no cookies and no
// personal data, so no consent banner is needed. Counting is off until GOATCOUNTER_CODE is set
// to your GoatCounter site code (the "mysite" in mysite.goatcounter.com).
const GOATCOUNTER_CODE = '';

export function startAnalytics() {
  if (!GOATCOUNTER_CODE) return;
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
  script.addEventListener('load', () => {
    // Tell apart people who installed the app to their home screen.
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (installed) trackEvent('opened-installed-app');
  });
  document.head.append(script);
}

// Counts a named event (e.g. "analyze"), shown under Events in the GoatCounter dashboard.
export function trackEvent(name) {
  window.goatcounter?.count?.({ path: name, title: name, event: true });
}
