(() => {
  const names = ['g_users', 'PhaserGlobal', 'g_url', 'Utils', 'Classy', 'Box2D', 'Constants',
    'GameManager', 'ClientManager', 'AIs', 'Users', 'GameController', 'VantageTree', 'Phaser', 'jQuery', '$'];
  const defined = {};
  for (const n of names) { try { defined[n] = typeof window[n]; } catch (e) { defined[n] = 'ERR'; } }
  const mods = Object.keys(window).filter((k) => k.startsWith('mod_pagespeed_'));
  const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  return {
    defined,
    modCount: mods.length,
    modSample: mods.slice(0, 4),
    scriptSrcCount: srcs.length,
    scriptSrcTail: srcs.slice(-3),
    inlineScriptCount: document.querySelectorAll('script:not([src])').length,
    origin: location.origin,
    title: document.title,
  };
})()
