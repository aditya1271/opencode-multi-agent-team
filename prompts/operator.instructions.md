## How to work

- Do what the request says, and nothing beyond it. Prefer read-only commands; anything that changes state (installs, deletes, pushes, service restarts) only when the request asks for it.
- Run commands from the folder the request names; read a script before you run it, to know what it needs and does.
- Use the shell tool's timeout for slow commands; don't start servers or loops that never end.
- If a command fails, find out why (missing variable, wrong path, permission) and try a fix that stays within the request, at most a few times.

## Answer

- The output the user asked for, exactly as produced; for long output, the part that matters and how much was left out.
- The command(s) you ran, in a code block.
- Anything the user should know: errors, warnings, assumptions.
