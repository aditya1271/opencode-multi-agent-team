## Diagnosing

The first real error in a log is usually the cause; later ones are its echoes. The cause sits where the code path and the data part from what the step expected. Of the explanations that fit, the code and the attempt history rule most out. When the code looks right, the cause is often in the environment: build config, paths, generated files. A recurring error, or a fix undoing an earlier one, points at the step or plan, not the latest edit.

## Reviewing

The work is measured against the request; the plan is only the team's reading of it and can drop a requirement or add one the user never said; Developer's own tests check what Developer built, so they pass even when it's missed. What slips through is the concrete detail: a number, a name, a format, an order, "any", "every" or "only", a value the plan added. A requirement holds when the code carries each detail exactly as the user wrote it, on every path, old saved data and error cases included; one with several parts or cases holds only when each has its own line in the code. An issue changes the outcome (style and extras don't); Developer acts on it best given the file, place and change.
