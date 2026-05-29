(function () {
  function getCookie(name) {
    var cookieValue = null;
    if (document.cookie && document.cookie !== "") {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i += 1) {
        var cookie = cookies[i].trim();
        if (cookie.substring(0, name.length + 1) === (name + "=")) {
          cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
          break;
        }
      }
    }
    return cookieValue;
  }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
  var state = { tasks: [], selected: {}, loading: false, error: "", message: "" };
  function close() {
    var b = document.getElementById('soft-tools-mosaic-backdrop');
    var m = document.getElementById('soft-tools-mosaic-modal');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }
  function render() {
    close();
    var backdrop = document.createElement('div');
    backdrop.id = 'soft-tools-mosaic-backdrop';
    backdrop.className = 'soft-tools-mosaic-modal-backdrop';
    backdrop.addEventListener('click', close);
    var modal = document.createElement('div');
    modal.id = 'soft-tools-mosaic-modal';
    modal.className = 'soft-tools-mosaic-modal';
    var rows = '';
    if (state.loading) rows = '<p>Завантаження задач...</p>';
    else if (state.error) rows = '<div class="alert alert-warning">' + esc(state.error) + '</div>';
    else if (!state.tasks.length) rows = '<div class="alert alert-info">Не знайдено готових задач з orthophoto.tif.</div>';
    else rows = state.tasks.map(function(t, i){
      return '<div class="soft-tools-mosaic-task-row" data-task-id="' + esc(t.id) + '">' +
        '<input type="checkbox" data-mosaic-check="' + esc(t.id) + '" ' + (state.selected[t.id] ? 'checked' : '') + '>' +
        '<div><div class="soft-tools-mosaic-task-title">' + esc(t.task_name || ('Task ' + t.id)) + '</div>' +
        '<div class="soft-tools-mosaic-task-meta">' + esc(t.project_name || '') + ' · ID ' + esc(t.id) + '</div></div>' +
        '<div class="soft-tools-mosaic-order"><button class="btn btn-xs btn-default" data-up="' + i + '">↑</button><button class="btn btn-xs btn-default" data-down="' + i + '">↓</button></div>' +
      '</div>';
    }).join('');
    modal.innerHTML = '<div class="soft-tools-mosaic-modal-header"><h4>Об’єднання ортофото</h4><button class="btn btn-default" id="soft-tools-mosaic-close">×</button></div>' +
      '<div class="soft-tools-mosaic-modal-body">' + rows + (state.message ? '<div class="alert alert-info">' + esc(state.message) + '</div>' : '') + '</div>' +
      '<div class="soft-tools-mosaic-modal-footer"><button class="btn btn-default" id="soft-tools-mosaic-refresh">Оновити</button><button class="btn btn-primary" id="soft-tools-mosaic-create">Створити об’єднане ортофото</button></div>';
    document.body.appendChild(backdrop); document.body.appendChild(modal);
    document.getElementById('soft-tools-mosaic-close').onclick = close;
    document.getElementById('soft-tools-mosaic-refresh').onclick = loadTasks;
    document.getElementById('soft-tools-mosaic-create').onclick = createMosaic;
    Array.prototype.forEach.call(modal.querySelectorAll('[data-mosaic-check]'), function(ch){ ch.onchange=function(){ state.selected[this.getAttribute('data-mosaic-check')] = this.checked; }; });
    Array.prototype.forEach.call(modal.querySelectorAll('[data-up]'), function(btn){ btn.onclick=function(){ var i=Number(this.getAttribute('data-up')); if(i>0){ var x=state.tasks[i-1]; state.tasks[i-1]=state.tasks[i]; state.tasks[i]=x; render(); } }; });
    Array.prototype.forEach.call(modal.querySelectorAll('[data-down]'), function(btn){ btn.onclick=function(){ var i=Number(this.getAttribute('data-down')); if(i<state.tasks.length-1){ var x=state.tasks[i+1]; state.tasks[i+1]=state.tasks[i]; state.tasks[i]=x; render(); } }; });
  }
  function loadTasks() {
    state.loading = true; state.error = ''; state.message = ''; render();
    fetch('/plugins/Smartpoint/api/mosaic/tasks/', { credentials: 'same-origin' }).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error(t || 'Backend endpoint не відповідає'); });
      return r.json();
    }).then(function(j){
      state.tasks = j.tasks || [];
      state.tasks.forEach(function(t, i){ if (i < 2 && state.selected[t.id] === undefined) state.selected[t.id] = true; });
      state.loading = false; render();
    }).catch(function(e){ state.loading = false; state.error = e.message || String(e); render(); });
  }
  function createMosaic() {
    var layers = state.tasks.filter(function(t){ return state.selected[t.id]; }).map(function(t){ return { task_id: t.id, project_id: t.project_id }; });
    if (layers.length < 2) { state.message = 'Виберіть мінімум 2 ортофото.'; render(); return; }
    state.message = 'Відправка шарів на backend...'; render();
    fetch('/plugins/Smartpoint/api/mosaic/create/', { method: 'POST', credentials: 'same-origin', headers: {'Content-Type':'application/json','X-CSRFToken':getCookie('csrftoken')||''}, body: JSON.stringify({layers: layers}) }).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error(t || 'Create failed'); }); return r.json();
    }).then(function(j){ state.message = j.message || 'Запит виконано.'; render(); }).catch(function(e){ state.error = e.message || String(e); state.message=''; render(); });
  }
  window.SmartpointOrthophotoMosaic = { open: function(){ loadTasks(); } };
})();
