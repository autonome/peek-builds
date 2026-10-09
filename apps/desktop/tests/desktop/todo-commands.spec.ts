import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import {
  waitForExtensionsReady,
  waitForPanelCommandsLoaded,
  waitForCmdNotExecuting,
} from '../helpers/window-utils';

// ============================================================================
// Todo feature round trip through the cmd panel (@desktop)
//
//   todo <text> [#tags]  -> text item tagged `todo` (+ trailing tags, removed from the text)
//   todos                -> selection list of outstanding todos; Enter opens the editor
//   complete <match>     -> suggestion list of todos; Tab fills, Enter swaps `todo` for `done`
//   done                 -> selection list of finished todos; read-only
//
// Tests run in file order against one app: `complete` with no todos goes
// first, before any todo exists.
// ============================================================================

const PANEL_OPEN_OPTS = {
  modal: true,
  width: 600,
  height: 50,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  center: true,
};

test.describe('Todo commands via the cmd panel @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  const stamp = Date.now();

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('todo-cmds'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  async function openPanel(): Promise<{ cmdWindow: Page; panelId: number }> {
    const openResult = await bgWindow.evaluate(async (opts) => {
      return await (window as any).app.window.open('peek://cmd/panel.html', opts);
    }, PANEL_OPEN_OPTS);
    expect(openResult.success).toBe(true);

    const cmdWindow = await app.getWindow('cmd/panel.html', 5000);
    await cmdWindow.waitForSelector('input', { timeout: 5000 });
    await waitForPanelCommandsLoaded(cmdWindow, 10000);
    await cmdWindow.waitForFunction(
      () => {
        const s = (window as any)._cmdState;
        return s?.commands?.['todo'] && s.commands['todos'] && s.commands['done'] && s.commands['complete'];
      },
      undefined,
      { timeout: 15000 }
    );
    return { cmdWindow, panelId: openResult.id };
  }

  async function closePanel(panelId: number) {
    try {
      await bgWindow.evaluate(async (id: number) => {
        await (window as any).app.window.close(id);
      }, panelId);
    } catch {
      // Panel may already have closed itself after running a command.
    }
  }

  /** Type `text` into a fresh panel and press Enter; resolves once the command has finished. */
  async function runCommand(text: string) {
    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', text);
    await cmdWindow.keyboard.press('Enter');
    await waitForCmdNotExecuting(cmdWindow, 10000);
    await closePanel(panelId);
  }

  /** Every item (id, title, content, tag names) carrying `tagName`. */
  async function itemsWithTag(tagName: string) {
    return await bgWindow.evaluate(async (name: string) => {
      const api = (window as any).app;
      const tag = await api.datastore.getOrCreateTag(name);
      const res = await api.datastore.getItemsByTag(tag.data.tag.id);
      const out: any[] = [];
      for (const it of res.data || []) {
        const tags = await api.datastore.getItemTags(it.id);
        out.push({
          id: it.id,
          title: it.title,
          content: it.content,
          tags: (tags.data || []).map((t: { name: string }) => t.name),
        });
      }
      return out;
    }, tagName);
  }

  async function addTodo(text: string): Promise<string> {
    return await bgWindow.evaluate(async (t: string) => {
      const api = (window as any).app;
      const added = await api.datastore.addItem('text', { content: t });
      const tag = await api.datastore.getOrCreateTag('todo');
      await api.datastore.tagItem(added.data.id, tag.data.tag.id);
      return added.data.id as string;
    }, text);
  }

  test('complete with no todos changes nothing and the panel recovers', async () => {
    await runCommand(`complete nothing-${stamp}`);
    expect(await itemsWithTag('done')).toEqual([]);
    expect(await itemsWithTag('todo')).toEqual([]);
  });

  test('todos with no todos reports failure and opens nothing', async () => {
    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', 'todos');
    await cmdWindow.keyboard.press('Enter');
    expect(await waitForCmdNotExecuting(cmdWindow, 10000)).not.toBe('TIMEOUT');
    const items = await cmdWindow
      .evaluate(() => (window as any)._cmdState?.outputItems?.length ?? 0)
      .catch(() => 0);
    expect(items).toBe(0);
    await closePanel(panelId);
  });

  test('todo creates a text item tagged todo', async () => {
    const text = `plain todo ${stamp}`;
    await runCommand(`todo ${text}`);

    await expect.poll(async () => (await itemsWithTag('todo')).map((i) => i.content)).toContain(text);
    const item = (await itemsWithTag('todo')).find((i) => i.content === text)!;
    expect(item.tags).toEqual(['todo']);
  });

  test('todo moves trailing #tags off the text and onto the item', async () => {
    const body = `ship the release ${stamp}`;
    await runCommand(`todo ${body} #qa-${stamp} #urgent-${stamp}`);

    await expect.poll(async () => (await itemsWithTag(`qa-${stamp}`)).length).toBe(1);
    const item = (await itemsWithTag(`qa-${stamp}`))[0];
    expect(item.content).toBe(body);
    expect([...item.tags].sort()).toEqual([`qa-${stamp}`, 'todo', `urgent-${stamp}`].sort());
  });

  test('todo keeps a #tag in the middle of the text in the text', async () => {
    const body = `ask #bob-${stamp} about the invoice`;
    await runCommand(`todo ${body}`);

    await expect.poll(async () => (await itemsWithTag('todo')).map((i) => i.content)).toContain(body);
  });

  test('todo with only tags, or nothing, creates no item', async () => {
    const before = (await itemsWithTag('todo')).length;
    await runCommand(`todo #only-${stamp} #tags-${stamp}`);
    await runCommand('todo');
    await runCommand('todo    ');
    expect((await itemsWithTag('todo')).length).toBe(before);
    expect(await itemsWithTag(`only-${stamp}`)).toEqual([]);
  });

  test('todo keeps quotes, markup and unicode in the text', async () => {
    const body = `ship "it" & <b>ok</b> naïve ✓ ${stamp}`;
    await runCommand(`todo ${body} #odd-${stamp}`);

    await expect.poll(async () => (await itemsWithTag(`odd-${stamp}`)).length).toBe(1);
    const item = (await itemsWithTag(`odd-${stamp}`))[0];
    expect(item.content).toBe(body);
  });

  test('todos lists the outstanding todos and Enter opens the selected one in the editor', async () => {
    const outstanding = await itemsWithTag('todo');
    expect(outstanding.length).toBeGreaterThan(0);

    await bgWindow.evaluate(() => {
      (window as any).__editorOpen = null;
      (window as any).app.subscribe('editor:open', (msg: any) => {
        (window as any).__editorOpen = msg;
      });
    });

    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', 'todos');
    await cmdWindow.keyboard.press('Enter');

    await cmdWindow.waitForFunction(
      () => ((window as any)._cmdState?.outputItems?.length ?? 0) > 0,
      undefined,
      { timeout: 10000 }
    );
    const listed = await cmdWindow.evaluate(() =>
      ((window as any)._cmdState.outputItems as any[]).map((i) => i.id)
    );
    expect([...listed].sort()).toEqual(outstanding.map((i) => i.id).sort());
    const first = listed[0];

    await cmdWindow.keyboard.press('Enter');

    await bgWindow.waitForFunction(
      () => (window as any).__editorOpen !== null,
      undefined,
      { timeout: 10000 }
    );
    const opened = await bgWindow.evaluate(() => (window as any).__editorOpen);
    expect(opened.itemId).toBe(first);

    await closePanel(panelId);
    // Close any editor window the open produced.
    const list = await bgWindow.evaluate(async () => (window as any).app.window.list());
    for (const w of list.windows || []) {
      if (w.url && w.url.includes('editor')) {
        await bgWindow.evaluate(async (id: number) => (window as any).app.window.close(id), w.id);
      }
    }
  });

  test('complete picker: Tab fills the picked todo and Enter swaps todo for done', async () => {
    const title = `pick me ${stamp}`;
    const otherTitle = `leave me ${stamp}`;
    const pickedId = await addTodo(title);
    const otherId = await addTodo(otherTitle);

    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', 'complete pick me');

    await cmdWindow.waitForFunction(
      (t: string) => {
        const s = (window as any)._cmdState;
        return (s?.paramSuggestions || []).some((p: any) => p._item?.content === t);
      },
      title,
      { timeout: 10000 }
    );

    await cmdWindow.keyboard.press('Tab');
    await cmdWindow.waitForFunction(
      (t: string) => ((window as any)._cmdState?.typed || '').includes(t),
      title,
      { timeout: 5000 }
    );

    await cmdWindow.keyboard.press('Enter');
    await waitForCmdNotExecuting(cmdWindow, 10000);

    await expect.poll(async () => (await itemsWithTag('done')).map((i) => i.id)).toContain(pickedId);
    expect((await itemsWithTag('todo')).map((i) => i.id)).not.toContain(pickedId);
    // The other todo is untouched.
    expect((await itemsWithTag('todo')).map((i) => i.id)).toContain(otherId);
    expect((await itemsWithTag('done')).map((i) => i.id)).not.toContain(otherId);
    await closePanel(panelId);
  });

  test('complete with typed text and no pick marks the first match done', async () => {
    const id = await addTodo(`typed match ${stamp}`);
    await runCommand(`complete typed match ${stamp}`);

    await expect.poll(async () => (await itemsWithTag('done')).map((i) => i.id)).toContain(id);
    expect((await itemsWithTag('todo')).map((i) => i.id)).not.toContain(id);
  });

  test('complete with text that matches no todo leaves everything as it was', async () => {
    const todoBefore = (await itemsWithTag('todo')).map((i) => i.id).sort();
    const doneBefore = (await itemsWithTag('done')).map((i) => i.id).sort();
    await runCommand(`complete zzz-no-such-todo-${stamp}`);
    expect((await itemsWithTag('todo')).map((i) => i.id).sort()).toEqual(todoBefore);
    expect((await itemsWithTag('done')).map((i) => i.id).sort()).toEqual(doneBefore);
  });

  test('done lists the finished todos and marks nothing', async () => {
    const finished = (await itemsWithTag('done')).map((i) => i.id).sort();
    expect(finished.length).toBeGreaterThan(0);
    const todoBefore = (await itemsWithTag('todo')).map((i) => i.id).sort();

    const { cmdWindow, panelId } = await openPanel();
    await cmdWindow.fill('input', 'done');
    await cmdWindow.keyboard.press('Enter');

    // Same signal the `todos` test waits on: the panel's output selection list is populated.
    await cmdWindow.waitForFunction(
      () => ((window as any)._cmdState?.outputItems?.length ?? 0) > 0,
      undefined,
      { timeout: 10000 }
    );
    const listed = await cmdWindow.evaluate(() =>
      ((window as any)._cmdState.outputItems as any[]).map((i) => i.id)
    );
    expect([...listed].sort()).toEqual(finished);
    expect((await itemsWithTag('todo')).map((i) => i.id).sort()).toEqual(todoBefore);

    await closePanel(panelId);
  });
});
