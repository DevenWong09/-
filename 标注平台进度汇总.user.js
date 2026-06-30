// ==UserScript==
// @name         [SCRIPT_NAME]
// @namespace    https://[DOMAIN]/
// @version      3.8.0
// @description  主要是统计一些网页数据进度的，比如标注平台
// @author       Devenwong
// @match        https://[DOMAIN]/project/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    LIST_API: '/api/[PATH]',
    PROGRESS_API: '/api/[PATH]',
    THIRD_API: '/api/[PATH]',
    STAT_OBJECTS: ['total_num', 'labeled_num', 'deliver_reviewing_num', 'finished_num'],
    CONCURRENCY: 5,
    PAGE_SIZE: 50,
  };

  function getProjectId() {
    const match = location.pathname.match(/\/project\/(\d+)\//);
    return match ? match[1] : null;
  }

  async function post(url, body) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  async function batchRequest(tasks, concurrency, fn) {
    const results = [];
    let index = 0;
    async function worker() {
      while (index < tasks.length) {
        const i = index++;
        try { results[i] = await fn(tasks[i], i); }
        catch (err) { results[i] = { error: err.message, task: tasks[i] }; }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function fetchDict(projectId) {
    const dict = {};
    try {
      const res = await post(CONFIG.THIRD_API, {
        page_id: 1, page_size: 100, project_id: [projectId]
      });
      if (res.code === 0 && res.data && res.data.items) {
        res.data.items.forEach(item => { dict[String(item.id)] = item.name; });
      }
    } catch (err) { console.warn("[SCRIPT_NAME] [ERROR_MSG]", err); }
    return dict;
  }

  // [COMMENT]
  function resolveOwner(taskInfo, lt, dynamicDict) {
    const possibleIds = [
      lt._id, taskInfo._id, lt._id2, taskInfo._id2,
      ...(lt._ids || []), ...(taskInfo._ids || [])
    ];

    // [COMMENT]
    for (const id of possibleIds) {
      if (!id || String(id) === "1" || String(id) === "0") continue;
      const strId = String(id);
      if (dynamicDict[strId] && dynamicDict[strId] !== '[BLACKLIST]') {
        return { id: `[PREFIX]_${strId}`, name: dynamicDict[strId] };
      }
    }

    const possibleNames = [lt._name, taskInfo._name, taskInfo._name2];
    for (const name of possibleNames) {
      if (name && name !== '[BLACKLIST]' && name !== '[DEFAULT_TEAM]') {
         const validId = possibleIds.find(id => id && String(id) !== "1" && String(id) !== "0");
         if (validId) return { id: `[PREFIX]_${validId}`, name: name };
      }
    }

    // [COMMENT]
    const teamId = lt._teamId || taskInfo._teamId;
    const teamName = lt._teamName || taskInfo._teamName;
    if (teamId && String(teamId) !== "0" && teamName && teamName !== '[DEFAULT_TEAM]') {
      return { id: `[PREFIX]_${teamId}`, name: teamName };
    }

    return { id: "[UNASSIGNED]", name: "[UNASSIGNED_LABEL]" };
  }

  async function fetchAllTasks(projectId, onProgress, ownerDict) {
    const allTasks = [];
    let pageId = 1;
    while (true) {
      onProgress?.(`[STATUS] ${pageId} [STATUS]`);
      const res = await post(CONFIG.LIST_API, {
        task_creator: '', order_creator: '', import_task_id: '', supplier_id: '',
        task_status_list: [], order_task_id_list: [], team_id: null,
        submit: Date.now(), project_id: projectId, task_type: 2,
        page_id: pageId, page_size: CONFIG.PAGE_SIZE, task_id_list: [], task_name_list: [],
      });
      if (res.code !== 0) throw new Error(`[ERROR]: ${res.message}`);
      const taskList = res.data?.task_info_list || [];
      if (taskList.length === 0) break;
      for (const taskInfo of taskList) {
        const labelTasks = taskInfo.label_task_list || [];
        for (const lt of labelTasks) {
          // [COMMENT]
          const ownerInfo = resolveOwner(taskInfo, lt, ownerDict);

          allTasks.push({
            taskId: lt.task_id,
            taskName: lt.task_name,
            ownerId: ownerInfo.id, // [COMMENT]
            ownerName: ownerInfo.name, // [COMMENT]
            projectTaskId: lt.project_task_id,
          });
        }
      }
      if (taskList.length < CONFIG.PAGE_SIZE) break;
      pageId++;
    }
    return allTasks;
  }

  async function fetchProgress(task, projectId) {
    const res = await post(CONFIG.PROGRESS_API, {
      project_id: projectId, task_id: task.taskId, stat_object: CONFIG.STAT_OBJECTS,
    });
    if (res.code !== 0) throw new Error(`[ERROR]: ${res.message}`);
    return res.data;
  }

  async function aggregate(onProgress, onDetail) {
    const projectId = getProjectId();
    if (!projectId) throw new Error('[ERROR]');

    onProgress?.('[STATUS]');
    const ownerDict = await fetchDict(projectId);

    onProgress?.('[STATUS]');
    const tasks = await fetchAllTasks(projectId, onProgress, ownerDict);
    onProgress?.(`[STATUS] ${tasks.length} [STATUS]`);

    if (tasks.length === 0) return { tasks: [], summary: {}, ownerSummary: {}, details: [], errorCount: 0 };

    let completed = 0;
    const details = await batchRequest(tasks, CONFIG.CONCURRENCY, async (task, idx) => {
      const progress = await fetchProgress(task, projectId);
      completed++;
      onProgress?.(`[STATUS] ${completed}/${tasks.length}`);
      onDetail?.(task, progress, idx);
      return { task, progress };
    });

    const summary = {
        total_num: 0, labeled_num: 0, wait_label_num: 0, deliver_reviewing_num: 0, finished_num: 0,
        idToNameMap: {} // [COMMENT]
    };
    const ownerSummary = {};
    let errorCount = 0;

    for (const item of details) {
      if (item.error) { errorCount++; continue; }
      const p = item.progress;

      const ownerId = item.task.ownerId;
      const ownerName = item.task.ownerName;

      // [COMMENT]
      if (!summary.idToNameMap[ownerId]) {
          summary.idToNameMap[ownerId] = ownerName;
      }

      summary.total_num += p.total_num || 0;
      summary.labeled_num += p.labeled_num || 0;
      summary.wait_label_num += p.wait_label_num || 0;
      summary.deliver_reviewing_num += p.deliver_reviewing_num || 0;
      summary.finished_num += p.finished_num || 0;

      // [COMMENT]
      if (!ownerSummary[ownerId]) {
        ownerSummary[ownerId] = { total_num: 0, labeled_num: 0, wait_label_num: 0, deliver_reviewing_num: 0, finished_num: 0 };
      }
      ownerSummary[ownerId].total_num += p.total_num || 0;
      ownerSummary[ownerId].labeled_num += p.labeled_num || 0;
      ownerSummary[ownerId].wait_label_num += p.wait_label_num || 0;
      ownerSummary[ownerId].deliver_reviewing_num += p.deliver_reviewing_num || 0;
      ownerSummary[ownerId].finished_num += p.finished_num || 0;
    }

    return { tasks, summary, ownerSummary, details, errorCount };
  }

  // [COMMENT]
  const STYLES = `
    .tm-progress-btn { position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border: none; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
    .tm-progress-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
    .tm-progress-btn.loading { opacity: 0.8; cursor: wait; }
    .tm-progress-panel { position: fixed; right: 24px; bottom: 80px; z-index: 2147483647; width: 720px; max-height: 85vh; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0, 0, 0, 0.15); display: none; flex-direction: column; overflow: hidden; font-family: -apple-system, sans-serif; }
    .tm-progress-panel.show { display: flex; }
    .tm-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
    .tm-panel-header h3 { margin: 0; font-size: 16px; font-weight: 600; }
    .tm-panel-close { background: rgba(255,255,255,0.2); border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; }
    .tm-panel-status { padding: 12px 20px; font-size: 13px; color: #666; border-bottom: 1px solid #f0f0f0; background: #fafbfc; }
    .tm-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .tm-summary-card { background: #f8f9ff; border-radius: 10px; padding: 12px 10px; text-align: center; }
    .tm-summary-card .label { font-size: 12px; color: #888; margin-bottom: 4px; white-space: nowrap;}
    .tm-summary-card .value { font-size: 20px; font-weight: 700; color: #333; }
    .tm-summary-card.owner .value { color: #2563eb; font-size: 16px; padding-top:2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;}
    .tm-summary-card.total .value { color: #667eea; }
    .tm-summary-card.labeled .value { color: #f59e0b; }
    .tm-summary-card.reviewing .value { color: #8b5cf6; }
    .tm-summary-card.finished .value { color: #10b981; }
    .tm-summary-card.waiting .value { color: #ef4444; }
    .tm-detail-section { padding: 12px 20px 8px; font-size: 13px; font-weight: 600; color: #555; background: #fafbfc; border-bottom: 1px solid #f0f0f0;}
    .tm-detail-table-wrap { overflow-y: auto; padding: 0 20px 16px; }

    /* [COMMENT] */
    .tm-detail-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
    .tm-detail-table th, .tm-detail-table td { padding: 8px 6px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tm-detail-table th:first-child, .tm-detail-table td:first-child { text-align: left; width: 40%; }
    .tm-detail-table th:nth-child(2), .tm-detail-table td:nth-child(2) { width: 12%; }
    .tm-detail-table th:nth-child(3), .tm-detail-table td:nth-child(3) { width: 12%; }
    .tm-detail-table th:nth-child(4), .tm-detail-table td:nth-child(4) { width: 12%; }
    .tm-detail-table th:nth-child(5), .tm-detail-table td:nth-child(5) { width: 12%; }
    .tm-detail-table th:nth-child(6), .tm-detail-table td:nth-child(6) { width: 12%; }
    .tm-detail-table th { position: sticky; top: 0; background: #f8f9fa; color: #666; font-weight: 600; border-bottom: 2px solid #e9ecef; }

    .tm-error-row td { color: #ef4444 !important; }
    .tm-copy-btn { margin: 0 20px 16px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px; color: #555; text-align: center; transition: all 0.2s;}
    .tm-copy-btn:hover { background: #f0f0f0; }
  `;

  function formatNum(n) { return n.toLocaleString('zh-CN'); }

  let lastResult = null;

  function initUI() {
    // [COMMENT]
    document.querySelectorAll('.tm-progress-btn, .tm-progress-panel, style[id^="tm-style-"]').forEach(el => el.remove());

    const style = document.createElement('style');
    style.id = 'tm-style-' + Date.now();
    style.textContent = STYLES;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'tm-progress-btn';
    btn.innerHTML = '<span class="icon">[ICON]</span><span>[BTN_LABEL]</span>';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'tm-progress-panel';
    panel.innerHTML = `
      <div class="tm-panel-header"><h3>[PANEL_TITLE]</h3><button class="tm-panel-close">✕</button></div>
      <div class="tm-panel-status">[STATUS_HINT]</div>
      <div class="tm-summary-grid" style="display:none;"></div>

      <div class="tm-detail-section tm-owner-title" style="display:none;">[SECTION_TITLE]</div>
      <div class="tm-detail-table-wrap tm-owner-wrap" style="display:none; min-height: 140px; max-height: 250px; margin-bottom: 10px;">
        <table class="tm-detail-table">
          <thead><tr><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th></tr></thead>
          <tbody class="tm-owner-body"></tbody>
        </table>
      </div>

      <div class="tm-detail-section tm-detail-title" style="display:none;">[SECTION_TITLE]</div>
      <div class="tm-detail-table-wrap tm-detail-wrap" style="display:none; flex: 1;">
        <table class="tm-detail-table">
          <thead><tr><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th><th>[COL]</th></tr></thead>
          <tbody class="tm-detail-body"></tbody>
        </table>
      </div>
      <button class="tm-copy-btn" style="display:none;">[BTN_LABEL]</button>
    `;
    document.body.appendChild(panel);

    const ui = {
      btn, panel,
      status: panel.querySelector('.tm-panel-status'),
      summary: panel.querySelector('.tm-summary-grid'),
      ownerTitle: panel.querySelector('.tm-owner-title'),
      ownerWrap: panel.querySelector('.tm-owner-wrap'),
      ownerBody: panel.querySelector('.tm-owner-body'),
      detailTitle: panel.querySelector('.tm-detail-title'),
      detailWrap: panel.querySelector('.tm-detail-wrap'),
      detailBody: panel.querySelector('.tm-detail-body'),
      copyBtn: panel.querySelector('.tm-copy-btn')
    };

    panel.querySelector('.tm-panel-close').addEventListener('click', () => panel.classList.remove('show'));

    btn.addEventListener('click', async () => {
      panel.classList.toggle('show');
      if (panel.classList.contains('show') && !btn.classList.contains('loading')) {
        await runAggregation(ui);
      }
    });

    ui.copyBtn.addEventListener('click', () => {
        if (!lastResult) return;
        const s = lastResult.summary;
        const ownerSum = lastResult.ownerSummary;

        const ownerNames = Object.values(s.idToNameMap).filter(name => !name.includes('[FILTER]') && !name.includes('[FILTER]'));
        let ownerText = ownerNames.length > 0 ? `[FORMAT](${ownerNames.join('、')})` : '[DEFAULT]';

        let lines = [
          `[TITLE]（[COUNT_LABEL] ${lastResult.tasks.length} [COUNT_LABEL]）`,
          `————————————————`,
          `[LABEL]:  ${ownerText}`,
          `[LABEL]:     ${formatNum(s.total_num)}`,
          `[LABEL]: ${formatNum(s.labeled_num)}`,
          `[LABEL]: ${formatNum(s.wait_label_num)}`,
          `[LABEL]:  ${formatNum(s.deliver_reviewing_num)}`,
          `[LABEL]:${formatNum(s.finished_num)}`,
          ``,
          `[LABEL]: ${(s.total_num > 0 ? (s.labeled_num / s.total_num * 100).toFixed(2) : 0)}%`,
          `[LABEL]: ${(s.total_num > 0 ? (s.finished_num / s.total_num * 100).toFixed(2) : 0)}%`,
          `\n[SECTION_TITLE]：`,
          `————————————————`
        ];

        const sortedIds = Object.entries(ownerSum).sort((a, b) => b[1].total_num - a[1].total_num);
        for (const [vId, stats] of sortedIds) {
           const dName = s.idToNameMap[vId];
           lines.push(`- ${dName}: [FORMAT] ${formatNum(stats.total_num)} | [FORMAT] ${formatNum(stats.labeled_num)} | [FORMAT] ${formatNum(stats.wait_label_num)} | [FORMAT] ${formatNum(stats.deliver_reviewing_num)} | [FORMAT] ${formatNum(stats.finished_num)}`);
        }

        navigator.clipboard.writeText(lines.join('\n')).then(() => {
          ui.copyBtn.textContent = '[BTN_DONE]';
          setTimeout(() => { ui.copyBtn.textContent = '[BTN_LABEL]'; }, 2000);
        });
    });
  }

  async function runAggregation(ui) {
    ui.btn.classList.add('loading');
    ui.btn.innerHTML = '<span class="icon">[ICON]</span><span>[BTN_LABEL]</span>';
    ui.summary.style.display = 'none'; ui.ownerTitle.style.display = 'none'; ui.ownerWrap.style.display = 'none';
    ui.detailTitle.style.display = 'none'; ui.detailWrap.style.display = 'none'; ui.copyBtn.style.display = 'none';

    let taskHtml = '';
    let ownerHtml = '';

    try {
      const result = await aggregate(
        (msg) => { ui.status.textContent = msg; },
        (task, progress) => {
          if (progress.error) {
            taskHtml += `<tr class="tm-error-row"><td title="${task.taskName}">${task.taskName}</td><td colspan="5">[ERROR_LABEL]</td></tr>`;
          } else {
            taskHtml += `
              <tr>
                <td title="${task.taskName}"><span style="color:#888; font-size:10px;">[${task.ownerName}]</span><br/>${task.taskName}</td>
                <td style="color:#667eea;">${formatNum(progress.total_num || 0)}</td>
                <td style="color:#f59e0b;">${formatNum(progress.labeled_num || 0)}</td>
                <td style="color:#ef4444;">${formatNum(progress.wait_label_num || 0)}</td>
                <td style="color:#8b5cf6;">${formatNum(progress.deliver_reviewing_num || 0)}</td>
                <td style="color:#10b981;">${formatNum(progress.finished_num || 0)}</td>
              </tr>
            `;
          }
        }
      );

      lastResult = result;
      const s = result.summary;
      const ownerSum = result.ownerSummary;

      ui.detailBody.innerHTML = taskHtml;

      const sortedIds = Object.entries(ownerSum).sort((a, b) => b[1].total_num - a[1].total_num);

      if (sortedIds.length === 0) {
         ownerHtml = '<tr><td colspan="6" style="text-align:center; color:#999; padding: 16px;">[EMPTY_HINT]</td></tr>';
      } else {
         for (const [vId, stats] of sortedIds) {
           const dName = s.idToNameMap[vId];
           ownerHtml += `
             <tr>
               <td title="${dName}"><b>${dName}</b></td>
               <td style="color:#667eea;">${formatNum(stats.total_num)}</td>
               <td style="color:#f59e0b;">${formatNum(stats.labeled_num)}</td>
               <td style="color:#ef4444;">${formatNum(stats.wait_label_num)}</td>
               <td style="color:#8b5cf6;">${formatNum(stats.deliver_reviewing_num)}</td>
               <td style="color:#10b981;">${formatNum(stats.finished_num)}</td>
             </tr>
           `;
         }
      }
      ui.ownerBody.innerHTML = ownerHtml;

      const ownerNames = Object.values(s.idToNameMap).filter(name => !name.includes('[FILTER]') && !name.includes('[FILTER]'));
      let ownerText = '[DEFAULT]';
      if (ownerNames.length === 1) ownerText = ownerNames[0];
      else if (ownerNames.length > 1) ownerText = `[FORMAT]`;

      ui.summary.innerHTML = `
        <div class="tm-summary-card owner" title="${ownerNames.join('、')}"><div class="label">[LABEL]</div><div class="value">${ownerText}</div></div>
        <div class="tm-summary-card total"><div class="label">[LABEL]</div><div class="value">${formatNum(s.total_num)}</div></div>
        <div class="tm-summary-card labeled"><div class="label">[LABEL]</div><div class="value">${formatNum(s.labeled_num)}</div></div>
        <div class="tm-summary-card waiting"><div class="label">[LABEL]</div><div class="value">${formatNum(s.wait_label_num)}</div></div>
        <div class="tm-summary-card reviewing"><div class="label">[LABEL]</div><div class="value">${formatNum(s.deliver_reviewing_num)}</div></div>
        <div class="tm-summary-card finished"><div class="label">[LABEL]</div><div class="value">${formatNum(s.finished_num)}</div></div>
      `;

      const errorMsg = result.errorCount > 0 ? `[FORMAT](${result.errorCount} [FORMAT])` : '';
      ui.status.textContent = `[STATUS_DONE] ${result.tasks.length} [STATUS] ${errorMsg}`;

      ui.summary.style.display = 'grid';
      ui.ownerTitle.style.display = 'block'; ui.ownerWrap.style.display = 'block';
      ui.detailTitle.style.display = 'block'; ui.detailWrap.style.display = 'block';
      ui.copyBtn.style.display = 'block';

    } catch (err) {
      ui.status.textContent = `[ERROR]: ${err.message}`;
    } finally {
      ui.btn.classList.remove('loading'); ui.btn.innerHTML = '<span class="icon">[ICON]</span><span>[BTN_LABEL]</span>';
    }
  }

  if (document.readyState === 'complete') initUI();
  else window.addEventListener('load', initUI);
})();