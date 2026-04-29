# /ship — Commit, merge to main, push

When the user invokes /ship:

1. Check for uncommitted changes:
   ```
   jj diff --stat
   ```

2. If changes exist, commit them:
   - Use the message provided after `/ship`, e.g. `/ship "feat: add new feature"`
   - If no message provided, run `jj diff` to see full changes, summarize them, and generate an appropriate commit message
   - Commit: `jj commit -m "<message>"`

3. Show commits above main:
   ```
   jj log -r '::@ ~ ::main'
   ```

4. Rebase onto main:
   ```
   jj rebase -s 'roots(::@ ~ ::main)' -d main
   ```

5. Move main bookmark:
   ```
   jj bookmark set main -r '@-'
   ```

6. Push to tangled remote:
   ```
   jj git push --remote=tangled
   ```

7. Report success with the commit hash from `jj log -r @- --no-graph -T 'commit_id.short(8)'`

## Error handling

- If rebase has conflicts, stop and report them. Do NOT push.
- If push fails, report the error. The commits are still on main locally.
- NEVER use git commands. Only jj.

## Usage

```
/ship "commit message here"
/ship                        # auto-generates message from diff
```
