#!/usr/bin/env node
// mcp-aux — the MCP face of the auxiliary tool runner.
//
// ONE SCHEMA, MANY PROGRAMS. Mikey, 2026-08-23: "There are tools that are loaded and
// then there should be tools that are run... Then we might be able to move some of the
// tools out of memory." A loaded tool costs context on every turn on every surface
// whether or not it is called; a run tool costs nothing until it runs. This server is
// eleven programs behind one schema, and most of them were never callable at all --
// generators and audits in ~/Code/harness that fired only when a human remembered.
//
// THIS FILE DELIBERATELY CONTAINS NO LOGIC. Dispatch, validation, host rules and the
// registry all live in ~/Code/harness/aux.py, which runs identically on Schmooey and on
// pop. pop has no node, so the MCP face exists only here while the CORE is shared. The
// thing that could drift is the logic, so there is exactly one copy of it.
//
// WHY `name` IS THE FIRST PARAMETER: ledger_log.mjs logs every span with
// meta.target = targetOf(args), and targetOf returns the first present of
// path/file/file_path/id/key/query/command/situation/name. So `aux_run{name:"regen"}`
// lands in the ledger as target="regen" with no logging change at all, and the trace
// still says WHICH program ran behind the generic tool name. Renaming this parameter
// to `program` would silently blind the telemetry.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const AUX = path.join(os.homedir(), 'Code/harness/aux.py');

const DESC =
  'Run one of the maintenance and audit programs that do NOT live in memory as tools of their own. ' +
  'START WITH op="list" — it returns every program, what it is for, and which machine it runs on; ' +
  'that catalogue is pulled on demand rather than occupying context on every turn, which is the whole point of this server. ' +
  'The programs cover documentation regeneration, contract and schema checks, protocol integrity, memory audits and embeddings, ' +
  'the test suite, and pop\'s GPU state. ' +
  'Arguments are declared per-program in the registry and VALIDATED there before anything runs, so a wrong or unknown argument ' +
  'comes back as an error naming what the program actually accepts — it is never silently ignored. ' +
  'This is a CLOSED REGISTRY, not a shell: it dispatches by name and cannot be handed a command line. For arbitrary commands use system_exec.';

const server = new Server({ name: 'mcp-aux', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'aux_run',
    description: DESC,
    inputSchema: {
      type: 'object',
      properties: {
        // `name` first, and named `name`, so the ledger's targetOf() picks it up.
        name: { type: 'string', description: 'Which program to run or describe. Omit only with op="list". Get the list from op="list".' },
        op:   { type: 'string', enum: ['run', 'list', 'describe'], description: '"run" (default) executes it; "list" returns the catalogue; "describe" returns one program in full, including exactly which arguments it takes.' },
        args: { type: 'object', description: 'Program arguments as plain key/value pairs, e.g. {"mode":"check"} or {"op":"similar","text":"the hammer"}. Validated against the registry — an unknown key is an error that names the accepted ones, never a silent no-op. Use op="describe" to see them.' },
      },
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {};
  const op = a.op || (a.name ? 'run' : 'list');
  const argv = [AUX, op];
  if (op !== 'list') {
    if (!a.name) return json({ ok: false, error: 'name is required for op="' + op + '". Call op="list" to see what exists.' });
    argv.push(a.name);
  }
  if (op === 'run') for (const [k, v] of Object.entries(a.args || {})) argv.push(`${k}=${v}`);

  try {
    // maxBuffer: a program that prints a lot (dupes, the test suite) must not fail as a
    // truncation error that reads like the program itself broke.
    const { stdout } = await run('python3', argv, { maxBuffer: 32 * 1024 * 1024, timeout: 960000 });
    return json(JSON.parse(stdout));
  } catch (e) {
    // aux.py exits non-zero when the PROGRAM failed, and still prints its JSON report on
    // stdout. That is a result, not a crash: parse it and return it rather than throwing
    // away the output and reporting only that the wrapper was unhappy.
    if (e.stdout) { try { return json(JSON.parse(e.stdout)); } catch { /* fall through */ } }
    return json({ ok: false, error: String(e.message).slice(0, 500),
                  stderr: String(e.stderr || '').slice(0, 800) });
  }
});

function json(o) { return { content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] }; }

await server.connect(new StdioServerTransport());
console.error('[aux] connected. registry=~/Code/harness/aux-registry.json');
