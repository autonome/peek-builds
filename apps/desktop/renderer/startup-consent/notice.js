// Classic script (not a module): file:// pages cannot load module scripts under
// this page's content security policy. The wording comes from the main process,
// which holds the canonical text.
(function () {
  'use strict';
  var bridge = window.startupConsent;
  var root = document.getElementById('notice');

  function el(tag, props, text) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (key) { node.setAttribute(key, props[key]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(notice) {
    root.textContent = '';
    var title = el('h1', { id: 'title', tabindex: '-1' }, notice.title);
    root.appendChild(title);
    notice.paragraphs.forEach(function (text) { root.appendChild(el('p', null, text)); });

    var fieldset = el('fieldset');
    fieldset.appendChild(el('legend', null, 'Confirm each statement to continue'));
    var boxes = notice.acknowledgments.map(function (text, index) {
      var row = el('div', { class: 'ack' });
      var box = el('input', { type: 'checkbox', id: 'ack-' + index });
      box.checked = false;
      row.appendChild(box);
      row.appendChild(el('label', { for: 'ack-' + index }, text));
      fieldset.appendChild(row);
      return box;
    });
    root.appendChild(fieldset);

    var error = el('p', { id: 'error', role: 'alert', 'aria-live': 'assertive' });
    root.appendChild(error);

    var actions = el('div', { class: 'actions' });
    var quit = el('button', { type: 'button', id: 'quit' }, notice.quit);
    var cont = el('button', { type: 'button', id: 'continue', class: 'primary' }, notice.continue);
    cont.disabled = true;
    actions.appendChild(quit);
    actions.appendChild(cont);
    root.appendChild(actions);

    function allChecked() {
      return boxes.every(function (box) { return box.checked; });
    }
    boxes.forEach(function (box) {
      box.addEventListener('change', function () { cont.disabled = !allChecked(); });
    });
    quit.addEventListener('click', function () { bridge.decide('decline'); });
    cont.addEventListener('click', function () {
      if (!allChecked()) return;
      error.textContent = '';
      bridge.decide('accept', boxes.map(function (box) { return box.checked; }));
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') bridge.decide('decline');
    });
    bridge.onError(function (message) { error.textContent = message; });

    // Nothing actionable is focused initially, so Enter cannot accept.
    title.focus();
  }

  if (!bridge) return;
  bridge.getNotice().then(function (notice) {
    if (notice && Array.isArray(notice.paragraphs)) render(notice);
  });
})();
