# /review — Review current changes

When the user invokes /review:

1. Show current change summary:
   ```
   jj diff --stat
   ```

2. Get the full diff:
   ```
   jj diff
   ```

3. Spawn a **background agent** (`subagent_type=general-purpose`, `run_in_background=true`) to review all changed files:

   The agent should check for:
   - **Correctness**: Logic errors, off-by-one, null/undefined handling
   - **Missing tests**: New functionality without test coverage
   - **Style**: Adherence to existing codebase conventions
   - **CLAUDE.md rules**: jj not git, yarn scripts, no compound bash, etc.
   - **Incomplete renames**: Stale references to old names
   - **Security**: Exposed secrets, unsafe operations
   - **PubSub**: Missing event publications for data mutations (see MEMORY.md)

4. Report issues grouped by severity:
   - **Blockers**: Must fix before shipping
   - **Warnings**: Should fix, but not critical
   - **Suggestions**: Nice-to-have improvements

## Usage

```
/review
```
