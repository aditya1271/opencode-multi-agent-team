# Project guide for agents

Fill in what an agent would otherwise have to work out on every task. Keep it short and exact.
The build and test commands the team uses as checks go in the plugin config (`checks`); this
file adds the details around them.

## Environment

- Shell and setup: <e.g. `source env.sh`, required modules>

## Build

- Incremental build: `<command>` (about <N> min)
- Full build: `<command>` (about <N> min)
- Where it runs: <local | `ssh <host>` | docker image>

## Test

- Single test: `<command> <test>`
- Suite: `<command>`
- Logs end up in: `<path>`

## Dependencies

- <docker / conan / package steps>

## Version control

- System: <git | p4>
- Rules: <e.g. open files with `p4 edit` before editing>
- Never: <e.g. push, submit, revert, clean>
