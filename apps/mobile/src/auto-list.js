// Pure auto-list continuation logic, extracted for testability.
// Given the full text value and cursor position (selectionStart),
// returns { newValue, cursorPos } or null if no list continuation applies.

export function autoListContinue(value, selectionStart) {
  const textBefore = value.substring(0, selectionStart);
  const textAfter = value.substring(selectionStart);

  // Find current line
  const lastNewline = textBefore.lastIndexOf('\n');
  const currentLine = textBefore.substring(lastNewline + 1);

  // Match list marker: optional whitespace + marker (-, *, +, or number.) + space + optional checkbox
  // Group 1: indent, Group 2: marker (-, *, +, or N.), Group 3: checkbox if present ([ ] or [x])
  const listMatch = currentLine.match(/^(\s*)([-*+]|\d+\.)\s(?:(\[[ x]\])\s)?/);
  if (!listMatch) return null;

  const indent = listMatch[1];
  const marker = listMatch[2];
  const checkbox = listMatch[3]; // undefined, '[ ]', or '[x]'
  const fullPrefix = listMatch[0];
  const contentAfterPrefix = currentLine.substring(fullPrefix.length);

  if (contentAfterPrefix.trim() === '') {
    // Empty list item — remove the marker (end the list)
    const lineStart = lastNewline + 1;
    const newValue = value.substring(0, lineStart) + '\n' + textAfter;
    return { newValue, cursorPos: lineStart + 1 };
  } else {
    // Continue the list
    let nextMarker = marker;
    const numMatch = marker.match(/^(\d+)\.$/);
    if (numMatch) {
      nextMarker = `${parseInt(numMatch[1], 10) + 1}.`;
    }

    let insertion;
    if (checkbox !== undefined) {
      // Always continue with unchecked checkbox
      insertion = `\n${indent}${nextMarker} [ ] `;
    } else {
      insertion = `\n${indent}${nextMarker} `;
    }

    const newValue = textBefore + insertion + textAfter;
    return { newValue, cursorPos: selectionStart + insertion.length };
  }
}
