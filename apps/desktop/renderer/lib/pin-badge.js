/**
 * attachPinBadge — the small indicator a pinned window's own content draws,
 * per docs/design/window-rules.md "Persistent windows: workspace-pinned and
 * global HUD". Two visually distinct forms — workspace-scoped ("this goes
 * away if you switch workspaces") and cross-workspace ("this window follows
 * you everywhere") — each carrying the unpin control: the badge is the only
 * place an already-pinned window can unpin itself. Pinning a not-yet-pinned
 * window always goes through the command palette ("pin to this workspace" /
 * "pin across workspaces"), never the badge.
 *
 * Rendered by the tile itself (CSS in the tile's own stylesheet), not a
 * window-kernel property — see the design doc's "The badge" section.
 *
 * Consumers must declare `context:changed` in their manifest's pubsub.topics
 * allowlist and `pin` in `capabilities.context.read` (they already need
 * `write` too, to publish `cmd:execute:unpin window`'s target correctly via
 * the command, not directly).
 *
 * Usage: `attachPinBadge(window.app)` once the tile's DOM is ready.
 */
export function attachPinBadge(api) {
  if (!api?.context?.get || !api?.pubsub?.subscribe) {
    throw new Error('[pin-badge] api.context.get and api.pubsub.subscribe required');
  }

  let el = null;

  const render = (scope) => {
    if (!scope) {
      if (el) {
        el.remove();
        el = null;
      }
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'pin-badge';

      const label = document.createElement('span');
      label.className = 'pin-badge-label';
      el.appendChild(label);

      const unpinBtn = document.createElement('button');
      unpinBtn.className = 'pin-badge-unpin';
      unpinBtn.type = 'button';
      unpinBtn.title = 'Unpin';
      unpinBtn.setAttribute('aria-label', 'Unpin');
      unpinBtn.textContent = '×';
      unpinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        api.pubsub.publish('cmd:execute:unpin window', { search: '', params: [] });
      });
      el.appendChild(unpinBtn);

      document.body.appendChild(el);
    }
    el.dataset.scope = scope;
    el.querySelector('.pin-badge-label').textContent =
      scope === 'global' ? 'Pinned · every workspace' : 'Pinned · this workspace';
  };

  const refresh = async () => {
    try {
      const result = await api.context.get('pin', null);
      render(result?.data?.value || null);
    } catch (err) {
      console.error('[pin-badge] failed to read pin state:', err);
    }
  };

  api.pubsub.subscribe('context:changed', (msg) => {
    if (msg?.key === 'pin') refresh();
  });

  refresh();
}
