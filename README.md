# mcp-aux

One MCP tool fronting many programs, so that rarely-used capability stops costing
context on every turn.

Sixty-four tool schemas across eight servers cost about 8,083 tokens, carried in the
model's window whether or not anything gets called. Collapsed behind a single tool,
that becomes about 404. Twenty times fewer, and the saving does not depend on usage,
because the old cost did not either.

## What is here

`index.js` is the MCP face: a stdio server exposing exactly one tool, `aux_run`, with
four operations — `list`, `find`, `describe`, `run`. It contains no logic. It builds an
argv and shells out to the core.

The core is not in this repository, because it lives in a private personal-
infrastructure repo alongside real machine names, home paths and a ledger of actual
prompts. **[DESIGN.md](DESIGN.md) describes it in full** — architecture, the registry
format, pseudocode for all four operations, the four design constraints and the known
limitations. `aux-registry.example.json` is a sanitized registry showing every
argument shape the validator supports.

Everything in DESIGN.md is behaviour of the running implementation, including the
warts. It is a description, not a specification of something aspirational.

## The idea in one paragraph

Dispatch by name from a closed registry, never a command line. Validate each program's
arguments against that registry *before* anything runs, so a wrong argument comes back
as an error naming what is accepted rather than a silent no-op. Carry the catalogue
behind `list` and `describe` so hidden capability is hidden and not lost. Refuse a
program declared for another machine instead of running it here and reporting
confidently about the wrong computer.

That last set is what makes this a capability boundary rather than a compression trick.
Deferred tool loading — [Anthropic, 2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use),
nine months before this was built — solves the same context problem by withholding
schemas while still exposing N tools and validating nothing of its own. This exposes
one tool and checks the door.

## Honest caveat

Collapsing tools removes the traffic that would have told you they were broken.
`op=find` shipped broken here and threw on every call for five days before anyone
noticed, because nothing called it. If you build one of these, write a test that walks
in through the front door the way a new user would and run it on a schedule.
