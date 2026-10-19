# Page Widget Extensibility API

Extensions can hook into the page host lifecycle, execute content scripts in the page webview, and display widgets alongside the page content.

## Architecture

```
Extension (background.js)          Page Host (page.js)
  |                                   |
  |-- widget:register ------------->  | stores registration
  |<-- widget:registered ----------  | confirms
  |                                   |
  |<-- page:loaded ----------------  | page finishes loading
  |                                   |
  |-- page:execute-script --------->  | runs in webview
  |<-- page:script-result ---------  | returns result
  |                                   |
  |-- widget:render --------------->  | creates widget DOM
  |-- widget:update --------------->  | updates widget content
  |-- widget:close ---------------->  | removes widget
  |                                   |
  |<-- page:navigated -------------  | in-page navigation
  |<-- page:will-close ------------  | window closing
```

All communication uses the pubsub system (`window.app.publish` / `window.app.subscribe`) with `GLOBAL` scope.

## Pubsub Topics

### Extension to Page Host

#### `widget:register`

Register a widget type. Must be called before `widget:render`.

```js
api.publish('widget:register', {
  extensionId: 'my-extension',  // Required: your extension ID
  widgetId: 'my-widget',        // Required: unique widget ID within your extension
  title: 'My Widget',           // Optional: display title (defaults to widgetId)
  position: 'right',            // Optional: 'right' (default). Reserved: 'left', 'bottom'
}, api.scopes.GLOBAL);
```

Response: `widget:registered` is published with `{ extensionId, widgetId, success: true }`.

#### `widget:render`

Populate a registered widget with content. If the widget is already rendered, it is replaced.

```js
api.publish('widget:render', {
  extensionId: 'my-extension',
  widgetId: 'my-widget',
  title: 'Updated Title',       // Optional: overrides registration title
  html: '<p>Widget content</p>',// HTML string for the widget body
  autoDismiss: 0,               // Optional: auto-close after N ms (0 = never)
}, api.scopes.GLOBAL);
```

#### `widget:update`

Update an already-rendered widget's content or title without replacing the DOM element.

```js
api.publish('widget:update', {
  extensionId: 'my-extension',
  widgetId: 'my-widget',
  html: '<p>New content</p>',   // Optional: new body content
  title: 'New Title',           // Optional: new title
}, api.scopes.GLOBAL);
```

#### `widget:close`

Remove a widget from the page.

```js
api.publish('widget:close', {
  extensionId: 'my-extension',
  widgetId: 'my-widget',
}, api.scopes.GLOBAL);
```

#### `page:execute-script`

Execute JavaScript in the page's webview. Results are returned via `page:script-result`.

```js
api.publish('page:execute-script', {
  extensionId: 'my-extension',
  requestId: 'unique-request-id', // Required: correlate with response
  script: 'document.title',       // Required: JS code to execute
}, api.scopes.GLOBAL);
```

### Page Host to Extension

#### `page:loaded`

Published when a page finishes loading. Already existed before this API.

```js
api.subscribe('page:loaded', (msg) => {
  // msg.url - the loaded page URL
  // msg.title - the page title
  // msg.opensearchUrl - OpenSearch URL if detected
}, api.scopes.GLOBAL);
```

#### `page:navigated`

Published on in-page navigation (did-navigate).

```js
api.subscribe('page:navigated', (msg) => {
  // msg.url - the new URL
  // msg.title - the page title
}, api.scopes.GLOBAL);
```

#### `page:will-close`

Published when the page window is about to close.

```js
api.subscribe('page:will-close', (msg) => {
  // msg.url - the current page URL
}, api.scopes.GLOBAL);
```

#### `page:script-result`

Response to a `page:execute-script` request.

```js
api.subscribe('page:script-result', (msg) => {
  if (msg.requestId !== myRequestId) return; // correlate
  if (msg.success) {
    console.log('Result:', msg.result);
  } else {
    console.error('Error:', msg.error);
  }
}, api.scopes.GLOBAL);
```

#### `widget:registered`

Confirmation after `widget:register`.

#### `widget:closed`

Published when a widget is closed (by user clicking X, or via `widget:close`).

## Content Script Execution Pattern

The request/response pattern uses `requestId` for correlation:

```js
function executeScript(script, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = `${extensionId}-${Date.now()}-${Math.random()}`;
    let timer, unsub;

    unsub = api.subscribe('page:script-result', (msg) => {
      if (msg.requestId !== requestId) return;
      clearTimeout(timer);
      unsub();
      msg.success ? resolve(msg.result) : reject(new Error(msg.error));
    }, api.scopes.GLOBAL);

    timer = setTimeout(() => { unsub(); reject(new Error('Timeout')); }, timeout);

    api.publish('page:execute-script', {
      extensionId, requestId, script
    }, api.scopes.GLOBAL);
  });
}
```

## Widget Positioning

Widgets are placed in the widget container to the right of the page webview. They stack vertically with an 8px gap. Each widget has:

- A header with title and close button
- A body that accepts HTML content
- Max width of 280px, min width of 200px
- Glass-morphism background with backdrop blur

Widgets share the navbar show/hide lifecycle -- they are part of the page chrome.

## Sample Extension

See `apps/desktop/features/pagewidgets-sample/` for a complete working example that:

1. Registers a "Page Summary" widget on startup
2. Listens for `page:loaded` events
3. Executes a content script to extract page metadata (title, description, headings, word count, link count)
4. Renders the metadata in its widget
5. Updates on navigation, cleans up on page close

## Testing

### Unit tests

```bash
node --test tests/unit/page-widgets.test.js
```

Tests the `createPageWidgetHost` factory function with mock dependencies. Covers registration, rendering, update, close, content script execution, and lifecycle events.

### Playwright tests

```bash
BACKEND=electron yarn test:electron tests/desktop/page-widgets.spec.ts
```

End-to-end tests that open real page windows and verify widget registration, rendering, update, close, and content script execution through the full pubsub pipeline.
