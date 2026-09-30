import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('bake-off labeling @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let tile: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('bake-off-labeling'));
    const opened = await bgWindow.evaluate(async () => {
      return await (window as any).app.window.open('peek://bake-off-labeling/home.html', {
        role: 'workspace',
        key: 'bake-off-labeling',
        width: 1100,
        height: 800,
      });
    });
    expect(opened.success).toBe(true);
    tile = await app.getWindow('bake-off-labeling/home.html', 10_000);
    await tile.waitForLoadState('domcontentloaded');
    await tile.locator('body[data-ready="true"]').waitFor({ timeout: 10_000 });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('opens and supports all three labeling workflows and export payloads', async () => {
    await expect(tile.locator('h1')).toHaveText('Bake-off labelling');

    await tile.evaluate(() => {
      (window as any).__bakeOffLabelingTest.setTaskItems([
        { id: 'page-1', type: 'url', title: 'Research page', content: 'https://example.test/research', createdAt: 10, lastVisitAt: 20 },
        { id: 'note-1', type: 'text', title: 'Loose note', content: 'Not part of a task', createdAt: 11, lastVisitAt: 0 },
      ]);
    });
    await tile.locator('#taskLabel').locator('input').fill('Research');
    await tile.locator('#createTaskButton').click();
    await tile.locator('peek-card[data-item-id="page-1"] input[type="checkbox"]').check();
    await tile.locator('#assignTaskButton').click();

    const taskPayload = await tile.evaluate(() => (window as any).__bakeOffLabelingTest.buildTaskPayload());
    expect(taskPayload).toEqual({
      generatedAt: expect.any(String),
      range: { since: expect.any(Number), until: expect.any(Number) },
      tasks: [{ id: expect.any(String), label: 'Research', itemIds: ['page-1'] }],
      unassignedItemIds: ['note-1'],
      items: [
        { id: 'page-1', type: 'url', title: 'Research page', url: 'https://example.test/research', content: 'https://example.test/research', createdAt: 10, lastVisitAt: 20 },
        { id: 'note-1', type: 'text', title: 'Loose note', url: null, content: 'Not part of a task', createdAt: 11, lastVisitAt: 0 },
      ],
    });

    await tile.evaluate(() => {
      (window as any).__bakeOffLabelingTest.replaceRangeTaskItems([
        { id: 'note-1', type: 'text', title: 'Loose note', content: 'Not part of a task', createdAt: 11 },
      ]);
    });
    const reloadedTaskPayload = await tile.evaluate(() => (window as any).__bakeOffLabelingTest.buildTaskPayload());
    expect(reloadedTaskPayload.tasks).toEqual([{ id: expect.any(String), label: 'Research', itemIds: [] }]);
    expect(reloadedTaskPayload.unassignedItemIds).toEqual(['note-1']);
    expect(reloadedTaskPayload.items.map((item: { id: string }) => item.id)).toEqual(['note-1']);

    await tile.locator('peek-button-group-item[value="entities"]').click();
    await tile.evaluate(() => {
      (window as any).__bakeOffLabelingTest.setEntityItems([
        { id: 'note-entity', type: 'text', title: 'People note', content: 'Ada Lovelace met Charles Babbage in London.' },
      ]);
    });
    await tile.locator('peek-card[data-item-id="note-entity"]').click();
    await expect(tile.locator('#entityText')).toContainText('Ada Lovelace');
    await tile.evaluate(() => {
      const text = document.querySelector('#entityText')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 'Ada Lovelace'.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await tile.locator('#tagEntityButton').click();
    await expect(tile.locator('.entity-span')).toContainText('person: “Ada Lovelace”');

    const entityPayload = await tile.evaluate(() => (window as any).__bakeOffLabelingTest.buildEntityPayload());
    expect(entityPayload).toEqual({
      generatedAt: expect.any(String),
      items: [{
        itemId: 'note-entity',
        type: 'text',
        url: null,
        text: 'Ada Lovelace met Charles Babbage in London.',
        entities: [{ type: 'person', span: 'Ada Lovelace', start: 0, end: 12 }],
      }],
    });

    await tile.locator('peek-button-group-item[value="routing"]').click();
    await tile.locator('#utterance').fill('Find my recent notes and open the first result');
    await tile.locator('#toolSelect').locator('select').selectOption('list_items');
    await tile.locator('#toolArgs').fill('{"type":"text"}');
    await tile.locator('#addCallButton').click();
    await tile.locator('#toolSelect').locator('select').selectOption('get_item');
    await tile.locator('#toolArgs').fill('{"id":"first-result"}');
    await tile.locator('#addCallButton').click();
    await expect(tile.locator('.pending-call')).toHaveCount(2);
    await tile.locator('#addCaseButton').click();

    await tile.locator('#utterance').fill('Book me a flight');
    await tile.evaluate(() => (document.querySelector('#refusalToggle') as any).toggle());
    await expect(tile.locator('#toolSelect')).toHaveAttribute('disabled', '');
    await tile.locator('#addCaseButton').click();
    await expect(tile.locator('.routing-case')).toHaveCount(2);
    await expect(tile.locator('.routing-case').nth(1)).toContainText('refusal');

    const routingPayload = await tile.evaluate(() => (window as any).__bakeOffLabelingTest.buildRoutingPayload());
    expect(routingPayload).toEqual({
      generatedAt: expect.any(String),
      cases: [
        {
          utterance: 'Find my recent notes and open the first result',
          expectedCalls: [
            { tool: 'list_items', args: { type: 'text' } },
            { tool: 'get_item', args: { id: 'first-result' } },
          ],
          refusal: false,
        },
        { utterance: 'Book me a flight', expectedCalls: [], refusal: true },
      ],
    });
  });
});
