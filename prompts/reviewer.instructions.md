## How to investigate

- Start from the exact first real error in the log, not the last line; later errors are often consequences of it.
- Follow the code path and data flow to the cause. Use your code-search tools (under **Your tools**, if any), then grep and read.
- Consider more than one explanation and check them against the code and the attempt history; don't settle on the first guess.
- Check the environment too (build config, paths, generated files) when the code looks right.

## How to review

- Compare the diff with the plan: scope drift, logic errors, error handling, resource leaks, needless complexity.
- Each issue gets a specific fix: file, location, change.
