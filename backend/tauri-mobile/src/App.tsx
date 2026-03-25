import { useState, useEffect, useLayoutEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import snarkdown from "snarkdown";
import "./App.css";
import readerCss from "./reader.css?raw";
import { autoListContinue } from "./auto-list.js";

declare const __BUILD_NUMBER__: string;

/** Pre-process markdown to protect checkbox syntax from snarkdown's link parsing */
function preProcessCheckboxes(md: string): string {
  return md
    .replace(/^(\s*[-*])\s+\[ \]/gm, '$1 CBTODO')
    .replace(/^(\s*[-*])\s+\[x\]/gim, '$1 CBDONE');
}

/** Post-process HTML to render checkbox placeholders as actual checkboxes */
function postProcessCheckboxes(html: string): string {
  return html
    .replace(/<li>\s*CBTODO\s*/g, '<li class="checkbox-item"><input type="checkbox" disabled /> ')
    .replace(/<li>\s*CBDONE\s*/g, '<li class="checkbox-item checkbox-checked"><input type="checkbox" checked disabled /> ');
}

type ItemType = "page" | "text" | "tagset" | "image";

interface ItemMetadata {
  title?: string;
  selectedText?: string;
  sourceApp?: string;
  sharedAt?: string;
  _sync?: SyncMetadata;
}

interface SavedUrl {
  id: string;
  url: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
}

interface SavedText {
  id: string;
  content: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
}

interface SavedTagset {
  id: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
}

interface SavedImage {
  id: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
  content?: string;
  thumbnail?: string; // Base64-encoded thumbnail
  mime_type: string;
  width?: number;
  height?: number;
}

interface TagStats {
  name: string;
  frequency: number;
  lastUsed: string;
  frecencyScore: number;
}

interface SyncMetadata {
  createdBy?: string;
  createdAt?: number;
  modifiedBy?: string;
  modifiedAt?: number;
}

interface BidirectionalSyncResult {
  success: boolean;
  pulled: number;
  pushed: number;
  conflicts: number;
  message: string;
}

interface SyncStatus {
  configured: boolean;
  last_sync_time: string | null;
  pending_count: number;
}

interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  lastUsed: string;
}

interface SyncSettings {
  server_url: string;
  api_key: string;
  auto_sync: boolean;
  sync_interval_minutes: number;
}

interface ProfileInfo {
  currentProfileId: string;
  isProductionBuild: boolean;
  profiles: ProfileEntry[];
  sync: SyncSettings;
}

// Unified item for combined list
interface UnifiedItem {
  id: string;
  type: ItemType;
  url?: string;
  content?: string;
  tags: string[];
  saved_at: string;
  metadata?: ItemMetadata;
  thumbnail?: string;
  mime_type?: string;
  width?: number;
  height?: number;
}

// ============================================================================
// Shared Editor Components
// ============================================================================

// Clear button for inputs - round X icon
interface ClearButtonProps {
  onClear: () => void;
  show: boolean;
  className?: string;
}

const ClearButton: React.FC<ClearButtonProps> = ({ onClear, show, className = '' }) => {
  if (!show) return null;
  return (
    <button
      type="button"
      className={`clear-btn ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClear();
      }}
      tabIndex={-1}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="12" r="12" fill="currentColor" opacity="0.3" />
        <path d="M15.5 8.5L8.5 15.5M8.5 8.5L15.5 15.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </button>
  );
};

interface EditorOverlayProps {
  children: React.ReactNode | ((swipeHandlers: SwipeHandlers) => React.ReactNode);
  onDismiss: () => void;
  keyboardHeight: number;
  className?: string;
}

interface SwipeHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
}

const SWIPE_THRESHOLD = 80;

const EditorOverlay: React.FC<EditorOverlayProps> = ({ children, onDismiss, keyboardHeight, className = '' }) => {
  const keyboardOpen = keyboardHeight > 0;

  // Track visual viewport height so the overlay never extends behind the keyboard.
  // visualViewport.height shrinks when the keyboard opens — we use it directly.
  const [viewportHeight, setViewportHeight] = useState(() =>
    window.visualViewport ? window.visualViewport.height : window.innerHeight
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => setViewportHeight(vv.height);
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // Swipe-down-to-close state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeStartYRef = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Counter iOS visual viewport scrolling when switching focus between inputs
  // iOS automatically scrolls the viewport to bring focused inputs into view,
  // but our fixed layout already handles positioning - so we reset the scroll
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleScroll = () => {
      // If viewport scrolled, reset it - our layout handles input visibility
      if (viewport.offsetTop !== 0) {
        window.scrollTo(0, 0);
      }
    };

    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Set --safe-area-top CSS variable for status bar / notch clearance.
  // On iOS: read from env(safe-area-inset-top) via a CSS trick.
  // On Android: Kotlin bridge overwrites with real WindowInsets value.
  // Default 40px ensures header clears notch even if bridge is slow.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.style.getPropertyValue('--safe-area-top')) {
      root.style.setProperty('--safe-area-top', '40px');
    }
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    swipeStartYRef.current = e.touches[0].clientY;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (swipeStartYRef.current === null) return;
    const delta = e.touches[0].clientY - swipeStartYRef.current;
    // Only allow downward swipe
    if (delta > 0) {
      setSwipeOffset(Math.min(delta, SWIPE_THRESHOLD + 40));
    }
  };

  const handleTouchEnd = () => {
    if (swipeStartYRef.current === null) return;
    const wasSwiped = swipeOffset > SWIPE_THRESHOLD;
    swipeStartYRef.current = null;
    setSwipeOffset(0);
    if (wasSwiped) {
      onDismiss();
    }
  };

  const swipeHandlers: SwipeHandlers = {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };

  const isRenderProp = typeof children === 'function';

  return (
    <div
      className={`edit-overlay ${className}${keyboardOpen ? ' keyboard-open' : ''}`}
      style={{ height: `${viewportHeight}px` }}
      onClick={(e) => e.target === e.currentTarget && onDismiss()}
    >
      <div
        ref={cardRef}
        className="expandable-card expanded editor-card"
        style={{ transform: swipeOffset > 0 ? `translateY(${swipeOffset}px)` : undefined }}
      >
        {/* When children is a render prop, the caller handles the drag handle */}
        {!isRenderProp && (
          <div
            className="editor-drag-handle"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <div className="drag-handle-bar" />
          </div>
        )}
        {isRenderProp ? (children as (sh: SwipeHandlers) => React.ReactNode)(swipeHandlers) : children}
      </div>
    </div>
  );
};

interface TagsSectionProps {
  selectedTags: Set<string>;
  availableTags: TagStats[];
  tagInput: string;
  onTagInputChange: (value: string) => void;
  onToggleTag: (tagName: string) => void;
  onAddTag: () => void;
  placeholder?: string;
}

const TagsSection: React.FC<TagsSectionProps> = ({
  selectedTags,
  availableTags,
  tagInput,
  onTagInputChange,
  onToggleTag,
  onAddTag,
  placeholder = "Add tag..."
}) => {
  const tagInputRef = useRef<HTMLInputElement>(null);

  const refocusInput = () => {
    requestAnimationFrame(() => tagInputRef.current?.focus());
  };

  // Filter available tags based on input and exclude already selected
  const unusedTags = availableTags.filter((tag) =>
    !selectedTags.has(tag.name) &&
    (!tagInput.trim() || tag.name.toLowerCase().includes(tagInput.toLowerCase().trim()))
  );

  // Add collapsed class when no available tags to show
  const isCollapsed = unusedTags.length === 0 && availableTags.length === 0;

  return (
    <div className={`editor-tags-section ${isCollapsed ? 'collapsed' : ''}`}>
      {selectedTags.size > 0 && (
        <div className="expandable-card-section">
          <div className="editing-tags">
            {Array.from(selectedTags).map((tag) => (
              <span key={tag} className="editing-tag">
                {tag}
                <button onClick={() => { onToggleTag(tag); refocusInput(); }}>&times;</button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="expandable-card-section">
        <div className="new-tag-input">
          <div className="input-with-clear">
            <input
              ref={tagInputRef}
              type="text"
              value={tagInput}
              onChange={(e) => onTagInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAddTag();
                  refocusInput();
                }
              }}
              onFocus={() => {
                // Counter iOS viewport scroll on focus
                requestAnimationFrame(() => window.scrollTo(0, 0));
              }}
              placeholder={placeholder}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <ClearButton show={tagInput.length > 0} onClear={() => onTagInputChange('')} />
          </div>
          <button onClick={() => { onAddTag(); refocusInput(); }} disabled={!tagInput.trim()}>
            Add
          </button>
        </div>
      </div>

      {unusedTags.length > 0 ? (
        <div className="expandable-card-section">
          <div className="all-tags-list">
            {unusedTags.map((tag) => (
              <span
                key={tag.name}
                className="tag-chip"
                onClick={() => { onToggleTag(tag.name); onTagInputChange(''); refocusInput(); }}
              >
                {tag.name}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="expandable-card-section">
          {availableTags.length === 0 ? (
            <div className="tags-empty-message">This is where your tags live - tag something!</div>
          ) : tagInput.trim() ? (
            <div className="tags-empty-message">No matching tags</div>
          ) : null}
        </div>
      )}
    </div>
  );
};

interface EditorButtonsProps {
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  saveLabel?: string;
  cancelLabel?: string;
  saveDisabled?: boolean;
}

const EditorButtons: React.FC<EditorButtonsProps> = ({
  onSave,
  onCancel,
  onDelete,
  saveLabel = "Save",
  cancelLabel = "Cancel",
  saveDisabled = false
}) => (
  <div className="expandable-card-buttons editor-buttons">
    {onDelete && (
      <button className="delete-btn" onClick={onDelete}>
        Delete
      </button>
    )}
    <button className="cancel-btn" onClick={onCancel}>
      {cancelLabel}
    </button>
    <button className="save-btn" onClick={onSave} disabled={saveDisabled}>
      {saveLabel}
    </button>
  </div>
);

interface EditorLayoutProps {
  onDismiss: () => void;
  keyboardHeight: number;
  children?: React.ReactNode;
  tags?: TagsSectionProps;
  buttons: EditorButtonsProps;
  className?: string;
  headerActions?: React.ReactNode;
}

const EditorLayout: React.FC<EditorLayoutProps> = ({
  onDismiss, keyboardHeight, children, tags, buttons, className, headerActions
}) => {
  const sepRef = useRef<HTMLDivElement>(null);
  const isDraggingSepRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartContentHeightRef = useRef(0);

  const getCard = () => sepRef.current?.closest('.editor-card') as HTMLElement | null;

  const handleSepDragStart = (clientY: number) => {
    const card = getCard();
    if (!card) return;
    const contentEl = card.querySelector('.editor-segment-content') as HTMLElement | null;
    if (!contentEl) return;
    isDraggingSepRef.current = true;
    dragStartYRef.current = clientY;
    dragStartContentHeightRef.current = contentEl.offsetHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    document.body.dataset.resizing = 'true';
  };

  const handleSepDragMove = (clientY: number) => {
    if (!isDraggingSepRef.current) return;
    const card = getCard();
    if (!card) return;
    const delta = clientY - dragStartYRef.current;
    const newHeight = Math.max(60, dragStartContentHeightRef.current + delta);
    card.style.setProperty('--segment-content-height', `${newHeight}px`);
    card.style.setProperty('--segment-content-flex', 'none');
  };

  const handleSepDragEnd = () => {
    isDraggingSepRef.current = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    delete document.body.dataset.resizing;
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => handleSepDragMove(e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      if (isDraggingSepRef.current && e.cancelable) e.preventDefault();
      if (e.touches.length === 1) handleSepDragMove(e.touches[0].clientY);
    };
    const onEnd = () => handleSepDragEnd();

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onEnd);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, []);

  return (
    <EditorOverlay onDismiss={onDismiss} keyboardHeight={keyboardHeight} className={className || "text-editor-overlay"}>
      {(swipeHandlers: SwipeHandlers) => (
        <>
          <div
            className="editor-header"
            onTouchStart={swipeHandlers.onTouchStart}
            onTouchMove={swipeHandlers.onTouchMove}
            onTouchEnd={swipeHandlers.onTouchEnd}
          >
            <button className="card-action-btn editor-header-back" onClick={onDismiss} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="drag-handle-bar" />
            {headerActions}
          </div>
          <div className="editor-segment-content">
            {children}
          </div>
          {tags && (
            <>
              <div
                ref={sepRef}
                className="editor-segment-separator"
                onMouseDown={(e) => { e.preventDefault(); handleSepDragStart(e.clientY); }}
                onTouchStart={(e) => { handleSepDragStart(e.touches[0].clientY); }}
              >
                <div className="editor-segment-separator-handle" />
              </div>
              <div className="editor-segment-tags"><TagsSection {...tags} /></div>
            </>
          )}
          <div className="editor-segment-buttons"><EditorButtons {...buttons} /></div>
        </>
      )}
    </EditorOverlay>
  );
};

interface ResizableInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  showClearButton?: boolean;
  onAutoSave?: (value: string) => void;
  autoCapitalize?: string;
  autoCorrect?: string;
  showUndoRedo?: boolean;
}

interface ResizableInputHandle {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const ResizableInput = forwardRef<ResizableInputHandle, ResizableInputProps>(({
  value,
  onChange,
  placeholder = "Enter text...",
  autoFocus = false,
  showClearButton = true,
  onAutoSave,
  autoCapitalize: autoCapitalizeProp = "sentences",
  autoCorrect: autoCorrectProp = "on",
  showUndoRedo = true,
}, ref) => {
  const [height, setHeight] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // Undo/redo history
  const historyRef = useRef<string[]>([value]);
  const historyIndexRef = useRef(0);
  const isUndoRedoRef = useRef(false);
  const [, forceRender] = useState(0);

  // Track value changes for undo history
  // NOTE: useLayoutEffect (not useEffect) is critical here. forceRender updates
  // undo/redo button disabled state, but useEffect fires AFTER paint, causing a
  // second re-render that resets cursor position on iOS WKWebView. useLayoutEffect
  // fires before paint, collapsing both renders into one visual update.
  // This is a partial fix — other async state updates (e.g. auto-save's
  // setOriginalEditValues/loadSavedTexts at 500ms) could still cause cursor jumps.
  // A full fix would save/restore selectionStart/End across all re-renders.
  useLayoutEffect(() => {
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    // Only push if different from current position
    if (history[idx] !== value) {
      // Truncate any redo history
      historyRef.current = history.slice(0, idx + 1);
      historyRef.current.push(value);
      // Bound to 100 entries
      if (historyRef.current.length > 100) {
        historyRef.current.shift();
      }
      historyIndexRef.current = historyRef.current.length - 1;
      forceRender(n => n + 1);
    }
  }, [value]);

  const handleUndo = () => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      isUndoRedoRef.current = true;
      onChange(historyRef.current[historyIndexRef.current]);
      forceRender(n => n + 1);
    }
  };

  const handleRedo = () => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      isUndoRedoRef.current = true;
      onChange(historyRef.current[historyIndexRef.current]);
      forceRender(n => n + 1);
    }
  };

  useImperativeHandle(ref, () => ({
    undo: handleUndo,
    redo: handleRedo,
    get canUndo() { return historyIndexRef.current > 0; },
    get canRedo() { return historyIndexRef.current < historyRef.current.length - 1; },
  }));

  // Min height for resize floor
  const minHeight = 60;

  // Find the .editor-segment-content ancestor (if inside EditorLayout)
  const getSegmentContent = () => {
    if (!wrapperRef.current) return null;
    return wrapperRef.current.closest('.editor-segment-content') as HTMLElement | null;
  };

  const handleDragStart = (clientY: number) => {
    const segment = getSegmentContent();
    if (segment) {
      // Inside EditorLayout: resize the segment split
      isDraggingRef.current = true;
      dragStartYRef.current = clientY;
      dragStartHeightRef.current = segment.offsetHeight;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
      document.body.dataset.resizing = 'true';
    } else if (wrapperRef.current) {
      // Standalone: resize the textarea wrapper
      isDraggingRef.current = true;
      dragStartYRef.current = clientY;
      dragStartHeightRef.current = wrapperRef.current.offsetHeight;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
      document.body.dataset.resizing = 'true';
    }
  };

  const handleDragMove = (clientY: number) => {
    if (!isDraggingRef.current) return;
    const delta = clientY - dragStartYRef.current;
    const segment = getSegmentContent();
    if (segment) {
      // Resize the editor-segment-content via CSS variable on .editor-card
      const card = segment.closest('.editor-card') as HTMLElement | null;
      if (card) {
        const newHeight = Math.max(minHeight, dragStartHeightRef.current + delta);
        card.style.setProperty('--segment-content-height', `${newHeight}px`);
        card.style.setProperty('--segment-content-flex', 'none');
      }
    } else {
      const newHeight = Math.max(minHeight, dragStartHeightRef.current + delta);
      setHeight(newHeight);
    }
  };

  const handleDragEnd = () => {
    isDraggingRef.current = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    delete document.body.dataset.resizing;
  };

  // Auto markdown list continuation on Enter (includes checkbox support)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, value: domValue } = textarea;
    const result = autoListContinue(domValue, selectionStart);
    if (!result) return; // Not a list line, let default Enter happen

    e.preventDefault();
    onChange(result.newValue);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.selectionStart = result.cursorPos;
        textareaRef.current.selectionEnd = result.cursorPos;
      }
    });
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => handleDragMove(e.clientY);
    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingRef.current && e.cancelable) e.preventDefault();
      if (e.touches.length === 1) handleDragMove(e.touches[0].clientY);
    };
    const handleEnd = () => handleDragEnd();

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [minHeight]);

  // Auto-focus textarea on mount to transfer keyboard from trigger input
  useEffect(() => {
    if (!autoFocus) return;
    // Short delay lets layout settle before focusing
    const timer = setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        // Place cursor at end of text
        const len = textareaRef.current.value.length;
        textareaRef.current.selectionStart = len;
        textareaRef.current.selectionEnd = len;
      }
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
    {showUndoRedo && <div className="undo-redo-buttons">
      <button type="button" onClick={handleUndo} disabled={historyIndexRef.current <= 0} title="Undo">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10"></polyline>
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
      </button>
      <button type="button" onClick={handleRedo} disabled={historyIndexRef.current >= historyRef.current.length - 1} title="Redo">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"></path>
        </svg>
      </button>
    </div>}
    <div
      className="resizable-input-wrapper"
      ref={wrapperRef}
      style={height != null ? { height: `${height}px`, maxHeight: '100%', flex: 'none', minHeight: `${minHeight}px` } : { flex: '1 1 0', minHeight: `${minHeight}px` }}
    >
      <textarea
        ref={textareaRef}
        className="resizable-input-textarea"
        value={value}
        onChange={(e) => {
          // Normalize: collapse multiple spaces after list markers (iOS swipe/autosuggestion adds extra space)
          const normalized = e.target.value.replace(/^(\s*(?:[-*+]|\d+\.))[ \t]{2,}/gm, '$1 ');
          onChange(normalized);
          // Trigger auto-save if provided
          if (onAutoSave) {
            onAutoSave(normalized);
          }
        }}
        onFocus={() => {
          // Counter iOS viewport scroll on focus
          requestAnimationFrame(() => window.scrollTo(0, 0));
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoCapitalize={autoCapitalizeProp}
        autoCorrect={autoCorrectProp}
        autoComplete="off"
        spellCheck={autoCorrectProp === "on"}
      />
      {showClearButton && <ClearButton show={value.length > 0} onClear={() => onChange('')} className="textarea-clear" />}
      <div
        className="drag-handle"
        onMouseDown={(e) => { e.preventDefault(); handleDragStart(e.clientY); }}
        onTouchStart={(e) => { handleDragStart(e.touches[0].clientY); }}
      >
        <div className="drag-handle-bar" />
      </div>
    </div>
    </>
  );
});

// ============================================================================
// Custom Hooks
// ============================================================================

// Custom hook to detect iOS keyboard height via Visual Viewport API
// Uses max observed height while keyboard is open to prevent layout shifts
// when switching between inputs with different suggestion bar states
const useKeyboardHeight = () => {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const maxHeightRef = useRef(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const newHeight = Math.max(0, window.innerHeight - viewport.height);
      if (newHeight === 0) {
        // Keyboard dismissed — reset
        maxHeightRef.current = 0;
        setKeyboardHeight(0);
      } else {
        // Keyboard visible — use max to prevent shrinking on input switch
        maxHeightRef.current = Math.max(maxHeightRef.current, newHeight);
        setKeyboardHeight(maxHeightRef.current);
      }
    };

    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleResize);

    return () => {
      viewport.removeEventListener('resize', handleResize);
      viewport.removeEventListener('scroll', handleResize);
    };
  }, []);

  return keyboardHeight;
};

function App() {
  // DEV: random background tint on each load so we can tell if assets are fresh
  useEffect(() => {
    const hue = Math.floor(Math.random() * 360);
    document.documentElement.style.setProperty('--dev-bg-light', `hsl(${hue}, 80%, 85%)`);
    document.documentElement.style.setProperty('--dev-bg-dark', `hsl(${hue}, 15%, 12%)`);
  }, []);

  // Filter state: "all" shows everything, or a single type
  const [activeFilter, setActiveFilter] = useState<ItemType | "all">("all");

  // Data state
  const [savedUrls, setSavedUrls] = useState<SavedUrl[]>([]);
  const [savedTexts, setSavedTexts] = useState<SavedText[]>([]);
  const [savedTagsets, setSavedTagsets] = useState<SavedTagset[]>([]);
  const [savedImages, setSavedImages] = useState<SavedImage[]>([]);
  const [allTags, setAllTags] = useState<TagStats[]>([]);

  // Page editing state
  const [editingUrlId, setEditingUrlId] = useState<string | null>(null);
  const [editingUrlValue, setEditingUrlValue] = useState("");
  const [editingTags, setEditingTags] = useState<Set<string>>(new Set());
  const [editingUrlTags, setEditingUrlTags] = useState<TagStats[]>([]); // Domain-boosted tags for editing
  const [newTagInput, setNewTagInput] = useState("");

  // Text creation/editing state
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [editingTextContent, setEditingTextContent] = useState("");
  const [editingTextTags, setEditingTextTags] = useState<Set<string>>(new Set());
  const [editingTextTagInput, setEditingTextTagInput] = useState("");
  const [textReaderMode, setTextReaderMode] = useState<string | null>(null); // item ID being viewed in reader mode
  const [editorReaderMode, setEditorReaderMode] = useState(false);
  const textEditorRef = useRef<ResizableInputHandle>(null);

  // Tagset editing state
  const [editingTagsetId, setEditingTagsetId] = useState<string | null>(null);
  const [editingTagsetTags, setEditingTagsetTags] = useState<Set<string>>(new Set());
  const [editingTagsetInput, setEditingTagsetInput] = useState("");

  // Image editing state
  const [editingImageId, setEditingImageId] = useState<string | null>(null);
  const [editingImageContent, setEditingImageContent] = useState("");
  const [editingImageTags, setEditingImageTags] = useState<Set<string>>(new Set());
  const [editingImageTagInput, setEditingImageTagInput] = useState("");
  const [fullscreenImageData, setFullscreenImageData] = useState<string | null>(null);

  // Unified add input state
  const [addInputText, setAddInputText] = useState("");
  const [addInputTags, setAddInputTags] = useState<Set<string>>(new Set());
  const [addInputExpanded, setAddInputExpanded] = useState(false);
  const [addInputNewTag, setAddInputNewTag] = useState("");

  // Webview animation duration (ms) — must match --webview-anim in CSS
  const WEBVIEW_ANIM_MS = 200;

  // Inline webview expansion state
  const [expandedWebview, setExpandedWebview] = useState<{
    url: string;
    itemId: string;
  } | null>(null);
  const [webviewAnimated, setWebviewAnimated] = useState(false); // drives height transition
  const [webviewLoaded, setWebviewLoaded] = useState(false);
  const [webviewError, setWebviewError] = useState<string | false>(false);

  // Camera capture state
  const [capturedImage, setCapturedImage] = useState<string | null>(null); // base64 data URL
  const [capturedImageTags, setCapturedImageTags] = useState<Set<string>>(new Set());
  const [capturedImageTagInput, setCapturedImageTagInput] = useState("");
  const capturedImageTagInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const keyboardPrimerRef = useRef<HTMLInputElement>(null);

  // Scroll ref for scroll-to-top
  const mainRef = useRef<HTMLElement>(null);

  // Delete confirmation state
  const [pendingDelete, setPendingDelete] = useState<{ id: string; type: ItemType } | null>(null);

  // Search and tag filter state (persisted to localStorage)
  const [searchText, setSearchText] = useState<string>(() => {
    return localStorage.getItem('searchText') || "";
  });
  const [selectedFilterTags, setSelectedFilterTags] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('selectedFilterTags');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  // Sort order state (persisted to localStorage)
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>(() => {
    return (localStorage.getItem('sortOrder') as 'newest' | 'oldest') || 'newest';
  });

  // Filter tags resizable state
  const [filterTagsHeight, setFilterTagsHeight] = useState<number>(() => {
    const saved = localStorage.getItem('filterTagsHeight');
    return saved ? parseInt(saved, 10) : 116;
  });
  const filterTagsRef = useRef<HTMLDivElement>(null);
  const filterTagsDraggingRef = useRef(false);
  const isResizingRef = useRef(false);
  const filterTagsDragStartYRef = useRef(0);
  const filterTagsDragStartHeightRef = useRef(0);

  // Toast notification state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToast({ message, type });
    toastTimeoutRef.current = setTimeout(() => setToast(null), 3000);
  };

  // Discard changes confirmation state
  const [pendingDiscard, setPendingDiscard] = useState<{ type: ItemType } | null>(null);

  // Track original values for dirty checking
  const [originalEditValues, setOriginalEditValues] = useState<{
    url?: string; tags?: string[]; content?: string;
  } | null>(null);

  // UI state
  const [isDark, setIsDark] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookUrlInput, setWebhookUrlInput] = useState("");
  const [webhookApiKey, setWebhookApiKey] = useState("");
  const [webhookApiKeyInput, setWebhookApiKeyInput] = useState("");
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [profileInfo, setProfileInfo] = useState<ProfileInfo | null>(null);
  const [profileInput, setProfileInput] = useState("");
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);
  const [archiveTag, setArchiveTag] = useState("archive");
  const [archiveTagInput, setArchiveTagInput] = useState("archive");
  const [todoTag, setTodoTag] = useState("todo");
  const [todoTagInput, setTodoTagInput] = useState("todo");
  const [doneTag, setDoneTag] = useState("done");
  const [doneTagInput, setDoneTagInput] = useState("done");
  const [readmeTag, setReadmeTag] = useState("readme");
  const [readmeTagInput, setReadmeTagInput] = useState("readme");
  const [readTag, setReadTag] = useState("read");
  const [readTagInput, setReadTagInput] = useState("read");
  const [todayTag, _setTodayTag] = useState("today");
  const [_todayTagInput, _setTodayTagInput] = useState("today");
  const [laterTag, _setLaterTag] = useState("later");
  const [_laterTagInput, _setLaterTagInput] = useState("later");
  const [offlineTag, setOfflineTag] = useState("offline");
  const [offlineTagInput, setOfflineTagInput] = useState("offline");
  const [offlineStorageSize, setOfflineStorageSize] = useState(0);
  // Track which item IDs have offline content downloaded (for two-state icon)
  const [offlineContentIds, setOfflineContentIds] = useState<Set<string>>(new Set());
  // Track items currently being fetched for offline content
  const [offlineFetchingIds, setOfflineFetchingIds] = useState<Set<string>>(new Set());

  // Keyboard height for iOS keyboard avoidance
  const keyboardHeight = useKeyboardHeight();

  // Edge swipe gesture: swipe from left edge to navigate back to the list view
  const edgeSwipeBackRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const EDGE_ZONE = 20;      // px from left edge to start swipe
    const MIN_SWIPE_DIST = 80; // px horizontal distance required
    let touchStartX = 0;
    let touchStartY = 0;
    let isEdgeSwipe = false;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX <= EDGE_ZONE) {
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        isEdgeSwipe = true;
      } else {
        isEdgeSwipe = false;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isEdgeSwipe) return;
      isEdgeSwipe = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      const dy = Math.abs(touch.clientY - touchStartY);
      // Must be a predominantly horizontal swipe
      if (dx >= MIN_SWIPE_DIST && dx > dy) {
        edgeSwipeBackRef.current?.();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // Periodic auto-sync
  const autoSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const DEFAULT_SYNC_INTERVAL_MINUTES = 30;
  const [syncIntervalMinutes, setSyncIntervalMinutes] = useState(DEFAULT_SYNC_INTERVAL_MINUTES);
  const syncIntervalMs = syncIntervalMinutes * 60_000;

  // Filter tags drag-to-resize handlers
  const handleFilterTagsDragStart = (clientY: number) => {
    filterTagsDraggingRef.current = true;
    isResizingRef.current = true;
    filterTagsDragStartYRef.current = clientY;
    filterTagsDragStartHeightRef.current = filterTagsRef.current?.offsetHeight ?? filterTagsHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  };

  useEffect(() => {
    const handleMove = (clientY: number) => {
      if (!filterTagsDraggingRef.current) return;
      const delta = clientY - filterTagsDragStartYRef.current;
      const newHeight = Math.max(71, filterTagsDragStartHeightRef.current + delta);
      setFilterTagsHeight(newHeight);
    };
    const handleMouseMove = (e: MouseEvent) => handleMove(e.clientY);
    const handleTouchMove = (e: TouchEvent) => {
      if (filterTagsDraggingRef.current && e.cancelable) e.preventDefault();
      if (e.touches.length === 1) handleMove(e.touches[0].clientY);
    };
    const handleEnd = () => {
      if (!filterTagsDraggingRef.current) return;
      filterTagsDraggingRef.current = false;
      isResizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      // Persist to localStorage
      localStorage.setItem('filterTagsHeight', String(Math.round(filterTagsHeight)));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleEnd);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [filterTagsHeight]);

  // Persist search text to localStorage
  useEffect(() => {
    localStorage.setItem('searchText', searchText);
  }, [searchText]);

  // Persist selected filter tags to localStorage
  useEffect(() => {
    localStorage.setItem('selectedFilterTags', JSON.stringify(Array.from(selectedFilterTags)));
  }, [selectedFilterTags]);

  // Persist sort order to localStorage
  useEffect(() => {
    localStorage.setItem('sortOrder', sortOrder);
  }, [sortOrder]);

  // DEV: random background tint on every load to verify page refreshed
  useEffect(() => {
    if (import.meta.env.DEV) {
      const hue = Math.floor(Math.random() * 360);
      document.documentElement.style.setProperty('--dev-bg-light', `hsl(${hue}, 15%, 96%)`);
      document.documentElement.style.setProperty('--dev-bg-dark', `hsl(${hue}, 10%, 12%)`);
      console.log(`[DEV] Page loaded — bg hue: ${hue}`);
    }
  }, []);

  // Detect system dark mode via native API (iOS) or Android bridge
  useEffect(() => {
    const checkDarkMode = async () => {
      try {
        const nativeDark = await invoke<boolean>("is_dark_mode");
        setIsDark(nativeDark);
      } catch (error) {
        // Check Android-injected global (set by MainActivity.kt)
        if (typeof (window as any).__ANDROID_DARK_MODE__ === "boolean") {
          setIsDark((window as any).__ANDROID_DARK_MODE__);
        } else {
          // Fallback to JS media query
          const jsMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
          setIsDark(jsMediaQuery.matches);
        }
      }
    };

    checkDarkMode();

    // Listen for system theme changes via media query
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => checkDarkMode();
    mediaQuery.addEventListener("change", handleChange);

    // Also check when app resumes from background
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkDarkMode();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Apply dark class to body
  useEffect(() => {
    document.body.classList.toggle("dark", isDark);
  }, [isDark]);

  // Load data on mount and when app returns to foreground
  useEffect(() => {
    const loadData = () => {
      loadSavedUrls();
      loadSavedTexts();
      loadSavedTagsets();
      loadSavedImages();
      loadAllTags();
    };

    const tryAutoSync = async () => {
      try {
        await invoke("auto_sync_if_needed");
      } catch (error) {
        // Silently ignore auto-sync errors
        console.log("Auto-sync check:", error);
      }
    };

    loadData();
    loadWebhookUrl();
    loadWebhookApiKey();
    loadAutoSync();
    loadSyncInterval();
    loadLastSync();
    loadSyncStatus();
    loadProfileInfo();
    loadArchiveTag();
    loadTodoTags();
    loadReadingTags();
    loadOfflineTag();
    loadOfflineStorageSize();
    tryAutoSync();

    // Reload when app comes back to foreground (to pick up items from share extension)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadData();
        tryAutoSync();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Listen for webview navigation events to record visits
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<{ itemId: string; url: string }>("webview:navigated", async (event) => {
        const { itemId } = event.payload;
        try {
          // Record subsequent navigation as a visit
          await invoke("record_visit", { itemId, source: "webview", windowType: "embedded" });
        } catch (error) {
          console.error("Failed to record webview visit:", error);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Reset empty expanded input when app returns to foreground
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // If input is expanded but empty, collapse it
        if (addInputExpanded && !addInputText.trim() && addInputTags.size === 0) {
          setAddInputExpanded(false);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [addInputExpanded, addInputText, addInputTags]);

  const loadWebhookUrl = async () => {
    try {
      const url = await invoke<string | null>("get_webhook_url");
      if (url) {
        setWebhookUrl(url);
        setWebhookUrlInput(url);
      }
    } catch (error) {
      console.error("Failed to load webhook URL:", error);
    }
  };

  const loadWebhookApiKey = async () => {
    try {
      const key = await invoke<string | null>("get_webhook_api_key");
      if (key) {
        setWebhookApiKey(key);
        setWebhookApiKeyInput(key);
      }
    } catch (error) {
      console.error("Failed to load webhook API key:", error);
    }
  };

  const loadAutoSync = async () => {
    try {
      const enabled = await invoke<boolean>("get_auto_sync");
      setAutoSyncEnabled(enabled);
    } catch (error) {
      console.error("Failed to load auto-sync setting:", error);
    }
  };

  const toggleAutoSync = async (enabled: boolean) => {
    try {
      await invoke("set_auto_sync", { enabled });
      setAutoSyncEnabled(enabled);
    } catch (error) {
      console.error("Failed to set auto-sync:", error);
    }
  };

  const loadSyncInterval = async () => {
    try {
      const minutes = await invoke<number>("get_sync_interval");
      if (minutes >= 0) setSyncIntervalMinutes(minutes);
    } catch (error) {
      console.error("Failed to load sync interval:", error);
    }
  };

  const saveSyncInterval = async (minutes: number) => {
    try {
      await invoke("set_sync_interval", { minutes });
      setSyncIntervalMinutes(minutes);
    } catch (error) {
      console.error("Failed to save sync interval:", error);
    }
  };

  const loadArchiveTag = async () => {
    try {
      const tag = await invoke<string>("get_archive_tag");
      setArchiveTag(tag);
      setArchiveTagInput(tag);
    } catch (error) {
      console.error("Failed to load archive tag:", error);
    }
  };

  const saveArchiveTag = async () => {
    try {
      await invoke("set_archive_tag", { tag: archiveTagInput });
      setArchiveTag(archiveTagInput);
    } catch (error) {
      console.error("Failed to save archive tag:", error);
    }
  };

  const loadTodoTags = async () => {
    try {
      const [todo, done] = await invoke<[string, string]>("get_todo_tags");
      setTodoTag(todo);
      setTodoTagInput(todo);
      setDoneTag(done);
      setDoneTagInput(done);
    } catch (error) {
      console.error("Failed to load todo tags:", error);
    }
  };

  const saveTodoTags = async () => {
    try {
      await invoke("set_todo_tags", { todoTag: todoTagInput, doneTag: doneTagInput });
      setTodoTag(todoTagInput);
      setDoneTag(doneTagInput);
    } catch (error) {
      console.error("Failed to save todo tags:", error);
    }
  };

  const loadReadingTags = async () => {
    try {
      const [readme, read] = await invoke<[string, string]>("get_reading_tags");
      setReadmeTag(readme);
      setReadmeTagInput(readme);
      setReadTag(read);
      setReadTagInput(read);
    } catch (error) {
      console.error("Failed to load reading tags:", error);
    }
  };

  const saveReadingTags = async () => {
    try {
      await invoke("set_reading_tags", { readmeTag: readmeTagInput, readTag: readTagInput });
      setReadmeTag(readmeTagInput);
      setReadTag(readTagInput);
    } catch (error) {
      console.error("Failed to save reading tags:", error);
    }
  };

  const loadOfflineTag = async () => {
    try {
      const tag = await invoke<string>("get_offline_tag");
      setOfflineTag(tag);
      setOfflineTagInput(tag);
    } catch (error) {
      console.error("Failed to load offline tag:", error);
    }
  };

  const saveOfflineTag = async () => {
    try {
      await invoke("set_offline_tag", { tag: offlineTagInput });
      setOfflineTag(offlineTagInput);
    } catch (error) {
      console.error("Failed to save offline tag:", error);
    }
  };

  const loadOfflineStorageSize = async () => {
    try {
      const size = await invoke<number>("get_offline_storage_size");
      setOfflineStorageSize(size);
    } catch (error) {
      console.error("Failed to load offline storage size:", error);
    }
  };

  const loadLastSync = async () => {
    try {
      const sync = await invoke<string | null>("get_last_sync");
      setLastSync(sync);
    } catch (error) {
      console.error("Failed to load last sync:", error);
    }
  };

  const loadSyncStatus = async () => {
    try {
      const status = await invoke<SyncStatus>("get_sync_status");
      setSyncStatus(status);
      if (status.last_sync_time) {
        setLastSync(status.last_sync_time);
      }
    } catch (error) {
      console.error("Failed to load sync status:", error);
    }
  };

  const loadProfileInfo = async () => {
    try {
      const info = await invoke<ProfileInfo>("get_profile_info");
      setProfileInfo(info);
      setProfileInput("");
    } catch (error) {
      console.error("Failed to load profile info:", error);
    }
  };

  const setProfile = async (profileId: string) => {
    console.log(`[Profile] setProfile called with: ${profileId}`);
    try {
      console.log(`[Profile] Invoking set_profile command...`);
      const info = await invoke<ProfileInfo>("set_profile", { profileId });
      console.log(`[Profile] set_profile returned:`, info);
      setProfileInfo(info);
      setProfileInput("");
      // Show restart prompt for full database isolation
      setShowRestartPrompt(true);
    } catch (error) {
      console.error("[Profile] Failed to set profile:", error);
      setSyncMessage(`Failed: ${error}`);
      setTimeout(() => setSyncMessage(null), 3000);
    }
  };

  const quitApp = async () => {
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("Failed to quit:", error);
    }
  };

  const saveWebhookSettings = async () => {
    try {
      await invoke("set_webhook_url", { url: webhookUrlInput });
      await invoke("set_webhook_api_key", { key: webhookApiKeyInput });
      setWebhookUrl(webhookUrlInput);
      setWebhookApiKey(webhookApiKeyInput);
      setSyncMessage("Settings saved");
      setTimeout(() => setSyncMessage(null), 2000);
    } catch (error) {
      console.error("Failed to save webhook settings:", error);
      setSyncMessage("Failed to save settings");
      setTimeout(() => setSyncMessage(null), 3000);
    }
  };

  // Bidirectional sync: pull then push
  const syncAll = async () => {
    if (!webhookUrl) {
      showToast("Please configure server URL first", "error");
      return;
    }

    setIsSyncing(true);
    showToast("Syncing...");

    try {
      const result = await invoke<BidirectionalSyncResult>("sync_all");
      const msg = `Synced: ${result.pulled} pulled, ${result.pushed} pushed${result.conflicts > 0 ? `, ${result.conflicts} conflicts` : ''}`;
      showToast(msg);
      setSyncMessage(msg);
      // Reload data to show new items from server
      loadSavedUrls();
      loadSavedTexts();
      loadSavedTagsets();
      loadSavedImages();
      loadAllTags();
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (error) {
      console.error("Failed to sync:", error);
      const errorMsg = `Sync failed: ${error}`;
      showToast(errorMsg, "error");
      setSyncMessage(errorMsg);
      setTimeout(() => setSyncMessage(null), 5000);
    } finally {
      setIsSyncing(false);
      // Always refresh sync status (pending count, last sync time) after sync attempt
      await loadSyncStatus();
    }
  };

  // Pull only from server
  const pullFromServer = async () => {
    if (!webhookUrl) {
      setSyncMessage("Please save a server URL first");
      setTimeout(() => setSyncMessage(null), 3000);
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null);

    try {
      const result = await invoke<BidirectionalSyncResult>("pull_from_server");
      const msg = `Pulled ${result.pulled} items${result.conflicts > 0 ? `, ${result.conflicts} conflicts` : ''}`;
      setSyncMessage(msg);
      await loadSyncStatus();
      // Reload data to show new items from server
      loadSavedUrls();
      loadSavedTexts();
      loadSavedTagsets();
      loadSavedImages();
      loadAllTags();
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (error) {
      console.error("Failed to pull:", error);
      setSyncMessage(`Pull failed: ${error}`);
      setTimeout(() => setSyncMessage(null), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  // Push only to server
  const pushToServer = async () => {
    if (!webhookUrl) {
      setSyncMessage("Please save a server URL first");
      setTimeout(() => setSyncMessage(null), 3000);
      return;
    }

    setIsSyncing(true);
    setSyncMessage(null);

    try {
      const result = await invoke<BidirectionalSyncResult>("push_to_server");
      setSyncMessage(`Pushed ${result.pushed} items`);
      await loadSyncStatus();
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (error) {
      console.error("Failed to push:", error);
      setSyncMessage(`Push failed: ${error}`);
      setTimeout(() => setSyncMessage(null), 5000);
    } finally {
      setIsSyncing(false);
    }
  };

  const loadSavedUrls = async () => {
    try {
      const urls = await invoke<SavedUrl[]>("get_saved_urls");
      setSavedUrls(urls);
      // After loading URLs, check which ones have offline content downloaded
      if (offlineTag) {
        const offlineItemIds = urls
          .filter(u => u.tags.includes(offlineTag))
          .map(u => u.id);
        if (offlineItemIds.length > 0) {
          try {
            const idsWithContent = await invoke<string[]>("check_offline_content_batch", { itemIds: offlineItemIds });
            setOfflineContentIds(new Set(idsWithContent));
          } catch (err) {
            console.error("Failed to check offline content status:", err);
          }
        } else {
          setOfflineContentIds(new Set());
        }
      }
    } catch (error) {
      console.error("Failed to load saved URLs:", error);
    }
  };

  const loadSavedTexts = async () => {
    try {
      const texts = await invoke<SavedText[]>("get_saved_texts");
      setSavedTexts(texts);
    } catch (error) {
      console.error("Failed to load saved texts:", error);
    }
  };

  const loadSavedTagsets = async () => {
    try {
      const tagsets = await invoke<SavedTagset[]>("get_saved_tagsets");
      setSavedTagsets(tagsets);
    } catch (error) {
      console.error("Failed to load saved tagsets:", error);
    }
  };

  const loadSavedImages = async () => {
    try {
      const images = await invoke<SavedImage[]>("get_saved_images");
      setSavedImages(images);
    } catch (error) {
      console.error("Failed to load saved images:", error);
    }
  };

  const loadAllTags = async () => {
    try {
      const tags = await invoke<TagStats[]>("get_tags_by_frecency");
      setAllTags(tags);
    } catch (error) {
      console.error("Failed to load tags:", error);
    }
  };

  // Dirty checking helpers
  const hasUrlChanges = (): boolean => {
    if (!originalEditValues) return false;
    return editingUrlValue !== originalEditValues.url || JSON.stringify(Array.from(editingTags).sort()) !== JSON.stringify(originalEditValues.tags);
  };
  const hasTextChanges = (): boolean => {
    if (!originalEditValues) return false;
    return editingTextContent !== originalEditValues.content || JSON.stringify(Array.from(editingTextTags).sort()) !== JSON.stringify(originalEditValues.tags);
  };
  const hasTagsetChanges = (): boolean => {
    if (!originalEditValues) return false;
    return JSON.stringify(Array.from(editingTagsetTags).sort()) !== JSON.stringify(originalEditValues.tags);
  };
  const hasImageChanges = (): boolean => {
    if (!originalEditValues) return false;
    return editingImageContent !== (originalEditValues.content ?? "") || JSON.stringify(Array.from(editingImageTags).sort()) !== JSON.stringify(originalEditValues.tags);
  };

  const startEditing = async (item: SavedUrl) => {
    keyboardPrimerRef.current?.focus();
    setEditingUrlId(item.id);
    setEditingUrlValue(item.url);
    setEditingTags(new Set(item.tags));
    setNewTagInput("");
    setOriginalEditValues({ url: item.url, tags: [...item.tags].sort() });

    // Fetch domain-boosted tags for this URL
    try {
      const tags = await invoke<TagStats[]>("get_tags_by_frecency_for_url", { url: item.url });
      setEditingUrlTags(tags);
    } catch (error) {
      console.error("Failed to load domain-boosted tags:", error);
      setEditingUrlTags(allTags); // Fallback to regular tags
    }
  };

  const cancelEditing = () => {
    setEditingUrlId(null);
    setEditingUrlValue("");
    setEditingTags(new Set());
    setEditingUrlTags([]);
    setNewTagInput("");
    setOriginalEditValues(null);
  };

  const requestCancelEditing = () => {
    if (hasUrlChanges()) setPendingDiscard({ type: "page" });
    else cancelEditing();
  };

  const deleteUrl = async (id: string) => {
    console.log("[Frontend] deleteUrl called for id:", id);
    try {
      await invoke("delete_url", { id });
      console.log("[Frontend] delete_url invoke succeeded");
      await loadSavedUrls();
      cancelEditing();
    } catch (error) {
      console.error("[Frontend] Failed to delete URL:", error);
    }
  };

  const toggleTag = (tagName: string) => {
    const newTags = new Set(editingTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setEditingTags(newTags);
  };

  const addNewTag = () => {
    const newTags = new Set(editingTags);
    const parts = newTagInput.split(",");
    let added = false;

    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed && !newTags.has(trimmed)) {
        newTags.add(trimmed);
        added = true;
      }
    }

    if (added) {
      setEditingTags(newTags);
    }
    setNewTagInput("");
  };

  const saveChanges = async () => {
    if (!editingUrlId) return;

    const finalTags = new Set(editingTags);
    if (newTagInput.trim()) {
      for (const tag of newTagInput.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0)) {
        finalTags.add(tag);
      }
      setNewTagInput("");
    }

    try {
      await invoke("update_url", { id: editingUrlId, url: editingUrlValue, tags: Array.from(finalTags) });
      await loadSavedUrls();
      await loadAllTags();
      cancelEditing();
      showToast("Page saved");
    } catch (error) {
      console.error("[Frontend] Failed to update URL:", error);
      showToast("Failed to save page", "error");
    }
  };

  // Unified add input functions
  const toggleAddInputTag = (tagName: string) => {
    console.log("[toggleAddInputTag] toggling tag:", tagName);
    const newTags = new Set(addInputTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    console.log("[toggleAddInputTag] new tags:", Array.from(newTags));
    setAddInputTags(newTags);
  };

  const resetAddInput = () => {
    setAddInputText("");
    setAddInputTags(new Set());
    setAddInputExpanded(false);
    setAddInputNewTag("");
  };

  const addInputAddNewTag = () => {
    const newTags = new Set(addInputTags);
    const parts = addInputNewTag.split(",");
    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        newTags.add(trimmed);
      }
    }
    setAddInputTags(newTags);
    setAddInputNewTag("");
  };

  // Camera functions
  const openCamera = () => {
    cameraInputRef.current?.click();
  };

  const handleCameraCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setCapturedImage(dataUrl);
      setCapturedImageTags(new Set());
      setCapturedImageTagInput("");
    };
    reader.readAsDataURL(file);

    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const toggleCapturedImageTag = (tagName: string) => {
    const newTags = new Set(capturedImageTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setCapturedImageTags(newTags);
  };

  const addCapturedImageTag = () => {
    const newTags = new Set(capturedImageTags);
    const parts = capturedImageTagInput.split(",");
    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        newTags.add(trimmed);
      }
    }
    setCapturedImageTags(newTags);
    setCapturedImageTagInput("");
  };

  const cancelCapturedImage = () => {
    setCapturedImage(null);
    setCapturedImageTags(new Set());
    setCapturedImageTagInput("");
  };

  const saveCapturedImage = async () => {
    if (!capturedImage) return;

    // Include any text in the input field
    const finalTags = new Set(capturedImageTags);
    if (capturedImageTagInput.trim()) {
      const parts = capturedImageTagInput.split(",");
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) {
          finalTags.add(trimmed);
        }
      }
    }

    try {
      // Extract base64 data from data URL
      const base64Data = capturedImage.split(",")[1];
      const mimeType = capturedImage.split(";")[0].split(":")[1];

      await invoke("save_captured_image", {
        imageData: base64Data,
        mimeType,
        tags: Array.from(finalTags),
      });

      cancelCapturedImage();
      await loadSavedImages();
      await loadAllTags();
    } catch (error) {
      console.error("Failed to save captured image:", error);
    }
  };

  const saveAddInput = async () => {
    const text = addInputText.trim();

    // Include any text in the new tag field
    const finalTags = new Set(addInputTags);
    console.log("[saveAddInput] addInputTags:", Array.from(addInputTags));
    if (addInputNewTag.trim()) {
      const parts = addInputNewTag.split(",");
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) {
          finalTags.add(trimmed);
        }
      }
    }
    const tags = Array.from(finalTags);
    console.log("[saveAddInput] final tags to save:", tags);

    // Detect type based on content
    const isUrl = text.startsWith("http://") || text.startsWith("https://");

    if (isUrl) {
      // Save as URL
      try {
        await invoke("save_url", { url: text, tags });
        resetAddInput();
        await loadSavedUrls();
        await loadAllTags();
        showToast("Page saved");
      } catch (error) {
        console.error("Failed to save URL:", error);
        showToast("Failed to save page", "error");
      }
    } else if (text) {
      // Save as text (note)
      try {
        console.log("[saveAddInput] Saving text with tags:", { content: text, tags });
        await invoke("save_text", { content: text, tags });
        resetAddInput();
        await loadSavedTexts();
        await loadAllTags();
        showToast("Note saved");
      } catch (error) {
        console.error("Failed to save text:", error);
        showToast("Failed to save note", "error");
      }
    } else if (tags.length > 0) {
      // Save as tagset (tags only, no text)
      try {
        await invoke("save_tagset", { tags });
        resetAddInput();
        await loadSavedTagsets();
        await loadAllTags();
        showToast("Tags saved");
      } catch (error) {
        console.error("Failed to save tagset:", error);
        showToast("Failed to save tags", "error");
      }
    }
  };

  // Detect what type the input would create
  const getAddInputType = (): "url" | "text" | "tagset" | null => {
    const text = addInputText.trim();
    if (text.startsWith("http://") || text.startsWith("https://")) return "url";
    if (text) return "text";
    if (addInputTags.size > 0) return "tagset";
    return null;
  };

  const startEditingText = (item: SavedText) => {
    keyboardPrimerRef.current?.focus();
    setEditingTextId(item.id);
    setEditingTextContent(item.content);
    const existingTags = item.tags.length > 0 ? item.tags : extractHashtags(item.content);
    setEditingTextTags(new Set(existingTags));
    setEditingTextTagInput("");
    setOriginalEditValues({ content: item.content, tags: [...existingTags].sort() });
    setEditorReaderMode(false);
  };

  const cancelEditingText = () => {
    setEditingTextId(null);
    setEditingTextContent("");
    setEditingTextTags(new Set());
    setEditingTextTagInput("");
    setOriginalEditValues(null);
    setEditorReaderMode(false);
  };

  const requestCancelEditingText = () => {
    if (hasTextChanges()) setPendingDiscard({ type: "text" });
    else cancelEditingText();
  };

  const toggleEditingTextTag = (tagName: string) => {
    const newTags = new Set(editingTextTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setEditingTextTags(newTags);
  };

  const addEditingTextTag = () => {
    const trimmed = editingTextTagInput.trim().toLowerCase();
    if (trimmed) {
      setEditingTextTags(new Set(editingTextTags).add(trimmed));
      setEditingTextTagInput("");
    }
  };

  // Auto-save timer ref
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Debounced auto-save for text editing (saves silently without closing)
  const scheduleAutoSave = useCallback((content: string) => {
    if (!editingTextId || !originalEditValues) return;

    // Clear any pending auto-save
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    // Only auto-save if content changed from original
    if (content.trim() === originalEditValues.content) return;

    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        await invoke("update_text", { id: editingTextId, content: content.trim(), tags: Array.from(editingTextTags) });
        // Update original values so we know what's saved
        setOriginalEditValues(prev => prev ? { ...prev, content: content.trim() } : null);
        await loadSavedTexts();
      } catch (error) {
        console.error("Auto-save failed:", error);
      }
    }, 500);
  }, [editingTextId, originalEditValues, editingTextTags]);

  // Clear auto-save timer on unmount or when editing ends
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [editingTextId]);

  const saveTextChanges = async () => {
    if (!editingTextId) return;

    // Clear any pending auto-save
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    const finalTags = new Set(editingTextTags);
    if (editingTextTagInput.trim()) {
      for (const tag of editingTextTagInput.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0)) {
        finalTags.add(tag);
      }
    }

    try {
      await invoke("update_text", { id: editingTextId, content: editingTextContent.trim(), tags: Array.from(finalTags) });
      await loadSavedTexts();
      await loadAllTags();
      cancelEditingText();
      showToast("Note saved");
    } catch (error) {
      console.error("Failed to update text:", error);
      showToast("Failed to save note", "error");
    }
  };

  const deleteText = async (id: string) => {
    try {
      await invoke("delete_url", { id }); // delete_url works for all item types
      await loadSavedTexts();
      cancelEditingText();
    } catch (error) {
      console.error("Failed to delete text:", error);
    }
  };

  // Tagset editing functions
  const startEditingTagset = (item: SavedTagset) => {
    keyboardPrimerRef.current?.focus();
    setEditingTagsetId(item.id);
    setEditingTagsetTags(new Set(item.tags));
    setEditingTagsetInput("");
    setOriginalEditValues({ tags: [...item.tags].sort() });
  };

  const cancelEditingTagset = () => {
    setEditingTagsetId(null);
    setEditingTagsetTags(new Set());
    setEditingTagsetInput("");
    setOriginalEditValues(null);
  };

  const requestCancelEditingTagset = () => {
    if (hasTagsetChanges()) setPendingDiscard({ type: "tagset" });
    else cancelEditingTagset();
  };

  const toggleEditingTagsetTag = (tagName: string) => {
    const newTags = new Set(editingTagsetTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setEditingTagsetTags(newTags);
  };

  const addEditingTagsetTag = () => {
    const newTags = new Set(editingTagsetTags);
    const parts = editingTagsetInput.split(",");
    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        newTags.add(trimmed);
      }
    }
    setEditingTagsetTags(newTags);
    setEditingTagsetInput("");
  };

  const saveTagsetChanges = async () => {
    if (!editingTagsetId) return;

    const finalTags = new Set(editingTagsetTags);
    if (editingTagsetInput.trim()) {
      for (const tag of editingTagsetInput.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0)) {
        finalTags.add(tag);
      }
    }

    if (finalTags.size === 0) {
      showToast("At least one tag is required", "error");
      return;
    }

    try {
      await invoke("update_tagset", { id: editingTagsetId, tags: Array.from(finalTags) });
      await loadSavedTagsets();
      await loadAllTags();
      cancelEditingTagset();
      showToast("Tags saved");
    } catch (error) {
      console.error("Failed to update tagset:", error);
      showToast("Failed to save tags", "error");
    }
  };

  const deleteTagset = async (id: string) => {
    try {
      await invoke("delete_url", { id }); // delete_url works for all item types
      await loadSavedTagsets();
      cancelEditingTagset();
    } catch (error) {
      console.error("Failed to delete tagset:", error);
    }
  };

  // Image editing functions
  const startEditingImage = (item: SavedImage) => {
    keyboardPrimerRef.current?.focus();
    setEditingImageId(item.id);
    setEditingImageContent(item.content || "");
    setEditingImageTags(new Set(item.tags));
    setEditingImageTagInput("");
    setOriginalEditValues({ content: item.content || "", tags: [...item.tags].sort() });
  };

  const cancelEditingImage = () => {
    setEditingImageId(null);
    setEditingImageContent("");
    setEditingImageTags(new Set());
    setEditingImageTagInput("");
    setOriginalEditValues(null);
  };

  const requestCancelEditingImage = () => {
    if (hasImageChanges()) setPendingDiscard({ type: "image" });
    else cancelEditingImage();
  };

  const toggleEditingImageTag = (tagName: string) => {
    const newTags = new Set(editingImageTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setEditingImageTags(newTags);
  };

  const addEditingImageTag = () => {
    const newTags = new Set(editingImageTags);
    const parts = editingImageTagInput.split(",");
    for (const part of parts) {
      const trimmed = part.trim().toLowerCase();
      if (trimmed) {
        newTags.add(trimmed);
      }
    }
    setEditingImageTags(newTags);
    setEditingImageTagInput("");
  };

  const saveImageChanges = async () => {
    if (!editingImageId) return;

    // Include any text in the input field
    const finalTags = new Set(editingImageTags);
    if (editingImageTagInput.trim()) {
      const parts = editingImageTagInput.split(",");
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) {
          finalTags.add(trimmed);
        }
      }
    }

    try {
      await invoke("update_image_tags", {
        id: editingImageId,
        tags: Array.from(finalTags),
      });
      await loadSavedImages();
      await loadAllTags();
      cancelEditingImage();
      showToast("Image saved");
    } catch (error) {
      console.error("Failed to update image:", error);
      showToast("Failed to save image", "error");
    }
  };

  // Helper to extract hashtags from text for display
  const extractHashtags = (content: string): string[] => {
    const matches = content.match(/#(\w+)/g);
    return matches ? matches.map((m) => m.slice(1).toLowerCase()) : [];
  };

  // Set filter to show only a specific type
  const selectFilter = (type: ItemType) => {
    // If already showing this type, go back to all
    if (activeFilter === type) {
      setActiveFilter("all");
    } else {
      setActiveFilter(type);
    }
  };

  // Scroll to top of the list
  const scrollToTop = () => {
    mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Periodic auto-sync: runs at configured interval, pauses when backgrounded, syncs on foreground return
  // When syncIntervalMinutes is 0, periodic sync is disabled entirely.
  useEffect(() => {
    if (!webhookUrl || syncIntervalMinutes === 0) return;

    const startInterval = () => {
      if (autoSyncIntervalRef.current) clearInterval(autoSyncIntervalRef.current);
      autoSyncIntervalRef.current = setInterval(() => {
        if (!isSyncing) syncAll();
      }, syncIntervalMs);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Returning to foreground — sync immediately and restart interval
        if (!isSyncing) syncAll();
        startInterval();
      } else {
        // Backgrounded — stop interval
        if (autoSyncIntervalRef.current) {
          clearInterval(autoSyncIntervalRef.current);
          autoSyncIntervalRef.current = null;
        }
      }
    };

    startInterval();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      if (autoSyncIntervalRef.current) clearInterval(autoSyncIntervalRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [webhookUrl, isSyncing, syncIntervalMs, syncIntervalMinutes]);

  // Reset to show all types, clear search/filters, and scroll to top
  const showAll = () => {
    setActiveFilter("all");
    setSearchText("");
    setSelectedFilterTags(new Set());
    scrollToTop();
  };

  // Tag filter functions
  const toggleFilterTag = (tagName: string) => {
    const newTags = new Set(selectedFilterTags);
    if (newTags.has(tagName)) {
      newTags.delete(tagName);
    } else {
      newTags.add(tagName);
    }
    setSelectedFilterTags(newTags);
  };

  // Filter tags by search text
  const getFilteredTags = () => {
    if (!searchText.trim()) return allTags;
    const search = searchText.toLowerCase();
    return allTags.filter(tag => tag.name.toLowerCase().includes(search));
  };

  // Create unified sorted list (filtered by type, search text, and selected tags)
  const getUnifiedItems = (): UnifiedItem[] => {
    const items: UnifiedItem[] = [];
    const showType = (type: ItemType) => activeFilter === "all" || activeFilter === type;

    if (showType("page")) {
      savedUrls.forEach((url) => {
        items.push({
          id: url.id,
          type: "page",
          url: url.url,
          tags: url.tags,
          saved_at: url.saved_at,
          metadata: url.metadata,
        });
      });
    }

    if (showType("text")) {
      savedTexts.forEach((text) => {
        items.push({
          id: text.id,
          type: "text",
          content: text.content,
          tags: text.tags,
          saved_at: text.saved_at,
          metadata: text.metadata,
        });
      });
    }

    if (showType("tagset")) {
      savedTagsets.forEach((tagset) => {
        items.push({
          id: tagset.id,
          type: "tagset",
          tags: tagset.tags,
          saved_at: tagset.saved_at,
          metadata: tagset.metadata,
        });
      });
    }

    if (showType("image")) {
      savedImages.forEach((image) => {
        items.push({
          id: image.id,
          type: "image",
          tags: image.tags,
          saved_at: image.saved_at,
          metadata: image.metadata,
          content: image.content,
          thumbnail: image.thumbnail,
          mime_type: image.mime_type,
          width: image.width,
          height: image.height,
        });
      });
    }

    // Filter by search text and selected tags
    const searchLower = searchText.toLowerCase();
    const filtered = items.filter(item => {
      // Match search text against tags, url, content, or title
      const matchesSearch = !searchText.trim() ||
        item.tags.some(t => t.toLowerCase().includes(searchLower)) ||
        item.url?.toLowerCase().includes(searchLower) ||
        item.content?.toLowerCase().includes(searchLower) ||
        item.metadata?.title?.toLowerCase().includes(searchLower);

      // Match selected tags (AND filter - item must have all selected tags)
      const matchesTags = selectedFilterTags.size === 0 ||
        Array.from(selectedFilterTags).every(t => item.tags.includes(t));

      // Hide archived items unless archive tag is explicitly selected
      const isArchived = archiveTag && item.tags.includes(archiveTag);
      const archiveSelected = archiveTag && selectedFilterTags.has(archiveTag);
      if (isArchived && !archiveSelected) return false;

      // Hide auto-hide tagged items (e.g. from:history) unless searching or tag selected
      const AUTO_HIDE_TAGS = ['from:history'];
      const isAutoHidden = AUTO_HIDE_TAGS.some(t => item.tags.includes(t));
      if (isAutoHidden) {
        const autoHideTagSelected = AUTO_HIDE_TAGS.some(t => selectedFilterTags.has(t));
        if (!searchText.trim() && !autoHideTagSelected) return false;
      }

      return matchesSearch && matchesTags;
    });

    // Sort by date, respecting sort order
    return filtered.sort((a, b) => {
      const diff = new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime();
      return sortOrder === 'oldest' ? -diff : diff;
    });
  };

  // Check if any edit mode is active
  const isEditing = editingUrlId || editingTextId || editingTagsetId || editingImageId;

  // Prevent iOS viewport scrolling when editor is open
  useEffect(() => {
    if (isEditing || addInputExpanded) {
      document.body.classList.add('editor-open');
    } else {
      document.body.classList.remove('editor-open');
    }
    return () => {
      document.body.classList.remove('editor-open');
    };
  }, [isEditing, addInputExpanded]);

  // Render edit modal content
  const renderEditModal = () => {
    if (!isEditing) return null;

    // URL editing
    if (editingUrlId) {
      const item = savedUrls.find(u => u.id === editingUrlId);
      if (!item) return null;

      const urlHasOffline = offlineTag && item.tags.includes(offlineTag);

      return (
        <EditorLayout
          onDismiss={requestCancelEditing}
          keyboardHeight={keyboardHeight}
          tags={{
            selectedTags: editingTags,
            availableTags: editingUrlTags,
            tagInput: newTagInput,
            onTagInputChange: setNewTagInput,
            onToggleTag: toggleTag,
            onAddTag: addNewTag,
          }}
          buttons={{
            onSave: saveChanges,
            onCancel: requestCancelEditing,
            onDelete: () => requestDelete(editingUrlId, "page"),
          }}
          headerActions={<>
            <button className="card-action-btn" onClick={(e) => openInBrowser(item.url, item.id, e)} title="Open in Safari">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
            <button className="card-action-btn" onClick={(e) => openInWebview(item.url, item.id, e)} title="Open in app">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
              </svg>
            </button>
            {urlHasOffline && (
              offlineContentIds.has(item.id) ? (
                <button className="card-action-btn offline-ready" onClick={(e) => openOfflineReader(item.id, e)} title="Read offline">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
                  </svg>
                </button>
              ) : (
                <button
                  className={`card-action-btn offline-pending${offlineFetchingIds.has(item.id) ? ' offline-fetching' : ''}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (offlineFetchingIds.has(item.id)) return;
                    setOfflineFetchingIds(prev => new Set(prev).add(item.id));
                    try {
                      await invoke("fetch_offline_content", { itemId: item.id, url: item.url });
                      setOfflineContentIds(prev => new Set(prev).add(item.id));
                    } catch (err) {
                      console.error("[App] Failed to fetch offline content for", item.id, err);
                    } finally {
                      setOfflineFetchingIds(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                    }
                  }}
                  title="Download for offline reading"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </button>
              )
            )}
            <button className="card-action-btn editor-header-delete" onClick={() => requestDelete(editingUrlId, "page")} title="Delete">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </>}
        >
          <div className="editor-url-content-wrapper">
            <div className="input-with-clear editor-url-wrapper">
              <input
                type="url"
                className="editor-url-input"
                value={editingUrlValue}
                onChange={(e) => setEditingUrlValue(e.target.value)}
                onFocus={() => {
                  // Counter iOS viewport scroll on focus
                  requestAnimationFrame(() => window.scrollTo(0, 0));
                }}
                placeholder="URL"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <ClearButton show={editingUrlValue.length > 0} onClear={() => setEditingUrlValue('')} />
            </div>
          </div>
        </EditorLayout>
      );
    }

    // Text/Note editing
    if (editingTextId) {
      const textUrlMatch = editingTextContent.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);
      const textItem = savedTexts.find(t => t.id === editingTextId);

      return (
        <EditorLayout
          onDismiss={requestCancelEditingText}
          keyboardHeight={keyboardHeight}
          tags={{
            selectedTags: editingTextTags,
            availableTags: allTags,
            tagInput: editingTextTagInput,
            onTagInputChange: setEditingTextTagInput,
            onToggleTag: toggleEditingTextTag,
            onAddTag: addEditingTextTag,
          }}
          buttons={{
            onSave: saveTextChanges,
            onCancel: requestCancelEditingText,
            onDelete: () => requestDelete(editingTextId, "text"),
            saveLabel: "Done",
          }}
          headerActions={<>
            {(editorReaderMode || /^#{1,6} |(\*\*|__).+(\*\*|__)|`[^`]+`|^\s*[-*+] |^\s*\d+\. |^\s*> |!\[|\[.+\]\(.+\)|^---$|^\*\*\*$/m.test(editingTextContent)) && (
            <button
              className={`card-action-btn ${editorReaderMode ? 'reader-active' : ''}`}
              onClick={() => setEditorReaderMode(!editorReaderMode)}
              title={editorReaderMode ? "Edit" : "Preview"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            )}
            {textUrlMatch && (
              <button className="card-action-btn" onClick={(e) => openInBrowser(textUrlMatch[0], editingTextId, e)} title="Open in Safari">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </button>
            )}
            {textUrlMatch && textItem && (
              <button className="card-action-btn" onClick={(e) => openInWebview(textUrlMatch[0], editingTextId, e)} title="Open in app">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="3" y1="9" x2="21" y2="9"></line>
                </svg>
              </button>
            )}
            {!editorReaderMode && (
              <>
                <button className="card-action-btn" type="button" onClick={() => textEditorRef.current?.undo()} disabled={!textEditorRef.current?.canUndo} title="Undo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10"></polyline>
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                  </svg>
                </button>
                <button className="card-action-btn" type="button" onClick={() => textEditorRef.current?.redo()} disabled={!textEditorRef.current?.canRedo} title="Redo">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"></path>
                  </svg>
                </button>
              </>
            )}
            <button className="card-action-btn editor-header-delete" onClick={() => requestDelete(editingTextId, "text")} title="Delete">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </>}
        >
          {editorReaderMode ? (
            <div className="note-reader-content" dangerouslySetInnerHTML={{ __html: (() => {
                const preprocessed = preProcessCheckboxes(editingTextContent);
                const rendered = preprocessed.split(/\n\n+/).map(block => {
                  const html = snarkdown(block.trim());
                  return /^<(h[1-6]|ul|ol|pre|blockquote|table|hr)/i.test(html) ? html : `<p>${html}</p>`;
                }).join('');
                return postProcessCheckboxes(rendered || `<p>${editingTextContent}</p>`);
              })() }} />
          ) : (
            <ResizableInput
              ref={textEditorRef}
              value={editingTextContent}
              onChange={setEditingTextContent}
              placeholder="Note text..."
              autoFocus
              showClearButton={false}
              onAutoSave={scheduleAutoSave}
              showUndoRedo={false}
            />
          )}
        </EditorLayout>
      );
    }

    // Tagset editing
    if (editingTagsetId) {
      return (
        <EditorLayout
          onDismiss={requestCancelEditingTagset}
          keyboardHeight={keyboardHeight}
          tags={{
            selectedTags: editingTagsetTags,
            availableTags: allTags,
            tagInput: editingTagsetInput,
            onTagInputChange: setEditingTagsetInput,
            onToggleTag: toggleEditingTagsetTag,
            onAddTag: addEditingTagsetTag,
          }}
          buttons={{
            onSave: saveTagsetChanges,
            onCancel: requestCancelEditingTagset,
            onDelete: () => requestDelete(editingTagsetId, "tagset"),
          }}
          headerActions={<>
            <button className="card-action-btn editor-header-delete" onClick={() => requestDelete(editingTagsetId, "tagset")} title="Delete">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </>}
        />
      );
    }

    // Image editing
    if (editingImageId) {
      const item = savedImages.find(i => i.id === editingImageId);
      if (!item) return null;
      const metadata = item.metadata as Record<string, unknown> | undefined;
      const title = metadata?.title as string | undefined;
      return (
        <EditorLayout
          onDismiss={requestCancelEditingImage}
          keyboardHeight={keyboardHeight}
          tags={{
            selectedTags: editingImageTags,
            availableTags: allTags,
            tagInput: editingImageTagInput,
            onTagInputChange: setEditingImageTagInput,
            onToggleTag: toggleEditingImageTag,
            onAddTag: addEditingImageTag,
          }}
          buttons={{
            onSave: saveImageChanges,
            onCancel: requestCancelEditingImage,
            onDelete: () => requestDelete(editingImageId, "image"),
          }}
          headerActions={<>
            <button className="card-action-btn editor-header-delete" onClick={() => requestDelete(editingImageId, "image")} title="Delete">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </>}
        >
          <div className="editor-image-preview">
            {item.thumbnail ? (
              <img
                src={`data:image/jpeg;base64,${item.thumbnail}`}
                alt={title || "Preview"}
                className="edit-modal-image"
                style={{ cursor: "pointer" }}
                onClick={async () => {
                  const data = await invoke<string | null>("get_image_data", { id: editingImageId });
                  if (data) setFullscreenImageData(data);
                }}
              />
            ) : (
              <div className="image-placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <circle cx="8.5" cy="8.5" r="1.5"></circle>
                  <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
              </div>
            )}
          </div>
          <ResizableInput
            value={editingImageContent}
            onChange={setEditingImageContent}
            placeholder="Image description..."
            showClearButton={false}
            showUndoRedo={false}
          />
        </EditorLayout>
      );
    }

    return null;
  };

  // ============================================================================
  // Shared Icon Constants & Item Footer Components
  // ============================================================================

  const ICON_TODAY = "!";
  const ICON_LATER = "\u{1F4A4}"; // 💤

  const ICON_TODO_CHECKED = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <polyline points="9 11 12 14 22 4"></polyline>
    </svg>
  );

  const ICON_TODO_UNCHECKED = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    </svg>
  );

  const ICON_READING_CHECKED = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
      <polyline points="9 11 12 14 22 4"></polyline>
    </svg>
  );

  const ICON_READING_UNCHECKED = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
    </svg>
  );

  const ICON_DELETE = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  );

  /** Todo/Done checkbox button */
  const TodoCheckbox: React.FC<{
    tags: string[];
    itemId: string;
    itemType: ItemType;
    onClick: (e: React.MouseEvent) => void;
  }> = ({ tags, onClick }) => {
    if (!tags.includes(todoTag) && !tags.includes(doneTag)) return null;
    const isDone = tags.includes(doneTag);
    return (
      <button
        className={`todo-checkbox ${isDone ? "checked" : ""}`}
        onClick={onClick}
      >
        {isDone ? ICON_TODO_CHECKED : ICON_TODO_UNCHECKED}
      </button>
    );
  };

  /** Reading (readme/read) checkbox button */
  const ReadingCheckbox: React.FC<{
    tags: string[];
    onClick: (e: React.MouseEvent) => void;
  }> = ({ tags, onClick }) => {
    if (!tags.includes(readmeTag) && !tags.includes(readTag)) return null;
    const isRead = tags.includes(readTag);
    return (
      <button
        className={`todo-checkbox reading-checkbox ${isRead ? "checked" : ""}`}
        onClick={onClick}
      >
        {isRead ? ICON_READING_CHECKED : ICON_READING_UNCHECKED}
      </button>
    );
  };

  /** Today/Later toggle button */
  const TodayToggleButton: React.FC<{
    tags: string[];
    onClick: (e: React.MouseEvent) => void;
  }> = ({ tags, onClick }) => {
    if (!tags.includes(todayTag) && !tags.includes(laterTag)) return null;
    const isToday = tags.includes(todayTag);
    return (
      <button
        className="todo-checkbox today-checkbox"
        onClick={onClick}
        title={isToday ? "Today" : "Later"}
      >
        {isToday ? ICON_TODAY : ICON_LATER}
      </button>
    );
  };

  /** Delete button (trash icon) */
  const DeleteButton: React.FC<{
    itemId: string;
    itemType: ItemType;
  }> = ({ itemId, itemType }) => (
    <button
      className="card-delete-btn"
      onClick={(e) => {
        e.stopPropagation();
        requestDelete(itemId, itemType);
      }}
    >
      {ICON_DELETE}
    </button>
  );

  /** Card footer with tag checkboxes, tags list, and date */
  const CardFooter: React.FC<{
    tags: string[];
    itemId: string;
    itemType: ItemType;
    savedAt: string;
    showReadingCheckbox?: boolean;
  }> = ({ tags, itemId, itemType, savedAt, showReadingCheckbox = false }) => (
    <div className="card-footer">
      <TodoCheckbox
        tags={tags}
        itemId={itemId}
        itemType={itemType}
        onClick={(e) => toggleTagPair(e, itemId, itemType, tags, todoTag, doneTag)}
      />
      {showReadingCheckbox && (
        <ReadingCheckbox
          tags={tags}
          onClick={(e) => toggleTagPair(e, itemId, itemType, tags, readmeTag, readTag)}
        />
      )}
      <TodayToggleButton
        tags={tags}
        onClick={(e) => toggleTagPair(e, itemId, itemType, tags, todayTag, laterTag)}
      />
      <div className="card-tags">
        {tags.map((tag) => (
          <span key={tag} className="card-tag">{tag}</span>
        ))}
        <span className="card-date">
          {new Date(savedAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );

  // Render unified item based on type
  const renderUnifiedItem = (item: UnifiedItem) => {
    switch (item.type) {
      case "page":
        return renderUrlItem({
          id: item.id,
          url: item.url!,
          tags: item.tags,
          saved_at: item.saved_at,
          metadata: item.metadata,
        });
      case "text":
        return renderTextItem({
          id: item.id,
          content: item.content!,
          tags: item.tags,
          saved_at: item.saved_at,
          metadata: item.metadata,
        });
      case "tagset":
        return renderTagsetItem({
          id: item.id,
          tags: item.tags,
          saved_at: item.saved_at,
          metadata: item.metadata,
        });
      case "image":
        return renderImageItem({
          id: item.id,
          tags: item.tags,
          saved_at: item.saved_at,
          metadata: item.metadata,
          content: item.content,
          thumbnail: item.thumbnail,
          mime_type: item.mime_type || "image/jpeg",
          width: item.width,
          height: item.height,
        });
      default:
        return null;
    }
  };

  // Create inline native WKWebView via Swift FFI
  const createInlineWebview = async (url: string, itemId: string) => {
    try {
      // Measure the webview-inline div's position so the native WKWebView aligns exactly
      let topOffset = 0;
      const card = document.getElementById(`card-${itemId}`);
      const inlineDiv = card?.querySelector('.webview-inline');
      if (inlineDiv) {
        topOffset = inlineDiv.getBoundingClientRect().top;
      }
      console.log("[App] Creating inline webview at topOffset:", topOffset, "for:", url, "itemId:", itemId);
      await invoke("open_inline_webview", { url, topOffset, itemId });
      setWebviewLoaded(true);
    } catch (error) {
      console.error("[App] Failed to create inline webview:", error);
      setWebviewError(String(error));
    }
  };

  const destroyInlineWebview = async () => {
    try {
      await invoke("close_inline_webview");
    } catch (error) {
      console.error("[App] Failed to close inline webview:", error);
    }
  };

  const renderWebviewInline = (_url: string) => {
    const isOffline = _url.startsWith('offline://') || (expandedWebview && !_url.startsWith('http'));
    const hasError = typeof webviewError === 'string' && webviewError.length > 0;
    return (
      <div className={`webview-inline ${webviewAnimated ? 'webview-expanded' : ''}`}>
        {hasError ? (
          <div className="webview-error">
            <p>{isOffline ? "Could not load offline content." : "This site can't be displayed inline."}</p>
            <p style={{fontSize: '11px', opacity: 0.6, wordBreak: 'break-all'}}>{webviewError}</p>
            {_url && _url.startsWith('http') && (
              <button onClick={(e) => { e.stopPropagation(); openUrl(_url); }}>Open in Safari</button>
            )}
          </div>
        ) : null}
        {!webviewLoaded && !hasError && <div className="webview-loading">{isOffline ? "Loading offline content..." : "Loading..."}</div>}
      </div>
    );
  };

  const renderUrlItem = (item: SavedUrl) => {
    const title = item.metadata?.title as string | undefined;
    const isExpanded = expandedWebview?.itemId === item.id;

    return (
      <div key={item.id} id={`card-${item.id}`} className={`saved-item-card ${isExpanded ? 'card-webview-expanded' : ''}`} onClick={() => !isExpanded && startEditing(item)}>
        <div className="card-header">
          {isExpanded && (
            <button className={`card-action-btn webview-back-btn ${webviewAnimated ? 'visible' : ''}`} onClick={(e) => { e.stopPropagation(); closeWebview(); }} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className="card-type-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
          </div>
          <span className="card-title">{title || item.url}</span>
          <div className="card-actions">
            <button
              className="card-action-btn"
              onClick={(e) => isExpanded ? (e.stopPropagation(), openUrl(item.url)) : openInBrowser(item.url, item.id, e)}
              title="Open in Safari"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15 3 21 3 21 9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
            <button
              className="card-action-btn"
              onClick={(e) => isExpanded ? (e.stopPropagation(), closeWebview()) : openInWebview(item.url, item.id, e)}
              title={isExpanded ? "Close webview" : "Open in app"}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="9" x2="21" y2="9"></line>
              </svg>
            </button>
            {offlineTag && item.tags.includes(offlineTag) && !isExpanded && (
              offlineContentIds.has(item.id) ? (
                <button
                  className="card-action-btn offline-ready"
                  onClick={(e) => { console.log("[App] EYE ICON TAPPED for", item.id); openOfflineReader(item.id, e); }}
                  title="Read offline"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
                  </svg>
                </button>
              ) : (
                <button
                  className={`card-action-btn offline-pending${offlineFetchingIds.has(item.id) ? ' offline-fetching' : ''}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (offlineFetchingIds.has(item.id)) return;
                    console.log("[App] Offline download tapped for", item.id);
                    setOfflineFetchingIds(prev => new Set(prev).add(item.id));
                    try {
                      await invoke("fetch_offline_content", { itemId: item.id, url: item.url });
                      setOfflineContentIds(prev => new Set(prev).add(item.id));
                    } catch (err) {
                      console.error("[App] Failed to fetch offline content for", item.id, err);
                    } finally {
                      setOfflineFetchingIds(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                    }
                  }}
                  title="Download for offline reading"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                </button>
              )
            )}
            <DeleteButton itemId={item.id} itemType="page" />
          </div>
        </div>
        {isExpanded && renderWebviewInline(expandedWebview.url)}
        <CardFooter tags={item.tags} itemId={item.id} itemType="page" savedAt={item.saved_at} showReadingCheckbox />
      </div>
    );
  };

  const renderTextItem = (item: SavedText) => {
    // Use actual tags from database, not just hashtags in content
    const tags = item.tags.length > 0 ? item.tags : extractHashtags(item.content);
    // Get summary: first line or truncated content (without hashtags for display)
    const contentWithoutTags = item.content.replace(/#\w+/g, '').trim();
    const summary = contentWithoutTags.split('\n')[0].slice(0, 100) || item.content.slice(0, 100);
    // Extract first URL from content
    const urlMatch = item.content.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/);

    const isExpanded = expandedWebview?.itemId === item.id;

    return (
      <div key={item.id} id={`card-${item.id}`} className={`saved-item-card ${isExpanded ? 'card-webview-expanded' : ''}`} onClick={() => !isExpanded && startEditingText(item)}>
        <div className="card-header">
          {isExpanded && (
            <button className={`card-action-btn webview-back-btn ${webviewAnimated ? 'visible' : ''}`} onClick={(e) => { e.stopPropagation(); closeWebview(); }} title="Back">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className="card-type-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
            </svg>
          </div>
          <div className="card-title">{summary}</div>
          <div className="card-actions">
            {(textReaderMode === item.id || /^#{1,6} |(\*\*|__).+(\*\*|__)|`[^`]+`|^\s*[-*+] |^\s*\d+\. |^\s*> |!\[|\[.+\]\(.+\)|^---$|^\*\*\*$/m.test(item.content)) && (
            <button
              className={`card-action-btn ${textReaderMode === item.id ? 'reader-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setTextReaderMode(textReaderMode === item.id ? null : item.id);
              }}
              title="Reader mode"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
            )}
            {urlMatch && (
              <button
                className="card-action-btn"
                onClick={(e) => isExpanded ? (e.stopPropagation(), openUrl(urlMatch[0])) : openInBrowser(urlMatch[0], item.id, e)}
                title="Open in Safari"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
              </button>
            )}
            {urlMatch && (
              <button
                className="card-action-btn"
                onClick={(e) => isExpanded ? (e.stopPropagation(), closeWebview()) : openInWebview(urlMatch[0], item.id, e)}
                title={isExpanded ? "Close webview" : "Open in app"}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="3" y1="9" x2="21" y2="9"></line>
                </svg>
              </button>
            )}
            <DeleteButton itemId={item.id} itemType="text" />
          </div>
        </div>
        {textReaderMode === item.id && (
          <div className="note-reader-content" dangerouslySetInnerHTML={{ __html: (() => {
                const preprocessed = preProcessCheckboxes(item.content);
                const rendered = preprocessed.split(/\n\n+/).map(block => {
                  const html = snarkdown(block.trim());
                  return /^<(h[1-6]|ul|ol|pre|blockquote|table|hr)/i.test(html) ? html : `<p>${html}</p>`;
                }).join('');
                return postProcessCheckboxes(rendered || `<p>${item.content}</p>`);
              })() }} />
        )}
        {isExpanded && renderWebviewInline(expandedWebview.url)}
        <CardFooter tags={tags} itemId={item.id} itemType="text" savedAt={item.saved_at} showReadingCheckbox />
      </div>
    );
  };

  const renderTagsetItem = (item: SavedTagset) => {
    return (
      <div key={item.id} className="saved-item-card" onClick={() => startEditingTagset(item)}>
        <div className="card-header">
          <div className="card-type-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
              <line x1="7" y1="7" x2="7.01" y2="7"></line>
            </svg>
          </div>
          <div className="card-tags card-title-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="card-tag">{tag}</span>
            ))}
          </div>
          <DeleteButton itemId={item.id} itemType="tagset" />
        </div>
        <div className="card-footer">
          <div className="card-tags">
            <span className="card-date">
              {new Date(item.saved_at).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
    );
  };

  const deleteImage = async (id: string) => {
    try {
      await invoke("delete_url", { id }); // delete_url works for all item types
      await loadSavedImages();
      cancelEditingImage();
    } catch (error) {
      console.error("Failed to delete image:", error);
    }
  };

  // Delete confirmation functions
  const requestDelete = (id: string, type: ItemType) => {
    setPendingDelete({ id, type });
  };

  const cancelDelete = () => {
    setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;

    const { id, type } = pendingDelete;
    setPendingDelete(null);

    const typeLabels: Record<ItemType, string> = {
      page: "Page",
      text: "Note",
      tagset: "Tags",
      image: "Image",
    };

    try {
      switch (type) {
        case "page":
          await deleteUrl(id);
          break;
        case "text":
          await deleteText(id);
          break;
        case "tagset":
          await deleteTagset(id);
          break;
        case "image":
          await deleteImage(id);
          break;
      }
      showToast(`${typeLabels[type]} deleted`);
    } catch (error) {
      console.error("Failed to delete:", error);
      showToast("Failed to delete", "error");
    }
  };

  const cancelDiscard = () => {
    setPendingDiscard(null);
  };

  const confirmDiscard = async () => {
    if (!pendingDiscard) return;
    const { type } = pendingDiscard;
    setPendingDiscard(null);
    switch (type) {
      case "page":
        cancelEditing();
        break;
      case "text":
        // Restore original content if auto-save changed it
        if (editingTextId && originalEditValues?.content !== undefined) {
          try {
            await invoke("update_text", { id: editingTextId, content: originalEditValues.content, tags: originalEditValues.tags || [] });
            await loadSavedTexts();
          } catch (error) {
            console.error("Failed to restore original content:", error);
          }
        }
        cancelEditingText();
        break;
      case "tagset":
        cancelEditingTagset();
        break;
      case "image":
        cancelEditingImage();
        break;
    }
  };

  // Generalized tag pair toggle (used for todo/done and readme/read)
  const toggleTagPair = async (e: React.MouseEvent, id: string, type: ItemType, currentTags: string[], tagA: string, tagB: string) => {
    e.stopPropagation(); // Don't trigger card click
    const hasA = currentTags.includes(tagA);
    const hasB = currentTags.includes(tagB);

    let newTags: string[];
    if (hasA) {
      // tagA -> tagB
      newTags = currentTags.filter(t => t !== tagA).concat(tagB);
    } else if (hasB) {
      // tagB -> tagA
      newTags = currentTags.filter(t => t !== tagB).concat(tagA);
    } else {
      return; // Neither tag present, shouldn't happen
    }

    try {
      await invoke("update_url_tags", { id, tags: newTags });
      // Reload the appropriate list
      switch (type) {
        case "page":
          await loadSavedUrls();
          break;
        case "text":
          await loadSavedTexts();
          break;
        case "tagset":
          await loadSavedTagsets();
          break;
        case "image":
          await loadSavedImages();
          break;
      }
      await loadAllTags();
    } catch (error) {
      console.error("Failed to toggle tag pair:", error);
    }
  };

  // Open URL in system browser (Safari)
  const openInBrowser = async (url: string, itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // Record visit before opening
      await invoke("record_visit", { itemId, source: "browser", windowType: "external" });
      await openUrl(url);
    } catch (error) {
      console.error("Failed to open in browser:", error);
    }
  };

  // Open URL in inline webview (expand card in-place)
  const appRef = useRef<HTMLDivElement>(null);

  const openInWebview = async (url: string, itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setWebviewLoaded(false);
    setWebviewError(false);
    setWebviewAnimated(false);
    setExpandedWebview({ url, itemId });
    // Double-rAF: first renders at height 0, second triggers the transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const card = document.getElementById(`card-${itemId}`);
        const app = appRef.current;
        if (card && app) {
          // Measure card's visual offset from top of app viewport
          const cardRect = card.getBoundingClientRect();
          const appRect = app.getBoundingClientRect();
          // Leave safe-area gap at top so rounded corners + app bg show behind notch
          const probe = document.createElement('div');
          probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden;';
          document.body.appendChild(probe);
          const safeTop = probe.offsetHeight;
          document.body.removeChild(probe);
          const offset = cardRect.top - appRect.top - safeTop;
          app.style.setProperty('--slide-offset', `${Math.max(0, offset)}px`);
        }
        // Set open easing on root so all transitions use it
        document.documentElement.style.setProperty('--webview-ease', 'var(--webview-ease-in)');
        setWebviewAnimated(true);
        // Create native WKWebView after animation completes
        setTimeout(() => createInlineWebview(url, itemId), WEBVIEW_ANIM_MS);
      });
    });
    try {
      await invoke("record_visit", { itemId, source: "webview", windowType: "embedded" });
    } catch (error) {
      console.error("[App] Failed to record webview visit:", error);
    }
  };

  const closeWebview = () => {
    // Destroy native webview immediately so it doesn't cover the animation
    destroyInlineWebview();
    // Switch to close easing before animating
    document.documentElement.style.setProperty('--webview-ease', 'var(--webview-ease-out)');
    setWebviewAnimated(false);
    if (appRef.current) {
      appRef.current.style.setProperty('--slide-offset', '0px');
    }
    // Wait for collapse animation, then unmount
    setTimeout(() => {
      setExpandedWebview(null);
      setWebviewLoaded(false);
      setWebviewError(false);
      // Refresh data to pick up any navigation-tracked history items
      loadSavedUrls();
    }, WEBVIEW_ANIM_MS);
  };

  const openOfflineReader = async (itemId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setWebviewLoaded(false);
    setWebviewError(false);
    setWebviewAnimated(false);
    // Store the real URL so error display can offer "Open in Safari" with the actual link
    const item = savedUrls.find((u: SavedUrl) => u.id === itemId);
    const realUrl = item?.url || '';
    setExpandedWebview({ url: realUrl || ('offline://' + itemId), itemId });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const card = document.getElementById(`card-${itemId}`);
        const app = appRef.current;
        if (card && app) {
          const cardRect = card.getBoundingClientRect();
          const appRect = app.getBoundingClientRect();
          const probe = document.createElement('div');
          probe.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden;';
          document.body.appendChild(probe);
          const safeTop = probe.offsetHeight;
          document.body.removeChild(probe);
          const offset = cardRect.top - appRect.top - safeTop;
          app.style.setProperty('--slide-offset', `${Math.max(0, offset)}px`);
        }
        document.documentElement.style.setProperty('--webview-ease', 'var(--webview-ease-in)');
        setWebviewAnimated(true);
        setTimeout(async () => {
          try {
            let topOffset = 0;
            const card = document.getElementById(`card-${itemId}`);
            const inlineDiv = card?.querySelector('.webview-inline');
            if (inlineDiv) {
              topOffset = inlineDiv.getBoundingClientRect().top;
            }
            console.log("[App] Opening offline reader at topOffset:", topOffset, "for item:", itemId);
            // Fetch article content + metadata from Rust, build HTML in frontend for HMR
            let content: { html: string; title: string; byline: string; dir: string; domain: string; url: string };
            try {
              content = await invoke("get_reader_content", { itemId });
            } catch (fetchErr) {
              // Content not cached yet (e.g. synced from desktop without fetching) — fetch on demand
              console.log("[App] No cached content for item:", itemId, "error:", fetchErr, "— attempting on-demand fetch");
              if (!realUrl) {
                throw new Error("No URL available for this item — cannot fetch offline content");
              }
              console.log("[App] Fetching offline content on demand from:", realUrl);
              await invoke("fetch_offline_content", { itemId, url: realUrl });
              console.log("[App] On-demand fetch complete, retrying get_reader_content");
              content = await invoke("get_reader_content", { itemId });
            }
            const dirAttr = content.dir ? ` dir="${content.dir}"` : "";
            const baseTag = content.url ? `<base href="${content.url.replace(/"/g, '&quot;')}">` : "";
            const domainLink = content.url
              ? `<a class="domain" href="${content.url.replace(/"/g, '&quot;')}">${content.domain}</a>`
              : "";
            const bylineHtml = content.byline
              ? `<div class="credits">${content.byline}</div>`
              : "";
            const headerHtml = (content.title || content.domain)
              ? `<div class="header">${domainLink}<h1>${content.title}</h1>${bylineHtml}</div>`
              : "";
            const fullHtml = `<!DOCTYPE html>
<html${dirAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
${baseTag}
<style>
${readerCss}
</style>
</head>
<body>
<div class="container">
${headerHtml}
<div class="reader-content">
${content.html}
</div>
</div>
</body>
</html>`;
            await invoke("show_inline_html", { html: fullHtml, topOffset, baseUrl: content.url });
            setWebviewLoaded(true);
          } catch (error: any) {
            const errMsg = error instanceof Error ? error.message : (typeof error === 'string' ? error : String(error));
            console.error("[App] Failed to open offline reader:", errMsg, error);
            setWebviewError(errMsg || "Unknown error loading offline content");
          }
        }, WEBVIEW_ANIM_MS);
      });
    });
  };

  const renderDiscardConfirmModal = () => {
    if (!pendingDiscard) return null;

    return (
      <div className="confirm-modal-overlay" onClick={cancelDiscard}>
        <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
          <p>Discard unsaved changes?</p>
          <div className="confirm-modal-buttons">
            <button className="cancel-btn" onClick={cancelDiscard}>
              Cancel
            </button>
            <button className="delete-btn" onClick={confirmDiscard}>
              Discard
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderDeleteConfirmModal = () => {
    if (!pendingDelete) return null;

    const typeLabels: Record<ItemType, string> = {
      page: "page",
      text: "note",
      tagset: "tag set",
      image: "image",
    };

    return (
      <div className="confirm-modal-overlay" onClick={cancelDelete}>
        <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
          <p>Delete this {typeLabels[pendingDelete.type]}?</p>
          <div className="confirm-modal-buttons">
            <button className="cancel-btn" onClick={cancelDelete}>
              Cancel
            </button>
            <button className="delete-btn" onClick={confirmDelete}>
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderImageItem = (item: SavedImage) => {
    const metadata = item.metadata as Record<string, unknown> | undefined;
    const title = metadata?.title as string | undefined;
    const sourceUrl = metadata?.sourceUrl as string | undefined;

    return (
      <div key={item.id} className="saved-item-card image-card" onClick={() => startEditingImage(item)}>
        <div className="card-header">
          <div className="card-thumbnail">
            {item.thumbnail ? (
              <img
                src={`data:image/jpeg;base64,${item.thumbnail}`}
                alt={title || "Preview"}
                style={{ cursor: "pointer" }}
                onClick={async (e) => {
                  e.stopPropagation();
                  const data = await invoke<string | null>("get_image_data", { id: item.id });
                  if (data) setFullscreenImageData(data);
                }}
              />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            )}
          </div>
          <div className="card-title">{title || sourceUrl || "Image"}</div>
          <DeleteButton itemId={item.id} itemType="image" />
        </div>
        {item.content && (
          <div className="card-content" style={{ padding: "0 12px 8px", fontSize: "13px", opacity: 0.8, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" as const }}>
            {item.content.length > 200 ? item.content.substring(0, 200) + "..." : item.content}
          </div>
        )}
        <CardFooter tags={item.tags} itemId={item.id} itemType="image" savedAt={item.saved_at} />
      </div>
    );
  };

  const closeSettings = () => {
    setShowSettings(false);
    // Reload data in case webhook was used
    loadSavedUrls();
    loadAllTags();
  };

  // Keep edge-swipe back handler in sync with current view state.
  // Priority: dismiss the topmost overlay first, then full-screen views.
  useEffect(() => {
    if (fullscreenImageData) {
      edgeSwipeBackRef.current = () => setFullscreenImageData(null);
    } else if (expandedWebview) {
      edgeSwipeBackRef.current = () => closeWebview();
    } else if (editingUrlId) {
      edgeSwipeBackRef.current = () => requestCancelEditing();
    } else if (editingTextId) {
      edgeSwipeBackRef.current = () => requestCancelEditingText();
    } else if (editingTagsetId) {
      edgeSwipeBackRef.current = () => requestCancelEditingTagset();
    } else if (editingImageId) {
      edgeSwipeBackRef.current = () => requestCancelEditingImage();
    } else if (addInputExpanded) {
      edgeSwipeBackRef.current = () => setAddInputExpanded(false);
    } else if (textReaderMode) {
      edgeSwipeBackRef.current = () => setTextReaderMode(null);
    } else if (capturedImage) {
      edgeSwipeBackRef.current = () => cancelCapturedImage();
    } else if (showSettings) {
      edgeSwipeBackRef.current = () => closeSettings();
    } else {
      // On the main list view — no back action
      edgeSwipeBackRef.current = null;
    }
  });

  if (showSettings) {
    return (
      <div className="app">
        <header>
          <button className="header-btn back-btn" onClick={closeSettings}>
            Back
          </button>
          <h1>Settings</h1>
          <div className="header-spacer"></div>
        </header>

        <main className="settings-view">
          {/* Server Sync Section */}
          <div className="settings-section">
            <h2>Server Sync</h2>
            <p className="settings-description">
              Sync your saved items with the server. Pull to get items from other devices, push to send local items, or sync all to do both.
            </p>
            <p className="settings-description" style={{ fontSize: "0.85rem", opacity: 0.8 }}>
              Items sync to your account's current profile on the server.
            </p>

            <div className="webhook-input">
              <input
                type="url"
                value={webhookUrlInput}
                onChange={(e) => setWebhookUrlInput(e.target.value)}
                placeholder="https://your-server.example.com"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>

            <div className="webhook-input api-key-field">
              <input
                type={showApiKey ? "text" : "password"}
                value={webhookApiKeyInput}
                onChange={(e) => setWebhookApiKeyInput(e.target.value)}
                placeholder="API key"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button
                type="button"
                className="toggle-visibility-btn"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                    <line x1="1" y1="1" x2="23" y2="23"></line>
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                )}
              </button>
            </div>

            <button
              onClick={saveWebhookSettings}
              disabled={webhookUrlInput === webhookUrl && webhookApiKeyInput === webhookApiKey}
              className="save-settings-btn"
            >
              Save Settings
            </button>

            <label className={`auto-sync-toggle${!webhookUrl ? ' disabled' : ''}`}>
              <input
                type="checkbox"
                checked={autoSyncEnabled}
                onChange={(e) => toggleAutoSync(e.target.checked)}
                disabled={!webhookUrl}
              />
              <span>Auto-sync when items are added or modified</span>
            </label>

            <div className="sync-interval-setting">
              <label htmlFor="sync-interval-input">Sync interval (minutes)</label>
              <input
                id="sync-interval-input"
                type="number"
                min={0}
                value={syncIntervalMinutes}
                onChange={(e) => saveSyncInterval(Math.max(0, Number(e.target.value) || 0))}
                disabled={!webhookUrl}
              />
              <span className="sync-interval-hint">0 = never auto-sync periodically</span>
            </div>

            {lastSync && (
              <p className="last-sync-info">
                Last synced: {new Date(lastSync).toLocaleString()}
              </p>
            )}

            {syncStatus && syncStatus.pending_count > 0 && (
              <p className="sync-pending-info">
                {syncStatus.pending_count} item{syncStatus.pending_count === 1 ? '' : 's'} pending sync
              </p>
            )}

            <button
              className="sync-btn primary"
              onClick={syncAll}
              disabled={!webhookUrl || isSyncing}
            >
              {isSyncing ? "Syncing..." : "Sync All"}
            </button>

            <div className="sync-btn-row">
              <button
                className="sync-btn secondary"
                onClick={pullFromServer}
                disabled={!webhookUrl || isSyncing}
              >
                Pull
              </button>
              <button
                className="sync-btn secondary"
                onClick={pushToServer}
                disabled={!webhookUrl || isSyncing}
              >
                Push
              </button>
            </div>

            {syncMessage && (
              <div className={`sync-message ${syncMessage.includes("failed") || syncMessage.includes("Failed") ? "error" : "success"}`}>
                {syncMessage}
              </div>
            )}
          </div>

          {/* Profile Section */}
          <div className="settings-section">
            <h2>Profiles</h2>
            {profileInfo && (
              <>
                <p className="settings-description">
                  {profileInfo.isProductionBuild
                    ? "App Store/TestFlight build"
                    : "Development build"}.
                  Each profile has separate local data and sync destination.
                </p>

                {(() => {
                  const currentProfile = profileInfo.profiles.find(p => p.id === profileInfo.currentProfileId);
                  const defaultProfile = profileInfo.profiles[0];
                  const isDefaultProfile = currentProfile?.id === defaultProfile?.id;

                  return (
                    <>
                      {!isDefaultProfile && currentProfile && (
                        <div className="profile-warning-banner">
                          Using "{currentProfile.name}" profile - data is isolated from default
                        </div>
                      )}

                      {/* Profile List */}
                      <div className="profile-list">
                        {profileInfo.profiles.map((profile) => {
                          const isCurrent = profile.id === profileInfo.currentProfileId;
                          // Can delete if not current and more than one profile exists
                          const canDelete = !isCurrent && profileInfo.profiles.length > 1;

                          return (
                            <div key={profile.id} className={`profile-item ${isCurrent ? "active" : ""}`}>
                              <label className="profile-radio-label">
                                <input
                                  type="radio"
                                  name="profile"
                                  checked={isCurrent}
                                  onChange={() => {
                                    console.log(`[Profile] Radio clicked: ${profile.id}, isCurrent: ${isCurrent}`);
                                    if (!isCurrent) {
                                      console.log(`[Profile] Switching to: ${profile.id}`);
                                      setProfile(profile.id);
                                    }
                                  }}
                                />
                                <span className="profile-name">{profile.name}</span>
                                {isCurrent && <span className="profile-badge current">active</span>}
                              </label>
                              {canDelete && (
                                <button
                                  className="profile-delete-btn"
                                  onClick={async () => {
                                    if (confirm(`Delete profile "${profile.name}"?\n\nThe database file will be preserved.`)) {
                                      try {
                                        const info = await invoke<ProfileInfo>("delete_profile", { profileId: profile.id });
                                        setProfileInfo(info);
                                      } catch (err) {
                                        alert(`Failed to delete: ${err}`);
                                      }
                                    }
                                  }}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Add Profile */}
                      <div className="profile-add-section">
                        <div className="profile-input-row">
                          <input
                            type="text"
                            value={profileInput}
                            onChange={(e) => setProfileInput(e.target.value)}
                            placeholder="New profile name"
                          />
                          <button
                            className="sync-btn secondary"
                            onClick={async () => {
                              if (profileInput.trim()) {
                                try {
                                  const info = await invoke<ProfileInfo>("create_profile", { name: profileInput.trim() });
                                  setProfileInfo(info);
                                  setProfileInput("");
                                } catch (err) {
                                  alert(`Failed to create: ${err}`);
                                }
                              }
                            }}
                            disabled={!profileInput.trim()}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </div>

          {/* Todos Section */}
          <div className="settings-section">
            <h2>Todos</h2>
            <p className="settings-description">
              Configure the tag pair for todo/done checkboxes. Items with the "active" tag show an unchecked checkbox; tapping it switches to the "completed" tag.
            </p>
            <div className="webhook-input">
              <label className="settings-label">Active tag</label>
              <input
                type="text"
                value={todoTagInput}
                onChange={(e) => setTodoTagInput(e.target.value)}
                placeholder="todo"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <div className="webhook-input">
              <label className="settings-label">Completed tag</label>
              <input
                type="text"
                value={doneTagInput}
                onChange={(e) => setDoneTagInput(e.target.value)}
                placeholder="done"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <button
              onClick={saveTodoTags}
              disabled={todoTagInput === todoTag && doneTagInput === doneTag}
              className="save-settings-btn"
            >
              Save Todo Tags
            </button>
          </div>

          {/* Reading List Section */}
          <div className="settings-section">
            <h2>Reading List</h2>
            <p className="settings-description">
              Configure the tag pair for reading list checkboxes. Works like todo/done but with a book icon. Items with the "unread" tag show an unchecked book; tapping it switches to the "read" tag.
            </p>
            <div className="webhook-input">
              <label className="settings-label">Unread tag</label>
              <input
                type="text"
                value={readmeTagInput}
                onChange={(e) => setReadmeTagInput(e.target.value)}
                placeholder="readme"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <div className="webhook-input">
              <label className="settings-label">Read tag</label>
              <input
                type="text"
                value={readTagInput}
                onChange={(e) => setReadTagInput(e.target.value)}
                placeholder="read"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <button
              onClick={saveReadingTags}
              disabled={readmeTagInput === readmeTag && readTagInput === readTag}
              className="save-settings-btn"
            >
              Save Reading Tags
            </button>
          </div>

          {/* Offline Section */}
          <div className="settings-section">
            <h2>Offline</h2>
            <p className="settings-description">
              Items tagged with this tag will have their content fetched and stored locally for offline reading. Reader-mode extraction is used to save clean article text.
            </p>
            <div className="webhook-input">
              <label className="settings-label">Offline tag</label>
              <input
                type="text"
                value={offlineTagInput}
                onChange={(e) => setOfflineTagInput(e.target.value)}
                placeholder="offline"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <button
              onClick={saveOfflineTag}
              disabled={offlineTagInput === offlineTag}
              className="save-settings-btn"
            >
              Save Offline Tag
            </button>
            <p className="settings-description" style={{ marginTop: '0.5rem' }}>
              Disk usage: {offlineStorageSize < 1024 ? `${offlineStorageSize} B` : offlineStorageSize < 1024 * 1024 ? `${(offlineStorageSize / 1024).toFixed(1)} KB` : `${(offlineStorageSize / (1024 * 1024)).toFixed(1)} MB`}
            </p>
          </div>

          {/* Display Section */}
          <div className="settings-section">
            <h2>Display</h2>
            <p className="settings-description">
              Items with this tag are hidden from the main view unless the tag is selected as a filter.
            </p>
            <div className="webhook-input">
              <input
                type="text"
                value={archiveTagInput}
                onChange={(e) => setArchiveTagInput(e.target.value)}
                placeholder="archive"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            <button
              onClick={saveArchiveTag}
              disabled={archiveTagInput === archiveTag}
              className="save-settings-btn"
            >
              Save Archive Tag
            </button>
          </div>

          {/* Debug Section */}
          <div className="settings-section">
            <h2>Debug</h2>
            <div className="sync-btn-row" style={{ flexDirection: 'column', gap: '0.5rem' }}>
              <button
                className="sync-btn secondary"
                onClick={async () => {
                  try {
                    const files = await invoke<string[]>("debug_list_container_files");
                    setSyncMessage("FILES: " + files.join(" | "));
                  } catch (e) {
                    setSyncMessage("ERROR: " + String(e));
                  }
                }}
              >
                List Container Files
              </button>
              <button
                className="sync-btn secondary"
                onClick={async () => {
                  try {
                    const info = await invoke<string>("debug_profiles_json");
                    setSyncMessage(info);
                  } catch (e) {
                    setSyncMessage("PROFILES ERROR: " + String(e));
                  }
                }}
              >
                Show profiles.json
              </button>
              <button
                className="sync-btn secondary"
                onClick={async () => {
                  try {
                    const info = await invoke<string>("debug_settings_table");
                    setSyncMessage(info);
                  } catch (e) {
                    setSyncMessage("SETTINGS ERROR: " + String(e));
                  }
                }}
              >
                Show Settings Table
              </button>
              <button
                className="sync-btn secondary"
                onClick={async () => {
                  try {
                    const info = await invoke<string>("debug_query_database");
                    setSyncMessage(info);
                  } catch (e) {
                    setSyncMessage("DB ERROR: " + String(e));
                  }
                }}
              >
                Query Database
              </button>
              <button
                className="sync-btn secondary"
                onClick={async () => {
                  try {
                    setSyncMessage("Exporting...");
                    const base64 = await invoke<string>("debug_export_database");
                    setSyncMessage("DB_START>>>" + base64.substring(0, 500) + "...(" + base64.length + " total chars). Use AirDrop or copy manually.");
                    console.log("FULL_DB_BASE64:", base64);
                  } catch (e) {
                    setSyncMessage("EXPORT ERROR: " + String(e));
                  }
                }}
              >
                Export Database
              </button>
              {profileInfo && profileInfo.profiles.length >= 2 && (
                <button
                  className="sync-btn secondary"
                  style={{ backgroundColor: '#c44' }}
                  onClick={async () => {
                    const p1 = profileInfo.profiles[0];
                    const p2 = profileInfo.profiles[1];
                    try {
                      setSyncMessage("Swapping...");
                      const result = await invoke<string>("swap_profile_databases", {
                        profileIdA: p1.id,
                        profileIdB: p2.id
                      });
                      setSyncMessage(result);
                    } catch (e) {
                      setSyncMessage("SWAP ERROR: " + String(e));
                    }
                  }}
                >
                  Swap Default ↔ Dev Databases
                </button>
              )}
            </div>
          </div>

        </main>

        {/* Restart prompt modal */}
        {showRestartPrompt && (
          <div className="modal-overlay">
            <div className="modal-content">
              <h3>Profile Changed</h3>
              <p>
                Switched to <strong>{profileInfo?.profiles.find(p => p.id === profileInfo?.currentProfileId)?.name ?? "unknown"}</strong> profile.
              </p>
              <p>
                Please restart the app to ensure complete data isolation.
              </p>
              <div className="modal-buttons">
                <button className="modal-btn secondary" onClick={() => setShowRestartPrompt(false)}>
                  Later
                </button>
                <button className="modal-btn primary" onClick={quitApp}>
                  Quit Now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const unifiedItems = getUnifiedItems();
  const totalCount = savedUrls.length + savedTexts.length + savedTagsets.length + savedImages.length;

  // Hidden camera input
  const cameraInput = (
    <input
      ref={cameraInputRef}
      type="file"
      accept="image/*"
      capture="environment"
      onChange={handleCameraCapture}
      style={{ display: "none" }}
    />
  );

  // Captured image edit view
  if (capturedImage) {
    return (
      <div className="app">
        {cameraInput}
        <header>
          <button className="header-btn back-btn" onClick={cancelCapturedImage}>
            Cancel
          </button>
          <h1>Save Photo</h1>
          <div className="header-spacer"></div>
        </header>

        <main className="saved-view">
          <div className="captured-image-view">
            <div className="captured-image-preview">
              <img src={capturedImage} alt="Captured" />
            </div>

            {capturedImageTags.size > 0 && (
              <div className="edit-section">
                <div className="editing-tags">
                  {Array.from(capturedImageTags).sort().map((tag) => (
                    <span key={tag} className="editing-tag">
                      {tag}
                      <button onClick={() => { toggleCapturedImageTag(tag); requestAnimationFrame(() => capturedImageTagInputRef.current?.focus()); }}>&times;</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="edit-section">
              <div className="new-tag-input">
                <input
                  ref={capturedImageTagInputRef}
                  type="text"
                  value={capturedImageTagInput}
                  onChange={(e) => setCapturedImageTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCapturedImageTag();
                      requestAnimationFrame(() => capturedImageTagInputRef.current?.focus());
                    }
                  }}
                  placeholder="Add tag..."
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button onClick={() => { addCapturedImageTag(); requestAnimationFrame(() => capturedImageTagInputRef.current?.focus()); }} disabled={!capturedImageTagInput.trim()}>
                  Add
                </button>
              </div>
            </div>

            {allTags.filter((t) =>
              !capturedImageTags.has(t.name) &&
              (!capturedImageTagInput.trim() || t.name.toLowerCase().includes(capturedImageTagInput.toLowerCase().trim()))
            ).length > 0 && (
              <div className="edit-section">
                <div className="all-tags-list">
                  {allTags.filter((t) =>
                    !capturedImageTags.has(t.name) &&
                    (!capturedImageTagInput.trim() || t.name.toLowerCase().includes(capturedImageTagInput.toLowerCase().trim()))
                  ).map((tag) => (
                    <span
                      key={tag.name}
                      className="tag-chip"
                      onClick={() => { toggleCapturedImageTag(tag.name); requestAnimationFrame(() => capturedImageTagInputRef.current?.focus()); }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="edit-buttons">
              <button className="cancel-btn" onClick={cancelCapturedImage}>
                Cancel
              </button>
              <button className="save-btn" onClick={saveCapturedImage}>
                Save
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className={`app ${expandedWebview ? 'webview-active' : ''}`} ref={appRef}>
      {fullscreenImageData && (
        <div className="image-fullscreen-overlay" onClick={() => setFullscreenImageData(null)}>
          <img
            className="image-fullscreen-img"
            src={`data:image/jpeg;base64,${fullscreenImageData}`}
            alt="Fullscreen"
          />
        </div>
      )}
      <input ref={keyboardPrimerRef} style={{ position: 'fixed', opacity: 0, top: '-100px' }} readOnly />
      {cameraInput}
      <header>
        <h1
          onClick={() => {
            if (activeFilter !== "all" || searchText || selectedFilterTags.size > 0) showAll();
            else scrollToTop();
          }}
          style={{ cursor: "pointer" }}
        >
          Peek <span style={{ fontSize: '0.5em', opacity: 0.5 }}>{__BUILD_NUMBER__}</span>
        </h1>
        <div style={{ flex: 1 }} />
        <div className="filter-icons">
          <button
            className={`filter-btn ${activeFilter === "page" ? "active" : ""}`}
            onClick={() => selectFilter("page")}
            title="Pages"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            <span className="filter-count">{savedUrls.length}</span>
          </button>
          <button
            className={`filter-btn ${activeFilter === "text" ? "active" : ""}`}
            onClick={() => selectFilter("text")}
            title="Notes"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
            </svg>
            <span className="filter-count">{savedTexts.length}</span>
          </button>
          <button
            className={`filter-btn ${activeFilter === "tagset" ? "active" : ""}`}
            onClick={() => selectFilter("tagset")}
            title="Tag Sets"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
              <line x1="7" y1="7" x2="7.01" y2="7"></line>
            </svg>
            <span className="filter-count">{savedTagsets.length}</span>
          </button>
          <button
            className={`filter-btn ${activeFilter === "image" ? "active" : ""}`}
            onClick={() => selectFilter("image")}
            title="Images"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            <span className="filter-count">{savedImages.length}</span>
          </button>
        </div>
        <button
          className="sort-btn"
          onClick={() => setSortOrder(prev => prev === 'newest' ? 'oldest' : 'newest')}
          title={sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
        >
          {sortOrder === 'newest' ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <polyline points="19 12 12 19 5 12"></polyline>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          )}
        </button>
        <div style={{ flex: 1 }} />
        <button className={`header-btn settings-btn ${isSyncing ? 'syncing' : ''}`} onClick={() => setShowSettings(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </header>

      {/* Profile warning banner when not on first/default profile */}
      {profileInfo && profileInfo.profiles.length > 0 && profileInfo.currentProfileId !== profileInfo.profiles[0].id && (
        <div className="profile-banner">
          Profile: {profileInfo.profiles.find(p => p.id === profileInfo.currentProfileId)?.name ?? "Unknown"}
        </div>
      )}

      <main
        className="saved-view"
        ref={mainRef}
      >
        {/* Input row: search + add side by side */}
        <div className="input-row">
          <div className="input-row-card">
            <div className="input-with-clear" style={{ flex: 1 }}>
              <input
                type="text"
                className="input-row-input"
                placeholder="Search..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              <ClearButton show={searchText.length > 0 || selectedFilterTags.size > 0} onClear={() => { setSearchText(''); setSelectedFilterTags(new Set()); }} />
            </div>
          </div>
          <div className="input-row-card">
            <div className="input-with-clear" style={{ flex: 1 }}>
              <input
                type="text"
                className="input-row-input"
                placeholder="Add..."
                value={addInputText}
                onChange={(e) => setAddInputText(e.target.value)}
                onFocus={() => setAddInputExpanded(true)}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button className="camera-btn" onClick={openCamera} title="Take photo">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                <circle cx="12" cy="13" r="4"></circle>
              </svg>
            </button>
          </div>
        </div>

        {/* Tag chips - always visible, filterable, resizable */}
        <div className="drag-handle-wrapper">
          <div
            className="filter-tags-container"
            ref={filterTagsRef}
            style={{ height: `${filterTagsHeight}px` }}
          >
            {allTags.length === 0 ? (
              <div className="filter-tags-empty">This is where your tags live - tag something!</div>
            ) : getFilteredTags().length === 0 ? (
              <div className="filter-tags-empty">No matching tags</div>
            ) : (
              <div className="filter-tags">
                {getFilteredTags().map((tag) => (
                  <span
                    key={tag.name}
                    className={`tag-chip ${selectedFilterTags.has(tag.name) ? "selected" : ""}`}
                    onClick={() => toggleFilterTag(tag.name)}
                  >
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div
            className="drag-handle"
            onMouseDown={(e) => { e.preventDefault(); handleFilterTagsDragStart(e.clientY); }}
            onTouchStart={(e) => { handleFilterTagsDragStart(e.touches[0].clientY); }}
          >
            <div className="drag-handle-bar" />
          </div>
        </div>

        {/* Item list */}
        <div className="unified-list">
          {totalCount === 0 ? (
            <div className="empty-state">
              <p>No saved items yet.</p>
              <p>Share a URL from any app to get started!</p>
            </div>
          ) : unifiedItems.length === 0 ? (
            <div className="empty-state">
              <p>No matching items.</p>
              <p>Tap Peek to clear filters.</p>
            </div>
          ) : (
            unifiedItems.map((item) => renderUnifiedItem(item))
          )}
        </div>
      </main>

      {/* Auto-sync status indicator */}
      <div className={`auto-sync-indicator ${isSyncing ? 'syncing' : ''}`} />

      {/* Edit modal overlay */}
      {renderEditModal()}

      {/* Quick Add overlay */}
      {addInputExpanded && (
        <EditorLayout
          onDismiss={() => setAddInputExpanded(false)}
          keyboardHeight={keyboardHeight}
          tags={{
            selectedTags: addInputTags,
            availableTags: allTags,
            tagInput: addInputNewTag,
            onTagInputChange: setAddInputNewTag,
            onToggleTag: toggleAddInputTag,
            onAddTag: addInputAddNewTag,
            placeholder: "Add new tag...",
          }}
          buttons={{
            onSave: saveAddInput,
            onCancel: () => setAddInputExpanded(false),
            cancelLabel: "Close",
            saveDisabled: !getAddInputType(),
          }}
        >
          <ResizableInput
            value={addInputText}
            onChange={setAddInputText}
            placeholder="Enter text, URL, or just select tags..."
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
          />
        </EditorLayout>
      )}

      {/* Delete confirmation modal */}
      {renderDeleteConfirmModal()}

      {/* Discard changes confirmation modal */}
      {renderDiscardConfirmModal()}

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}

      {/* Restart prompt modal */}
      {showRestartPrompt && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Profile Changed</h3>
            <p>
              Switched to <strong>{profileInfo?.profiles.find(p => p.id === profileInfo?.currentProfileId)?.name ?? "unknown"}</strong> profile.
            </p>
            <p>
              Please restart the app to ensure complete data isolation.
            </p>
            <div className="modal-buttons">
              <button className="modal-btn secondary" onClick={() => setShowRestartPrompt(false)}>
                Later
              </button>
              <button className="modal-btn primary" onClick={quitApp}>
                Quit Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
