/* 科研台 — 统一 SVG 图标系统
 * 线性图标，继承 currentColor，兼容浅色/霓虹双主题。
 * 用法：ico('search') / ico('star', 14, 'is-on')
 * HTML 占位：<span class="ico-slot" data-ico="search"></span>，由 hydrateIcons() 填充。
 */
(function (global) {
  'use strict';

  // 所有 path 均基于 24×24 viewBox
  var P = {
    // 导航 / 面板
    menu:        '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panelLeft:   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    panelRight:  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    list:        '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    chevronUp:   '<path d="M6 15l6-6 6 6"/>',
    chevronRight:'<path d="M9 6l6 6-6 6"/>',
    maximize:    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    minimize:    '<path d="M5 12h14"/>',
    close:       '<path d="M6 6l12 12M18 6L6 18"/>',
    focus:       '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>',

    // 主题 / 设置 / 帮助
    moon:        '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    sun:         '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    settings:    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z"/>',
    keyboard:    '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
    command:     '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    help:        '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2-2.5 3.5M12 17h.01"/>',

    // 实体
    fileText:    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    layers:      '<path d="M12 3L3 8l9 5 9-5z"/><path d="M3 13l9 5 9-5M3 18l9 5 9-5"/>',
    folder:      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen:  '<path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 17.5z"/>',
    lightbulb:   '<path d="M9 18h6M10 22h4"/><path d="M15.1 14.5a6 6 0 1 0-6.2 0c.6.4 1 1.2 1 2h4c0-.8.4-1.6 1-2z"/>',
    flask:       '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h9.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/>',
    checkSquare: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>',
    shield:       '<path d="M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    timeline:     '<path d="M3 12h18M6 8v8M12 6v12M18 9v6"/><circle cx="6" cy="8" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="18" cy="9" r="2"/>',

    // 操作
    search:      '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    plus:        '<path d="M12 5v14M5 12h14"/>',
    minus:       '<path d="M5 12h14"/>',
    star:        '<path d="M12 3l2.9 5.9 6.5 1-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.9l6.5-1z" fill="currentColor" stroke="none"/>',
    starOff:     '<path d="M12 3l2.9 5.9 6.5 1-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.9l6.5-1z"/>',
    sparkle:     '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 15l.6 1.6 1.6.6-1.6.6L19 19.4l-.6-1.6-1.6-.6 1.6-.6z"/>',
    edit:        '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    external:    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
    trash:       '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
    upload:      '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    refresh:     '<path d="M20 11a8 8 0 1 0-2.3 6M20 5v6h-6"/>',
    check:       '<path d="M5 12l4 4L19 6"/>',
    arrowRight:  '<path d="M5 12h14M13 6l6 6-6 6"/>',
    link:        '<path d="M10 13a5 5 0 0 0 7 .5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7-.5l-2 2a5 5 0 0 0 7 7l1-1"/>',
    tag:         '<path d="M20.6 13.6L12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
    clock:       '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar:    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/>',
    chart:       '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    stats:       '<path d="M4 20V4M4 20h16"/><rect x="7" y="12" width="3" height="5" rx="0.5"/><rect x="12" y="8" width="3" height="9" rx="0.5"/><rect x="17" y="5" width="3" height="12" rx="0.5"/>',
    network:     '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6.8 7.4L10.5 16M17.2 7.4L13.5 16M7 6h10"/>',
    download:    '<path d="M12 3v12M7 11l5 5 5-5M4 18v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
    dot:         '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
    more:        '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    sparklesBig: '<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/><path d="M19 14l.9 2.5 2.5.9-2.5.9L19 21l-.9-2.6-2.5-.9 2.5-.9z"/><path d="M5 15l.7 1.9 1.9.7-1.9.7L5 20.2l-.7-1.9-1.9-.7 1.9-.7z"/>',
    code:        '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
    filter:      '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
    copy:        '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    book:        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    zap:         '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    gitBranch:   '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6M18 9a9 9 0 0 1-9 9"/>',
    globe:       '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'
  };

  function ico(name, size, cls) {
    var body = P[name] || P.dot;
    return '<svg class="ico ' + (cls || '') + '" width="' + (size || 16) + '" height="' + (size || 16) +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  function hydrateIcons(root) {
    var scope = root || document;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-ico]'), function (el) {
      if (el.dataset.iDone) return;
      el.innerHTML = ico(el.dataset.ico, el.dataset.icoSize || 16, el.dataset.icoClass || '');
      el.dataset.iDone = '1';
    });
  }

  global.ICONS = P;
  global.ico = ico;
  global.hydrateIcons = hydrateIcons;
})(window);
