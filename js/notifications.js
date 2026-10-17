(function (root) {
  'use strict';
  const shown = new Set();

  async function requestPermission() {
    if (!('Notification' in root)) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    return Notification.requestPermission();
  }

  function notify(alerts, enabled) {
    if (!enabled || !('Notification' in root) || Notification.permission !== 'granted') return;
    alerts.forEach(alert => {
      if (shown.has(alert.key)) return;
      shown.add(alert.key);
      try {
        new Notification('Fintrack', { body: alert.text, icon: 'icons/icon.svg', tag: alert.key });
      } catch {}
    });
  }

  root.FintrackNotifications = { requestPermission, notify };
})(typeof globalThis !== 'undefined' ? globalThis : this);
