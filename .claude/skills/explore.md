# /explore — Research a codebase question

When the user invokes /explore with a question:

1. Spawn an **Explore agent** (`subagent_type=Explore`) to research the question.

2. The agent should:
   - Use Grep, Glob, and Read tools to search the codebase — NOT bash commands
   - Search broadly first, then narrow down
   - Check multiple locations and naming conventions
   - Look for related files and cross-references

3. Return structured findings:
   - **Answer**: Direct answer to the question
   - **Relevant files**: Absolute paths to key files
   - **Architecture**: How the components fit together (if applicable)
   - **Key functions/classes**: Important entry points

4. Relay the agent's findings to the user in a clear format.

## Usage

```
/explore "how does lazy extension loading work"
/explore "where are sync conflicts resolved"
/explore "what pubsub events does the groups UI listen to"
```
