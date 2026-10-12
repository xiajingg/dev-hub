/* dev-hub · 前端脚本
 *
 * 渲染策略：按 id 复用 <tr>，单元格级 diff —— 只有内容真的变了才写 DOM。
 * 2 秒轮询只负责取数，不再整表重建；弹窗打开时暂停轮询。
 * 日志抽屉保留最近 LOG_MAX_LINES 行，避免长跑服务把 DOM 撑爆。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var LOG_MAX_LINES = 5000;                 // 抽屉里最多保留多少行
  var LOG_TRIM_AT = LOG_MAX_LINES + 300;    // 超过这个数才触发裁剪（滞回，避免每秒都扫一遍）
  var TOAST_MAX = 6;
  var POLL_MS = 2000;

  var state = {
    projects: [],
    rows: {},          // id -> <tr>
    editingId: null,
    search: '',
    filter: 'all',
    busy: {},          // id -> 'start' | 'stop' | 'restart'
    batch: false,
    loaded: false,
    parseTimer: null,
  };

  var log = { id: null, name: '', offset: 0, timer: null, follow: true, external: false, warned: false, lines: 0 };
  var scanList = [];
  var skelRows = [];
  var portPopAnchor = null;

  // ================================================================== 工具

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, opts) {
    var o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {});
    return fetch(path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || ('HTTP ' + r.status)); e.data = data; throw e; }
        return data;
      });
    });
  }

  function fmtMem(bytes) {
    if (!bytes) return '—';
    var mb = bytes / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
  }

  function fmtSize(n) {
    if (n == null || !isFinite(n)) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  }

  // 提示条：同样内容不重复弹；超过上限先挤掉最旧的一条
  function toast(title, detail, kind) {
    var box = $('toasts');
    var key = (kind || '') + '|' + title + '|' + (detail || '');
    for (var i = 0; i < box.children.length; i++) {
      if (box.children[i]._key === key) return;   // 已经在屏上，不重复
    }
    // 超出上限：最旧的一条立刻摘掉。
    // 注意不能用 dropToast —— 它只是「淡出后 150ms 再移除」，children.length 不会当场变小，
    // 放在 while 条件里就是个死循环。
    while (box.children.length >= TOAST_MAX) {
      var oldest = box.firstChild;
      if (!oldest) break;
      if (oldest._timer) clearTimeout(oldest._timer);
      oldest._gone = true;
      box.removeChild(oldest);
    }

    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el._key = key;
    el.innerHTML =
      '<div class="t">' + esc(title) + '</div>' +
      (detail ? '<div class="d">' + esc(detail) + '</div>' : '') +
      '<button class="x" title="关闭" aria-label="关闭">×</button>';
    el.querySelector('.x').addEventListener('click', function () { dropToast(el); });
    el._timer = setTimeout(function () { dropToast(el); }, kind === 'err' ? 9000 : 4500);
    box.appendChild(el);
  }

  function dropToast(el) {
    if (!el || el._gone) return;
    el._gone = true;
    if (el._timer) clearTimeout(el._timer);
    el.classList.add('leaving');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 150);
  }

  function copyText(text, el, label) {
    var done = function () {
      if (el) {
        el.classList.add('copied');
        setTimeout(function () { el.classList.remove('copied'); }, 900);
      }
      toast(label || '已复制', text, 'ok');
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { toast('复制失败', '请手动选中复制', 'err'); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function anyModalOpen() {
    return !$('maskEdit').classList.contains('hidden') ||
           !$('maskScan').classList.contains('hidden') ||
           !$('maskConfirm').classList.contains('hidden');
  }

  // ================================================================== 单元格内容

  function stateCell(p) {
    if (p.status === 'running') {
      // ★ 来源必须明说，不能靠「有没有徽标」来暗示 —— 用户会误以为没徽标就是没纳管。
      //   外部启动 = 平台没启动它，只是接管了 PID（扫描导入 / 平台重启认回 / 点启动时发现已在跑）
      var origin = p.adopted
        ? '<span class="badge info" title="不是平台启动的，平台只是接管了它的 PID（来源：扫描导入、平台重启后认回、或点「启动」时发现它已经在跑）。停止时照样能停掉。">外部启动</span>'
        : '<span class="badge" title="这个进程是平台启动的，PID 和日志从一开始就由平台掌握。">平台启动</span>';
      return '<span class="state"><i class="dot running"></i><small>运行中</small>' + origin + '</span>';
    }
    if (p.external) return '<span class="state"><i class="dot orphan"></i><small>外部运行中</small></span>';
    if (p.orphan) return '<span class="state"><i class="dot orphan"></i><small>残留占用</small></span>';
    if (p.status === 'error') {
      // ★ 异常退出要说清楚「怎么退的」—— 退出码是排查的第一线索
      return '<span class="state"><i class="dot error"></i><small>异常退出</small>' +
        (p.exitCode != null ? '<span class="badge err" title="进程退出码 ' + esc(p.exitCode) + '">exit ' + esc(p.exitCode) + '</span>' : '') +
        '</span>';
    }
    return '<span class="state"><i class="dot stopped"></i><small>已停止</small></span>';
  }

  function portCell(p) {
    var links = p.portLinks || [];
    var tips = [];
    if (p.livePorts && p.livePorts.length) tips.push('服务端口：' + p.livePorts.join('、'));
    if (p.hiddenPorts && p.hiddenPorts.length) tips.push('已折叠（内部 / 管理端口）：' + p.hiddenPorts.join('、'));
    if (p.claimedPort) tips.push('本记录认领：' + (p.claimedHost || '*') + ':' + p.claimedPort);
    if (p.startedAt) tips.push('启动于：' + p.startedAt);
    var tip = esc(tips.join('\n'));

    // 地址不是 127.0.0.1 时把地址一起显示 —— 否则双栈下两个 5173 根本分不清
    var portTxt = p.port ? (p.host === '::1' ? '[::1]:' + p.port : String(p.port)) : '';
    var primaryLink = p.port
      ? links.filter(function (l) { return l.port === p.port && (!p.host || l.host === p.host); })[0] || null
      : null;

    var html;
    if (!p.port) {
      html = '<span class="dim">—</span>';
    } else if (primaryLink) {
      html = '<a class="port hot portlink" href="' + esc(primaryLink.url) + '" target="_blank" rel="noopener" ' +
        'title="在新标签页打开 ' + esc(primaryLink.url) + '">' + esc(portTxt) + '</a>';
    } else {
      html = '<span class="port" title="' + tip + '">' + esc(portTxt) + '</span>';
    }

    // 「+N」= 除主端口外还有几个端口可以直接打开
    var moreCount = links.length - (primaryLink ? 1 : 0);
    if (moreCount > 0) html += '<i class="more portmore" title="点开看全部端口">+' + moreCount + '</i>';
    return html;
  }

  function nameCell(p) {
    var html = '<b>' + esc(p.name) + '</b>';
    if (p.verify === 'unverified') {
      html += '<span class="badge warn" title="平台重启后认回这个进程，但 ps 不可用，没能校验它的身份">未校验</span>';
    }
    if (p.portStale) {
      html += '<span class="badge warn" title="登记时钉的 ' + esc(p.claimLabel) +
        ' 现在已经没人在监听了，多半是服务换了端口。点「编辑」重钉一下，否则导入去重认不出它">端口已变</span>';
    }
    if (p.stopCommand) html += '<span class="badge" title="停止命令：' + esc(p.stopCommand) + '">自定义停止</span>';
    if (p.logSource === 'external') html += '<span class="badge" title="日志文件：' + esc(p.logPath || '') + '">项目日志</span>';
    (p.tags || []).forEach(function (t) { html += '<span class="badge tag">' + esc(t) + '</span>'; });

    // 异常退出：把 lastError 直接摆出来，不用去翻日志才知道为什么挂
    if (p.status === 'error' && p.lastError) {
      html += '<div class="errline" title="' + esc(p.lastError) + '">' + esc(p.lastError) + '</div>';
    }
    return html;
  }

  function actBtn(act, label, disabled, busyAct) {
    var isBusy = busyAct === act;
    var cls = 'mini' + (act === 'del' ? ' danger' : '');
    return '<button class="' + cls + '" data-act="' + act + '"' +
      (disabled || busyAct ? ' disabled' : '') + '>' +
      (isBusy ? '<span class="spin"></span>' : '') + label + '</button>';
  }

  function actionsCell(p) {
    var busyAct = state.busy[p.id] || '';
    return '<div class="actions">' +
      actBtn('start', busyAct === 'start' ? '启动中' : '启动', p.status === 'running', busyAct) +
      actBtn('stop', busyAct === 'stop' ? '停止中' : '停止', p.status !== 'running', busyAct) +
      actBtn('restart', busyAct === 'restart' ? '重启中' : '重启', false, busyAct) +
      actBtn('logs', '日志', false, '') +
      actBtn('edit', '编辑', false, busyAct) +
      actBtn('del', '删除', false, busyAct) +
      '</div>';
  }

  var CELLS = [
    { key: 'state' },
    { key: 'name', cls: 'col-name' },
    { key: 'port', cls: 'portcell' },
    { key: 'pid', cls: 'mono dim col-pid' },
    { key: 'mem', cls: 'mono dim col-mem' },
    { key: 'cwd', cls: 'mono dim col-cwd' },
    { key: 'actions' }
  ];

  function cellsFor(p) {
    var dir = p.cwd || '';
    return {
      state: stateCell(p),
      name: nameCell(p),
      port: portCell(p),
      pid: p.pid || '—',
      mem: fmtMem(p.memory),
      cwd: '<div class="truncate copyable" data-copy="' + esc(dir) + '" title="点击复制：' + esc(dir) + '">' + esc(dir) + '</div>',
      actions: actionsCell(p)
    };
  }

  // 建一次 td 骨架，之后只改 innerHTML
  function ensureSkeleton(tr) {
    if (tr._cell) return;
    var html = CELLS.map(function (c) {
      return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + ' data-c="' + c.key + '"></td>';
    }).join('');
    tr.innerHTML = html;
    tr._cell = {};
    tr._cache = {};
    CELLS.forEach(function (c) { tr._cell[c.key] = tr.querySelector('[data-c="' + c.key + '"]'); });
  }

  function paintRow(tr, p) {
    ensureSkeleton(tr);
    var parts = cellsFor(p);
    for (var i = 0; i < CELLS.length; i++) {
      var k = CELLS[i].key;
      if (tr._cache[k] !== parts[k]) {      // ★ 只有变了才写 DOM
        tr._cache[k] = parts[k];
        tr._cell[k].innerHTML = parts[k];
      }
    }
  }

  // ================================================================== 列表渲染

  function applyFilter(all) {
    var q = state.search.trim().toLowerCase();
    return all.filter(function (p) {
      var f = state.filter;
      if (f === 'running' && !(p.status === 'running' || p.external || p.orphan)) return false;
      if (f === 'error' && p.status !== 'error') return false;
      if (f === 'stopped' && (p.status !== 'stopped' || p.external || p.orphan)) return false;
      if (!q) return true;
      var hay = [p.name, p.cwd, p.command, p.port, p.claimedPort, (p.tags || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function clearSkeleton() {
    skelRows.forEach(function (tr) { if (tr.parentNode) tr.parentNode.removeChild(tr); });
    skelRows = [];
  }

  function render() {
    var all = state.projects;
    var list = applyFilter(all);

    var running = all.filter(function (p) { return p.status === 'running'; }).length;
    var errs = all.filter(function (p) { return p.status === 'error'; }).length;
    var stat = $('stat');
    stat.textContent = '共 ' + all.length + ' 个项目 · ' + running + ' 个运行中' + (errs ? ' · ' + errs + ' 个异常' : '');
    stat.classList.remove('err');

    clearSkeleton();

    var empty = $('empty');
    if (list.length) {
      empty.style.display = 'none';
    } else {
      empty.style.display = 'block';
      empty.innerHTML = all.length
        ? '没有匹配「' + esc(state.search.trim()) + '」的项目。试试清空搜索或切回「全部」。'
        : '还没有项目。点右上角「新建项目」，粘贴一条以 <code>cd /绝对路径 &amp;&amp;</code> 开头的启动命令。';
    }

    var tbody = $('rows');
    var seen = {};

    list.forEach(function (p, i) {
      var tr = state.rows[p.id];
      if (!tr) {
        tr = document.createElement('tr');
        tr.setAttribute('data-id', p.id);
        state.rows[p.id] = tr;
      }
      paintRow(tr, p);
      seen[p.id] = 1;
      var cur = tbody.children[i];
      if (cur !== tr) tbody.insertBefore(tr, cur || null);
    });

    // 回收已消失的行
    Object.keys(state.rows).forEach(function (id) {
      if (seen[id]) return;
      var el = state.rows[id];
      if (el.parentNode) el.parentNode.removeChild(el);
      delete state.rows[id];
    });

    // 浮层锚点如果被回收了，顺手把浮层收起来，免得飘在错的位置
    if (portPopAnchor && !document.contains(portPopAnchor)) closePortPop();
  }

  function showSkeleton() {
    var tbody = $('rows');
    var html = '';
    for (var i = 0; i < 4; i++) {
      html += '<tr class="skrow">' +
        '<td><div class="sk w1"></div></td>' +
        '<td><div class="sk w2"></div></td>' +
        '<td><div class="sk w3"></div></td>' +
        '<td class="col-pid"><div class="sk w4"></div></td>' +
        '<td class="col-mem"><div class="sk w4"></div></td>' +
        '<td class="col-cwd"><div class="sk w5"></div></td>' +
        '<td><div class="sk w6"></div></td>' +
        '</tr>';
    }
    tbody.innerHTML = html;
    skelRows = Array.prototype.slice.call(tbody.children);
  }

  function load(silent) {
    return api('/api/projects').then(function (d) {
      state.projects = d.projects || [];
      state.loaded = true;
      render();
    }).catch(function (e) {
      var stat = $('stat');
      stat.textContent = '加载失败：' + e.message;
      stat.classList.add('err');
      // 首屏就没连上：别把骨架屏永远留在那儿
      if (!state.loaded) {
        clearSkeleton();
        $('empty').innerHTML = '连不上 dev-hub 服务：' + esc(e.message) +
          '<br><span class="dim">确认平台还在运行，然后点右上角「刷新」。</span>';
        $('empty').style.display = 'block';
      }
      if (!silent) toast('加载失败', e.message, 'err');
    });
  }

  function poll() {
    if (document.hidden) return;      // 页面在后台，不刷
    if (anyModalOpen()) return;       // 弹窗开着，不刷（别跟用户正在编辑的表单抢）
    load(true);
  }

  // ================================================================== 端口浮层

  var portPop = document.createElement('div');
  portPop.id = 'portPop';
  document.body.appendChild(portPop);

  var KIND_LABEL = { service: '服务', infra: '中间件', mgmt: '管理端口' };

  function closePortPop() {
    portPop.classList.remove('open');
    portPopAnchor = null;
  }

  function showPortPop(anchor, p) {
    var links = p.portLinks || [];
    if (!links.length) return;
    portPop.innerHTML =
      '<div class="hd">' + esc(p.name) + ' · 点端口在新标签页打开</div>' +
      links.map(function (l) {
        return '<div class="row">' +
          '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
          esc(l.host === '127.0.0.1' ? String(l.port) : '[' + l.host + ']:' + l.port) + '</a>' +
          '<span class="c">' + esc(l.cmd || '') + '</span>' +
          '<span class="k">' + esc(KIND_LABEL[l.kind] || '') + '</span>' +
          '</div>';
      }).join('');

    portPopAnchor = anchor;
    portPop.classList.add('open');
    var r = anchor.getBoundingClientRect();
    var w = portPop.offsetWidth;
    var h = portPop.offsetHeight;
    var left = Math.min(r.left - 40, window.innerWidth - w - 12);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    portPop.style.left = Math.max(12, left) + 'px';
    portPop.style.top = Math.max(12, top) + 'px';
  }

  // ================================================================== 行操作

  $('rows').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr');
    var id = tr && tr.getAttribute('data-id');

    // 点「+N」→ 弹出全部端口，每个都能直接打开
    var more = ev.target.closest('.portmore');
    if (more && id) {
      var mp = state.projects.find(function (x) { return x.id === id; });
      if (mp) showPortPop(more, mp);
      return;
    }

    closePortPop();

    // 点工作目录 → 复制
    var cp = ev.target.closest('.copyable');
    if (cp) {
      copyText(cp.getAttribute('data-copy') || '', cp, '已复制工作目录');
      return;
    }

    var btn = ev.target.closest('button[data-act]');
    if (!btn || !id) return;
    var act = btn.getAttribute('data-act');
    var p = state.projects.find(function (x) { return x.id === id; });
    if (!p) return;

    if (act === 'logs') return openLog(p);
    if (act === 'edit') return openEdit(p);

    if (act === 'del') {
      return confirmDialog({
        title: '从列表移除',
        body: '确定把「<b>' + esc(p.name) + '</b>」从列表里移除吗？<br>' +
          '<span class="dim">只移除登记记录，<b>不会</b>停止正在运行的进程。需要停止请先点「停止」。</span>',
        okText: '移除',
        danger: true
      }).then(function (yes) {
        if (!yes) return;
        return api('/api/projects/' + id, { method: 'DELETE' })
          .then(function () { toast('已移除', p.name, 'ok'); return load(true); })
          .catch(function (e) { toast('移除失败', e.message, 'err'); });
      });
    }

    if (act === 'start' || act === 'stop' || act === 'restart') {
      state.busy[id] = act;
      render();
      api('/api/projects/' + id + '/' + act, { method: 'POST' })
        .then(function (r) {
          delete state.busy[id];
          if (act === 'stop') {
            var how = r.via === 'script' ? '（按停止命令）' : r.via === 'script+kill' ? '（停止命令 + 强制）' : '';
            toast('已停止', p.name + how, 'ok');
            if (r.warning) toast('注意', r.warning, 'warn');
          } else if (r.adopted) {
            // 「接管」的准确含义是「平台没启动它，只是认了它的 PID」——
            // 必须说清楚，否则用户会以为「点了启动却没生效」（已经踩过两次）。
            toast('服务本来就在跑', r.message || (p.name + ' 已在运行，平台接管了它的 PID（来源标为「外部启动」）'), 'warn');
            if (r.warning) toast('注意', r.warning, 'warn');
          } else {
            toast(act === 'start' ? '已启动' : '已重启', p.name + (r.pid ? ' · PID ' + r.pid : ''), 'ok');
          }
          (r.warnings || []).forEach(function (w) { toast('注意', w, 'warn'); });
          return load(true);
        })
        .catch(function (e) {
          delete state.busy[id];
          toast(e.data && e.data.portConflict ? '端口冲突' : '操作失败', e.message, 'err');
          return load(true);
        });
    }
  });

  // ================================================================== 新建 / 编辑

  function openNew() {
    state.editingId = null;
    $('editTitle').textContent = '新建项目';
    $('fCommand').value = '';
    $('fName').value = '';
    $('fName').placeholder = '';
    $('fTags').value = '';
    $('fPort').value = '';
    $('fHost').value = '';
    $('fEnv').value = '';
    $('fStop').value = '';
    $('fLogFile').value = '';
    $('parseHint').innerHTML = '';
    $('portHint').innerHTML = '';
    $('maskEdit').classList.remove('hidden');
    $('fCommand').focus();
  }

  function openEdit(p) {
    state.editingId = p.id;
    $('editTitle').textContent = '编辑：' + p.name;
    $('fCommand').value = p.command || '';
    $('fName').value = p.name || '';
    $('fTags').value = (p.tags || []).join(', ');
    $('fPort').value = p.port || '';
    $('fHost').value = p.host || '';
    $('fEnv').value = Object.keys(p.env || {}).map(function (k) { return k + '=' + p.env[k]; }).join('\n');
    $('fStop').value = p.stopCommand || '';
    $('fLogFile').value = p.logFile || '';
    $('parseHint').innerHTML = '';
    $('portHint').innerHTML = '';
    $('maskEdit').classList.remove('hidden');
    doParse();
  }

  function envFromText(text) {
    var env = {};
    String(text || '').split('\n').forEach(function (line) {
      var i = line.indexOf('=');
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      if (k) env[k] = line.slice(i + 1);
    });
    return env;
  }

  function tagsFromText(text) {
    return String(text || '').split(/[,，、]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; }).slice(0, 8);
  }

  // 列出该目录下正在监听的服务端口，点一下钉住本记录要用的那个。
  // 唯一键是「地址 + 端口」，所以标签上带地址 —— 双栈下 127.0.0.1:5173 和 [::1]:5173 是两条不同的记录。
  function renderPortChips(cwd, pinnedPort, pinnedHost) {
    var box = $('portHint');
    box.innerHTML = '';
    if (!cwd) return;
    api('/api/ports/by-cwd', { method: 'POST', body: JSON.stringify({ cwd: cwd }) })
      .then(function (d) {
        var svc = d.services || [];
        if (!svc.length) return;

        var head = document.createElement('span');
        head.textContent = pinnedPort
          ? '本记录认领：' + (pinnedHost || '*') + ':' + pinnedPort + '。改认领请点下面：'
          : '该目录下有 ' + svc.length + ' 个服务端口在跑，点一下钉住本记录要用的那个：';
        box.appendChild(head);
        box._head = head;

        svc.forEach(function (s) {
          var hostVal = s.bindHost === '*' ? '' : s.host || '';
          var on = String(pinnedPort) === String(s.port) && (pinnedHost || '') === hostVal;
          var label = (s.bindHost === '*' ? '*' : s.host) + ':' + s.port;

          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (on ? ' on' : '');
          b.setAttribute('data-port', s.port);
          b.setAttribute('data-host', hostVal);
          b.title = s.bindHost === '*'
            ? '绑在所有地址上（127.0.0.1 和 ::1 都能访问）'
            : '只绑在 ' + s.host + ' 上';
          b.innerHTML = esc(label) + '<i>' + esc(s.cmd) + '</i>';
          box.appendChild(b);
        });
      })
      .catch(function () {});
  }

  function doParse() {
    var cmd = $('fCommand').value;
    if (!cmd.trim()) { $('parseHint').innerHTML = ''; $('portHint').innerHTML = ''; return Promise.resolve(null); }
    return api('/api/cmd/parse', { method: 'POST', body: JSON.stringify({ command: cmd }) })
      .then(function (r) {
        if (!r.ok) {
          $('parseHint').innerHTML = '<span class="bad">✗ ' + esc(r.error) + '</span>';
          $('portHint').innerHTML = '';
          return null;
        }
        var html = '<span class="ok">✓ 执行目录：<span class="mono">' + esc(r.cwd) + '</span></span>';
        if (!r.exists) html += '<span class="warn">⚠ 该目录当前不存在</span>';
        if (r.port) html += '<span class="dim">· 从命令里解析到端口 ' + r.port + '（启动后会自动校准）</span>';
        $('parseHint').innerHTML = html;
        if (!$('fName').value) $('fName').placeholder = r.name || '';
        renderPortChips(r.cwd, $('fPort').value, $('fHost').value);
        return r;
      })
      .catch(function (e) {
        $('parseHint').innerHTML = '<span class="bad">✗ 解析失败：' + esc(e.message) + '</span>';
        return null;
      });
  }

  $('fCommand').addEventListener('input', function () {
    clearTimeout(state.parseTimer);
    state.parseTimer = setTimeout(doParse, 260);
  });

  // 点端口标签 → 钉住 / 取消（同时钉地址和端口）
  $('portHint').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-port]');
    if (!b) return;
    var p = b.getAttribute('data-port');
    var h = b.getAttribute('data-host') || '';
    var same = $('fPort').value === p && ($('fHost').value || '') === h;
    $('fPort').value = same ? '' : p;
    $('fHost').value = same ? '' : h;
    syncChips();
  });

  function syncChips() {
    Array.prototype.forEach.call($('portHint').querySelectorAll('.chip'), function (c) {
      c.classList.toggle('on',
        c.getAttribute('data-port') === $('fPort').value &&
        (c.getAttribute('data-host') || '') === ($('fHost').value || ''));
    });
  }

  // 手动改端口号 = 放弃已钉的地址（地址交给启动后自动探测）
  $('fPort').addEventListener('input', function () {
    $('fHost').value = '';
    Array.prototype.forEach.call($('portHint').querySelectorAll('.chip'), function (c) { c.classList.remove('on'); });
  });

  $('btnNew').addEventListener('click', openNew);
  $('fTags').addEventListener('input', function () {
    var n = tagsFromText($('fTags').value).length;
    $('fTags').title = n ? '将保存 ' + n + ' 个标签' : '';
  });

  function saveEdit() {
    var payload = {
      command: $('fCommand').value,
      name: $('fName').value,
      tags: tagsFromText($('fTags').value),
      port: $('fPort').value ? Number($('fPort').value) : null,
      host: $('fHost').value,
      env: envFromText($('fEnv').value),
      stopCommand: $('fStop').value,
      logFile: $('fLogFile').value
    };
    var btn = $('btnSave');
    btn.disabled = true;
    var req = state.editingId
      ? api('/api/projects/' + state.editingId, { method: 'PUT', body: JSON.stringify(payload) })
      : api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    req.then(function () {
      $('maskEdit').classList.add('hidden');
      toast(state.editingId ? '已保存' : '已创建', payload.name || '', 'ok');
      return load(true);
    }).catch(function (e) {
      toast('保存失败', e.message, 'err');
    }).then(function () { btn.disabled = false; });
  }

  $('btnSave').addEventListener('click', saveEdit);

  // 表单里按回车 = 保存（textarea 除外，那里回车要换行）
  $('maskEdit').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
      ev.preventDefault();
      saveEdit();
    }
  });

  // ================================================================== 确认弹窗

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      var params = opts || {};
      var prev = document.activeElement;   // 关掉之后把焦点还回去，别丢在 <body> 上
      var ok = $('cfOk');
      var cancel = $('cfCancel');
      $('cfTitle').textContent = params.title || '确认';
      $('cfBody').innerHTML = params.body || '';
      ok.textContent = params.okText || '确定';
      ok.className = params.danger ? 'danger-solid' : 'primary';
      $('maskConfirm').classList.remove('hidden');

      var done = function (v) {
        $('maskConfirm').classList.add('hidden');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onNo);
        document.removeEventListener('keydown', onKey);
        if (prev && prev.focus && document.contains(prev)) prev.focus();
        resolve(v);
      };
      var onOk = function () { done(true); };
      var onNo = function () { done(false); };
      var onKey = function (ev) {
        if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
        else if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onNo);
      document.addEventListener('keydown', onKey);
      ok.focus();
    });
  }

  // ================================================================== 工具栏：搜索 / 筛选 / 批量

  $('search').addEventListener('input', function () {
    state.search = $('search').value;
    render();
  });

  $('filters').addEventListener('click', function (ev) {
    var b = ev.target.closest('.segbtn');
    if (!b) return;
    state.filter = b.getAttribute('data-filter');
    Array.prototype.forEach.call($('filters').children, function (x) { x.classList.toggle('on', x === b); });
    render();
  });

  function setBatchHint(t) { $('batchHint').textContent = t || ''; }

  function batchAction(act) {
    if (state.batch) return;
    var targets = act === 'start'
      ? state.projects.filter(function (p) { return p.status !== 'running' && !p.external && !p.orphan; })
      : state.projects.filter(function (p) { return p.status === 'running'; });

    if (!targets.length) {
      return toast('没有可' + (act === 'start' ? '启动' : '停止') + '的项目', '', 'warn');
    }

    var run = function () {
      state.batch = true;
      $('btnStartAll').disabled = true;
      $('btnStopAll').disabled = true;
      targets.forEach(function (p) { state.busy[p.id] = act; });
      setBatchHint('0 / ' + targets.length);
      render();

      var done = 0, ok = 0;
      var fails = [];
      var next = function (i) {
        if (i >= targets.length) {
          state.batch = false;
          targets.forEach(function (p) { delete state.busy[p.id]; });
          setBatchHint('');
          $('btnStartAll').disabled = false;
          $('btnStopAll').disabled = false;
          render();
          toast(act === 'start' ? '批量启动完成' : '批量停止完成',
            ok + ' 个成功' + (fails.length ? '，' + fails.length + ' 个失败：' + fails[0].name + ' — ' + fails[0].msg : ''),
            fails.length ? 'err' : 'ok');
          return load(true);
        }
        var p = targets[i];
        api('/api/projects/' + p.id + '/' + act, { method: 'POST' })
          .then(function () { ok++; })
          .catch(function (e) { fails.push({ name: p.name, msg: e.message }); })
          .then(function () {
            delete state.busy[p.id];
            done++;
            setBatchHint(done + ' / ' + targets.length);
            render();
            next(i + 1);
          });
      };
      next(0);
    };

    if (act === 'stop') {
      confirmDialog({
        title: '全部停止',
        body: '将停止 <b>' + targets.length + '</b> 个正在运行的项目。<br>' +
          '<span class="dim">平台启动的会杀掉整个进程组；外部启动的（接管来的）也会被停止。</span>',
        okText: '全部停止',
        danger: true
      }).then(function (yes) { if (yes) run(); });
      return;
    }
    run();
  }

  $('btnStartAll').addEventListener('click', function () { batchAction('start'); });
  $('btnStopAll').addEventListener('click', function () { batchAction('stop'); });

  // ================================================================== 扫描导入

  $('btnScan').addEventListener('click', function () {
    var btn = $('btnScan');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>扫描中…';
    api('/api/scan', { method: 'POST' }).then(function (d) {
      scanList = (d.candidates || []).map(function (c) {
        return {
          pick: !c.duplicate,
          name: c.name,
          port: c.port,
          command: c.suggestedCommand,
          pid: c.pid,
          pgid: c.pgid,
          duplicate: c.duplicate,
          duplicateReason: c.duplicateReason || '',
          portClash: c.portClash || [],
          commandReliable: c.commandReliable
        };
      });
      renderScan();
      $('maskScan').classList.remove('hidden');
    }).catch(function (e) {
      toast('扫描失败', e.message, 'err');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '扫描当前运行的服务';
    });
  });

  function renderScan() {
    $('scanEmpty').style.display = scanList.length ? 'none' : 'block';
    $('scanRows').innerHTML = scanList.map(function (c, i) {
      return '<tr data-i="' + i + '">' +
        '<td><input type="checkbox" data-f="pick" ' + (c.pick ? 'checked' : '') + ' /></td>' +
        '<td><input data-f="name" value="' + esc(c.name) + '" />' +
          (c.duplicate
            ? '<span class="badge warn dup" title="' + esc(c.duplicateReason) + '">' +
              (c.portClash && c.portClash.length ? '端口已占用' : '已登记') + '</span>'
            : '') +
          (c.commandReliable ? '' : '<span class="badge warn">命令待补全</span>') + '</td>' +
        '<td><input data-f="port" value="' + esc(c.port == null ? '' : c.port) + '" /></td>' +
        '<td><input class="mono" data-f="command" value="' + esc(c.command) + '" /></td>' +
        '</tr>';
    }).join('');
    syncScanAll();
    updateScanCount();
  }

  function syncScanAll() {
    var n = scanList.filter(function (c) { return c.pick; }).length;
    var box = $('scanAll');
    box.checked = n > 0 && n === scanList.length;
    box.indeterminate = n > 0 && n < scanList.length;
  }

  function updateScanCount() {
    var n = scanList.filter(function (c) { return c.pick; }).length;
    $('scanCount').textContent = '已选 ' + n + ' / ' + scanList.length;
  }

  $('scanAll').addEventListener('change', function () {
    var v = $('scanAll').checked;
    // 已被别的记录认领的候选不允许勾选（后端也会跳过，这里先拦住省得白跑）
    scanList.forEach(function (c) { c.pick = v; });
    Array.prototype.forEach.call($('scanRows').querySelectorAll('input[data-f="pick"]'), function (x) { x.checked = v; });
    updateScanCount();
  });

  $('scanRows').addEventListener('input', function (ev) {
    var el = ev.target;
    var f = el.getAttribute('data-f');
    if (!f) return;
    var tr = el.closest('tr');
    var i = Number(tr.getAttribute('data-i'));
    if (!scanList[i]) return;
    scanList[i][f] = f === 'pick' ? el.checked : el.value;
    if (f === 'pick') { updateScanCount(); syncScanAll(); }
  });

  $('btnImport').addEventListener('click', function () {
    var items = scanList.filter(function (c) { return c.pick; }).map(function (c) {
      return { name: c.name, command: c.command, port: c.port ? Number(c.port) : null, pid: c.pid, pgid: c.pgid };
    });
    if (!items.length) return toast('没有选中任何项', '', 'warn');
    var btn = $('btnImport');
    btn.disabled = true;
    api('/api/import', { method: 'POST', body: JSON.stringify({ items: items }) }).then(function (d) {
      var res = d.results || [];
      var ok = res.filter(function (r) { return r.ok; }).length;
      var skipped = res.filter(function (r) { return !r.ok && r.skipped; });
      var bad = res.filter(function (r) { return !r.ok && !r.skipped; });
      var detail = [];
      if (skipped.length) detail.push(skipped.length + ' 条因端口已被认领而跳过（' + skipped[0].error + '）');
      if (bad.length) detail.push(bad.length + ' 条失败：' + bad[0].error);
      toast('已导入 ' + ok + ' 个项目', detail.join('；'), bad.length ? 'err' : skipped.length ? 'warn' : 'ok');
      $('maskScan').classList.add('hidden');
      return load(true);
    }).catch(function (e) {
      toast('导入失败', e.message, 'err');
    }).then(function () { btn.disabled = false; });
  });

  // ================================================================== 日志抽屉

  function openLog(p) {
    log.id = p.id;
    log.name = p.name;
    log.offset = 0;
    log.follow = true;
    log.warned = false;
    log.lines = 0;
    log.external = p.logSource === 'external';
    $('logTitle').textContent = p.name + (log.external ? ' · 项目日志文件' : '');
    $('logPath').textContent = p.logPath || p.cwd || '';
    $('logMeta').textContent = p.logSize ? fmtSize(p.logSize) : '';
    $('logText').textContent = '';
    $('logTrim').classList.add('hidden');
    $('btnFollow').textContent = '自动滚动：开';
    $('btnClearLog').disabled = log.external;
    $('btnClearLog').title = log.external ? '这是项目自己的日志文件，平台不主动清空' : '清空平台抓取的日志';
    $('drawer').classList.add('open');
    pollLog(true);
    clearInterval(log.timer);
    log.timer = setInterval(pollLog, 1000);
  }

  function countNewlines(s) {
    var n = 0, i = -1;
    while ((i = String(s).indexOf('\n', i + 1)) !== -1) n++;
    return n;
  }

  // 从头部裁掉多余的节点，让抽屉里最多剩 LOG_MAX_LINES 行。
  // 不裁的话，长跑服务几小时后 pre 里几万行，滚动和内存都顶不住。
  function trimLog() {
    var pre = $('logText');
    var nodes = Array.prototype.slice.call(pre.childNodes);
    var counts = nodes.map(function (n) { return countNewlines(n.textContent || n.nodeValue || ''); });
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (total <= LOG_MAX_LINES) return;

    var drop = total - LOG_MAX_LINES;
    for (var i = 0; i < nodes.length && drop > 0; i++) {
      var c = counts[i];
      if (c <= drop) {
        drop -= c;
        pre.removeChild(nodes[i]);
      } else {
        // 这个节点要从中间切开，保留后半段
        var rest = String(nodes[i].textContent || '').split('\n').slice(drop).join('\n');
        pre.removeChild(nodes[i]);
        pre.insertBefore(document.createTextNode(rest), pre.firstChild);
        drop = 0;
      }
    }
    log.lines = LOG_MAX_LINES;
    $('logTrim').classList.remove('hidden');
  }

  function pollLog(force) {
    if (!log.id) return;
    if (document.hidden && !force) return;   // 后台标签页不刷；但刚点开日志的那一次必须取
    var id = log.id;
    api('/api/projects/' + id + '/logs?offset=' + log.offset).then(function (d) {
      if (log.id !== id) return;                 // 期间切了项目，丢弃这次结果
      if (d.exists === false && !log.warned) {
        log.warned = true;
        $('logText').textContent = '（日志文件还不存在：' + (d.file || '') + '）\n';
      }
      if (d.data) {
        var body = $('logBody');
        var near = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
        $('logText').appendChild(document.createTextNode(d.data));
        log.lines += countNewlines(d.data);
        if (log.lines > LOG_TRIM_AT) trimLog();
        if (log.follow || near) body.scrollTop = body.scrollHeight;
      }
      if (d.size != null) $('logMeta').textContent = fmtSize(d.size);
      if (d.offset != null) log.offset = d.offset;
    }).catch(function () { /* 忽略瞬时错误 */ });
  }

  function closeLog() {
    $('drawer').classList.remove('open');
    clearInterval(log.timer);
    log.timer = null;
    log.id = null;
    log.lines = 0;
  }

  $('btnCloseLog').addEventListener('click', closeLog);
  $('btnFollow').addEventListener('click', function () {
    log.follow = !log.follow;
    $('btnFollow').textContent = '自动滚动：' + (log.follow ? '开' : '关');
    if (log.follow) $('logBody').scrollTop = $('logBody').scrollHeight;
  });

  $('btnClearLog').addEventListener('click', function () {
    if (!log.id) return;
    var id = log.id;
    confirmDialog({
      title: '清空日志',
      body: '清空「<b>' + esc(log.name) + '</b>」的平台日志？<br><span class="dim">此操作不可撤销。项目之后的新输出会继续写进来。</span>',
      okText: '清空',
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      return api('/api/projects/' + id + '/logs/clear', { method: 'POST' })
        .then(function () {
          $('logText').textContent = '';
          $('logTrim').classList.add('hidden');
          log.offset = 0;
          log.lines = 0;
          toast('日志已清空', log.name, 'ok');
        })
        .catch(function (e) { toast('清空失败', e.message, 'err'); });
    });
  });

  $('btnDownloadLog').addEventListener('click', function () {
    if (log.id) window.open('/api/projects/' + log.id + '/logs/download', '_blank');
  });

  $('btnFullLog').addEventListener('click', function () {
    var d = $('drawer');
    d.classList.toggle('full');
    $('btnFullLog').textContent = d.classList.contains('full') ? '还原' : '全屏';
  });

  // ================================================================== 全局交互

  document.addEventListener('click', function (ev) {
    if (!ev.target || !ev.target.closest) return;
    var c = ev.target.closest('[data-close]');
    if (c) $(c.getAttribute('data-close')).classList.add('hidden');
    // 点别处收起端口弹出层
    if (!ev.target.closest('#portPop') && !ev.target.closest('.portmore')) closePortPop();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      // 确认弹窗自己处理 Esc（stopPropagation 拦不住同一个 document 上的其它监听器，
      // 不在这里提前返回的话，从抽屉里弹出的确认框一按 Esc 会把背后的抽屉一起关掉）
      if (!$('maskConfirm').classList.contains('hidden')) return;
      // 搜索框里按 Esc = 清空并失焦
      if (document.activeElement === $('search')) {
        $('search').value = '';
        state.search = '';
        $('search').blur();
        render();
        return;
      }
      if (portPop.classList.contains('open')) return closePortPop();
      if ($('drawer').classList.contains('open')) return closeLog();
      $('maskEdit').classList.add('hidden');
      $('maskScan').classList.add('hidden');
      return;
    }
    // ⌘K / Ctrl+K 聚焦搜索
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      $('search').focus();
      $('search').select();
    }
  });

  // 弹窗内 Tab 循环，别把焦点丢到背后的页面上
  ['maskEdit', 'maskScan', 'maskConfirm'].forEach(function (id) {
    $(id).addEventListener('keydown', function (ev) {
      if (ev.key !== 'Tab') return;
      var f = Array.prototype.filter.call(
        this.querySelectorAll('button, input, textarea, select, a[href]'),
        function (el) { return !el.disabled && el.offsetParent !== null; }
      );
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
  });

  // 弹出层是 fixed 定位，滚动 / 改窗口大小后就对不上位置了，直接收起
  window.addEventListener('scroll', closePortPop, true);
  window.addEventListener('resize', closePortPop);

  $('btnRefresh').addEventListener('click', function () { load(false); });

  // 页面从后台切回来时立刻刷一次（后台时是不刷的）
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { load(true); if (log.id) pollLog(); }
  });

  setInterval(poll, POLL_MS);

  showSkeleton();
  load(true);
})();
