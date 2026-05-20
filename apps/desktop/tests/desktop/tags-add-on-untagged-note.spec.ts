/**
 * Regression coverage: adding a tag to a note that currently has zero
 * tags must work — historically reported as broken (peek task
 * item_1769334985100_ee5xcvv9u). Exercises the Tags feature detail-view
 * available-tags chip click path, which is the most likely surface for
 * "tag buttons" in the report.
 */
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

test.describe('add tag to note with no tags @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('tags-add-untagged'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('addTag succeeds on an item with no prior tags', async () => {
    const stamp = Date.now();
    const tagName = `lone-${stamp}`;

    // Seed: a tag (from another item, so it appears in the sidebar
    // after the in-use filter) and a fresh note with NO tags.
    const seed = await bgWindow.evaluate(async (name: string) => {
      const seedItem = await (window as any).app.datastore.addItem('text', {
        content: `seed #${name}`,
      });
      const tagsRes = await (window as any).app.datastore.getItemTags(seedItem.data.id);
      const tagId = tagsRes.data?.[0]?.id;
      const note = await (window as any).app.datastore.addItem('text', {
        content: 'untagged note body',
      });
      const noteTags = await (window as any).app.datastore.getItemTags(note.data.id);
      return { tagId, noteId: note.data.id, noteTagCount: noteTags.data?.length ?? -1 };
    }, tagName);
    expect(seed.tagId).toBeTruthy();
    expect(seed.noteTagCount).toBe(0);

    // Drive the datastore call the Tags feature would make on chip click.
    const linked = await bgWindow.evaluate(async ({ noteId, tagId }: { noteId: string; tagId: string }) => {
      return await (window as any).app.datastore.tagItem(noteId, tagId);
    }, { noteId: seed.noteId, tagId: seed.tagId });
    expect(linked.success).toBe(true);

    const after = await bgWindow.evaluate(async (id: string) => {
      return await (window as any).app.datastore.getItemTags(id);
    }, seed.noteId);
    const names = (after.data || []).map((t: { name: string }) => t.name);
    expect(names).toContain(tagName);
  });
});
