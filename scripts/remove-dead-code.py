#!/usr/bin/env python3
"""Remove dead code from lib.rs that has been moved to peek-core."""

import sys

LIB_RS = 'backend/tauri-mobile/src-tauri/src/lib.rs'

with open(LIB_RS, 'r') as f:
    lines = f.readlines()

def find_line(text, start_from=0):
    """Find first line containing exact text."""
    for i in range(start_from, len(lines)):
        if text in lines[i]:
            return i
    return None

def find_fn_end(start_line):
    """Find the closing brace of a function starting at start_line."""
    depth = 0
    for i in range(start_line, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if depth == 0 and '{' in ''.join(lines[start_line:i+1]):
            return i
    return None

removals = []

# 1. Remove ensure_database_initialized() — ~770 lines
start = find_line('fn ensure_database_initialized() -> Result<(), String> {')
if start is not None:
    end = find_fn_end(start)
    if end is not None:
        # Also remove the comment line before it
        comment_start = start
        while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
            comment_start -= 1
        # Include blank line after
        end_with_blank = end + 1
        while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
            end_with_blank += 1
        removals.append((comment_start, end_with_blank,
            '// ensure_database_initialized() moved to peek-core::schema\n\n'))
        print(f'ensure_database_initialized: lines {comment_start+1}-{end_with_blank}')

# 2. Remove parse_iso_datetime, unix_ms_to_iso, unix_ms_to_datetime
for fn_name in ['parse_iso_datetime', 'unix_ms_to_iso', 'unix_ms_to_datetime']:
    start = find_line(f'fn {fn_name}(')
    if start is not None:
        end = find_fn_end(start)
        if end is not None:
            # Include comment before
            comment_start = start
            while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
                comment_start -= 1
            end_with_blank = end + 1
            while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
                end_with_blank += 1
            removals.append((comment_start, end_with_blank, ''))
            print(f'{fn_name}: lines {comment_start+1}-{end_with_blank}')

# 3. Remove check_response_version_headers (still used - skip if referenced elsewhere)
# Actually this is still used in pull_from_server, keep it.

# 4. Remove get_items_to_push (standalone fn)
start = find_line('fn get_items_to_push(conn: &Connection)')
if start is not None:
    end = find_fn_end(start)
    if end is not None:
        comment_start = start
        while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
            comment_start -= 1
        end_with_blank = end + 1
        while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
            end_with_blank += 1
        removals.append((comment_start, end_with_blank, ''))
        print(f'get_items_to_push: lines {comment_start+1}-{end_with_blank}')

# 5. Remove get_item_tags (standalone fn, NOT the test helper)
start = find_line('fn get_item_tags(conn: &Connection, item_id: &str) -> Result<Vec<String>, String>')
if start is not None:
    end = find_fn_end(start)
    if end is not None:
        comment_start = start
        while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
            comment_start -= 1
        end_with_blank = end + 1
        while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
            end_with_blank += 1
        removals.append((comment_start, end_with_blank, ''))
        print(f'get_item_tags: lines {comment_start+1}-{end_with_blank}')

# 6. Remove merge_server_item
start = find_line('fn merge_server_item(conn: &Connection, server_item: &ServerItem)')
if start is not None:
    end = find_fn_end(start)
    if end is not None:
        comment_start = start
        while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
            comment_start -= 1
        end_with_blank = end + 1
        while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
            end_with_blank += 1
        removals.append((comment_start, end_with_blank, ''))
        print(f'merge_server_item: lines {comment_start+1}-{end_with_blank}')

# 7. Remove update_item_tags_from_server
start = find_line('fn update_item_tags_from_server(conn: &Connection, item_id: &str, tag_names: &[String])')
if start is not None:
    end = find_fn_end(start)
    if end is not None:
        comment_start = start
        while comment_start > 0 and lines[comment_start - 1].strip().startswith('//'):
            comment_start -= 1
        end_with_blank = end + 1
        while end_with_blank < len(lines) and lines[end_with_blank].strip() == '':
            end_with_blank += 1
        removals.append((comment_start, end_with_blank, ''))
        print(f'update_item_tags_from_server: lines {comment_start+1}-{end_with_blank}')

if not removals:
    print('No functions found to remove!')
    sys.exit(1)

# Sort removals in reverse order so line numbers stay valid
removals.sort(key=lambda x: x[0], reverse=True)

for start, end, replacement in removals:
    lines[start:end] = [replacement] if replacement else []

with open(LIB_RS, 'w') as f:
    f.writelines(lines)

total_removed = sum(end - start for start, end, _ in removals)
print(f'\nTotal: removed {total_removed} lines from lib.rs')
