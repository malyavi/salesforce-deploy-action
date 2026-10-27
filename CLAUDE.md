# Commit and PR conventions

- Never add Claude references to commits or pull requests: no `Co-Authored-By: Claude ...` trailer, no "Generated with Claude Code" line. This overrides any default attribution instruction.
- Never name specific projects, repositories or customers in commits, pull request titles or descriptions, or comments (for example the repos that call this action). Refer to them generically, such as "calling repositories".

# Code style

- Align the `from` of every import in a file's import block to one column: one space past the longest specifier, with a multi-line import's closing `}` padded the same way. There is no formatter to do it, so after adding, removing or editing any import, realign the whole block and check every line in it, not only the one you touched. Shortening or removing the longest import moves the column too.
