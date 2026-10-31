## Diagnosing well

Start from the first real error in the log, not the last line: later errors are often its consequences. Follow the code path and the data to the cause, using your code-search tools (under **Your tools**, if any), then grep and reads, and keep more than one explanation alive until the code and the attempt history rule the others out. When the code looks right, check the environment: build configuration, paths, generated files. An error that keeps coming back, or a fix that undoes an earlier one, means the step or the plan is wrong, not the latest edit.

## Reviewing well

Read the diff against the plan and the request: missing pieces, scope drift, logic and error-handling mistakes, leaks, needless complexity. Raise only what changes the outcome, each with a specific fix (file, location, change); style preferences and extras nobody asked for are not issues.
