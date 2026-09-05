# The auxiliary runner: one tool, many programs

## What problem this solves

Every MCP tool you wire up costs context on **every turn of every session**, whether
you call it or not. The tool's name, description and input schema sit in the model's
window permanently. You pay the same rent for the tool you use ten times a day and the
tool you used once in July.

Measured on this system, 2026-08-30, by speaking MCP to each server over stdio and
taking `len(json.dumps(tools))` — the actual schema bytes a client carries:

```
  random      13 tools    4154 chars
  math        13 tools    9692
  database    11 tools    5384
  reasoning    7 tools    4867
  github       6 tools    3396
  projects     5 tools    1388
  tasks        5 tools    1268
  vault        4 tools    2185
  TOTAL       64 tools   32334 chars   ~8083 tokens

  aux          1 tool     1619 chars   ~404 tokens
```

Twenty times fewer, and the saving is structural rather than usage-dependent: the old
cost did not depend on how often you called anything, so neither does the saving.

This is the same insight as Anthropic's deferred tool loading, published
[2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use), nine months
before this was built. It is not a priority claim. The design differs in one way that
turned out to matter, described under "Closed registry" below.

## What is in this repository, and what is not

This repo contains the **MCP face**: `index.js`, a thin stdio server exposing exactly
one tool, `aux_run`. It contains no logic. It builds an argv and shells out.

The **core** — the dispatcher, the registry, the argument validator, the finder — lives
in a private repository, because that repo is personal infrastructure: real machine
names, home paths, a LAN address, and a SQLite ledger of actual prompts. Publishing it
would leak all of that to save readers a few hundred lines.

So the core is described here instead, in prose and pseudocode faithful to the running
implementation (`aux.py`, 319 lines; `aux_mcp.py`, 210 lines). Everything below is real
behaviour, not aspiration. Where the implementation has a wart, the wart is documented.

## The shape

```
  MCP client
     |
     |  ONE tool schema: aux_run { op, name, args, query }
     v
  index.js          <- this repo. No logic. Builds argv, runs python3, returns JSON.
     |
     v
  aux.py            <- the core (private). Dispatch, validation, host rules, find.
     |
     +---> a registered PROGRAM        (subprocess: node/bash/python)
     |
     +---> a collapsed MCP SERVER      (spawn, speak MCP over stdio, call one tool)
```

Two machines share `aux.py` and the registry byte-for-byte. Only `index.js` is
Mac-only, because the second machine has Python but no Node and no MCP client. The
thing that could drift is the logic, so there is exactly one copy of the logic.

## The registry

A single JSON file with two namespaces. See `aux-registry.example.json`.

A **program** is something runnable that was never an MCP tool. These cost zero context
before and zero after; exposing them through the runner makes them callable without
making them present.

```json
"sync-check": {
  "purpose": "Are the files that exist on BOTH machines actually identical? ...",
  "host": "mac",
  "cwd": "~/Code/harness",
  "cmd": ["bash", "aux-sync.sh"],
  "timeout_s": 120,
  "args": {
    "fix": {
      "choices": ["no", "yes"],
      "default": "no",
      "flag": { "yes": "--push" },
      "help": "yes copies the Mac's copies to pop and re-checks."
    }
  }
}
```

A **server** is a whole MCP server that used to be wired individually and is now
reached as `alias.tool`:

```json
"random": {
  "purpose": "Dice, coin flips, shuffles, samples, UUIDs, weighted choice, ...",
  "cmd": ["node", "$HOME/Code/mcp-random/dist/index.js"]
}
```

The two namespaces are disjoint by construction: program ids never contain a dot, so a
dotted name is unambiguously `server.tool`. No precedence rule, no trap.

## Operations

`aux_run` takes four inputs: `op` (list / find / describe / run), `name`, `args`,
`query`. Omitting `op` with a `name` present means run; omitting both means list.

### list — the catalogue is pulled, not pushed

Returns every program and every collapsed server with its purpose. This is the honest
trade: what used to be always-present becomes one round trip. Without list and
describe, the collapsed tools are not hidden, they are lost.

### describe — what does this actually accept

```
function describe(name):
    if name is missing:
        return error "name is required for describe; call list to see what exists"
    if name contains ".":
        alias, tool = split on the dot
        spawn the server, speak MCP, return that one tool's real schema
    return the registry entry verbatim, including the full args declaration
```

### run — dispatch and validate

The load-bearing part. Argument checking happens **before** anything executes.

```
function run(name, given):

    # 1. a dotted name is a collapsed MCP server
    if "." in name:
        alias, tool = split on the dot
        spec = servers[alias]  or return {ok: false, available: [...]}
        ok, out = mcp_call(spec, tool, given)
        if not ok:
            # the usual cause is a tool name that does not exist on that
            # server, and the answer to that is the list. Hand it back here
            # rather than making the caller spend a round trip asking.
            return {ok: false, error: out, tools_on_this_server: [...]}
        return {ok: true, server: alias, tool: tool, output: out}

    # 2. otherwise it is a registered program
    spec = programs[name]  or return {ok: false, available: sorted(programs)}

    # 3. refuse the wrong machine rather than running the wrong thing
    if spec.host not in ("any", this_host()):
        return {ok: false,
                error: "<name> runs on <host>; this is <here>",
                hint: "ssh to <host> and run: aux.py run <name>"}

    # 4. validate against the registry. Raises with a USABLE message.
    try:
        tail = build(spec.args, given)
    except ValueError as e:
        return {ok: false, error: str(e), accepts: spec.args}

    # 5. execute
    proc = subprocess(spec.cmd + tail, cwd=spec.cwd, timeout=spec.timeout_s)

    # `ok` is the PROGRAM's exit code, never the fact that we managed to
    # start it. Reporting a successful launch as a successful run is the
    # wrapper-vs-result mistake this system keeps finding in itself.
    return {ok: proc.code == 0 and not timed_out,
            exit_code: proc.code, ran: <the actual command line>,
            cwd: ..., host: ..., ms: ..., output: proc.stdout, stderr: ...}
```

And the validator, which is the whole reason this is a boundary rather than a menu:

```
function build(declared_args, given):
    unknown = keys in `given` that `declared_args` does not declare
    if unknown:
        raise "unknown argument(s): <them>. This program accepts: <these>"

    tail = []
    for key, decl in declared_args:
        val = given.get(key, decl.default)
        if val is None:
            if decl.optional: continue
            raise "<key> is required"
        if decl.choices and val not in decl.choices:
            raise "<key>=<val> is not one of: <choices>"

        # three arg shapes, which is all eleven programs needed. Deliberately
        # NOT a general schema language.
        if decl.flag:        tail.append(decl.flag[val])   # choice -> switch
        elif decl.positional: tail.append(val)
        else:                 tail += ["--" + key, val]
    return tail
```

Live example of a rejection:

```json
{ "ok": false,
  "error": "fix=maybe is not one of: no, yes",
  "accepts": { "fix": { "choices": ["no","yes"], "default": "no", ... } } }
```

### find — search the registry instead of reading it

`list` is fine at fourteen programs and will not be at forty, and it makes the caller
read everything to find one thing.

```
function find(query, limit=5):
    tokens = lowercase words of query, minus stopwords
    if no tokens: return error "find needs a query"

    candidates = every program
               + every collapsed server
               + every TOOL on every collapsed server (asked live, not cached)

    for each candidate:
        score, named, coverage = 0, false, 0
        for each token:
            if token is a substring of the candidate NAME:
                score += 3; named = true; coverage += 1
            elif token is a substring of its purpose text:
                score += 1; coverage += 1

    # THE FLOOR: a name hit, or at least two DISTINCT query words in the blurb.
    # Coverage is what stops one common word carrying a result. The first
    # version scored "summarise a long web page" against object_count because
    # that description happens to contain "long". One incidental word is not a
    # match, and a finder that answers confidently with junk is worse than one
    # that says it found nothing.
    keep = [c for c in candidates if c.named or c.coverage >= 2]

    if keep is empty:
        return {ok: true, matches: [],
                note: "nothing matched. list shows everything there is."}
    return top `limit` by (score, coverage), each with a ready-to-paste `call`
```

## Four design constraints, each from something that bit this system

**1. Closed registry, not a shell.** It dispatches by name from a manifest and cannot
be handed a command line. A runner that takes a command is just `exec` with extra
steps, and would be strictly worse: no per-program validation, no logging, no
allow-list. This is the real difference from deferred loading, which withholds schemas
but still exposes N tools and validates nothing of its own. One tool with a registry
behind it is closer to a system call table than to a menu.

**2. It must carry its own catalogue.** `list` and `describe` are not conveniences.
Without them the collapsed capability is not hidden, it is gone.

**3. Per-program validation lives in the registry.** A single generic `args: object`
reintroduces the exact bug this system was built after: a handler destructuring a
parameter its schema never declared, producing a permanent silent null. Every entry
declares its own arguments and the runner checks them before running.

**4. Refuse the wrong host.** A program declared for one machine that quietly ran on
the other would produce a confident answer about the wrong computer.

## Telemetry, and why the first parameter is called `name`

Every call is logged with `meta.target`, and the logger derives that from the first
present of `path / file / id / key / query / command / name`. Calling the parameter
`name` means `aux_run{name:"regen"}` lands in the ledger as `target="regen"` with zero
changes to any logging code — the trace still says which program ran behind the generic
tool name. Calling it `program` would have silently blinded the telemetry.

Captured-but-unreadable is the same as missing: a usage view that groups by TOOL name
would count all fourteen programs as one row called `aux_run`, and "is anyone using X"
would get a wrong answer.

## Known limitations

**A one-word query can only match a name.** The floor requires a name hit or two
distinct words. So `"is the documentation still true"` finds `doc-check` and
`"documentation"` alone finds nothing. Longer queries work better than shorter ones,
which is backwards from every search anyone has used. Left alone deliberately:
loosening it means more confident wrong answers everywhere else.

**Matching is lexical, not semantic.** A query token must be a substring of the name or
the purpose. `"documentation"` cannot reach a program named `doc-check` whose purpose
says "docs". The repair is to write purposes in the words users type, not the words the
code uses — fix the data, not the matcher.

**Hidden capability is unexercised capability.** `op=find` shipped broken on
2026-08-31 and threw on every call for five days before anyone noticed, because
nothing called it. Collapsing tools does not only risk making them colder; it removes
the traffic that would have told you something was broken. If you build one of these,
write a test that walks through the front door the way a new user would, and run it on
a schedule. The thing that used to catch your bugs was people bumping into them, and
you just removed the people.
