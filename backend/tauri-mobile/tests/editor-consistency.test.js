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

describe('Image editor content display', () => {
  // Extract the image editor overlay rendering function body
  const editorImageSection = (() => {
    // Find the renderEditingOverlay or similar section that handles image editing
    // The image editor is inside a block that checks editingImageId
    const imageEditorPattern = /editor-image-preview[^]*?EditorButtons/s;
    const match = appSource.match(imageEditorPattern);
    return match ? match[0] : '';
  })();

  it('image editor renders content when item.content is present', () => {
    // The image editor overlay should reference item.content
    assert.ok(
      editorImageSection.includes('item.content'),
      'Image editor overlay must reference item.content to display content text'
    );
    // Verify there is a conditional render for content
    assert.ok(
      editorImageSection.includes('item.content &&'),
      'Image editor must conditionally render content (item.content && ...)'
    );
  });

  it('image editor content is inside a scrollable wrapper (editor-image-scrollable)', () => {
    // The scrollable div must wrap the content and tags section
    assert.ok(
      editorImageSection.includes('editor-image-scrollable'),
      'Image editor must have editor-image-scrollable wrapper class'
    );
    // Verify the scrollable div comes before content and tags
    const scrollableIdx = editorImageSection.indexOf('editor-image-scrollable');
    const contentIdx = editorImageSection.indexOf('edit-image-content');
    const tagsSectionIdx = editorImageSection.indexOf('TagsSection');
    assert.ok(scrollableIdx < contentIdx,
      'editor-image-scrollable must appear before edit-image-content');
    assert.ok(scrollableIdx < tagsSectionIdx,
      'editor-image-scrollable must appear before TagsSection');
  });

  it('getUnifiedItems passes content field for image items', () => {
    // Find the getUnifiedItems function body
    const getUnifiedPattern = /const getUnifiedItems = \(\)[^]*?(?=\n  const \w+ = )/s;
    const match = appSource.match(getUnifiedPattern);
    assert.ok(match, 'getUnifiedItems function not found');

    // Within the image section, content must be passed from image.content
    const imageSection = match[0].match(/showType\("image"\)[^]*?}\);/s);
    assert.ok(imageSection, 'Image section in getUnifiedItems not found');
    assert.ok(
      imageSection[0].includes('content: image.content'),
      'getUnifiedItems must pass content: image.content for image items'
    );
  });

  it('renderUnifiedItem passes content to renderImageItem for image type', () => {
    // Find renderUnifiedItem function body
    const renderUnifiedPattern = /const renderUnifiedItem = \(item: UnifiedItem\)[^]*?(?=\n  (?:const|\/\/))/s;
    const match = appSource.match(renderUnifiedPattern);
    assert.ok(match, 'renderUnifiedItem function not found');

    // The image case must pass content field
    const imageCasePattern = /case "image":[^]*?renderImageItem\(\{[^}]*\}/s;
    const imageCase = match[0].match(imageCasePattern);
    assert.ok(imageCase, 'Image case in renderUnifiedItem not found');
    assert.ok(
      imageCase[0].includes('content: item.content'),
      'renderUnifiedItem must pass content: item.content to renderImageItem'
    );
  });
});

describe('Image card content display', () => {
  it('renderImageItem shows content text on image cards', () => {
    // Find the renderImageItem function
    const renderImagePattern = /const renderImageItem = \(item: SavedImage\)[^]*?(?=\n  const \w+ = )/s;
    const match = appSource.match(renderImagePattern);
    assert.ok(match, 'renderImageItem function not found');

    // Must conditionally render item.content
    assert.ok(
      match[0].includes('item.content'),
      'renderImageItem must reference item.content'
    );
    assert.ok(
      match[0].includes('card-content'),
      'renderImageItem must render content in a card-content div'
    );
  });
});
