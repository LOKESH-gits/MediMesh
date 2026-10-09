/* MediMesh — PWA layer (added on top of the prototype; does not touch app.js).
   Registers the service worker (true offline app shell) and shows an "Install app" button. */
(function () {
  var secure = /^https?:$/.test(location.protocol);
  if ('serviceWorker' in navigator && secure) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && !navigator.serviceWorker.controller) {
              try { if (!localStorage.getItem('mm_pwa_ready')) { localStorage.setItem('mm_pwa_ready', '1'); toast('Offline-ready — MediMesh is now saved on this device'); } } catch (e) {}
            }
          });
        });
      }).catch(function () {});
    });
  }
  var deferred = null, btn = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    if (btn) return;
    btn = document.createElement('button');
    btn.textContent = 'Install MediMesh';
    btn.setAttribute('aria-label', 'Install MediMesh as an app');
    btn.style.cssText = 'position:fixed;left:16px;bottom:96px;z-index:70;padding:10px 16px;border-radius:12px;border:0;background:#35B8B2;color:#04221F;font:700 .9rem Figtree,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);cursor:pointer';
    btn.onclick = function () {
      deferred.prompt();
      deferred.userChoice.finally(function () { btn.remove(); btn = null; deferred = null; });
    };
    document.body.appendChild(btn);
  });
  window.addEventListener('appinstalled', function () { if (btn) btn.remove(); btn = null; try { toast('MediMesh installed'); } catch (e) {} });
})();
