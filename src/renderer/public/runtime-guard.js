// Production builds load this before the app (vite.web.config.ts injects it; the
// dev server does not): React DevTools cannot attach to the live app, and nothing
// is written to the browser console. A plain script from the site itself, so the
// Content-Security-Policy (script-src 'self') allows it.
;(function () {
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  if (hook && typeof hook === 'object') {
    for (var key in hook) {
      try {
        hook[key] = typeof hook[key] === 'function' ? function () {} : null
      } catch (e) {}
    }
    try {
      hook.isDisabled = true
    } catch (e) {}
  }
  var silent = function () {}
  var methods = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'table', 'dir', 'dirxml', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'assert']
  for (var i = 0; i < methods.length; i++) {
    try {
      console[methods[i]] = silent
    } catch (e) {}
  }
})()
