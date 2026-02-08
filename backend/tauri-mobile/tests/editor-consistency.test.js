import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

describe('Editor overlay consistency', () => {
  it('all startEditing functions call keyboardPrimerRef.focus()', () => {
    // Find all startEditing function bodies and verify each calls keyboardPrimerRef
    const startEditingFns = ['startEditing', 'startEditingText', 'startEditingTagset', 'startEditingImage'];
    for (const fnName of startEditingFns) {
      // Match "const fnName = ..." through the next "const " or "//"
      const fnPattern = new RegExp(`const ${fnName} = [^]*?(?=\\n  const |\\n  \\/\\/)`, 's');
      const match = appSource.match(fnPattern);
      assert.ok(match, `Function ${fnName} not found`);
      assert.ok(
        match[0].includes('keyboardPrimerRef.current?.focus()'),
        `${fnName} must call keyboardPrimerRef.current?.focus()`
      );
    }
  });

  it('all EditorOverlay instances use text-editor-overlay class', () => {
    // Find all <EditorOverlay lines and verify they have className="text-editor-overlay"
    // Filter to editor overlays for saved items (exclude add-input overlay and component definition)
    const editorOverlayLines = appSource.split('\n').filter(line =>
      line.includes('<EditorOverlay') && !line.includes('AddInputExpanded') && !line.includes('addInputExpanded') && !line.includes('const EditorOverlay')
    );
    assert.ok(editorOverlayLines.length >= 4, `Expected at least 4 EditorOverlay instances, found ${editorOverlayLines.length}`);

    for (const line of editorOverlayLines) {
      assert.ok(
        line.includes('text-editor-overlay'),
        `EditorOverlay missing text-editor-overlay class: ${line.trim()}`
      );
    }
  });

  it('keyboardPrimerRef is defined and rendered', () => {
    assert.ok(
      appSource.includes('keyboardPrimerRef'),
      'keyboardPrimerRef must be defined'
    );
    assert.ok(
      appSource.includes('ref={keyboardPrimerRef}'),
      'keyboardPrimerRef must be rendered as a ref on an element'
    );
  });
});
